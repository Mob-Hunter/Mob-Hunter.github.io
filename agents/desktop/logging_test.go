package main

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func TestLogRotationAndTail(t *testing.T) {
	dir := t.TempDir()
	l, c := newLogger(dir, false, nil)
	line := strings.Repeat("x", 1000)
	for i := 0; i < 2500; i++ { // ~2.5 MB → at least two rotations
		l.Printf("%04d %s", i, line)
	}
	c.Close()
	for _, f := range []string{"agent.log", "agent.log.1", "agent.log.2"} {
		st, err := os.Stat(logDir(dir) + "/" + f)
		if err != nil {
			t.Fatalf("%s missing: %v", f, err)
		}
		if st.Size() > logMaxBytes+2000 {
			t.Fatalf("%s too big: %d", f, st.Size())
		}
	}
	if _, err := os.Stat(logDir(dir) + "/agent.log.4"); err == nil {
		t.Fatal("kept more than logKeep rotated files")
	}
	tail, err := tailLog(dir, 5)
	if err != nil || len(tail) != 5 || !strings.Contains(tail[4], "2499 ") {
		t.Fatalf("tail: %v %v", len(tail), err)
	}
	if levelOf("command poll failed: timeout") != "warning" || levelOf("checked in") != "info" {
		t.Fatal("event log levels")
	}
}

type staticSource struct{}

func (staticSource) Hardware() Hardware {
	return Hardware{Serial: "S1", Model: "Test PC", OS: "TestOS 1"}
}
func (staticSource) Telemetry() Telemetry {
	return Telemetry{PatchLevel: "2026-11-01", Security: Posture{Encrypted: boolp(true), Firewall: boolp(false), PendingUpdates: intp(2)}}
}

func TestInventoryFromThisMachine(t *testing.T) {
	inv := collectInventory(staticSource{})
	if inv.System.Hostname == "" || inv.OS.Arch == "" || inv.Hardware.Threads == 0 || inv.AgentVersion != Version {
		t.Fatalf("basic fields missing: %+v", inv)
	}
	want := map[string]string{"Disk encryption": "On", "Firewall": "Off", "Updates waiting": "2", "Last update installed": "2026-11-01"}
	for _, s := range inv.Settings {
		if v, ok := want[s.Name]; ok && v == s.Value {
			delete(want, s.Name)
		}
	}
	if len(want) != 0 {
		t.Fatalf("posture settings missing: %v", want)
	}
	for _, n := range inv.Network {
		if virtualNIC(n.Name) {
			t.Fatalf("virtual adapter reported: %s", n.Name)
		}
	}
	b, _ := json.Marshal(inv)
	if len(b) > 900_000 {
		t.Fatalf("inventory too large for the server: %d bytes", len(b))
	}
	if len(inv.Software) > maxSoftware {
		t.Fatal("software list not capped")
	}
}
