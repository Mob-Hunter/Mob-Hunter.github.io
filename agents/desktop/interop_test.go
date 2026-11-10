package main

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base32"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"os"
	"strings"
	"testing"
	"time"
)

// TestInteropWithRealServer runs the real agent (with a fake OS layer) against a running Mob Hunter
// Worker. Skipped unless MH_INTEROP_URL and MH_INTEROP_BOOTSTRAP are set (see interop.sh).
func TestInteropWithRealServer(t *testing.T) {
	base := strings.TrimRight(os.Getenv("MH_INTEROP_URL"), "/")
	boot := os.Getenv("MH_INTEROP_BOOTSTRAP")
	if base == "" || boot == "" {
		t.Skip("set MH_INTEROP_URL and MH_INTEROP_BOOTSTRAP")
	}
	jar, _ := cookiejar.New(nil)
	h := &http.Client{Jar: jar, Timeout: 30 * time.Second}
	admin := func(method, path string, in any) (int, map[string]any, []any) {
		t.Helper()
		var body io.Reader
		if in != nil {
			b, _ := json.Marshal(in)
			body = bytes.NewReader(b)
		}
		req, _ := http.NewRequest(method, base+"/api"+path, body)
		req.Header.Set("x-mob-hunter-csrf", "1")
		req.Header.Set("content-type", "application/json")
		res, err := h.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		raw, _ := io.ReadAll(res.Body)
		var obj map[string]any
		var arr []any
		if json.Unmarshal(raw, &obj) != nil {
			_ = json.Unmarshal(raw, &arr)
		}
		return res.StatusCode, obj, arr
	}
	must := func(method, path string, in any) map[string]any {
		t.Helper()
		status, obj, _ := admin(method, path, in)
		if status >= 300 {
			t.Fatalf("%s %s: %d %v", method, path, status, obj)
		}
		return obj
	}

	// --- admin: bootstrap the fresh server and sign in with password + TOTP
	pw := "correct horse battery staple"
	b := must("POST", "/bootstrap", map[string]any{"token": boot, "name": "Root", "email": "root@corp.test", "password": pw})
	ch := must("POST", "/admin/login", map[string]any{"email": "root@corp.test", "password": pw})
	must("POST", "/admin/mfa", map[string]any{"challengeId": ch["challengeId"], "code": totp(t, b["totpSecret"].(string))})
	e := must("POST", "/admin/enrollments", map[string]any{})

	// --- device: the real enrolment, check-in and command loop
	sys := &fakeSystem{platform: "linux", privileged: true, posture: Posture{Firewall: boolp(false), Encrypted: boolp(true), PendingUpdates: intp(4)}}
	a := &Agent{Dir: t.TempDir(), Sys: sys}
	link, err := parseEnrolLink(e["standardLink"].(string))
	if err != nil {
		t.Fatal(err)
	}
	if err := a.Enrol(link, func(string, []string, []string) bool { return true }); err != nil {
		t.Fatalf("enrol: %v", err)
	}
	id := a.Cfg.DeviceID
	d := must("GET", "/admin/devices/"+id, nil)
	if d["platform"] != "linux" || d["state"] != "active" || d["os"] != "Ubuntu 24.04.3 LTS" {
		t.Fatalf("device record: platform=%v state=%v os=%v", d["platform"], d["state"], d["os"])
	}
	keys := []string{}
	for _, th := range d["risk"].(map[string]any)["threats"].([]any) {
		keys = append(keys, th.(map[string]any)["key"].(string))
	}
	if strings.Join(keys, ",") != "firewall_off,updates_pending" {
		t.Fatalf("threats detected from posture: %v", keys)
	}

	// Phone-only commands are refused for a computer before they are ever signed.
	if s, o, _ := admin("POST", "/admin/devices/"+id+"/commands", map[string]any{"type": "LOCATE", "ticket": "INC-1", "reason": "should be refused"}); s != 422 || o["error"] != "not_supported" {
		t.Fatalf("LOCATE on a computer: %d %v", s, o)
	}
	// MESSAGE and LOCK are signed by the server, verified and executed by the agent.
	must("POST", "/admin/devices/"+id+"/commands", map[string]any{"type": "MESSAGE", "params": map[string]any{"title": "From IT", "text": "Please restart tonight"}})
	must("POST", "/admin/devices/"+id+"/commands", map[string]any{"type": "LOCK"})
	out, err := a.Poll()
	if err != nil {
		t.Fatal(err)
	}
	if len(out) != 2 || out[0].Result != "succeeded" || out[1].Result != "succeeded" {
		t.Fatalf("outcomes: %+v", out)
	}
	if sys.locked != 1 || !strings.Contains(strings.Join(sys.notifications, "|"), "From IT: Please restart tonight") {
		t.Fatalf("OS effects: locked=%d notes=%v", sys.locked, sys.notifications)
	}
	_, _, cmds := admin("GET", "/admin/commands?deviceId="+id, nil)
	for _, c := range cmds {
		if c.(map[string]any)["status"] != "succeeded" {
			t.Fatalf("command not succeeded on the server: %v", c)
		}
	}
	// The posture is fixed on the computer → the threat resolves at the next check-in.
	sys.posture.Firewall = boolp(true)
	if err := a.Checkin(); err != nil {
		t.Fatal(err)
	}
	land := must("GET", "/admin/threats", nil)
	if land["devices"].(float64) != 1 || land["counts"].(map[string]any)["medium"].(float64) != 0 {
		t.Fatalf("landscape: devices=%v counts=%v", land["devices"], land["counts"])
	}

	// Deleting the computer in the console: signed RELEASE → service and credentials removed → record erased.
	must("POST", "/admin/devices/"+id+"/delete", map[string]any{"reason": "Laptop returned to IT stock", "confirm": "DELETE"})
	if _, err := a.Poll(); err != nil {
		t.Fatal(err)
	}
	if !sys.serviceGone || a.Cfg != nil {
		t.Fatal("agent did not release itself")
	}
	if c, _ := loadConfig(a.Dir); c != nil {
		t.Fatal("credentials left on disk")
	}
	if s, _, _ := admin("GET", "/admin/devices/"+id, nil); s != 404 {
		t.Fatalf("device record still present: %d", s)
	}
}

func totp(t *testing.T, secret string) string {
	t.Helper()
	key, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(strings.ToUpper(strings.TrimRight(secret, "=")))
	if err != nil {
		t.Fatal(err)
	}
	var msg [8]byte
	binary.BigEndian.PutUint64(msg[:], uint64(time.Now().Unix()/30))
	m := hmac.New(sha1.New, key)
	m.Write(msg[:])
	sum := m.Sum(nil)
	o := sum[len(sum)-1] & 15
	code := (binary.BigEndian.Uint32(sum[o:o+4]) & 0x7fffffff) % 1_000_000
	return fmt.Sprintf("%06d", code)
}
