//go:build darwin

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"
)

type macSystem struct{ updates cached }

func newSystem() System { return &macSystem{} }

func defaultDir() string {
	if os.Geteuid() == 0 {
		return "/Library/Application Support/MobHunter"
	}
	d, _ := os.UserConfigDir()
	return filepath.Join(d, "MobHunter")
}

func (s *macSystem) Platform() string { return "macos" }
func (s *macSystem) Privileged() bool { return os.Geteuid() == 0 }

var serialRe = regexp.MustCompile(`"IOPlatformSerialNumber" = "([^"]+)"`)

func (s *macSystem) Hardware() Hardware {
	name, _ := run(5*time.Second, "sw_vers", "-productName")
	ver, _ := run(5*time.Second, "sw_vers", "-productVersion")
	model, _ := run(5*time.Second, "sysctl", "-n", "hw.model")
	serial := "unknown"
	if out, err := run(10*time.Second, "ioreg", "-rd1", "-c", "IOPlatformExpertDevice"); err == nil {
		if m := serialRe.FindStringSubmatch(out); m != nil {
			serial = m[1]
		}
	}
	if model == "" {
		model = "Mac"
	}
	return Hardware{Serial: serial, Model: "Apple " + model, OS: strings.TrimSpace(name + " " + ver)}
}

var pctRe = regexp.MustCompile(`(\d+)%`)

func (s *macSystem) Telemetry() Telemetry {
	t := Telemetry{BatteryHealth: "good", Integrity: "NOT_EVALUATED", BatteryLevel: 100, NoBattery: true}
	var st syscall.Statfs_t
	if syscall.Statfs("/", &st) == nil {
		t.StorageFreeGb = gb(float64(st.Bavail) * float64(st.Bsize))
		t.StorageTotalGb = gb(float64(st.Blocks) * float64(st.Bsize))
	}
	if out, err := run(5*time.Second, "pmset", "-g", "batt"); err == nil && strings.Contains(out, "InternalBattery") {
		if m := pctRe.FindStringSubmatch(out); m != nil {
			t.BatteryLevel, _ = strconv.Atoi(m[1])
			t.NoBattery = false
		}
	}
	sec := Posture{}
	if out, err := run(10*time.Second, "fdesetup", "status"); err == nil {
		sec.Encrypted = boolp(strings.Contains(out, "FileVault is On"))
	}
	if out, err := run(10*time.Second, "/usr/libexec/ApplicationFirewall/socketfilterfw", "--getglobalstate"); err == nil {
		sec.Firewall = boolp(strings.Contains(strings.ToLower(out), "enabled"))
	}
	if out, err := run(10*time.Second, "csrutil", "status"); err == nil {
		// System Integrity Protection off means the OS can be modified underneath every protection.
		sec.Compromised = boolp(strings.Contains(out, "disabled"))
	}
	sec.PendingUpdates = s.updates.get(6*time.Hour, func() *int {
		out, err := run(5*time.Minute, "softwareupdate", "-l")
		if err != nil && !strings.Contains(out, "No new software") {
			return nil
		}
		return intp(strings.Count(out, "* Label:"))
	})
	t.Security = sec
	return t
}

func consoleUID() string {
	if fi, err := os.Stat("/dev/console"); err == nil {
		if st, ok := fi.Sys().(*syscall.Stat_t); ok && st.Uid != 0 {
			return strconv.Itoa(int(st.Uid))
		}
	}
	return ""
}

func (s *macSystem) Notify(title, text string) error {
	esc := func(x string) string { return strings.ReplaceAll(strings.ReplaceAll(x, `\`, `\\`), `"`, `\"`) }
	script := `display notification "` + esc(singleLine(text, 300)) + `" with title "Mob Hunter" subtitle "` + esc(singleLine(title, 80)) + `"`
	var err error
	if uid := consoleUID(); os.Geteuid() == 0 && uid != "" {
		_, err = run(15*time.Second, "launchctl", "asuser", uid, "osascript", "-e", script)
	} else {
		_, err = run(15*time.Second, "osascript", "-e", script)
	}
	return err
}

func (s *macSystem) Lock() error {
	_, err := run(10*time.Second, "pmset", "displaysleepnow")
	return err
}

func (s *macSystem) Reboot(message string) error {
	_, err := run(15*time.Second, "shutdown", "-r", "+1", singleLine(message, 120))
	return err
}

const plistPath = "/Library/LaunchDaemons/com.mobhunter.agent.plist"
const macExe = "/usr/local/bin/mob-hunter-agent"

func (s *macSystem) InstallService(exe string) error {
	if !s.Privileged() {
		return fmt.Errorf("run with sudo to install the service")
	}
	if exe != macExe {
		b, err := os.ReadFile(exe)
		if err != nil {
			return err
		}
		_ = os.MkdirAll(filepath.Dir(macExe), 0o755)
		if err := os.WriteFile(macExe, b, 0o755); err != nil {
			return err
		}
	}
	plist := `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.mobhunter.agent</string>
<key>ProgramArguments</key><array><string>` + macExe + `</string><string>run</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
</dict></plist>
`
	if err := os.WriteFile(plistPath, []byte(plist), 0o644); err != nil {
		return err
	}
	if out, err := run(30*time.Second, "launchctl", "load", "-w", plistPath); err != nil {
		return fmt.Errorf("launchctl: %v %s", err, out)
	}
	return nil
}

func (s *macSystem) RemoveService() error {
	if !s.Privileged() {
		return nil
	}
	_ = os.Remove(macExe)
	if _, err := os.Stat(plistPath); err == nil {
		_, _ = run(30*time.Second, "launchctl", "unload", "-w", plistPath)
		_ = os.Remove(plistPath)
	}
	return nil
}

func serviceStatus() string {
	if _, err := run(10e9, "launchctl", "print", "system/com.mobhunter.agent"); err != nil {
		return "launch daemon not loaded"
	}
	return "launch daemon com.mobhunter.agent is loaded"
}
