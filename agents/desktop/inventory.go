package main

import (
	"net"
	"os"
	"runtime"
	"sort"
	"strings"
	"time"
)

// Inventory is the device's configuration snapshot: hardware, operating system, storage, network
// adapters, security-relevant settings and (on computers) installed programs. It never contains
// files, documents, browsing, messages or how programs are used.
type Inventory struct {
	CollectedAt  int64      `json:"collectedAt"`
	AgentVersion string     `json:"agentVersion"`
	System       SystemInfo `json:"system"`
	OS           OSInfo     `json:"os"`
	Hardware     HW         `json:"hardware"`
	Disks        []Disk     `json:"disks"`
	Network      []NIC      `json:"network"`
	Settings     []Setting  `json:"settings"`
	Software     []App      `json:"software"`
}

type SystemInfo struct {
	Hostname     string `json:"hostname"`
	Manufacturer string `json:"manufacturer,omitempty"`
	Model        string `json:"model,omitempty"`
	Serial       string `json:"serial,omitempty"`
	Firmware     string `json:"firmware,omitempty"`
	Chassis      string `json:"chassis,omitempty"`
}

type OSInfo struct {
	Name        string `json:"name"`
	Version     string `json:"version,omitempty"`
	Build       string `json:"build,omitempty"`
	Arch        string `json:"arch"`
	Kernel      string `json:"kernel,omitempty"`
	InstallDate string `json:"installDate,omitempty"`
	LastBoot    string `json:"lastBoot,omitempty"`
	Timezone    string `json:"timezone,omitempty"`
}

type HW struct {
	CPU      string  `json:"cpu,omitempty"`
	Cores    int     `json:"cores,omitempty"`
	Threads  int     `json:"threads"`
	MemoryGB float64 `json:"memoryGb,omitempty"`
	TPM      string  `json:"tpm,omitempty"`
}

type Disk struct {
	Mount     string  `json:"mount"`
	FS        string  `json:"fs,omitempty"`
	SizeGB    float64 `json:"sizeGb"`
	FreeGB    float64 `json:"freeGb"`
	Encrypted *bool   `json:"encrypted,omitempty"`
}

type NIC struct {
	Name string   `json:"name"`
	MAC  string   `json:"mac,omitempty"`
	IPv4 []string `json:"ipv4,omitempty"`
	IPv6 []string `json:"ipv6,omitempty"`
	Up   bool     `json:"up"`
}

// Setting is one configuration value, grouped by category for display ("Security", "Updates", …).
type Setting struct {
	Category string `json:"category"`
	Name     string `json:"name"`
	Value    string `json:"value"`
}

type App struct {
	Name      string `json:"name"`
	Version   string `json:"version,omitempty"`
	Publisher string `json:"publisher,omitempty"`
}

const maxSoftware = 3000

// collectInventory gathers the cross-platform parts, then the OS-specific ones.
func collectInventory(sys inventorySource) Inventory {
	inv := Inventory{CollectedAt: time.Now().UnixMilli(), AgentVersion: Version}
	inv.System.Hostname, _ = os.Hostname()
	inv.OS.Arch = runtime.GOARCH
	inv.Hardware.Threads = runtime.NumCPU()
	inv.Network = networkAdapters()
	hw := sys.Hardware()
	inv.System.Model, inv.System.Serial, inv.OS.Name = hw.Model, hw.Serial, hw.OS
	osInventory(&inv)
	// Posture as settings too, so the inventory is one complete picture.
	t := sys.Telemetry()
	addBool := func(name string, v *bool, on, off string) {
		if v != nil {
			inv.Settings = append(inv.Settings, Setting{"Security", name, map[bool]string{true: on, false: off}[*v]})
		}
	}
	addBool("Disk encryption", t.Security.Encrypted, "On", "Off")
	addBool("Firewall", t.Security.Firewall, "On", "Off")
	addBool("Real-time malware protection", t.Security.Antivirus, "On", "Off")
	addBool("Secure Boot", t.Security.SecureBoot, "On", "Off")
	if t.Security.PendingUpdates != nil {
		inv.Settings = append(inv.Settings, Setting{"Updates", "Updates waiting", itoa(*t.Security.PendingUpdates)})
	}
	if t.PatchLevel != "" {
		inv.Settings = append(inv.Settings, Setting{"Updates", "Last update installed", t.PatchLevel})
	}
	if len(inv.Software) > maxSoftware {
		inv.Software = inv.Software[:maxSoftware]
	}
	sort.Slice(inv.Software, func(i, j int) bool {
		return strings.ToLower(inv.Software[i].Name) < strings.ToLower(inv.Software[j].Name)
	})
	sort.SliceStable(inv.Settings, func(i, j int) bool { return inv.Settings[i].Category < inv.Settings[j].Category })
	return inv
}

// inventorySource is the part of System the inventory needs (keeps tests independent of the OS layer).
type inventorySource interface {
	Hardware() Hardware
	Telemetry() Telemetry
}

func networkAdapters() []NIC {
	ifs, _ := net.Interfaces()
	var out []NIC
	for _, i := range ifs {
		if i.Flags&net.FlagLoopback != 0 || len(i.HardwareAddr) == 0 || virtualNIC(i.Name) {
			continue
		}
		n := NIC{Name: i.Name, MAC: i.HardwareAddr.String(), Up: i.Flags&net.FlagUp != 0}
		addrs, _ := i.Addrs()
		for _, a := range addrs {
			ip, _, err := net.ParseCIDR(a.String())
			if err != nil || ip.IsLinkLocalUnicast() {
				continue
			}
			if ip.To4() != nil {
				n.IPv4 = append(n.IPv4, ip.String())
			} else {
				n.IPv6 = append(n.IPv6, ip.String())
			}
		}
		out = append(out, n)
		if len(out) >= 32 {
			break
		}
	}
	return out
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	if neg {
		b = append([]byte{'-'}, b...)
	}
	return string(b)
}

func set(inv *Inventory, cat, name, value string) {
	if v := strings.TrimSpace(value); v != "" {
		inv.Settings = append(inv.Settings, Setting{cat, name, v})
	}
}

func onOff(b bool) string {
	if b {
		return "On"
	}
	return "Off"
}

// virtualNIC hides container / bridge plumbing that says nothing about the device.
func virtualNIC(name string) bool {
	for _, p := range []string{"veth", "docker", "br-", "virbr", "ifb", "cni", "flannel", "vmnet", "vboxnet", "awdl", "llw", "anpi", "ap1", "utun", "bridge"} {
		if strings.HasPrefix(name, p) {
			return true
		}
	}
	return false
}
