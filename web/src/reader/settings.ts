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

function normalizeSettings(value: Partial<ReaderSettings>): ReaderSettings {
  const fontSize = Number.isFinite(value.fontSize) ? Math.min(36, Math.max(12, Math.round(value.fontSize as number))) : DEFAULTS.fontSize;
  const lineHeight = Number.isFinite(value.lineHeight) ? Math.min(2.2, Math.max(1.3, Math.round((value.lineHeight as number) * 10) / 10)) : DEFAULTS.lineHeight;
  const margin = Number.isFinite(value.margin) ? Math.min(48, Math.max(0, Math.round((value.margin as number) / 2) * 2)) : DEFAULTS.margin;
  const theme: ReaderTheme = value.theme === "dark" || value.theme === "sepia" ? value.theme : "light";
  return { fontSize, lineHeight, margin, theme };
}

export function loadSettings(): ReaderSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<ReaderSettings>;
    return normalizeSettings(parsed);
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
