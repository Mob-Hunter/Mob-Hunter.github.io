/**
 * Production configuration, fixed at build time.
 * VITE_SERVER_URL = the FleetGuard server (Cloudflare Worker) that hosts the live console and API.
 * When it is set, copies of the console served anywhere else (e.g. GitHub Pages) do not run the
 * in-browser demo: they show a landing page that sends people to the live server.
 */
export const SERVER_URL: string | null = ((import.meta.env.VITE_SERVER_URL as string | undefined) || '').replace(/\/$/, '') || null;

/** Where the signed APKs and SHA256SUMS.txt are published (GitHub Pages). */
export const DOWNLOADS_URL: string | null = ((import.meta.env.VITE_DOWNLOADS_URL as string | undefined) || '').replace(/\/$/, '') || null;

export function isOffServer(): boolean {
  if (!SERVER_URL || typeof location === 'undefined') return false;
  try {
    return new URL(SERVER_URL).origin !== location.origin;
  } catch {
    return false;
  }
}

export const APK_FILES = [
  {
    file: 'fleetguard-console.apk',
    name: 'FleetGuard Console',
    who: 'Administrators',
    text: 'The admin console as an Android app, connected to your FleetGuard server. Install it like any app (allow installs from your browser when asked).',
  },
  {
    file: 'fleetguard-agent.apk',
    name: 'FleetGuard device agent',
    who: 'Company phones (IT only)',
    text: 'Installed automatically when a factory-reset phone scans the enrolment QR from “Add devices”. Installing it from this link gives an ordinary app without management rights — for testing only.',
  },
] as const;
