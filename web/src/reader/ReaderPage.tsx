import { useCallback, useEffect, useRef, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
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

const SAVE_LABELS: Record<string, string> = {
  saving: "Saving…",
  saved: "Saved",
  error: "Save failed",
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

export function ReaderPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const bookId = Number(id);
  const [settings, setSettings] = useState<ReaderSettings>(loadSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [encoding, setEncoding] = useState("");
  const [position, setPosition] = useState<ProgressBody | null>(null);

  const valid = Number.isInteger(bookId) && bookId > 0;
  const { onProgress, saveState } = useProgressSaver(valid ? bookId : 0);

  const handleProgress = useCallback(
    (progress: ProgressBody) => {
      setPosition(progress);
      onProgress(progress);
    },
    [onProgress],
  );

  const detail = useQuery({
    queryKey: ["book", bookId],
    queryFn: () => api.getBook(bookId),
    enabled: valid,
  });

  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

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
        {position && (
          <span className="reader-position">{Math.round(position.percent)}%</span>
        )}
        {saveState !== "idle" && (
          <span className={`save-indicator ${saveState}`} aria-live="polite">
            {SAVE_LABELS[saveState]}
          </span>
        )}
        <span className="format-badge">{book.format}</span>
        <button
          type="button"
          ref={settingsButtonRef}
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
          panelRef={settingsPanelRef}
          showEncoding={book.format === "txt"}
          encoding={encoding}
          onEncodingChange={setEncoding}
        />
      )}
      <ErrorBoundary
        key={book.id}
        fallback={(error) => (
          <div className="reader-error">
            <p>{error.message || "This book could not be displayed."}</p>
            <button type="button" onClick={() => navigate("/")}>
              Back to library
            </button>
          </div>
        )}
      >
        {book.format === "cbz" ? (
          <ComicReader detail={book} onProgress={handleProgress} />
        ) : (
          <FoliateTextReader
            detail={book}
            settings={settings}
            encoding={encoding}
            onProgress={handleProgress}
          />
        )}
      </ErrorBoundary>
    </main>
  );
}

function SettingsPanel({
  settings,
  onChange,
  onClose,
  panelRef,
  showEncoding,
  encoding,
  onEncodingChange,
}: {
  settings: ReaderSettings;
  onChange: (settings: ReaderSettings) => void;
  onClose: () => void;
  panelRef: React.RefObject<HTMLDivElement | null>;
  showEncoding: boolean;
  encoding: string;
  onEncodingChange: (encoding: string) => void;
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
    <div
      className="settings-panel"
      role="dialog"
      aria-label="Reader settings"
      tabIndex={-1}
      ref={panelRef}
    >
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
      {showEncoding && (
        <div className="settings-row">
          <label>
            <span>Encoding</span>
            <select
              value={encoding}
              onChange={(event) => onEncodingChange(event.target.value)}
            >
              {TXT_ENCODINGS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      <button type="button" className="settings-close" onClick={onClose}>
        Done
      </button>
    </div>
  );
}
