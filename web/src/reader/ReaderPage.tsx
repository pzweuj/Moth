import { useCallback, useEffect, useRef, useState } from "react";
import { Navigate, useLocation, useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, type ProgressBody } from "../api";
import { ErrorBoundary } from "../ErrorBoundary";
import {
  loadSettings,
  saveSettings,
  type ReaderSettings,
  type ReaderTheme,
} from "./settings";
import { useProgressSaver } from "./useProgressSaver";
import { FoliateTextReader } from "./FoliateTextReader";
import { ComicReader } from "./ComicReader";
import { loadComicSettings, saveComicSettings, type ComicSettings, type ComicScaleMode } from "./comicSettings";
import { getLocalProgress, getOfflineTxtEncoding, setOfflineTxtEncoding } from "../offline/db";
import { translateError, useUi } from "../i18n";
import { AppearanceControls } from "../ui/AppearanceControls";
import type { ReaderReturnLocation } from "../library/LibraryPage";

const SAVE_LABELS: Record<string, string> = {
  "local-saved": "Saved on device",
  saving: "Saving…",
  saved: "Saved",
  offline: "Saved on device",
  "needs-login": "Sign in to sync",
  error: "Save failed",
  "local-error": "Could not save on device",
};

/** TXT encoding options offered to the reader when auto-detection is wrong. */
export const TXT_ENCODINGS = [
  { value: "", label: "Auto" },
  { value: "utf-8", label: "UTF-8" },
  { value: "gb18030", label: "GB18030" },
  { value: "gbk", label: "GBK" },
  { value: "big5", label: "Big5" },
  { value: "utf-16le", label: "UTF-16LE" },
  { value: "utf-16be", label: "UTF-16BE" },
] as const;

function storedTxtEncoding(bookId: number): string {
  try {
    return localStorage.getItem(`moth:txt-encoding:${bookId}`) ?? "";
  } catch {
    return "";
  }
}

export function ReaderPage() {
  const { t, theme: appTheme, setTheme: setAppTheme } = useUi();
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const bookId = Number(id);
  const returnTo = (location.state as { returnTo?: ReaderReturnLocation } | null)?.returnTo;
  const backToLibrary = useCallback(() => {
    if (returnTo?.pathname?.startsWith("/")) {
      navigate(returnTo.pathname, { replace: true, state: returnTo.state });
    } else {
      navigate("/", { replace: true });
    }
  }, [navigate, returnTo]);
  const [settings, setSettings] = useState<ReaderSettings>(loadSettings);
  const [comicSettings, setComicSettings] = useState<ComicSettings>(loadComicSettings);
  const [fixedLayout, setFixedLayout] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [encoding, setEncoding] = useState(() => storedTxtEncoding(bookId));
  const [position, setPosition] = useState<ProgressBody | null>(null);
  const [localProgress, setLocalProgress] = useState<ProgressBody | null>(null);
  const [localProgressReady, setLocalProgressReady] = useState(false);
  const [offlineEncodingReady, setOfflineEncodingReady] = useState(true);

  useEffect(() => {
    const nextTheme: ReaderTheme = appTheme === "dark" ? "dark" : settings.theme === "dark" ? "light" : settings.theme;
    if (nextTheme !== settings.theme) setSettings((current) => ({ ...current, theme: nextTheme }));
  }, [appTheme, settings.theme]);

  const valid = Number.isInteger(bookId) && bookId > 0;
  const detail = useQuery({
    queryKey: ["book", bookId, encoding],
    queryFn: () => api.getBook(bookId, encoding),
    enabled: valid,
    networkMode: "always",
  });
  const { onProgress, saveState } = useProgressSaver(
    valid ? bookId : 0,
    detail.data?.content_version,
    localProgress?.revision ?? detail.data?.progress?.revision ?? 0,
    detail.data?.format === "txt" ? encoding : undefined,
  );

  const handleProgress = useCallback(
    (progress: ProgressBody) => {
      setPosition(progress);
      onProgress(progress);
    },
    [onProgress],
  );

  useEffect(() => {
    const value = detail.data;
    if (!value) {
      setOfflineEncodingReady(true);
      setLocalProgressReady(false);
      return;
    }
    let cancelled = false;
    const expectedEncoding = value.format === "txt" ? encoding : undefined;
    if (value.format !== "txt" || navigator.onLine) setOfflineEncodingReady(true);
    setLocalProgress(null);
    setLocalProgressReady(false);
    void getLocalProgress(value.id, value.content_version, expectedEncoding).then((progress) => {
      if (!cancelled) {
        if (progress && isProgressForVersion(progress, value.content_version, expectedEncoding)) {
          setLocalProgress(progress);
          setPosition(progress);
        } else {
          setPosition(progressForReader(value.progress, value.content_version, expectedEncoding) ?? null);
        }
        setLocalProgressReady(true);
      }
    }).catch(() => {
      // Private browser storage is optional; the server position remains usable.
      if (!cancelled) {
        setPosition(progressForReader(value.progress, value.content_version, expectedEncoding) ?? null);
        setLocalProgressReady(true);
      }
    });
    return () => { cancelled = true; };
  // Only reload local progress when the book identity, content, or TXT
  // decoder changes;
  // ordinary progress refetches must not restart the reader.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.data?.id, detail.data?.content_version, detail.data?.format, encoding]);

  useEffect(() => {
    const value = detail.data;
    if (!value || value.format !== "txt") return;
    const preferred = storedTxtEncoding(value.id);
    void getOfflineTxtEncoding(value.id, value.content_version).then((cached) => {
      if (navigator.onLine) {
        if (preferred && preferred !== encoding) setEncoding(preferred);
        setOfflineEncodingReady(true);
        return;
      }
      const cachedEncoding = cached === "auto" ? "" : cached;
      // While offline, only the encoding whose chapters were visited is
      // available. Prefer it over a stale browser preference so opening a
      // cached TXT book cannot ask IndexedDB for chapters that do not exist.
      if (!navigator.onLine && cached && cachedEncoding !== encoding) {
        setEncoding(cachedEncoding);
      } else if (preferred && preferred !== encoding) {
        setEncoding(preferred);
      } else if (!preferred && cachedEncoding && cachedEncoding !== encoding) {
        setEncoding(cachedEncoding);
      }
      setOfflineEncodingReady(true);
    }).catch(() => {
      // The automatic decoder remains the fallback when private storage is unavailable.
      setOfflineEncodingReady(true);
    });
  // The same identity-based dependency rule keeps encoding changes local.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.data?.id, detail.data?.content_version, detail.data?.format, encoding]);

  const handleEncodingChange = useCallback((value: string) => {
    setEncoding(value);
    const book = detail.data;
    if (!book) return;
    try {
      localStorage.setItem(`moth:txt-encoding:${book.id}`, value);
    } catch {
      // Keep the in-memory choice when localStorage is unavailable.
    }
    void setOfflineTxtEncoding(book.id, book.content_version, value);
  }, [detail.data]);

  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  useEffect(() => {
    saveComicSettings(comicSettings);
  }, [comicSettings]);

  const handleSettingsChange = useCallback((next: ReaderSettings) => {
    setSettings(next);
    setAppTheme(next.theme === "dark" ? "dark" : "light");
  }, [setAppTheme]);

  // Escape closes the settings panel; focus moves into the panel when it
  // opens and returns to the toggle button when it closes.
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const settingsPanelRef = useRef<HTMLDivElement>(null);
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (settingsOpen) {
      settingsPanelRef.current?.focus();
    } else if (wasOpenRef.current) {
      settingsButtonRef.current?.focus();
    }
    wasOpenRef.current = settingsOpen;
  }, [settingsOpen]);
  useEffect(() => {
    if (!settingsOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSettingsOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [settingsOpen]);

  if (!valid) {
    return <Navigate to="/" replace />;
  }

  if (detail.isPending) {
    return (
      <main className="state-screen">
        <span className="spinner" aria-hidden="true" />
        <p>{t("Opening your book…")}</p>
      </main>
    );
  }

  const book = detail.data;
  if (detail.isError || !book) {
    const message = detail.error instanceof Error
      ? detail.error.message
      : "This book could not be opened.";
    return (
      <main className="state-screen">
        <p className="eyebrow">{t("Moth / reader")}</p>
        <h1>{t("Book unavailable")}</h1>
        <p>{translateError(message, t)}</p>
        <button
          className="primary-button compact-button"
          type="button"
          onClick={backToLibrary}
        >
          {t("Back to library")}
        </button>
      </main>
    );
  }

  if (!localProgressReady || !offlineEncodingReady) {
    return (
      <main className="state-screen">
        <span className="spinner" aria-hidden="true" />
        <p>{t("Restoring your place…")}</p>
      </main>
    );
  }

  const expectedEncoding = book.format === "txt" ? encoding : undefined;
  const serverProgress = progressForReader(book.progress, book.content_version, expectedEncoding);
  const readerBook = localProgress
    ? { ...book, progress: localProgress }
    : { ...book, progress: serverProgress };
  return (
    <main className="reader-shell">
      <header className="reader-top-bar">
        <button type="button" onClick={backToLibrary}>
          ← {t("Your library")}
        </button>
        <span className="reader-title">{book.title}</span>
        {position && (
          <span className="reader-position">{Math.round(position.percent)}%</span>
        )}
        {saveState !== "idle" && (
          <span className={`save-indicator ${saveState}`} aria-live="polite">
            {t(SAVE_LABELS[saveState] ?? saveState)}
          </span>
        )}
        <span className="format-badge">{book.format}</span>
        <button
          type="button"
          ref={settingsButtonRef}
          onClick={() => setSettingsOpen((open) => !open)}
          aria-expanded={settingsOpen}
          aria-label={t("Reader settings")}
        >
          Aa
        </button>
        <AppearanceControls compact />
      </header>
      {settingsOpen && (
        <SettingsPanel
          settings={settings}
          onChange={handleSettingsChange}
          onClose={() => setSettingsOpen(false)}
          panelRef={settingsPanelRef}
          showEncoding={book.format === "txt"}
          encoding={encoding}
          onEncodingChange={handleEncodingChange}
          isComic={book.format === "cbz"}
          comicSettings={comicSettings}
          onComicChange={setComicSettings}
          fixedLayout={fixedLayout}
        />
      )}
      <ErrorBoundary
        key={`${book.id}:${book.content_version}:${book.format}:${encoding}`}
        fallback={(error) => (
          <div className="reader-error">
            <p>{translateError(error, t)}</p>
            <button type="button" onClick={backToLibrary}>
              {t("Back to library")}
            </button>
          </div>
        )}
      >
        {book.format === "cbz" ? (
            <ComicReader detail={readerBook} onProgress={handleProgress} settings={comicSettings} onBack={backToLibrary} />
        ) : (
          <FoliateTextReader
            detail={readerBook}
            settings={settings}
            encoding={encoding}
            onProgress={handleProgress}
            onLayoutChange={setFixedLayout}
            onBack={backToLibrary}
          />
        )}
      </ErrorBoundary>
    </main>
  );
}

function isProgressForVersion(
  progress: ProgressBody,
  contentVersion: string,
  expectedEncoding?: string,
): boolean {
  // Legacy rows have no content version and are safe to use because the
  // migration never had a CFI to restore.
  if (progress.content_version && progress.content_version !== contentVersion) return false;
  if (expectedEncoding === undefined) return !progress.encoding;
  const actual = progress.encoding?.trim().toLowerCase() || "auto";
  const expected = expectedEncoding.trim().toLowerCase() || "auto";
  return actual === expected;
}

function progressForReader(
  progress: ProgressBody | undefined,
  contentVersion: string,
  expectedEncoding?: string,
): ProgressBody | undefined {
  if (!progress) return undefined;
  // A CFI, chapter index, and percentage all refer to the decoded publication.
  // Do not restore a stale location after a file or TXT decoder changes.
  return isProgressForVersion(progress, contentVersion, expectedEncoding) ? progress : undefined;
}

function SettingsPanel({
  settings,
  onChange,
  onClose,
  panelRef,
  showEncoding,
  encoding,
  onEncodingChange,
  isComic,
  comicSettings,
  onComicChange,
  fixedLayout,
}: {
  settings: ReaderSettings;
  onChange: (settings: ReaderSettings) => void;
  onClose: () => void;
  panelRef: React.RefObject<HTMLDivElement | null>;
  showEncoding: boolean;
  encoding: string;
  onEncodingChange: (encoding: string) => void;
  isComic: boolean;
  comicSettings: ComicSettings;
  onComicChange: (settings: ComicSettings) => void;
  fixedLayout: boolean;
}) {
  const { t } = useUi();
  const update = <K extends keyof ReaderSettings>(
    key: K,
    value: ReaderSettings[K],
  ) => onChange({ ...settings, [key]: value });
  const themes: { value: ReaderTheme; label: string }[] = [
    { value: "light", label: "Light" },
    { value: "sepia", label: "Sepia" },
    { value: "dark", label: "Dark" },
  ];
  const visibleThemes = isComic ? themes.filter((theme) => theme.value !== "sepia") : themes;
  const activeTheme = isComic && settings.theme === "sepia" ? "light" : settings.theme;
  return (
    <div
      className="settings-panel"
      role="dialog"
      aria-label={t("Reader settings")}
      tabIndex={-1}
      ref={panelRef}
    >
      <div className="settings-appearance">
        <AppearanceControls compact showTheme={false} />
      </div>
      {fixedLayout && <p className="settings-note">{t("Fixed-layout EPUBs keep their original layout; text reflow is unavailable.")}</p>}
      {!isComic && <div className="settings-row">
        <label>
          <span>{t("Font size")}</span>
          <button type="button" className="settings-stepper" disabled={fixedLayout} onClick={() => update("fontSize", Math.max(12, settings.fontSize - 1))} aria-label={t("Decrease font size")}>−</button>
          <input
            type="range"
            min={12}
            max={36}
            step={1}
            value={settings.fontSize}
            disabled={fixedLayout}
            aria-label={t("Font size")}
            onChange={(event) => update("fontSize", Number(event.target.value))}
          />
          <button type="button" className="settings-stepper" disabled={fixedLayout} onClick={() => update("fontSize", Math.min(36, settings.fontSize + 1))} aria-label={t("Increase font size")}>+</button>
          <output>{settings.fontSize}px</output>
        </label>
      </div>}
      {!isComic && <div className="settings-row">
        <label>
          <span>{t("Line height")}</span>
          <input
            type="range"
            min={1.3}
            max={2.2}
            step={0.1}
            value={settings.lineHeight}
            disabled={fixedLayout}
            aria-label={t("Line height")}
            onChange={(event) => update("lineHeight", Number(event.target.value))}
          />
          <output>{settings.lineHeight.toFixed(1)}</output>
        </label>
      </div>}
      {!isComic && <div className="settings-row">
        <label>
          <span>{t("Margin")}</span>
          <input
            type="range"
            min={0}
            max={48}
            step={2}
            value={settings.margin}
            disabled={fixedLayout}
            aria-label={t("Margin")}
            onChange={(event) => update("margin", Number(event.target.value))}
          />
          <output>{settings.margin}px</output>
        </label>
      </div>}
      {isComic && <>
        <div className="settings-row">
          <span>{t("Image size")}</span>
          <div className="theme-options" role="group" aria-label={t("Image size")}>
            {(["fit-screen", "fit-width", "custom"] as ComicScaleMode[]).map((mode) => (
              <button
                key={mode}
                type="button"
                className={comicSettings.mode === mode ? "is-active" : ""}
                aria-pressed={comicSettings.mode === mode}
                onClick={() => onComicChange({ ...comicSettings, mode })}
              >
                {t(mode === "fit-screen" ? "Fit screen" : mode === "fit-width" ? "Fit width" : "Custom zoom")}
              </button>
            ))}
          </div>
        </div>
        {comicSettings.mode === "custom" && <div className="settings-row">
          <label>
            <span>{t("Zoom")}</span>
            <button type="button" className="settings-stepper" onClick={() => onComicChange({ ...comicSettings, scale: Math.max(50, comicSettings.scale - 10) })} aria-label={t("Decrease zoom")}>−</button>
            <input type="range" min={50} max={300} step={10} value={comicSettings.scale} aria-label={t("Zoom")} onChange={(event) => onComicChange({ ...comicSettings, scale: Number(event.target.value) })} />
            <button type="button" className="settings-stepper" onClick={() => onComicChange({ ...comicSettings, scale: Math.min(300, comicSettings.scale + 10) })} aria-label={t("Increase zoom")}>+</button>
            <output>{comicSettings.scale}%</output>
          </label>
        </div>}
        <button type="button" className="settings-reset" onClick={() => onComicChange({ mode: "fit-screen", scale: 100 })}>{t("Reset")}</button>
      </>}
      <div className="settings-row">
        <span>{t("Theme")}</span>
        <div className="theme-options" role="group" aria-label={t("Theme")}>
          {visibleThemes.map((theme) => (
            <button
              key={theme.value}
              type="button"
              className={activeTheme === theme.value ? "is-active" : ""}
              aria-pressed={activeTheme === theme.value}
                onClick={() => update("theme", theme.value)}
            >
              {t(theme.label)}
            </button>
          ))}
        </div>
      </div>
      {showEncoding && (
        <div className="settings-row">
          <label>
            <span>{t("Encoding")}</span>
            <select
              value={encoding}
              aria-label={t("Encoding")}
              onChange={(event) => onEncodingChange(event.target.value)}
            >
              {TXT_ENCODINGS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label === "Auto" ? t("Auto") : option.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      <button type="button" className="settings-close" onClick={onClose}>
        {t("Done")}
      </button>
    </div>
  );
}
