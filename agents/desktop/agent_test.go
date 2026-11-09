package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func signedEnvelope(t *testing.T, priv ed25519.PrivateKey, c Command) Envelope {
	t.Helper()
	b, _ := json.Marshal(c)
	return Envelope{Signed: string(b), Sig: hex.EncodeToString(ed25519.Sign(priv, b)), Payload: b}
}

func TestVerifyRules(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	pubHex := hex.EncodeToString(pub)
	now := time.UnixMilli(1_800_000_000_000)
	base := Command{V: 1, ID: "cmd_1", DeviceID: "dev_1", Type: "LOCK", Nonce: "abcdef0123456789", IssuedAt: now.UnixMilli() - 1000, ExpiresAt: now.UnixMilli() + 9*60_000}
	never := func(string) bool { return false }

	if c, r := verify(signedEnvelope(t, priv, base), pubHex, "dev_1", now, never); r != "" || c.Type != "LOCK" {
		t.Fatalf("valid command rejected: %q", r)
	}
	// Tampering with the signed bytes breaks the signature.
	env := signedEnvelope(t, priv, base)
	env.Signed = strings.Replace(env.Signed, "LOCK", "WIPE", 1)
	if _, r := verify(env, pubHex, "dev_1", now, never); r != "bad_signature" {
		t.Fatalf("tampered command: got %q", r)
	}
	// Signed by another key.
	_, other, _ := ed25519.GenerateKey(rand.Reader)
	if _, r := verify(signedEnvelope(t, other, base), pubHex, "dev_1", now, never); r != "bad_signature" {
		t.Fatalf("foreign key: got %q", r)
	}
	cases := map[string]func(c *Command){
		"wrong_device": func(c *Command) { c.DeviceID = "dev_2" },
		"expired":      func(c *Command) { c.IssuedAt, c.ExpiresAt = now.UnixMilli()-9*60_000, now.UnixMilli()-1 },
		"malformed":    func(c *Command) { c.ExpiresAt = c.IssuedAt + 11*60_000 }, // longer than 10 minutes
		"not_yet_valid": func(c *Command) {
			c.IssuedAt, c.ExpiresAt = now.UnixMilli()+5*60_000, now.UnixMilli()+9*60_000
		},
	}
	for want, mutate := range cases {
		c := base
		mutate(&c)
		if _, r := verify(signedEnvelope(t, priv, c), pubHex, "dev_1", now, never); r != want {
			t.Errorf("%s: got %q", want, r)
		}
	}
	seen := func(k string) bool { return k == "n:"+base.Nonce }
	if _, r := verify(signedEnvelope(t, priv, base), pubHex, "dev_1", now, seen); r != "replayed" {
		t.Fatalf("replay: got %q", r)
	}
}

func TestEnrolLink(t *testing.T) {
	pin := strings.Repeat("ab", 32)
	l, err := parseEnrolLink("mobhunter://enrol?server=https%3A%2F%2Fmdm.example.com%2Fapi&token=tok123&pin=" + pin)
	if err != nil || l.Server != "https://mdm.example.com/api" || l.Token != "tok123" || l.Pin != pin {
		t.Fatalf("parse: %+v %v", l, err)
	}
	for _, bad := range []string{
		"https://evil.example/enrol?token=x",
		"mobhunter://enrol?server=http%3A%2F%2Fmdm.example.com&token=t&pin=" + pin, // plain HTTP
		"mobhunter://enrol?server=https%3A%2F%2Fmdm.example.com&token=t&pin=short",
	} {
		if _, err := parseEnrolLink(bad); err == nil {
			t.Errorf("accepted %q", bad)
		}
	}
}

func TestPinOf(t *testing.T) {
	// SHA-256 of the raw key bytes, matching the server's fingerprint().
	if got := pinOf("00"); got != "6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d" {
		t.Fatalf("pin: %s", got)
	}
}

func TestConfigRoundTripAndSeen(t *testing.T) {
	dir := t.TempDir()
	c := &Config{Server: "https://x", DeviceID: "dev_1"}
	for i := 0; i < 1200; i++ {
		c.remember("id:" + string(rune('a'+i%26)))
	}
	if len(c.Seen) != 1000 {
		t.Fatalf("seen list not bounded: %d", len(c.Seen))
	}
	if err := saveConfig(dir, c); err != nil {
		t.Fatal(err)
	}
	got, err := loadConfig(dir)
	if err != nil || got.DeviceID != "dev_1" || !got.seen("id:a") {
		t.Fatalf("round trip: %+v %v", got, err)
	}
	if err := removeConfig(dir); err != nil {
		t.Fatal(err)
	}
	if got, _ := loadConfig(dir); got != nil {
		t.Fatal("config not removed")
	}
}
