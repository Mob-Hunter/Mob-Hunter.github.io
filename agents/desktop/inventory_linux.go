//go:build linux

package main

import (
	"bufio"
	"os"
	"strconv"
	"strings"
	"syscall"
	"time"
)

func osInventory(inv *Inventory) {
	inv.System.Manufacturer = readTrim("/sys/class/dmi/id/sys_vendor")
	inv.System.Model = firstNonEmpty(readTrim("/sys/class/dmi/id/product_name"), inv.System.Model)
	inv.System.Firmware = strings.TrimSpace(readTrim("/sys/class/dmi/id/bios_vendor") + " " + readTrim("/sys/class/dmi/id/bios_version") + " " + readTrim("/sys/class/dmi/id/bios_date"))
	inv.System.Chassis = chassisName(readTrim("/sys/class/dmi/id/chassis_type"))
	for _, line := range strings.Split(readTrim("/etc/os-release"), "\n") {
		if v, ok := strings.CutPrefix(line, "VERSION_ID="); ok {
			inv.OS.Version = strings.Trim(v, `"`)
		}
		if v, ok := strings.CutPrefix(line, "BUILD_ID="); ok {
			inv.OS.Build = strings.Trim(v, `"`)
		}
	}
	inv.OS.Kernel = readTrim("/proc/sys/kernel/osrelease")
	if up, err := strconv.ParseFloat(strings.Fields(readTrim("/proc/uptime") + " 0")[0], 64); err == nil && up > 0 {
		inv.OS.LastBoot = time.Now().Add(-time.Duration(up) * time.Second).UTC().Format(time.RFC3339)
	}
	if fi, err := os.Stat("/var/log/installer"); err == nil {
		inv.OS.InstallDate = fi.ModTime().UTC().Format("2006-01-02")
	} else if fi, err := os.Stat("/lost+found"); err == nil {
		inv.OS.InstallDate = fi.ModTime().UTC().Format("2006-01-02")
	}
	if tz, err := os.Readlink("/etc/localtime"); err == nil && strings.Contains(tz, "zoneinfo/") {
		inv.OS.Timezone = tz[strings.Index(tz, "zoneinfo/")+len("zoneinfo/"):]
	} else {
		inv.OS.Timezone = readTrim("/etc/timezone")
	}
	// CPU and memory
	cores := map[string]bool{}
	for _, line := range strings.Split(readTrim("/proc/cpuinfo"), "\n") {
		k, v, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		k, v = strings.TrimSpace(k), strings.TrimSpace(v)
		switch k {
		case "model name", "Model", "Hardware":
			if inv.Hardware.CPU == "" {
				inv.Hardware.CPU = v
			}
		case "core id":
			cores[v] = true
		}
	}
	if len(cores) > 0 {
		inv.Hardware.Cores = len(cores)
	}
	for _, line := range strings.Split(readTrim("/proc/meminfo"), "\n") {
		if f := strings.Fields(line); len(f) >= 2 && f[0] == "MemTotal:" {
			kb, _ := strconv.ParseFloat(f[1], 64)
			inv.Hardware.MemoryGB = gb(kb * 1024)
		}
	}
	if _, err := os.Stat("/sys/class/tpm/tpm0"); err == nil {
		inv.Hardware.TPM = "Present (" + firstNonEmpty(readTrim("/sys/class/tpm/tpm0/tpm_version_major"), "?") + ".x)"
	} else {
		inv.Hardware.TPM = "Not present"
	}
	inv.Disks = linuxDisks()
	inv.Software = linuxSoftware()

	// Configuration settings
	set(inv, "Accounts", "Administrators (sudo/wheel)", strings.Join(groupMembers("sudo", "wheel", "admin"), ", "))
	set(inv, "Remote access", "SSH server", serviceActive("ssh", "sshd"))
	set(inv, "Remote access", "Remote desktop (xrdp / VNC)", serviceActive("xrdp", "vncserver", "x11vnc"))
	set(inv, "Updates", "Automatic updates", firstNonEmpty(autoUpdatesLinux(), "Not configured"))
	set(inv, "Network", "Domain / realm", firstNonEmpty(realm(), "Not joined"))
	set(inv, "System", "SELinux", selinux())
	set(inv, "System", "AppArmor", firstNonEmpty(map[string]string{"Y": "Enabled", "N": "Disabled"}[readTrim("/sys/module/apparmor/parameters/enabled")], ""))
	set(inv, "System", "Init system", firstNonEmpty(readTrim("/proc/1/comm"), "unknown"))
	set(inv, "Time", "NTP synchronisation", ntpSync())
}

func firstNonEmpty(v ...string) string {
	for _, s := range v {
		if strings.TrimSpace(s) != "" {
			return strings.TrimSpace(s)
		}
	}
	return ""
}

func chassisName(code string) string {
	m := map[string]string{"3": "Desktop", "4": "Low-profile desktop", "6": "Mini tower", "7": "Tower", "8": "Portable", "9": "Laptop", "10": "Notebook", "13": "All-in-one", "14": "Sub-notebook", "17": "Server", "23": "Rack server", "30": "Tablet", "31": "Convertible", "32": "Detachable", "35": "Mini PC", "1": "Virtual / other"}
	return m[code]
}

var realFS = map[string]bool{"ext2": true, "ext3": true, "ext4": true, "xfs": true, "btrfs": true, "zfs": true, "vfat": true, "exfat": true, "ntfs": true, "ntfs3": true, "f2fs": true, "jfs": true, "reiserfs": true}

func linuxDisks() []Disk {
	f, err := os.Open("/proc/mounts")
	if err != nil {
		return nil
	}
	defer f.Close()
	crypt := ""
	if has("lsblk") {
		crypt, _ = run(10*time.Second, "lsblk", "-rno", "MOUNTPOINT,TYPE,PKNAME")
	}
	seen := map[string]bool{}
	var out []Disk
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		p := strings.Fields(sc.Text())
		if len(p) < 3 || !realFS[p[2]] || seen[p[0]] || strings.HasPrefix(p[1], "/snap/") || strings.HasPrefix(p[1], "/var/lib/docker") {
			continue
		}
		seen[p[0]] = true
		var st syscall.Statfs_t
		if syscall.Statfs(p[1], &st) != nil {
			continue
		}
		d := Disk{Mount: p[1], FS: p[2], SizeGB: gb(float64(st.Blocks) * float64(st.Bsize)), FreeGB: gb(float64(st.Bavail) * float64(st.Bsize))}
		if crypt != "" {
			enc := strings.HasPrefix(p[0], "/dev/mapper/") && strings.Contains(crypt, "crypt")
			d.Encrypted = &enc
		}
		out = append(out, d)
		if len(out) >= 32 {
			break
		}
	}
	return out
}

func linuxSoftware() []App {
	var out []App
	switch {
	case has("dpkg-query"):
		s, err := run(60*time.Second, "dpkg-query", "-W", "-f", "${db:Status-Abbrev}\t${Package}\t${Version}\t${Maintainer}\n")
		if err != nil {
			return nil
		}
		for _, l := range strings.Split(s, "\n") {
			f := strings.Split(l, "\t")
			if len(f) == 4 && strings.HasPrefix(f[0], "ii") {
				out = append(out, App{Name: f[1], Version: f[2], Publisher: trimEmail(f[3])})
			}
		}
	case has("rpm"):
		s, err := run(60*time.Second, "rpm", "-qa", "--qf", "%{NAME}\t%{VERSION}-%{RELEASE}\t%{VENDOR}\n")
		if err != nil {
			return nil
		}
		for _, l := range strings.Split(s, "\n") {
			if f := strings.Split(l, "\t"); len(f) == 3 {
				out = append(out, App{Name: f[0], Version: f[1], Publisher: strings.TrimSuffix(f[2], "(none)")})
			}
		}
	case has("pacman"):
		s, _ := run(60*time.Second, "pacman", "-Q")
		for _, l := range strings.Split(s, "\n") {
			if f := strings.Fields(l); len(f) == 2 {
				out = append(out, App{Name: f[0], Version: f[1]})
			}
		}
	}
	return out
}

func trimEmail(s string) string {
	if i := strings.Index(s, "<"); i > 0 {
		return strings.TrimSpace(s[:i])
	}
	return s
}

func groupMembers(groups ...string) []string {
	var out []string
	for _, line := range strings.Split(readTrim("/etc/group"), "\n") {
		f := strings.Split(line, ":")
		if len(f) == 4 {
			for _, g := range groups {
				if f[0] == g && f[3] != "" {
					out = append(out, strings.Split(f[3], ",")...)
				}
			}
		}
	}
	return out
}

func serviceActive(names ...string) string {
	if !has("systemctl") {
		return ""
	}
	for _, n := range names {
		if out, _ := run(5*time.Second, "systemctl", "is-active", n); out == "active" {
			return "Running (" + n + ")"
		}
	}
	return "Not running"
}

func autoUpdatesLinux() string {
	if b := readTrim("/etc/apt/apt.conf.d/20auto-upgrades"); strings.Contains(b, `Unattended-Upgrade "1"`) {
		return "On (unattended-upgrades)"
	}
	if out, _ := run(5*time.Second, "systemctl", "is-enabled", "dnf-automatic.timer"); out == "enabled" {
		return "On (dnf-automatic)"
	}
	return ""
}

func realm() string {
	if has("realm") {
		if out, err := run(10*time.Second, "realm", "list", "--name-only"); err == nil {
			return strings.TrimSpace(strings.Split(out, "\n")[0])
		}
	}
	return ""
}

func selinux() string {
	switch readTrim("/sys/fs/selinux/enforce") {
	case "1":
		return "Enforcing"
	case "0":
		return "Permissive"
	}
	return ""
}

func ntpSync() string {
	if !has("timedatectl") {
		return ""
	}
	out, _ := run(5*time.Second, "timedatectl", "show", "-p", "NTPSynchronized", "--value")
	return map[string]string{"yes": "Synchronised", "no": "Not synchronised"}[out]
}
