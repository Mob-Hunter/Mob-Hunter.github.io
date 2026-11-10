//go:build windows

package main

import (
	"encoding/json"
	"strings"
	"time"
)

// One PowerShell run reads the whole inventory as JSON. Every probe is wrapped so a missing
// cmdlet (Home editions, Server Core) leaves that field empty instead of failing the rest.
const inventoryScript = `$ErrorActionPreference='SilentlyContinue'; $o=[ordered]@{}
$cs=Get-CimInstance Win32_ComputerSystem; $os=Get-CimInstance Win32_OperatingSystem; $b=Get-CimInstance Win32_BIOS; $cpu=Get-CimInstance Win32_Processor | Select-Object -First 1; $enc=Get-CimInstance Win32_SystemEnclosure | Select-Object -First 1
$o.manufacturer="$($cs.Manufacturer)"; $o.model="$($cs.Model)"; $o.serial="$($b.SerialNumber)"; $o.firmware="$($b.Manufacturer) $($b.SMBIOSBIOSVersion)"
$o.chassis=@($enc.ChassisTypes) -join ','
$o.osName="$($os.Caption)"; $o.osVersion="$($os.Version)"; $o.build="$($os.BuildNumber).$((Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion').UBR)"; $o.displayVersion=(Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion').DisplayVersion
$o.installDate=$os.InstallDate.ToString('yyyy-MM-dd'); $o.lastBoot=$os.LastBootUpTime.ToUniversalTime().ToString('o'); $o.timezone=(Get-TimeZone).Id
$o.cpu="$($cpu.Name)".Trim(); $o.cores=[int]$cpu.NumberOfCores; $o.memory=[double]$cs.TotalPhysicalMemory
try{$t=Get-Tpm -ErrorAction Stop; $o.tpm= if($t.TpmPresent){ "Present, " + $(if($t.TpmReady){'ready'}else{'not ready'}) } else {'Not present'}}catch{}
$o.domain= if($cs.PartOfDomain){"$($cs.Domain)"}else{"Workgroup: $($cs.Workgroup)"}
try{$o.aad=((dsregcmd /status) -match 'AzureAdJoined\s*:\s*YES').Count -gt 0}catch{}
$o.disks=@(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object { $bl=$null; try{$bl=(Get-BitLockerVolume -MountPoint $_.DeviceID -ErrorAction Stop).ProtectionStatus -eq 'On'}catch{}; [ordered]@{mount=$_.DeviceID; fs=$_.FileSystem; size=[double]$_.Size; free=[double]$_.FreeSpace; bitlocker=$bl} })
$uk='HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
$o.software=@(Get-ItemProperty $uk | Where-Object { $_.DisplayName -and -not $_.SystemComponent -and -not $_.ParentKeyName } | Sort-Object DisplayName -Unique | ForEach-Object { [ordered]@{name="$($_.DisplayName)"; version="$($_.DisplayVersion)"; publisher="$($_.Publisher)"} })
$s=[ordered]@{}
$s.uac=(Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System').EnableLUA
$s.rdp=(Get-ItemProperty 'HKLM:\System\CurrentControlSet\Control\Terminal Server').fDenyTSConnections
$s.nla=(Get-ItemProperty 'HKLM:\System\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp').UserAuthentication
try{$s.admins=@(Get-LocalGroupMember -SID 'S-1-5-32-544' -ErrorAction Stop | ForEach-Object { "$($_.Name)" }) -join ', '}catch{}
try{$s.guest=(Get-LocalUser -SID ((Get-CimInstance Win32_UserAccount -Filter "LocalAccount=True AND SID LIKE '%-501'").SID) -ErrorAction Stop).Enabled}catch{}
$s.inactivity=(Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System').InactivityTimeoutSecs
$s.autoLogon=(Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon').AutoAdminLogon
try{$s.smb1=(Get-SmbServerConfiguration -ErrorAction Stop).EnableSMB1Protocol}catch{}
$s.psPolicy="$(Get-ExecutionPolicy -Scope LocalMachine)"
try{$m=Get-MpComputerStatus -ErrorAction Stop; $s.avSigAge=$m.AntivirusSignatureAge; $s.tamper=$m.IsTamperProtected; $s.avEngine=$m.AMEngineVersion}catch{}
try{$s.fwProfiles=@(Get-NetFirewallProfile -ErrorAction Stop | ForEach-Object { "$($_.Name): $(if($_.Enabled){'On'}else{'Off'})" }) -join ', '}catch{}
$au=Get-ItemProperty 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU'; $s.wuNoAuto=$au.NoAutoUpdate; $s.wuServer=(Get-ItemProperty 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate').WUServer
$s.hvci=(Get-CimInstance -ClassName Win32_DeviceGuard -Namespace root\Microsoft\Windows\DeviceGuard).SecurityServicesRunning -join ','
$s.lsaPpl=(Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Lsa').RunAsPPL
$s.usbStorage=(Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Services\USBSTOR').Start
$o.settings=$s
$o | ConvertTo-Json -Compress -Depth 5`

type winInv struct {
	Manufacturer, Model, Serial, Firmware, Chassis string
	OSName                                         string `json:"osName"`
	OSVersion                                      string `json:"osVersion"`
	Build                                          string
	DisplayVersion                                 string `json:"displayVersion"`
	InstallDate                                    string `json:"installDate"`
	LastBoot                                       string `json:"lastBoot"`
	Timezone, CPU, TPM, Domain                     string
	Cores                                          int
	Memory                                         float64
	AAD                                            *bool `json:"aad"`
	Disks                                          []struct {
		Mount, FS  string
		Size, Free float64
		BitLocker  *bool `json:"bitlocker"`
	}
	Software []App
	Settings map[string]any
}

func osInventory(inv *Inventory) {
	out, err := ps(3*time.Minute, inventoryScript)
	if err != nil || !strings.Contains(out, "{") {
		set(inv, "Agent", "Inventory", "PowerShell inventory failed: "+singleLine(out, 120))
		return
	}
	var w winInv
	if err := json.Unmarshal([]byte(out[strings.Index(out, "{"):]), &w); err != nil {
		set(inv, "Agent", "Inventory", "Could not read inventory: "+err.Error())
		return
	}
	inv.System.Manufacturer, inv.System.Model, inv.System.Serial = strings.TrimSpace(w.Manufacturer), firstNonEmptyW(w.Model, inv.System.Model), firstNonEmptyW(w.Serial, inv.System.Serial)
	inv.System.Firmware, inv.System.Chassis = strings.TrimSpace(w.Firmware), chassisWin(w.Chassis)
	inv.OS.Name, inv.OS.Version, inv.OS.Build = firstNonEmptyW(strings.TrimSpace(w.OSName+" "+w.DisplayVersion), inv.OS.Name), w.OSVersion, w.Build
	inv.OS.InstallDate, inv.OS.LastBoot, inv.OS.Timezone = w.InstallDate, w.LastBoot, w.Timezone
	inv.Hardware.CPU, inv.Hardware.Cores, inv.Hardware.MemoryGB, inv.Hardware.TPM = w.CPU, w.Cores, gb(w.Memory), w.TPM
	for _, d := range w.Disks {
		inv.Disks = append(inv.Disks, Disk{Mount: d.Mount, FS: d.FS, SizeGB: gb(d.Size), FreeGB: gb(d.Free), Encrypted: d.BitLocker})
	}
	inv.Software = w.Software
	st := w.Settings
	str := func(k string) string {
		if v, ok := st[k]; ok && v != nil {
			switch x := v.(type) {
			case float64:
				return itoa(int(x))
			case bool:
				return map[bool]string{true: "true", false: "false"}[x]
			default:
				return strings.TrimSpace(strings.ReplaceAll(strings.ReplaceAll(toString(x), "\r", ""), "\n", " "))
			}
		}
		return ""
	}
	flag := func(k, on, off, unset string) string {
		switch str(k) {
		case "1", "true":
			return on
		case "0", "false":
			return off
		}
		return unset
	}
	set(inv, "Network", "Domain", w.Domain)
	if w.AAD != nil {
		set(inv, "Network", "Microsoft Entra ID (Azure AD) joined", map[bool]string{true: "Yes", false: "No"}[*w.AAD])
	}
	set(inv, "Security", "User Account Control", flag("uac", "On", "Off", ""))
	set(inv, "Security", "Credential Guard / HVCI services", firstNonEmptyW(map[string]string{"": "None running"}[str("hvci")], str("hvci")))
	set(inv, "Security", "LSA protection (RunAsPPL)", flag("lsaPpl", "On", "Off", "Off"))
	set(inv, "Security", "Defender tamper protection", flag("tamper", "On", "Off", ""))
	if v := str("avSigAge"); v != "" {
		set(inv, "Security", "Defender signature age", v+" day(s)")
	}
	set(inv, "Security", "Defender engine", str("avEngine"))
	set(inv, "Security", "Firewall profiles", str("fwProfiles"))
	set(inv, "Security", "SMBv1 server", flag("smb1", "Enabled", "Disabled", ""))
	set(inv, "Security", "PowerShell execution policy (machine)", str("psPolicy"))
	set(inv, "Security", "USB mass storage", map[string]string{"4": "Blocked", "3": "Allowed"}[str("usbStorage")])
	set(inv, "Accounts", "Local administrators", str("admins"))
	set(inv, "Accounts", "Guest account", flag("guest", "Enabled", "Disabled", ""))
	set(inv, "Accounts", "Automatic sign-in", flag("autoLogon", "On", "Off", "Off"))
	if v := str("inactivity"); v != "" && v != "0" {
		set(inv, "Accounts", "Screen lock after inactivity", v+" s")
	} else {
		set(inv, "Accounts", "Screen lock after inactivity", "Not enforced by policy")
	}
	set(inv, "Remote access", "Remote Desktop", flag("rdp", "Disabled", "Enabled", "Disabled"))
	set(inv, "Remote access", "RDP Network Level Authentication", flag("nla", "Required", "Not required", ""))
	set(inv, "Updates", "Automatic updates", flag("wuNoAuto", "Disabled by policy", "On", "On (default)"))
	set(inv, "Updates", "Update server (WSUS)", firstNonEmptyW(str("wuServer"), "Microsoft Update"))
}

func firstNonEmptyW(v ...string) string {
	for _, s := range v {
		if strings.TrimSpace(s) != "" {
			return strings.TrimSpace(s)
		}
	}
	return ""
}

func toString(v any) string {
	b, _ := json.Marshal(v)
	return strings.Trim(string(b), `"`)
}

func chassisWin(codes string) string {
	m := map[string]string{"3": "Desktop", "4": "Low-profile desktop", "6": "Mini tower", "7": "Tower", "8": "Portable", "9": "Laptop", "10": "Notebook", "13": "All-in-one", "14": "Sub-notebook", "23": "Rack server", "30": "Tablet", "31": "Convertible", "32": "Detachable", "35": "Mini PC", "1": "Virtual / other"}
	first := strings.Split(codes, ",")[0]
	return m[strings.TrimSpace(first)]
}
