import type { DevicePolicy, ProvisioningPayload } from './types';

export const ENROLLMENT_TTL_MS = 15 * 60 * 1000;
export const AGENT_PACKAGE = 'com.mobhunter.agent';
export const AGENT_COMPONENT = `${AGENT_PACKAGE}/.AgentAdminReceiver`;
export const AGENT_VERSION = '1.0.0';
/** SHA-256 of the APK signing certificate, URL-safe base64 as Android expects. Replace at release time. */
export const APK_SIGNATURE_CHECKSUM = 'REPLACE_WITH_RELEASE_SIGNING_CERT_SHA256_URLSAFE_B64';

export function buildProvisioningPayload(opts: {
  apiBaseUrl: string;
  token: string;
  serverPin: string;
  wifi?: { ssid: string; security: 'WPA' | 'WEP' | 'NONE' };
  apkVersion?: string;
  signatureChecksum?: string;
  /** absolute HTTPS URL of the signed agent APK (default: the /api/apk/{version} route) */
  apkDownloadUrl?: string;
}): ProvisioningPayload {
  const payload: ProvisioningPayload = {
    'android.app.extra.PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME': AGENT_COMPONENT,
    'android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_DOWNLOAD_LOCATION': opts.apkDownloadUrl || `${opts.apiBaseUrl}/apk/${opts.apkVersion ?? AGENT_VERSION}`,
    'android.app.extra.PROVISIONING_DEVICE_ADMIN_SIGNATURE_CHECKSUM': opts.signatureChecksum ?? APK_SIGNATURE_CHECKSUM,
    'android.app.extra.PROVISIONING_LEAVE_ALL_SYSTEM_APPS_ENABLED': true,
    'android.app.extra.PROVISIONING_SKIP_ENCRYPTION': false,
    'android.app.extra.PROVISIONING_ADMIN_EXTRAS_BUNDLE': {
      serverUrl: opts.apiBaseUrl,
      token: opts.token,
      serverPin: opts.serverPin,
    },
  };
  // Wi-Fi password is intentionally NOT supported: a QR is easily photographed.
  if (opts.wifi?.ssid) {
    payload['android.app.extra.PROVISIONING_WIFI_SSID'] = opts.wifi.ssid;
    payload['android.app.extra.PROVISIONING_WIFI_SECURITY_TYPE'] = opts.wifi.security;
  }
  return payload;
}

export function defaultPolicy(): DevicePolicy {
  return {
    version: 1,
    passwordMinLength: 6,
    maxTimeToLockSec: 300,
    updateWindow: { startMinute: 120, endMinute: 240 },
    disallowFactoryReset: true,
    disallowUsbTransfer: true,
    disallowUnknownSources: true,
    disallowDebugging: true,
    keepLocationOn: true,
    continuousLocation: false,
    continuousIntervalMin: 15,
    workingHours: { startHour: 8, endHour: 18, days: [1, 2, 3, 4, 5], timeZone: 'Asia/Colombo' },
    securityLogging: false,
    networkLogging: false,
  };
}

/** Policy text the employee acknowledges at enrolment (Non-negotiable #1). */
export const COLLECTION_NOTICE = {
  version: '2026-11-v1',
  title: 'Company device notice',
  collected: [
    'Device identifiers: serial number, model, OS version and security patch level.',
    'Device health: battery level, health and temperature; free storage; Play Integrity verdict.',
    'Location — only when a Location Operator requests it against a ticket (you get a notification every time), while the device is in Lost Mode, or, if your policy enables it, every 15+ minutes during working hours with a persistent notification.',
    'The list of company apps installed by the management service.',
  ],
  notCollected: [
    'Messages, e-mail, call content, photos, files, browsing history.',
    'Screen contents or screenshots. There is no remote screen or remote shell.',
    'Network traffic or security logs (both are switched off).',
  ],
  retention: 'Location results are encrypted and deleted after 30 days. Audit records of who requested a location are kept for 1 year.',
  rights: 'You can see every location request made for your device on the transparency page linked from each notification, and you can contact the Data Protection Officer to access or correct your data.',
} as const;
