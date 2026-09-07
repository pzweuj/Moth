export type ComicScaleMode = "fit-screen" | "fit-width" | "custom";

export type ComicSettings = {
  mode: ComicScaleMode;
  /** Percentage of the fit-screen size when mode is custom. */
  scale: number;
};

const DEFAULTS: ComicSettings = { mode: "fit-screen", scale: 100 };
const STORAGE_KEY = "moth:comic-settings";

function normalize(value: Partial<ComicSettings>): ComicSettings {
  const mode: ComicScaleMode = value.mode === "fit-width" || value.mode === "custom" ? value.mode : "fit-screen";
  const rawScale = Number(value.scale);
  const scale = Number.isFinite(rawScale) ? Math.min(300, Math.max(50, Math.round(rawScale / 10) * 10)) : DEFAULTS.scale;
  return { mode, scale };
}

export function loadComicSettings(): ComicSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? normalize(JSON.parse(raw) as Partial<ComicSettings>) : { ...DEFAULTS };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveComicSettings(settings: ComicSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalize(settings)));
  } catch {
    // Settings remain available for the current session when storage is blocked.
  }
}
