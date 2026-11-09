//go:build linux

package main

import (
	"fmt"
	"os"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

type linuxSystem struct{ updates cached }

func newSystem() System { return &linuxSystem{} }

func defaultDir() string {
	if os.Geteuid() == 0 {
		return "/var/lib/mob-hunter"
	}
	d, _ := os.UserConfigDir()
	return filepath.Join(d, "mob-hunter")
}

func (s *linuxSystem) Platform() string { return "linux" }
func (s *linuxSystem) Privileged() bool { return os.Geteuid() == 0 }

func (s *linuxSystem) Hardware() Hardware {
	osName := "Linux"
	for _, line := range strings.Split(readTrim("/etc/os-release"), "\n") {
		if v, ok := strings.CutPrefix(line, "PRETTY_NAME="); ok {
			osName = strings.Trim(v, `"`)
		}
	}
	model := strings.TrimSpace(readTrim("/sys/class/dmi/id/sys_vendor") + " " + readTrim("/sys/class/dmi/id/product_name"))
	if model == "" {
		model = "Linux computer"
	}
	serial := readTrim("/sys/class/dmi/id/product_serial") // root only
	if serial == "" || strings.EqualFold(serial, "To be filled by O.E.M.") {
		if id := readTrim("/etc/machine-id"); len(id) >= 12 {
			serial = "MID-" + strings.ToUpper(id[:12])
		} else {
			serial = "unknown"
		}
	}
	return Hardware{Serial: serial, Model: model, OS: osName}
}

func (s *linuxSystem) Telemetry() Telemetry {
	t := Telemetry{BatteryHealth: "good", Integrity: "NOT_EVALUATED", NoBattery: true, BatteryLevel: 100}
	var st syscall.Statfs_t
	if syscall.Statfs("/", &st) == nil {
		t.StorageFreeGb = gb(float64(st.Bavail) * float64(st.Bsize))
		t.StorageTotalGb = gb(float64(st.Blocks) * float64(st.Bsize))
	}
	if bats, _ := filepath.Glob("/sys/class/power_supply/BAT*"); len(bats) > 0 {
		if n, err := strconv.Atoi(readTrim(filepath.Join(bats[0], "capacity"))); err == nil {
			t.BatteryLevel, t.NoBattery = n, false
			full, _ := strconv.ParseFloat(readTrim(filepath.Join(bats[0], "energy_full")), 64)
			design, _ := strconv.ParseFloat(readTrim(filepath.Join(bats[0], "energy_full_design")), 64)
			if design > 0 {
				t.BatteryHealth = healthOf(full / design)
			}
		}
	}
	// "Patch level" on a computer = the date packages were last updated.
	var last time.Time
	for _, p := range []string{"/var/lib/dpkg/status", "/var/lib/rpm/rpmdb.sqlite", "/var/lib/rpm/Packages", "/var/lib/pacman/local", "/var/log/dnf.rpm.log"} {
		if fi, err := os.Stat(p); err == nil && fi.ModTime().After(last) {
			last = fi.ModTime()
		}
	}
	if !last.IsZero() {
		t.PatchLevel = last.UTC().Format("2006-01-02")
	}
	sec := Posture{}
	if has("lsblk") {
		if out, err := run(10*time.Second, "lsblk", "-rno", "TYPE"); err == nil {
			sec.Encrypted = boolp(strings.Contains(out, "crypt"))
		}
	}
	sec.Firewall = linuxFirewall()
	if b, err := os.ReadFile("/sys/firmware/efi/efivars/SecureBoot-8be4df61-93ca-11d2-aa0d-00e098032b8c"); err == nil && len(b) > 0 {
		sec.SecureBoot = boolp(b[len(b)-1] == 1)
	}
	sec.PendingUpdates = s.updates.get(6*time.Hour, linuxPendingUpdates)
	t.Security = sec
	return t
}

func linuxFirewall() *bool {
	known := false
	if has("ufw") {
		known = true
		if out, err := run(10*time.Second, "ufw", "status"); err == nil && strings.Contains(out, "Status: active") {
			return boolp(true)
		}
	}
	if has("systemctl") {
		for _, svc := range []string{"firewalld", "nftables", "iptables", "ufw"} {
			if out, _ := run(5*time.Second, "systemctl", "is-active", svc); out == "active" {
				return boolp(true)
			}
		}
		known = true
	}
	if !known || os.Geteuid() != 0 {
		return nil // cannot tell without root
	}
	return boolp(false)
}

func linuxPendingUpdates() *int {
	switch {
	case has("apt-get"):
		out, err := run(2*time.Minute, "apt-get", "-s", "-o", "Debug::NoLocking=true", "upgrade")
		if err != nil {
			return nil
		}
		n := 0
		for _, l := range strings.Split(out, "\n") {
			if strings.HasPrefix(l, "Inst ") {
				n++
			}
		}
		return intp(n)
	case has("dnf"):
		out, _ := run(3*time.Minute, "dnf", "-q", "--cacheonly", "check-update")
		n := 0
		for _, l := range strings.Split(out, "\n") {
			if f := strings.Fields(l); len(f) == 3 && strings.Contains(f[0], ".") {
				n++
			}
		}
		return intp(n)
	}
	return nil
}

// Notify shows a desktop notification in every graphical session, plus a terminal broadcast.
func (s *linuxSystem) Notify(title, text string) error {
	title, text = singleLine(title, 80), singleLine(text, 300)
	shown := false
	if os.Geteuid() == 0 {
		dirs, _ := filepath.Glob("/run/user/*")
		for _, d := range dirs {
			uid := filepath.Base(d)
			u, err := user.LookupId(uid)
			if err != nil || uid == "0" || !has("notify-send") || !has("runuser") {
				continue
			}
			if _, err := run(10*time.Second, "runuser", "-u", u.Username, "--", "env", "DBUS_SESSION_BUS_ADDRESS=unix:path="+d+"/bus", "notify-send", "-u", "critical", "-a", "Mob Hunter", title, text); err == nil {
				shown = true
			}
		}
		if has("wall") {
			if _, err := run(10*time.Second, "wall", "Mob Hunter: "+title+" — "+text); err == nil {
				shown = true
			}
		}
	} else if has("notify-send") {
		if _, err := run(10*time.Second, "notify-send", "-u", "critical", "-a", "Mob Hunter", title, text); err == nil {
			shown = true
		}
	}
	if !shown {
		return fmt.Errorf("no session to show the message in")
	}
	return nil
}

func (s *linuxSystem) Lock() error {
	if out, err := run(15*time.Second, "loginctl", "lock-sessions"); err != nil {
		return fmt.Errorf("loginctl lock-sessions: %v %s", err, out)
	}
	return nil
}

func (s *linuxSystem) Reboot(message string) error {
	_, err := run(15*time.Second, "shutdown", "-r", "+1", singleLine(message, 120))
	return err
}

const unitPath = "/etc/systemd/system/mob-hunter-agent.service"
const installedExe = "/usr/local/bin/mob-hunter-agent"

func (s *linuxSystem) InstallService(exe string) error {
	if !s.Privileged() {
		return fmt.Errorf("run as root to install the service")
	}
	if exe != installedExe {
		b, err := os.ReadFile(exe)
		if err != nil {
			return err
		}
		if err := os.WriteFile(installedExe, b, 0o755); err != nil {
			return err
		}
	}
	unit := "[Unit]\nDescription=Mob Hunter device management agent\nAfter=network-online.target\nWants=network-online.target\n\n" +
		"[Service]\nExecStart=" + installedExe + " run\nRestart=always\nRestartSec=30\n\n[Install]\nWantedBy=multi-user.target\n"
	if err := os.WriteFile(unitPath, []byte(unit), 0o644); err != nil {
		return err
	}
	if out, err := run(30*time.Second, "systemctl", "daemon-reload"); err != nil {
		return fmt.Errorf("%v %s", err, out)
	}
	if out, err := run(30*time.Second, "systemctl", "enable", "--now", "mob-hunter-agent"); err != nil {
		return fmt.Errorf("%v %s", err, out)
	}
	return nil
}

func (s *linuxSystem) RemoveService() error {
	if !s.Privileged() {
		return nil
	}
	_ = os.Remove(installedExe)
	if _, err := os.Stat(unitPath); err == nil {
		_ = os.Remove(unitPath)
		_, _ = run(30*time.Second, "systemctl", "daemon-reload")
		// Last: this stops the running service, which may be this process.
		_, _ = run(30*time.Second, "systemctl", "disable", "--now", "mob-hunter-agent")
	}
	return nil
}
