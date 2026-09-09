export type ReaderFlow = "paginated" | "scrolled";

export interface ReaderSettings {
  /** Base font size in px. */
  fontSize: number;
  /** Line height as a unitless multiplier. */
  lineHeight: number;
  flow: ReaderFlow;
}

export type ComicMode = "single" | "double" | "webtoon";
export type ComicDirection = "ltr" | "rtl";
export type ComicFit = "screen" | "width" | "height";

export interface ComicSettings {
  mode: ComicMode;
  direction: ComicDirection;
  fit: ComicFit;
}

const DEFAULTS: ReaderSettings = {
  fontSize: 18,
  lineHeight: 1.7,
  flow: "paginated",
};

const STORAGE_KEY = "moth:reader-settings";
const COMIC_STORAGE_KEY = "moth:comic-settings";

const DEFAULT_COMIC_SETTINGS: ComicSettings = {
  mode: "single",
  direction: "ltr",
  fit: "screen",
};

function normalizeSettings(value: Partial<ReaderSettings>): ReaderSettings {
  const fontSize = Number.isFinite(value.fontSize) ? Math.min(36, Math.max(12, Math.round(value.fontSize as number))) : DEFAULTS.fontSize;
  const lineHeight = Number.isFinite(value.lineHeight) ? Math.min(2.2, Math.max(1.3, Math.round((value.lineHeight as number) * 10) / 10)) : DEFAULTS.lineHeight;
  const flow: ReaderFlow = value.flow === "scrolled" ? "scrolled" : "paginated";
  return { fontSize, lineHeight, flow };
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

function normalizeComicSettings(value: Partial<ComicSettings>): ComicSettings {
  return {
    mode: value.mode === "double" || value.mode === "webtoon" ? value.mode : "single",
    direction: value.direction === "rtl" ? "rtl" : "ltr",
    fit: value.fit === "width" || value.fit === "height" ? value.fit : "screen",
  };
}

export function loadComicSettings(): ComicSettings {
  try {
    const raw = localStorage.getItem(COMIC_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_COMIC_SETTINGS };
    return normalizeComicSettings(JSON.parse(raw) as Partial<ComicSettings>);
  } catch {
    return { ...DEFAULT_COMIC_SETTINGS };
  }
}

export function saveComicSettings(settings: ComicSettings): void {
  try {
    localStorage.setItem(COMIC_STORAGE_KEY, JSON.stringify(normalizeComicSettings(settings)));
  } catch {
    // Storage can be unavailable in private browsing; settings just don't persist.
  }
}
