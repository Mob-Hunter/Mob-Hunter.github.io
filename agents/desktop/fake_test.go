package main

import "sync"

// fakeSystem records what the agent asked the OS to do.
type fakeSystem struct {
	mu            sync.Mutex
	platform      string
	privileged    bool
	posture       Posture
	notifications []string
	locked        int
	rebooted      int
	serviceGone   bool
}

func (f *fakeSystem) Platform() string { return f.platform }
func (f *fakeSystem) Privileged() bool { return f.privileged }
func (f *fakeSystem) Hardware() Hardware {
	return Hardware{Serial: "GO-TEST-1", Model: "Interop Laptop", OS: "Ubuntu 24.04.3 LTS"}
}
func (f *fakeSystem) Telemetry() Telemetry {
	return Telemetry{BatteryLevel: 80, BatteryHealth: "good", StorageFreeGb: 120, StorageTotalGb: 512, Integrity: "NOT_EVALUATED", PatchLevel: "2026-11-01", Security: f.posture}
}
func (f *fakeSystem) Notify(title, text string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.notifications = append(f.notifications, title+": "+text)
	return nil
}
func (f *fakeSystem) Lock() error                 { f.locked++; return nil }
func (f *fakeSystem) Reboot(string) error         { f.rebooted++; return nil }
func (f *fakeSystem) InstallService(string) error { return nil }
func (f *fakeSystem) RemoveService() error        { f.serviceGone = true; return nil }
