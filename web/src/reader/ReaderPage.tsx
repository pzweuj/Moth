import { useCallback, useEffect, useRef, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, type ProgressBody } from "../api";
import {
  loadSettings,
  saveSettings,
  type ReaderSettings,
  type ReaderTheme,
} from "./settings";
import { FoliateTextReader } from "./FoliateTextReader";
import { ComicReader } from "./ComicReader";

const SAVE_DELAY_MS = 1500;

export function ReaderPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const bookId = Number(id);
  const [settings, setSettings] = useState<ReaderSettings>(loadSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const timerRef = useRef<number | null>(null);
  const pendingRef = useRef<ProgressBody | null>(null);

  const detail = useQuery({
    queryKey: ["book", bookId],
    queryFn: () => api.getBook(bookId),
    enabled: Number.isInteger(bookId) && bookId > 0,
  });

  useEffect(() => saveSettings(settings), [settings]);

  const flushProgress = useCallback(() => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const pending = pendingRef.current;
    if (pending) {
      pendingRef.current = null;
      void api.putProgress(bookId, pending);
    }
  }, [bookId]);

  // Save the latest location on a debounce, and flush it on unmount so a
  // reader closed mid-session still persists its place.
  const onProgress = useCallback(
    (progress: ProgressBody) => {
      pendingRef.current = progress;
      if (timerRef.current != null) return;
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        const value = pendingRef.current;
        if (value) {
          pendingRef.current = null;
          void api.putProgress(bookId, value);
        }
      }, SAVE_DELAY_MS);
    },
    [bookId],
  );

  useEffect(() => flushProgress, [flushProgress]);

  if (!Number.isInteger(bookId) || bookId <= 0) {
    return <Navigate to="/" replace />;
  }

  if (detail.isPending) {
    return (
      <main className="state-screen">
        <span className="spinner" aria-hidden="true" />
        <p>Opening your book…</p>
      </main>
    );
  }

  const book = detail.data;
  if (detail.isError || !book) {
    return (
      <main className="state-screen">
        <p className="eyebrow">Moth / reader</p>
        <h1>Book unavailable</h1>
        <p>This book could not be opened.</p>
        <button
          className="primary-button compact-button"
          type="button"
          onClick={() => navigate("/")}
        >
          Back to library
        </button>
      </main>
    );
  }

  return (
    <main className="reader-shell">
      <header className="reader-top-bar">
        <button type="button" onClick={() => navigate("/")}>
          ← Library
        </button>
        <span className="reader-title">{book.title}</span>
        <span className="format-badge">{book.format}</span>
        <button
          type="button"
          onClick={() => setSettingsOpen((open) => !open)}
          aria-expanded={settingsOpen}
          aria-label="Reader settings"
        >
          Aa
        </button>
      </header>
      {settingsOpen && (
        <SettingsPanel
          settings={settings}
          onChange={setSettings}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {book.format === "cbz" ? (
        <ComicReader detail={book} onProgress={onProgress} />
      ) : (
        <FoliateTextReader detail={book} settings={settings} onProgress={onProgress} />
      )}
    </main>
  );
}

function SettingsPanel({
  settings,
  onChange,
  onClose,
}: {
  settings: ReaderSettings;
  onChange: (settings: ReaderSettings) => void;
  onClose: () => void;
}) {
  const update = <K extends keyof ReaderSettings>(
    key: K,
    value: ReaderSettings[K],
  ) => onChange({ ...settings, [key]: value });
  const themes: { value: ReaderTheme; label: string }[] = [
    { value: "light", label: "Light" },
    { value: "sepia", label: "Sepia" },
    { value: "dark", label: "Dark" },
  ];
  return (
    <div className="settings-panel" role="dialog" aria-label="Reader settings">
      <div className="settings-row">
        <label>
          <span>Font size</span>
          <input
            type="range"
            min={12}
            max={28}
            step={1}
            value={settings.fontSize}
            onChange={(event) => update("fontSize", Number(event.target.value))}
          />
          <output>{settings.fontSize}px</output>
        </label>
      </div>
      <div className="settings-row">
        <label>
          <span>Line height</span>
          <input
            type="range"
            min={1.3}
            max={2.2}
            step={0.1}
            value={settings.lineHeight}
            onChange={(event) => update("lineHeight", Number(event.target.value))}
          />
          <output>{settings.lineHeight.toFixed(1)}</output>
        </label>
      </div>
      <div className="settings-row">
        <label>
          <span>Margin</span>
          <input
            type="range"
            min={0}
            max={48}
            step={2}
            value={settings.margin}
            onChange={(event) => update("margin", Number(event.target.value))}
          />
          <output>{settings.margin}px</output>
        </label>
      </div>
      <div className="settings-row">
        <span>Theme</span>
        <div className="theme-options" role="group" aria-label="Theme">
          {themes.map((theme) => (
            <button
              key={theme.value}
              type="button"
              className={settings.theme === theme.value ? "is-active" : ""}
              onClick={() => update("theme", theme.value)}
            >
              {theme.label}
            </button>
          ))}
        </div>
      </div>
      <button type="button" className="settings-close" onClick={onClose}>
        Done
      </button>
    </div>
  );
}
