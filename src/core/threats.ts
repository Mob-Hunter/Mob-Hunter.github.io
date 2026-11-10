import type { CommandType } from './rbac';
import type { CommandRecord, Device, Incident, Platform, ThreatSeverity } from './types';
import { DESKTOP_PLATFORMS } from './types';

/**
 * Mobile threat detection. Every rule reads configuration and integrity signals the agent
 * reports (or server-side facts such as check-in age and rejected command signatures). Nothing
 * here needs, or could use, the employee's messages, files, photos, browsing or app usage.
 */

export type ThreatCategory = 'Device integrity' | 'OS & patching' | 'Configuration' | 'Network' | 'Physical' | 'Management channel';

export interface ThreatDef {
  key: string;
  title: string;
  category: ThreatCategory;
  severity: ThreatSeverity;
  /** what it means, in one sentence */
  why: string;
  /** what the administrator should do */
  fix: string;
  /** one-click remediation offered in the console */
  remedy?: { command: CommandType; label: string; message?: string };
}

export const SEVERITY_WEIGHT: Record<ThreatSeverity, number> = { critical: 40, high: 20, medium: 10, low: 4 };
export const SEVERITIES: ThreatSeverity[] = ['critical', 'high', 'medium', 'low'];

const msg = (text: string) => ({ command: 'MESSAGE' as const, label: 'Send instructions', message: text });

export const THREATS: Record<string, ThreatDef> = {
  device_compromised: {
    key: 'device_compromised',
    title: 'Device rooted, jailbroken or tampered',
    category: 'Device integrity',
    severity: 'critical',
    why: 'The operating system integrity check failed: apps, including malware, can bypass every OS protection.',
    fix: 'Lock the device, take it out of service and re-image or replace it. Do not trust data it sends.',
    remedy: { command: 'LOCK', label: 'Lock device' },
  },
  command_tampering: {
    key: 'command_tampering',
    title: 'Tampered or replayed command rejected',
    category: 'Management channel',
    severity: 'critical',
    why: 'The agent refused a command whose signature, expiry or nonce did not verify: someone may be interfering with the management channel.',
    fix: 'Check the audit log for the rejected command, verify the network path, and rotate the device by re-enrolling it if it repeats.',
  },
  device_stolen: {
    key: 'device_stolen',
    title: 'Device reported lost or stolen',
    category: 'Physical',
    severity: 'high',
    why: 'Company data on the device is outside your control until it is recovered.',
    fix: 'Follow the incident: keep Lost Mode on, and wipe the device if it is not recovered.',
  },
  integrity_basic: {
    key: 'integrity_basic',
    title: 'Uncertified build or unlocked bootloader',
    category: 'Device integrity',
    severity: 'medium',
    why: 'The device only meets basic integrity: it may run a custom ROM or have an unlocked bootloader.',
    fix: 'Confirm the device is approved hardware with stock firmware; replace it if not.',
  },
  patch_critical: {
    key: 'patch_critical',
    title: 'Security patch more than 6 months old',
    category: 'OS & patching',
    severity: 'high',
    why: 'Publicly known, actively exploited vulnerabilities are unpatched on this device.',
    fix: 'Install the latest OS update; replace devices that no longer receive updates.',
    remedy: msg('Your device is missing important security updates. Please install the latest system update today (Settings → System → Software update).'),
  },
  patch_outdated: {
    key: 'patch_outdated',
    title: 'Security patch more than 90 days old',
    category: 'OS & patching',
    severity: 'medium',
    why: 'Several months of security fixes are missing.',
    fix: 'Ask the user to install the latest system update.',
    remedy: msg('Your device has security updates waiting. Please install the latest system update this week.'),
  },
  updates_pending: {
    key: 'updates_pending',
    title: 'OS updates waiting to install',
    category: 'OS & patching',
    severity: 'low',
    why: 'Downloaded or available updates have not been installed.',
    fix: 'Ask the user to install updates, or schedule a restart.',
    remedy: msg('Updates are waiting to be installed on your computer. Please save your work and install them today.'),
  },
  no_screen_lock: {
    key: 'no_screen_lock',
    title: 'No screen lock',
    category: 'Configuration',
    severity: 'high',
    why: 'Anyone who picks the device up can open it and its company data.',
    fix: 'Ask the user to set a PIN, password or biometric lock; company devices enforce it through policy.',
    remedy: msg('Your device has no screen lock. Please set a PIN or password now — it is required by company policy.'),
  },
  not_encrypted: {
    key: 'not_encrypted',
    title: 'Storage not encrypted',
    category: 'Configuration',
    severity: 'high',
    why: 'Data can be read directly from the disk if the device is lost.',
    fix: 'Turn on device encryption (BitLocker, FileVault or LUKS on computers).',
  },
  antivirus_off: {
    key: 'antivirus_off',
    title: 'Real-time malware protection off',
    category: 'Configuration',
    severity: 'high',
    why: 'Malware is not being blocked when it arrives.',
    fix: 'Turn real-time protection back on (Microsoft Defender on Windows).',
    remedy: msg('Real-time virus protection is turned off on your computer. Please turn it back on, or contact IT.'),
  },
  usb_debugging: {
    key: 'usb_debugging',
    title: 'USB debugging enabled',
    category: 'Configuration',
    severity: 'medium',
    why: 'A connected computer can install apps and read data over USB.',
    fix: 'Turn off USB debugging in Developer options; company phones block it by policy.',
    remedy: msg('USB debugging is on. Please turn it off: Settings → System → Developer options → USB debugging.'),
  },
  unknown_sources: {
    key: 'unknown_sources',
    title: 'Apps can be installed from unknown sources',
    category: 'Configuration',
    severity: 'medium',
    why: 'Sideloaded apps skip store review — the most common way malware reaches phones.',
    fix: 'Remove the "install unknown apps" permission; company phones block it by policy.',
    remedy: msg('Your phone allows apps from unknown sources. Please turn this off in Settings → Apps → Special app access → Install unknown apps.'),
  },
  firewall_off: {
    key: 'firewall_off',
    title: 'Firewall off',
    category: 'Network',
    severity: 'medium',
    why: 'Network services on the computer are reachable by anyone on the same network.',
    fix: 'Turn the firewall on (Windows Defender Firewall, macOS firewall, ufw or firewalld).',
    remedy: msg('The firewall on your computer is turned off. Please turn it back on, or contact IT.'),
  },
  open_wifi: {
    key: 'open_wifi',
    title: 'Connected to an open Wi-Fi network',
    category: 'Network',
    severity: 'medium',
    why: 'Traffic on unencrypted Wi-Fi can be intercepted or redirected by others nearby.',
    fix: 'Ask the user to avoid open networks or use mobile data / the company VPN.',
    remedy: msg('You are connected to an open (unencrypted) Wi-Fi network. Please switch to a secure network or mobile data.'),
  },
  secure_boot_off: {
    key: 'secure_boot_off',
    title: 'Secure Boot off',
    category: 'Device integrity',
    severity: 'low',
    why: 'Boot-level malware (bootkits) is not blocked.',
    fix: 'Turn on Secure Boot in the firmware settings.',
  },
  dev_options: {
    key: 'dev_options',
    title: 'Developer options enabled',
    category: 'Configuration',
    severity: 'low',
    why: 'Developer settings weaken some protections and are rarely needed on work phones.',
    fix: 'Turn off Developer options unless the user is a developer.',
  },
  agent_silent: {
    key: 'agent_silent',
    title: 'Not checked in for 3+ days',
    category: 'Management channel',
    severity: 'medium',
    why: 'The device is not receiving policy or commands: it may be off, lost, or the agent was blocked.',
    fix: 'Contact the user; if the device cannot be found, report it lost.',
  },
  notice_pending: {
    key: 'notice_pending',
    title: 'Enrolment not completed',
    category: 'Management channel',
    severity: 'low',
    why: 'The employee has not acknowledged the device notice for more than a day, so the device is only partly managed.',
    fix: 'Ask the user to open the Mob Hunter app and read the notice.',
  },
};

export interface DetectedThreat {
  key: string;
  detail: string;
}

const DAY = 86_400_000;

/** Parses "2026-10-05" or "2026-10" (security patch level / last update date). */
export function patchAgeDays(patchLevel: string | undefined, now: number): number | null {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(patchLevel ?? '');
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3] ?? 1));
  if (!Number.isFinite(t) || t > now + DAY) return null;
  return Math.floor((now - t) / DAY);
}

export function isDesktop(p: Platform | undefined): boolean {
  return !!p && DESKTOP_PLATFORMS.includes(p);
}

/** Runs every rule against one device. Retired, wiped and released devices have no live threats. */
export function detectThreats(d: Device, now: number, ctx: { commands: CommandRecord[]; incidents: Incident[] }): DetectedThreat[] {
  if (d.state === 'retired' || d.state === 'wiped' || d.state === 'released') return [];
  const out: DetectedThreat[] = [];
  const add = (key: string, detail: string) => out.push({ key, detail });
  const t = d.telemetry;
  const s = t?.security ?? {};

  if (t?.integrity === 'FAILED' || s.compromised) add('device_compromised', t?.integrity === 'FAILED' ? 'Play Integrity verdict: FAILED' : 'OS integrity check failed');
  else if (t?.integrity === 'MEETS_BASIC_INTEGRITY') add('integrity_basic', 'Play Integrity verdict: basic integrity only');

  const tampered = ctx.commands.filter((c) => c.deviceId === d.id && c.status === 'rejected' && (c.completedAt ?? 0) > now - 30 * DAY && /bad_signature|wrong_device|replayed|malformed|tamper/i.test(c.resultSummary ?? ''));
  if (tampered.length) add('command_tampering', `${tampered.length} command(s) rejected in the last 30 days — last: ${tampered[tampered.length - 1].resultSummary}`);

  const incident = ctx.incidents.find((i) => i.deviceId === d.id && i.status === 'active');
  if (incident) add('device_stolen', `Reported ${incident.kind} (ticket ${incident.ticket})`);
  else if (d.lostMode) add('device_stolen', 'Lost Mode is on');

  const age = patchAgeDays(t?.patchLevel, now);
  if (age !== null && age > 180) add('patch_critical', `${isDesktop(d.platform) ? 'Last update' : 'Patch level'} ${t!.patchLevel} (${age} days old)`);
  else if (age !== null && age > 90) add('patch_outdated', `${isDesktop(d.platform) ? 'Last update' : 'Patch level'} ${t!.patchLevel} (${age} days old)`);
  if ((s.pendingUpdates ?? 0) > 0) add('updates_pending', `${s.pendingUpdates} update(s) waiting`);

  if (s.screenLock === false) add('no_screen_lock', 'No PIN, password or biometric lock is set');
  if (s.encrypted === false) add('not_encrypted', 'Device storage is not encrypted');
  if (s.antivirus === false) add('antivirus_off', 'Real-time protection reported off');
  if (s.usbDebugging) add('usb_debugging', 'ADB is enabled');
  else if (s.devOptions) add('dev_options', 'Developer options are on');
  if (s.unknownSources) add('unknown_sources', 'Install from unknown sources is allowed');
  if (s.firewall === false) add('firewall_off', 'Host firewall reported off');
  if (s.openWifi) add('open_wifi', 'Current Wi-Fi network has no encryption');
  if (s.secureBoot === false) add('secure_boot_off', 'Secure Boot reported off');

  if (d.state === 'active' && d.lastCheckinAt && now - d.lastCheckinAt > 3 * DAY) add('agent_silent', `Last check-in ${Math.floor((now - d.lastCheckinAt) / DAY)} days ago`);
  if (d.state === 'enrolled' && now - d.enrolledAt > DAY) add('notice_pending', 'Notice not acknowledged');
  return out;
}

export function riskScore(severities: ThreatSeverity[]): number {
  return Math.min(100, severities.reduce((sum, s) => sum + SEVERITY_WEIGHT[s], 0));
}

export type RiskBand = 'secure' | 'low' | 'medium' | 'high' | 'critical';
export function riskBand(score: number): RiskBand {
  if (score >= 70) return 'critical';
  if (score >= 40) return 'high';
  if (score >= 20) return 'medium';
  if (score > 0) return 'low';
  return 'secure';
}
