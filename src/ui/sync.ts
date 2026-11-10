export const SYNC_CHOICES = [5, 15, 30, 60, 120, 240, 480, 720, 1440] as const;

/** 5 → "5 minutes", 60 → "1 hour", 1440 → "24 hours". */
export function fmtInterval(min: number): string {
  if (min < 60) return `${min} minutes`;
  const h = min / 60;
  return `${h} hour${h === 1 ? '' : 's'}`;
}
