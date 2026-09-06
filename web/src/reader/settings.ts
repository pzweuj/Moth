export type ReaderTheme = "light" | "sepia" | "dark";

export interface ReaderSettings {
  /** Base font size in px. */
  fontSize: number;
  /** Line height as a unitless multiplier. */
  lineHeight: number;
  /** Horizontal page margin in px. */
  margin: number;
  theme: ReaderTheme;
}

const DEFAULTS: ReaderSettings = {
  fontSize: 18,
  lineHeight: 1.7,
  margin: 16,
  theme: "light",
};

const STORAGE_KEY = "moth:reader-settings";

export function loadSettings(): ReaderSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<ReaderSettings>;
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(settings: ReaderSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage can be unavailable in private browsing; settings just don't persist.
  }
}
