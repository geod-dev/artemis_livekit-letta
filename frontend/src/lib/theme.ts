export type Theme = 'light' | 'dark';

const THEME_KEY = 'theme';
const THEME_COLORS: Record<Theme, string> = {
  light: '#ffffff',
  dark: '#15141a',
};

export function getStoredTheme(): Theme {
  try {
    return window.localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle('dark', theme === 'dark');
  document.documentElement.style.colorScheme = theme;
  const color = THEME_COLORS[theme];
  document
    .querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    ?.setAttribute('content', color);
  (
    window as Window & { ArtemisNative?: { setSystemBarColor: (color: string) => void } }
  ).ArtemisNative?.setSystemBarColor(color);
  try {
    window.localStorage.setItem(THEME_KEY, theme);
  } catch {
    // The current page theme still works when storage is unavailable.
  }
}
