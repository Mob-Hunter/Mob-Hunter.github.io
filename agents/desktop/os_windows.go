//go:build windows

package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type windowsSystem struct{ updates cached }

func newSystem() System { return &windowsSystem{} }

func defaultDir() string {
	if isAdmin() {
		return filepath.Join(os.Getenv("ProgramData"), "MobHunter")
	}
	d, _ := os.UserConfigDir()
	return filepath.Join(d, "MobHunter")
}

func isAdmin() bool {
	_, err := run(10*time.Second, "net", "session")
	return err == nil
}

func (s *windowsSystem) Platform() string { return "windows" }
func (s *windowsSystem) Privileged() bool { return isAdmin() }

func ps(timeout time.Duration, script string) (string, error) {
	return run(timeout, "powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script)
}

// One PowerShell call reads inventory and security posture as JSON (settings only, never content).
const probe = `$ErrorActionPreference='SilentlyContinue'; $o=@{}
$cs=Get-CimInstance Win32_ComputerSystem; $b=Get-CimInstance Win32_BIOS; $os=Get-CimInstance Win32_OperatingSystem
$o.model=("$($cs.Manufacturer) $($cs.Model)").Trim(); $o.serial="$($b.SerialNumber)".Trim(); $o.os="$($os.Caption) $($os.Version)"
$d=Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$($env:SystemDrive)'"; $o.free=[double]$d.FreeSpace; $o.size=[double]$d.Size
$bat=Get-CimInstance Win32_Battery | Select-Object -First 1; if($bat){$o.battery=[int]$bat.EstimatedChargeRemaining}
try{$o.bitlocker=((Get-BitLockerVolume -MountPoint $env:SystemDrive -ErrorAction Stop).ProtectionStatus -eq 'On')}catch{}
try{$o.firewall=(@(Get-NetFirewallProfile -ErrorAction Stop | Where-Object {-not $_.Enabled}).Count -eq 0)}catch{}
try{$m=Get-MpComputerStatus -ErrorAction Stop; $o.av=[bool]$m.RealTimeProtectionEnabled}catch{}
try{$o.secureBoot=[bool](Confirm-SecureBootUEFI -ErrorAction Stop)}catch{}
try{$h=Get-HotFix | Where-Object {$_.InstalledOn} | Sort-Object InstalledOn | Select-Object -Last 1; if($h){$o.lastUpdate=$h.InstalledOn.ToString('yyyy-MM-dd')}}catch{}
$o | ConvertTo-Json -Compress`

type winProbe struct {
	Model      string  `json:"model"`
	Serial     string  `json:"serial"`
	OS         string  `json:"os"`
	Free       float64 `json:"free"`
	Size       float64 `json:"size"`
	Battery    *int    `json:"battery"`
	BitLocker  *bool   `json:"bitlocker"`
	Firewall   *bool   `json:"firewall"`
	AV         *bool   `json:"av"`
	SecureBoot *bool   `json:"secureBoot"`
	LastUpdate string  `json:"lastUpdate"`
}

func (s *windowsSystem) probe() winProbe {
	var p winProbe
	if out, err := ps(90*time.Second, probe); err == nil {
		_ = json.Unmarshal([]byte(out[strings.Index(out, "{"):]), &p)
	}
	return p
}

func (s *windowsSystem) Hardware() Hardware {
	p := s.probe()
	if p.Serial == "" {
		p.Serial = "unknown"
	}
	if p.Model == "" {
		p.Model = "Windows PC"
	}
	if p.OS == "" {
		p.OS = "Windows"
	}
	return Hardware{Serial: p.Serial, Model: p.Model, OS: p.OS}
}

func (s *windowsSystem) Telemetry() Telemetry {
	p := s.probe()
	t := Telemetry{BatteryHealth: "good", Integrity: "NOT_EVALUATED", StorageFreeGb: gb(p.Free), StorageTotalGb: gb(p.Size), PatchLevel: p.LastUpdate, BatteryLevel: 100, NoBattery: true}
	if p.Battery != nil {
		t.BatteryLevel, t.NoBattery = *p.Battery, false
	}
	t.Security = Posture{Encrypted: p.BitLocker, Firewall: p.Firewall, Antivirus: p.AV, SecureBoot: p.SecureBoot}
	t.Security.PendingUpdates = s.updates.get(6*time.Hour, func() *int {
		out, err := ps(5*time.Minute, `(New-Object -ComObject Microsoft.Update.Session).CreateUpdateSearcher().Search("IsInstalled=0 and IsHidden=0 and Type='Software'").Updates.Count`)
		if n, e := strconv.Atoi(strings.TrimSpace(out)); err == nil && e == nil {
			return intp(n)
		}
		return nil
	})
	return t
}

// Notify uses msg.exe, which reaches every signed-in session even from the SYSTEM service.
func (s *windowsSystem) Notify(title, text string) error {
	m := singleLine(title, 80) + "\r\n\r\n" + singleLine(text, 300) + "\r\n\r\n— Mob Hunter (your IT team)"
	if out, err := run(15*time.Second, "msg.exe", "*", "/TIME:3600", m); err != nil {
		return fmt.Errorf("msg.exe: %v %s", err, out)
	}
	return nil
}

// Lock disconnects the active console session, which returns it to the lock screen.
func (s *windowsSystem) Lock() error {
	if !isAdmin() {
		_, err := run(10*time.Second, "rundll32.exe", "user32.dll,LockWorkStation")
		return err
	}
	out, _ := run(10*time.Second, "query", "session")
	for _, line := range strings.Split(out, "\n") {
		f := strings.Fields(strings.TrimLeft(line, ">"))
		for i := 1; i < len(f); i++ {
			if strings.EqualFold(f[i], "Active") {
				if _, err := strconv.Atoi(f[i-1]); err == nil {
					if o, err := run(10*time.Second, "tsdiscon.exe", f[i-1]); err != nil {
						return fmt.Errorf("tsdiscon: %v %s", err, o)
					}
					return nil
				}
			}
		}
	}
	return fmt.Errorf("no signed-in session to lock")
}

func (s *windowsSystem) Reboot(message string) error {
	_, err := run(15*time.Second, "shutdown.exe", "/r", "/t", "60", "/c", singleLine(message, 200))
	return err
}
