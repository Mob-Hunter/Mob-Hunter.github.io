//go:build windows

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/eventlog"
	"golang.org/x/sys/windows/svc/mgr"
)

const (
	serviceName    = "MobHunterAgent"
	serviceDisplay = "Mob Hunter Agent"
	serviceDesc    = "Mob Hunter device management agent: reports device health and security settings to your organisation and runs signed commands (message, lock, restart). It cannot read files, the screen, messages or browsing."
	legacyTask     = "MobHunterAgent" // 1.0–1.1 ran as a scheduled task
)

func installDir() string   { return filepath.Join(os.Getenv("ProgramFiles"), "MobHunter") }
func installedExe() string { return filepath.Join(installDir(), "mob-hunter-agent.exe") }

// InstallService copies the agent to Program Files and registers it as an automatic (delayed-start)
// Windows service running as LocalSystem, restarted by the Service Control Manager if it stops
// unexpectedly, with an Event Log source "MobHunterAgent".
func (s *windowsSystem) InstallService(exe string) error {
	if !isAdmin() {
		return fmt.Errorf("run from an elevated (administrator) PowerShell to install the service")
	}
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("service manager: %w", err)
	}
	defer m.Disconnect()

	// Upgrade path: stop an existing service (or the 1.x scheduled task) before replacing the binary.
	if old, err := m.OpenService(serviceName); err == nil {
		stopService(old)
		_ = old.Delete()
		old.Close()
		waitDeleted(m)
	}
	_, _ = run(30*time.Second, "schtasks.exe", "/Delete", "/F", "/TN", legacyTask)

	dst := installedExe()
	if !strings.EqualFold(filepath.Clean(exe), dst) {
		if err := os.MkdirAll(installDir(), 0o755); err != nil {
			return err
		}
		b, err := os.ReadFile(exe)
		if err != nil {
			return err
		}
		if err := os.WriteFile(dst, b, 0o755); err != nil {
			return err
		}
	}
	// Only SYSTEM and Administrators may read the agent's key and logs.
	dir := defaultDir()
	_ = os.MkdirAll(dir, 0o700)
	_, _ = run(30*time.Second, "icacls", dir, "/inheritance:r", "/grant:r", "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F")

	sv, err := m.CreateService(serviceName, dst, mgr.Config{
		DisplayName:      serviceDisplay,
		Description:      serviceDesc,
		StartType:        mgr.StartAutomatic,
		DelayedAutoStart: true,
		ErrorControl:     mgr.ErrorNormal,
	}, "run")
	if err != nil {
		return fmt.Errorf("create service: %w", err)
	}
	defer sv.Close()
	// Restart after 30 s, 60 s, then every 5 minutes; reset the failure count after a day.
	_ = sv.SetRecoveryActions([]mgr.RecoveryAction{
		{Type: mgr.ServiceRestart, Delay: 30 * time.Second},
		{Type: mgr.ServiceRestart, Delay: 60 * time.Second},
		{Type: mgr.ServiceRestart, Delay: 5 * time.Minute},
	}, 86400)
	_ = eventlog.Remove(serviceName)
	if err := eventlog.InstallAsEventCreate(serviceName, eventlog.Error|eventlog.Warning|eventlog.Info); err != nil {
		return fmt.Errorf("event log source: %w", err)
	}
	if err := sv.Start(); err != nil {
		return fmt.Errorf("start service: %w", err)
	}
	return nil
}

func stopService(s *mgr.Service) {
	if st, err := s.Query(); err == nil && st.State != svc.Stopped {
		_, _ = s.Control(svc.Stop)
		for i := 0; i < 30; i++ {
			if st, err := s.Query(); err != nil || st.State == svc.Stopped {
				return
			}
			time.Sleep(500 * time.Millisecond)
		}
	}
}

func waitDeleted(m *mgr.Mgr) {
	for i := 0; i < 20; i++ {
		s, err := m.OpenService(serviceName)
		if err != nil {
			return
		}
		s.Close()
		time.Sleep(500 * time.Millisecond)
	}
}

// RemoveService unregisters the service and Event Log source and removes the program folder once
// this process has exited (a running .exe cannot delete itself).
func (s *windowsSystem) RemoveService() error {
	if !isAdmin() {
		return nil
	}
	_, _ = run(30*time.Second, "schtasks.exe", "/Delete", "/F", "/TN", legacyTask)
	_ = eventlog.Remove(serviceName)
	_, _ = run(10*time.Second, "cmd.exe", "/C", "start", "", "/MIN", "cmd.exe", "/C", "ping -n 6 127.0.0.1 >nul & rmdir /S /Q \""+installDir()+"\"")
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()
	sv, err := m.OpenService(serviceName)
	if err != nil {
		return nil
	}
	defer sv.Close()
	_ = sv.Delete() // marked for deletion; completes when the service stops
	go func() { time.Sleep(time.Second); _, _ = sv.Control(svc.Stop) }()
	return nil
}

// eventWriter sends each log line to the Windows Event Log (Application, source MobHunterAgent).
type eventWriter struct{ l *eventlog.Log }

func (w eventWriter) Write(p []byte) (int, error) {
	line := strings.TrimSpace(string(p))
	if levelOf(line) == "warning" {
		_ = w.l.Warning(2, line)
	} else {
		_ = w.l.Info(1, line)
	}
	return len(p), nil
}

// runService runs the agent under the Service Control Manager when started as a service, else in the foreground.
func runService(a *Agent, foreground func(stop <-chan struct{})) error {
	isSvc, err := svc.IsWindowsService()
	if err != nil || !isSvc {
		return runForeground(foreground)
	}
	if el, err := eventlog.Open(serviceName); err == nil {
		defer el.Close()
		l, c := newLogger(a.Dir, false, eventWriter{el})
		defer c.Close()
		a.Log = l
	}
	return svc.Run(serviceName, &handler{a: a, loop: foreground})
}

type handler struct {
	a    *Agent
	loop func(stop <-chan struct{})
}

func (h *handler) Execute(_ []string, req <-chan svc.ChangeRequest, status chan<- svc.Status) (bool, uint32) {
	status <- svc.Status{State: svc.StartPending}
	stop := make(chan struct{})
	done := make(chan struct{})
	go func() { h.loop(stop); close(done) }()
	status <- svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}
	h.a.logf("service started (agent %s)", Version)
	for {
		select {
		case <-done: // released (RELEASE / uninstall): nothing left to manage
			status <- svc.Status{State: svc.StopPending}
			return false, 0
		case c := <-req:
			switch c.Cmd {
			case svc.Interrogate:
				status <- c.CurrentStatus
			case svc.Stop, svc.Shutdown:
				h.a.logf("service stopping")
				status <- svc.Status{State: svc.StopPending}
				close(stop)
				select {
				case <-done:
				case <-time.After(20 * time.Second):
				}
				return false, 0
			}
		}
	}
}

// serviceStatus describes the installed service for `mob-hunter-agent status`.
func serviceStatus() string {
	m, err := mgr.Connect()
	if err != nil {
		return "service manager unavailable (run as administrator)"
	}
	defer m.Disconnect()
	s, err := m.OpenService(serviceName)
	if err != nil {
		return "service not installed"
	}
	defer s.Close()
	st, err := s.Query()
	if err != nil {
		return "service installed (state unknown)"
	}
	names := map[svc.State]string{svc.Stopped: "stopped", svc.StartPending: "starting", svc.StopPending: "stopping", svc.Running: "running", svc.Paused: "paused"}
	return fmt.Sprintf("service %s is %s", serviceName, names[st.State])
}
