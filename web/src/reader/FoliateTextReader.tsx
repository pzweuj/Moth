import { useCallback, useEffect, useRef, useState } from "react";
import type { BookDetail, ProgressBody } from "../api";
import { bookFileUrl } from "../api";
import type { FoliateBook, FoliateViewElement } from "../../vendor/foliate-js/view.js";
import "../../vendor/foliate-js/view.js";
import { makeRangeLoader } from "./zipLoader";
import { TextPublication } from "./textPublication";
import { readerCss } from "./readerCss";
import type { ReaderSettings } from "./settings";

interface FoliateTextReaderProps {
  detail: BookDetail;
  settings: ReaderSettings;
  /** Optional explicit encoding for TXT decoding (reparses on change). */
  encoding?: string;
  onProgress: (progress: ProgressBody) => void;
}

/**
 * Reflowable reader (EPUB / MOBI / TXT) built on the vendored foliate-js
 * `foliate-view` element. EPUB and MOBI parse the raw file client-side (EPUB
 * over HTTP Range via zip.js); TXT is wrapped in a `TextPublication` that
 * implements the foliate book interface over Moth's chapter API.
 */
export function FoliateTextReader({
  detail,
  settings,
  encoding,
  onProgress,
}: FoliateTextReaderProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<FoliateViewElement | null>(null);
  const publicationRef = useRef<TextPublication | null>(null);
  const onProgressRef = useRef(onProgress);
  onProgressRef.current = onProgress;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const [toc, setToc] = useState<{ label: string; href: string }[]>([]);
  const [tocOpen, setTocOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let view: FoliateViewElement | null = null;
    const publication =
      detail.format === "txt" ? new TextPublication(detail, encoding) : null;
    publicationRef.current = publication;

    const open = async () => {
      const element = document.createElement(
        "foliate-view",
      ) as unknown as FoliateViewElement;
      view = element;
      host.append(element);

      let book: FoliateBook;
      if (publication) {
        book = publication as unknown as FoliateBook;
      } else if (detail.format === "mobi") {
        const [{ MOBI }, fflate] = await Promise.all([
          import("../../vendor/foliate-js/mobi.js"),
          import("../../vendor/foliate-js/vendor/fflate.js"),
        ]);
        const res = await fetch(bookFileUrl(detail.id));
        if (!res.ok) throw new Error(`Could not fetch the book (${res.status}).`);
        const file = new File([await res.blob()], detail.title || "book.mobi");
        book = await new MOBI({ unzlib: fflate.unzlibSync }).open(file);
      } else {
        const { EPUB } = await import("../../vendor/foliate-js/epub.js");
        const loader = await makeRangeLoader(bookFileUrl(detail.id));
        book = await new EPUB(loader).init();
      }

      if (cancelled) {
        publication?.destroy();
        return;
      }

      element.addEventListener("relocate", (event: Event) => {
        const location = (event as CustomEvent).detail ?? {};
        const fraction = typeof location.fraction === "number" ? location.fraction : 0;
        const section = location.section ?? {};
        const page = location.location ?? {};
        onProgressRef.current({
          chapter_index: typeof section.current === "number" ? section.current : 0,
          page_index: typeof page.current === "number" ? page.current : 0,
          percent: Math.min(100, Math.max(0, fraction * 100)),
        });
      });

      await element.open(book);
      if (cancelled) return;
      viewRef.current = element;

      // The renderer is created by `open()`, so layout settings apply after.
      element.renderer.setAttribute("flow", "paginated");
      element.renderer.setAttribute("margin", `${settingsRef.current.margin}px`);
      element.renderer.setStyles(readerCss(settingsRef.current));

      const bookToc = book.toc as unknown;
      setToc(
        Array.isArray(bookToc)
          ? (bookToc as { label: string; href: string }[])
          : [],
      );

      const progress = detail.progress;
      if (progress && progress.percent > 0) {
        await element.init({ lastLocation: { fraction: progress.percent / 100 } });
      } else {
        await element.init({ showTextStart: true });
      }
      if (!cancelled) setLoading(false);
    };

    setLoading(true);
    setError(null);
    open().catch((err: unknown) => {
      if (cancelled) return;
      console.error("could not open book", err);
      setError(err instanceof Error ? err.message : "Could not open this book.");
      setLoading(false);
    });

    return () => {
      cancelled = true;
      view?.close();
      view?.remove();
      viewRef.current = null;
      publication?.destroy();
      publicationRef.current = null;
    };
    // `encoding` reopens the book so a manual TXT encoding change takes effect
    // immediately. `detail` carries the book identity and progress.
  }, [detail, encoding]);

  // Apply setting changes to the open renderer.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.renderer.setStyles(readerCss(settings));
    view.renderer.setAttribute("margin", `${settings.margin}px`);
  }, [settings]);

  // Keyboard navigation (disabled while the contents drawer is open). Space
  // is only captured when nothing interactive is focused so it still
  // activates buttons.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (tocOpen) return;
      const view = viewRef.current;
      if (!view) return;
      if (event.key === "ArrowRight" || event.key === "PageDown") {
        event.preventDefault();
        void view.next();
      } else if (event.key === "ArrowLeft" || event.key === "PageUp") {
        event.preventDefault();
        void view.prev();
      } else if (event.key === " ") {
        const target = event.target as HTMLElement | null;
        if (target?.closest("button, a, input, select, textarea, [contenteditable]")) {
          return;
        }
        event.preventDefault();
        void view.next();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tocOpen]);

  // Escape closes the contents drawer; focus moves into it when it opens and
  // back to the toggle button when it closes.
  const tocButtonRef = useRef<HTMLButtonElement>(null);
  const tocListRef = useRef<HTMLDivElement>(null);
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (tocOpen) {
      tocListRef.current?.focus();
    } else if (wasOpenRef.current) {
      tocButtonRef.current?.focus();
    }
    wasOpenRef.current = tocOpen;
  }, [tocOpen]);
  useEffect(() => {
    if (!tocOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setTocOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tocOpen]);

  const goTo = useCallback((href: string) => {
    const view = viewRef.current;
    if (view) void view.goTo(href);
  }, []);

  const prev = useCallback(() => {
    void viewRef.current?.prev();
  }, []);
  const next = useCallback(() => {
    void viewRef.current?.next();
  }, []);

  return (
    <div className="reader-stage">
      <div ref={hostRef} className="reader-host" />
      {loading && <div className="reader-loading">Opening…</div>}
      {error && (
        <div className="reader-error">
          <p>{error}</p>
          <button type="button" onClick={() => window.history.back()}>
            Back to library
          </button>
        </div>
      )}
      <div className="reader-bottom-bar">
        <button type="button" onClick={prev} disabled={loading || !!error}>
          ← Prev
        </button>
        {toc.length > 0 && (
        <button
          type="button"
          ref={tocButtonRef}
          onClick={() => setTocOpen((open) => !open)}
          aria-expanded={tocOpen}
        >
          Contents
        </button>
        )}
        <button type="button" onClick={next} disabled={loading || !!error}>
          Next →
        </button>
      </div>
      {tocOpen && toc.length > 0 && (
        <div
          className="reader-toc"
          role="dialog"
          aria-label="Table of contents"
          tabIndex={-1}
          ref={tocListRef}
        >
          <div className="reader-toc-head">
            <span>Contents</span>
            <button type="button" onClick={() => setTocOpen(false)} aria-label="Close contents">
              ✕
            </button>
          </div>
          <ul>
            {toc.map((item, index) => (
              <li key={index}>
                <button
                  type="button"
                  onClick={() => {
                    goTo(item.href);
                    setTocOpen(false);
                  }}
                >
                  {item.label || `Chapter ${index + 1}`}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
