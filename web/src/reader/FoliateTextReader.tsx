import { useCallback, useEffect, useRef, useState } from "react";
import type { BookDetail, ProgressBody } from "../api";
import { bookFileUrl } from "../api";
import type { FoliateBook, FoliateViewElement } from "../../vendor/foliate-js/view.js";
import "../../vendor/foliate-js/view.js";
import { makeRangeLoader } from "./zipLoader";
import { TextPublication } from "./textPublication";
import { readerCss } from "./readerCss";
import type { ReaderSettings } from "./settings";
import { getOfflineFile } from "../offline/db";
import { sanitizeBookDocument } from "./bookSanitizer";

interface FoliateTextReaderProps {
  detail: BookDetail;
  settings: ReaderSettings;
  /** Optional explicit encoding for TXT decoding (reparses on change). */
  encoding?: string;
  onProgress: (progress: ProgressBody) => void;
}

type TocEntry = { label: string; href: string; level: number };

function flattenToc(value: unknown, level = 0): TocEntry[] {
  if (!Array.isArray(value)) return [];
  const result: TocEntry[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const entry = item as { label?: unknown; href?: unknown; children?: unknown };
    if (typeof entry.href === "string") {
      result.push({
        label: typeof entry.label === "string" ? entry.label : "",
        href: entry.href,
        level,
      });
    }
    result.push(...flattenToc(entry.children, level + 1));
  }
  return result;
}

/**
 * Sanitize Foliate's HTML before it becomes an iframe Blob URL. The later
 * iframe load listener remains as defense in depth, while this transform
 * prevents external styles/resources from starting before the CSP is present.
 */
function installBookTransformGuards(book: FoliateBook): void {
  const target = (book as unknown as { transformTarget?: EventTarget }).transformTarget;
  if (!target) return;
  target.addEventListener("load", (event: Event) => {
    const detail = (event as CustomEvent<{ isScript?: boolean; allow?: boolean }>).detail;
    if (detail?.isScript) detail.allow = false;
  });
  target.addEventListener("data", (event: Event) => {
    const detail = (event as CustomEvent<{ data?: unknown; type?: string }>).detail;
    if (!detail || typeof detail.data === "undefined") return;
    const type = detail.type?.toLowerCase() ?? "";
    if (!type.includes("html") && !type.includes("xhtml")) return;
    detail.data = Promise.resolve(detail.data).then((value) => {
      if (typeof value !== "string") return value;
      let document = new DOMParser().parseFromString(
        value,
        type.includes("xhtml") ? "application/xhtml+xml" : "text/html",
      );
      // Some MOBI/KF8 records are HTML fragments labelled as XHTML without
      // being well-formed XML. Falling back to HTML parsing is safer than
      // returning the unsanitized source in that case.
      if (document.querySelector("parsererror")) {
        document = new DOMParser().parseFromString(value, "text/html");
      }
      sanitizeBookDocument(document);
      return new XMLSerializer().serializeToString(document);
    });
  });
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
  const restoredRef = useRef(false);
  const [toc, setToc] = useState<TocEntry[]>([]);
  const [tocOpen, setTocOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    const requestController = new AbortController();
    restoredRef.current = false;
    let view: FoliateViewElement | null = null;
    let zipLoader: Awaited<ReturnType<typeof makeRangeLoader>> | null = null;
    const publication =
      detail.format === "txt" ? new TextPublication(detail, encoding) : null;
    publicationRef.current = publication;

    const open = async () => {
      const element = document.createElement(
        "foliate-view",
      ) as unknown as FoliateViewElement;
      view = element;
      host.append(element);

      // EPUB/MOBI documents are user-provided HTML. The vendored renderer
      // already runs them in a sandbox; this second layer removes active
      // elements, event attributes and dangerous URLs before the document is
      // exposed to the reader.
      element.addEventListener("load", (event: Event) => {
        const document = (event as CustomEvent<{ doc?: Document }>).detail?.doc;
        if (document) sanitizeBookDocument(document);
      });
      // Do not let untrusted book links escape the reader. Internal chapter
      // links are still handled by Foliate's navigation layer.
      element.addEventListener("external-link", (event: Event) => {
        event.preventDefault();
      });

      let book: FoliateBook;
      if (publication) {
        book = publication as unknown as FoliateBook;
      } else if (detail.format === "mobi") {
        const [{ MOBI }, fflate] = await Promise.all([
          import("../../vendor/foliate-js/mobi.js"),
          import("../../vendor/foliate-js/vendor/fflate.js"),
        ]);
        const cached = await getOfflineFile(detail.id, detail.content_version);
        const res = cached ? null : await fetch(bookFileUrl(detail.id), {
          signal: requestController.signal,
          headers: { "If-Match": `"${detail.content_version}"` },
        });
        if (res && !res.ok) throw new Error(`Could not fetch the book (${res.status}).`);
        if (res && res.headers.get("etag")?.trim() !== `"${detail.content_version}"`) {
          throw new Error("The book changed while it was opening. Refresh and try again.");
        }
        const file = new File([cached ?? (await res!.blob())], detail.title || "book.mobi");
        book = await new MOBI({ unzlib: fflate.unzlibSync }).open(file);
      } else {
        const { EPUB } = await import("../../vendor/foliate-js/epub.js");
        const cached = await getOfflineFile(detail.id, detail.content_version);
        zipLoader = await makeRangeLoader(
          bookFileUrl(detail.id),
          cached ?? undefined,
          requestController.signal,
          detail.content_version,
        );
        book = await new EPUB(zipLoader).init();
      }

      installBookTransformGuards(book);

      if (cancelled) {
        publication?.destroy();
        return;
      }

      element.addEventListener("relocate", (event: Event) => {
        // Foliate emits relocation events while opening and restoring a book.
        // Do not persist those transient start positions before init() has
        // applied the saved CFI/fraction.
        if (!restoredRef.current) return;
        const location = (event as CustomEvent).detail ?? {};
        const fraction = typeof location.fraction === "number" ? location.fraction : 0;
        const section = location.section ?? {};
        const page = location.location ?? {};
        onProgressRef.current({
          chapter_index: typeof section.current === "number" ? section.current : 0,
          page_index: typeof page.current === "number" ? page.current : 0,
          percent: Math.min(100, Math.max(0, fraction * 100)),
          cfi: typeof location.cfi === "string" ? location.cfi : undefined,
        });
      });

      await element.open(book);
      if (cancelled) return;
      viewRef.current = element;

      // The renderer is created by `open()`, so layout settings apply after.
      element.renderer.setAttribute("flow", "paginated");
      element.renderer.setAttribute("margin", `${settingsRef.current.margin}px`);
      element.renderer.setStyles(readerCss(settingsRef.current));

      setToc(flattenToc(book.toc));

      const progress = detail.progress;
      let restored = false;
      if (progress?.cfi) {
        try {
          // Foliate resolves malformed or stale CFIs to `undefined` instead
          // of throwing. Check the navigation target first, then keep a
          // percentage fallback for a changed publication or broken CFI.
          if (element.resolveNavigation(progress.cfi)) {
            await element.init({ lastLocation: progress.cfi });
            restored = true;
          }
        } catch {
          // Fall through to percentage restoration below.
        }
      }
      if (!restored && progress && progress.percent > 0) {
        await element.init({
          lastLocation: { fraction: Math.min(1, Math.max(0, progress.percent / 100)) },
        });
        restored = true;
      }
      if (!restored) await element.init({ showTextStart: true });
      if (!cancelled) {
        restoredRef.current = true;
        setLoading(false);
      }
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
      restoredRef.current = false;
      requestController.abort();
      void zipLoader?.close().catch(() => undefined);
      view?.close();
      view?.remove();
      viewRef.current = null;
      publication?.destroy();
      publicationRef.current = null;
    };
    // `encoding` reopens the book so a manual TXT encoding change takes effect
    // immediately. `detail` carries the book identity and progress.
    // Progress and metadata refreshes must not tear down an open book. A
    // content-version or encoding change deliberately reopens it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.id, detail.format, detail.content_version, encoding]);

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
      const target = event.target as HTMLElement | null;
      if (target?.closest("button, a, input, select, textarea, [contenteditable], .settings-panel")) {
        return;
      }
      const view = viewRef.current;
      if (!view) return;
      if (event.key === "ArrowRight" || event.key === "PageDown") {
        event.preventDefault();
        void view.next();
      } else if (event.key === "ArrowLeft" || event.key === "PageUp") {
        event.preventDefault();
        void view.prev();
      } else if (event.key === " ") {
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
                  style={{ paddingLeft: `${10 + item.level * 16}px` }}
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
