//go:build darwin

package main

import (
	"encoding/json"
	"strconv"
	"strings"
	"syscall"
	"time"
)

func osInventory(inv *Inventory) {
	inv.System.Manufacturer = "Apple"
	if out, err := run(60*time.Second, "system_profiler", "-json", "SPHardwareDataType"); err == nil {
		var hw struct {
			SPHardwareDataType []map[string]any `json:"SPHardwareDataType"`
		}
		if json.Unmarshal([]byte(out), &hw) == nil && len(hw.SPHardwareDataType) > 0 {
			h := hw.SPHardwareDataType[0]
			g := func(k string) string { s, _ := h[k].(string); return s }
			inv.System.Model = strings.TrimSpace(g("machine_name") + " (" + g("machine_model") + ")")
			inv.System.Serial = firstNonEmpty(g("serial_number"), inv.System.Serial)
			inv.System.Firmware = g("boot_rom_version")
			inv.Hardware.CPU = firstNonEmpty(g("chip_type"), g("cpu_type"))
			if n, _ := strconv.Atoi(strings.Fields(g("number_processors") + " 0")[0]); n > 0 {
				inv.Hardware.Cores = n
			}
		}
	}
	if m, _ := run(5*time.Second, "sysctl", "-n", "hw.memsize"); m != "" {
		v, _ := strconv.ParseFloat(m, 64)
		inv.Hardware.MemoryGB = gb(v)
	}
	inv.OS.Version, _ = run(5*time.Second, "sw_vers", "-productVersion")
	inv.OS.Build, _ = run(5*time.Second, "sw_vers", "-buildVersion")
	inv.OS.Kernel, _ = run(5*time.Second, "uname", "-r")
	if b, _ := run(5*time.Second, "sysctl", "-n", "kern.boottime"); b != "" {
		if i := strings.Index(b, "sec = "); i >= 0 {
			if sec, err := strconv.ParseInt(strings.Trim(strings.Fields(b[i+6:])[0], ","), 10, 64); err == nil {
				inv.OS.LastBoot = time.Unix(sec, 0).UTC().Format(time.RFC3339)
			}
		}
	}
	if tz, _ := run(5*time.Second, "readlink", "/etc/localtime"); strings.Contains(tz, "zoneinfo/") {
		inv.OS.Timezone = tz[strings.Index(tz, "zoneinfo/")+len("zoneinfo/"):]
	}
	inv.Hardware.TPM = "Apple Secure Enclave"
	var st syscall.Statfs_t
	if syscall.Statfs("/", &st) == nil {
		fv, _ := run(10*time.Second, "fdesetup", "status")
		enc := strings.Contains(fv, "FileVault is On")
		inv.Disks = []Disk{{Mount: "/", FS: "apfs", SizeGB: gb(float64(st.Blocks) * float64(st.Bsize)), FreeGB: gb(float64(st.Bavail) * float64(st.Bsize)), Encrypted: &enc}}
	}
	if out, err := run(2*time.Minute, "system_profiler", "-json", "-detailLevel", "mini", "SPApplicationsDataType"); err == nil {
		var apps struct {
			Apps []map[string]any `json:"SPApplicationsDataType"`
		}
		if json.Unmarshal([]byte(out), &apps) == nil {
			for _, a := range apps.Apps {
				name, _ := a["_name"].(string)
				ver, _ := a["version"].(string)
				pub, _ := a["obtained_from"].(string)
				if name != "" {
					inv.Software = append(inv.Software, App{Name: name, Version: ver, Publisher: pub})
				}
			}
		}
	}
	gk, _ := run(5*time.Second, "spctl", "--status")
	set(inv, "Security", "Gatekeeper", map[bool]string{true: "On", false: "Off"}[strings.Contains(gk, "enabled")])
	sip, _ := run(5*time.Second, "csrutil", "status")
	set(inv, "Security", "System Integrity Protection", map[bool]string{true: "On", false: "Off"}[strings.Contains(sip, "enabled")])
	stealth, _ := run(5*time.Second, "/usr/libexec/ApplicationFirewall/socketfilterfw", "--getstealthmode")
	set(inv, "Security", "Firewall stealth mode", map[bool]string{true: "On", false: "Off"}[strings.Contains(strings.ToLower(stealth), "enabled")])
	au, _ := run(5*time.Second, "defaults", "read", "/Library/Preferences/com.apple.SoftwareUpdate", "AutomaticallyInstallMacOSUpdates")
	set(inv, "Updates", "Install macOS updates automatically", map[string]string{"1": "On", "0": "Off"}[au])
	ssh, _ := run(5*time.Second, "systemsetup", "-getremotelogin")
	set(inv, "Remote access", "Remote Login (SSH)", strings.TrimPrefix(ssh, "Remote Login: "))
	admins, _ := run(5*time.Second, "dscl", ".", "-read", "/Groups/admin", "GroupMembership")
	set(inv, "Accounts", "Administrators", strings.Join(strings.Fields(strings.TrimPrefix(admins, "GroupMembership:")), ", "))
	auto, _ := run(5*time.Second, "defaults", "read", "/Library/Preferences/com.apple.loginwindow", "autoLoginUser")
	set(inv, "Accounts", "Automatic login", firstNonEmpty(map[bool]string{true: "On (" + auto + ")"}[auto != ""], "Off"))
	set(inv, "Network", "Directory binding", firstNonEmpty(func() string { o, _ := run(10*time.Second, "dsconfigad", "-show"); return singleLine(o, 160) }(), "Not bound"))
}

func firstNonEmpty(v ...string) string {
	for _, s := range v {
		if strings.TrimSpace(s) != "" {
			return strings.TrimSpace(s)
		}
	}
	return ""
}
