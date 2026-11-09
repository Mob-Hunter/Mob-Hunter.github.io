/** Colour theme: the cyber dark theme by default; light is a per-browser choice. */
export type Theme = 'dark' | 'light';
const KEY = 'mob-hunter.theme';

export function getTheme(): Theme {
  try {
    return localStorage.getItem(KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

export function applyTheme(t: Theme = getTheme()): void {
  document.documentElement.dataset.theme = t;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', t === 'dark' ? '#060a13' : '#f3f6fa');
}

export function setTheme(t: Theme): void {
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* private mode: applies for this visit only */
  }
  applyTheme(t);
}
