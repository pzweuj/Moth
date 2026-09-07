import { useCallback, useEffect, useRef, useState } from "react";
import type { BookDetail, ProgressBody } from "../api";
import { bookFileUrl, fetchWithTimeout } from "../api";
import type { FoliateBook, FoliateViewElement } from "../../vendor/foliate-js/view.js";
import "../../vendor/foliate-js/view.js";
import { makeRangeLoader } from "./zipLoader";
import { FOLIATE_PARSER_VERSION, TextPublication } from "./textPublication";
import { readerCss } from "./readerCss";
import type { ReaderSettings } from "./settings";
import { getOfflineChapterIndices, saveOfflineChapter, saveOfflineResource } from "../offline/db";
import { sanitizeBookDocument } from "./bookSanitizer";
import { installTapNavigation } from "./readerInteractions";
import { translateError, useUi } from "../i18n";
import { ReaderTapHint } from "./ReaderTapHint";

interface FoliateTextReaderProps {
  detail: BookDetail;
  settings: ReaderSettings;
  /** Optional explicit encoding for TXT decoding (reparses on change). */
  encoding?: string;
  onProgress: (progress: ProgressBody) => void;
  /** Reports whether an EPUB declares a fixed (pre-paginated) layout. */
  onLayoutChange?: (fixedLayout: boolean) => void;
  onBack?: () => void;
}

type TocEntry = { label: string; href?: string; level: number };

function flattenToc(value: unknown, level = 0): TocEntry[] {
  if (!Array.isArray(value)) return [];
  const result: TocEntry[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const entry = item as { label?: unknown; href?: unknown; children?: unknown; subitems?: unknown };
    if (typeof entry.href === "string") {
      result.push({
        label: typeof entry.label === "string" ? entry.label : "",
        href: entry.href,
        level,
      });
    } else if (typeof entry.label === "string") {
      // Foliate uses linkless entries as directory/group headings. Preserve
      // those labels while still recursing into their descendants.
      result.push({ label: entry.label, level });
    }
    result.push(...flattenToc(entry.subitems ?? entry.children, level + 1));
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

type FoliateSection = {
  id?: unknown;
  load?: () => Promise<unknown>;
};

function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

async function blobDataUrl(blob: Blob): Promise<string> {
  const mime = blob.type || "application/octet-stream";
  return `data:${mime};base64,${base64FromBytes(new Uint8Array(await blob.arrayBuffer()))}`;
}

/**
 * Foliate replaces archive resources with temporary blob URLs. Persisting
 * those URLs would make a cached section unusable after reload, so materialize
 * the small set of URLs referenced by the section before writing IndexedDB.
 * CSS is expanded recursively so fonts and background images survive too.
 */
async function materializeBlobUrls(value: string, seen = new Set<string>(), signal?: AbortSignal): Promise<string | null> {
  const urls = [...new Set(value.match(/blob:[^"'\s)<>]+/g) ?? [])];
  let result = value;
  for (const url of urls) {
    if (seen.has(url)) return null;
    seen.add(url);
    try {
      const response = await fetch(url, { signal });
      if (!response.ok) return null;
      const blob = await response.blob();
      let replacement: string;
      if (blob.type.toLowerCase().split(";", 1)[0] === "text/css") {
        const css = await materializeBlobUrls(await blob.text(), seen, signal);
        if (css === null) return null;
        replacement = await blobDataUrl(new Blob([css], { type: blob.type || "text/css" }));
      } else {
        replacement = await blobDataUrl(blob);
      }
      result = result.split(url).join(replacement);
    } finally {
      seen.delete(url);
    }
  }
  return result;
}

async function cacheFoliateSection(
  detail: BookDetail,
  index: number,
  url: string,
  fallbackTitle: string,
  pending: Set<number>,
  signal: AbortSignal,
): Promise<void> {
  if (pending.has(index)) return;
  pending.add(index);
  try {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`Could not read rendered section (${response.status}).`);
    const materialized = await materializeBlobUrls(await response.text(), new Set<string>(), signal);
    if (materialized === null) throw new Error("A rendered section resource could not be cached.");
    const document = new DOMParser().parseFromString(materialized, "text/html");
    sanitizeBookDocument(document);
    const title = document.querySelector("title")?.textContent?.trim()
      || fallbackTitle
      || `Chapter ${index + 1}`;
    // Keep stylesheet elements from the rendered head while storing a body
    // fragment; TextPublication will add the per-unit CSP on reconstruction.
    const head = document.head
      ? Array.from(document.head.children)
        .filter((element) => element.tagName.toLowerCase() === "style" || element.tagName.toLowerCase() === "link")
        .map((element) => element.outerHTML)
        .join("")
      : "";
    const content = `${head}${document.body?.innerHTML ?? materialized}`;
    await saveOfflineChapter(
      detail.id,
      detail.content_version,
      index,
      "",
      { title, content },
      FOLIATE_PARSER_VERSION,
    );
  } catch {
    // Caching is best effort. The online section remains usable, and a later
    // visit can retry the same unit after its resources are available.
  } finally {
    pending.delete(index);
  }
}

/** Cache the actual Foliate section instead of guessing a server chapter. */
function installFoliateSectionCache(book: FoliateBook, detail: BookDetail, signal: AbortSignal): void {
  const sections = (book as unknown as { sections?: FoliateSection[] }).sections;
  if (!Array.isArray(sections)) return;
  const pending = new Set<number>();
  sections.forEach((section, index) => {
    if (typeof section.load !== "function") return;
    const original = section.load.bind(section);
    section.load = async () => {
      const loaded = await original();
      if (typeof loaded === "string" && loaded.startsWith("blob:")) {
        void cacheFoliateSection(
          detail,
          index,
          loaded,
          detail.chapters[index]?.title || (typeof section.id === "string" ? section.id : ""),
          pending,
          signal,
        );
      }
      return loaded;
    };
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
  onLayoutChange,
  onBack,
}: FoliateTextReaderProps) {
  const { t } = useUi();
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<FoliateViewElement | null>(null);
  const publicationRef = useRef<TextPublication | null>(null);
  const onProgressRef = useRef(onProgress);
  const onLayoutChangeRef = useRef(onLayoutChange);
  onProgressRef.current = onProgress;
  onLayoutChangeRef.current = onLayoutChange;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const restoredRef = useRef(false);
  const [toc, setToc] = useState<TocEntry[]>([]);
  const [tocOpen, setTocOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    const requestController = new AbortController();
    restoredRef.current = false;
    let view: FoliateViewElement | null = null;
    let removeTapNavigation: (() => void) | undefined;
    let zipLoader: Awaited<ReturnType<typeof makeRangeLoader>> | null = null;
    const reportPublicationError = (error: unknown) => {
      if (cancelled) return;
      // Keep the original error object so a later language switch can render
      // the same stable API code in the newly selected locale.
      setError(error);
    };
    let publication: TextPublication | null = detail.format === "txt"
      ? new TextPublication(detail, encoding)
      : null;
    if (publication) publication.onError = reportPublicationError;
    publicationRef.current = publication;

    const open = async () => {
      const element = document.createElement(
        "foliate-view",
      ) as unknown as FoliateViewElement;
      view = element;
      host.append(element);
      removeTapNavigation = installTapNavigation(element, {
        previous: () => { void element.prev(); },
        next: () => { void element.next(); },
      });

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
      } else {
        // When the server is unavailable, a partial chapter cache can still
        // provide a usable Foliate publication. It intentionally exposes only
        // the units that have already been read; a missing unit reports the
        // explicit "needs internet" error from TextPublication.
        let cachedParserVersion = detail.format === "txt" ? undefined : FOLIATE_PARSER_VERSION;
        let cachedIndices = await getOfflineChapterIndices(
          detail.id,
          detail.content_version,
          detail.format === "txt" ? encoding : "",
          cachedParserVersion,
        ).catch(() => []);
        // Older builds stored server-rendered EPUB/MOBI chapters under the
        // TXT parser key. Keep those units readable during the transition,
        // while all new Foliate sections use their own cache schema.
        if (!cachedIndices.length && detail.format !== "txt") {
          const legacyIndices = await getOfflineChapterIndices(
            detail.id,
            detail.content_version,
            "",
            "txt-v1",
          ).catch(() => []);
          if (legacyIndices.length) {
            cachedIndices = legacyIndices;
            cachedParserVersion = "txt-v1";
          }
        }
        const useCachedPublication = cachedIndices.length > 0 && (
          typeof navigator === "undefined" || !navigator.onLine
        );
        if (useCachedPublication) {
          publication = new TextPublication(detail, detail.format === "txt" ? encoding : undefined, cachedParserVersion);
          publication.onError = reportPublicationError;
          publicationRef.current = publication;
          book = publication as unknown as FoliateBook;
        } else {
          try {
            if (detail.format === "mobi") {
              const [{ MOBI }, fflate] = await Promise.all([
                import("../../vendor/foliate-js/mobi.js"),
                import("../../vendor/foliate-js/vendor/fflate.js"),
              ]);
              const res = await fetchWithTimeout(bookFileUrl(detail.id), {
                signal: requestController.signal,
                headers: { "If-Match": `"${detail.content_version}"` },
              });
              if (!res.ok) throw new Error(`Could not fetch the book (${res.status}).`);
              if (res.headers.get("etag")?.trim() !== `"${detail.content_version}"`) {
                throw new Error("The book changed while it was opening. Refresh and try again.");
              }
              const file = new File([await res.blob()], detail.title || "book.mobi");
              book = await new MOBI({ unzlib: fflate.unzlibSync }).open(file);
            } else {
              const { EPUB } = await import("../../vendor/foliate-js/epub.js");
              zipLoader = await makeRangeLoader(
                bookFileUrl(detail.id),
                undefined,
                requestController.signal,
                detail.content_version,
                (filename, blob) => {
                  if (requestController.signal.aborted) return;
                  void saveOfflineResource(detail.id, detail.content_version, filename, blob, blob.type, filename).catch(() => undefined);
                },
              );
              book = await new EPUB(zipLoader).init();
            }
          } catch (error) {
            let fallbackParserVersion = detail.format === "txt" ? undefined : FOLIATE_PARSER_VERSION;
            let fallbackIndices = await getOfflineChapterIndices(
              detail.id,
              detail.content_version,
              detail.format === "txt" ? encoding : "",
              fallbackParserVersion,
            ).catch(() => []);
            if (!fallbackIndices.length && detail.format !== "txt") {
              fallbackIndices = await getOfflineChapterIndices(
                detail.id,
                detail.content_version,
                "",
                "txt-v1",
              ).catch(() => []);
              if (fallbackIndices.length) fallbackParserVersion = "txt-v1";
            }
            if (!fallbackIndices.length) throw error;
            publication = new TextPublication(detail, detail.format === "txt" ? encoding : undefined, fallbackParserVersion);
            publication.onError = reportPublicationError;
            publicationRef.current = publication;
            book = publication as unknown as FoliateBook;
          }
        }
      }

      installBookTransformGuards(book);
      const isFixedLayout = (book as unknown as { rendition?: { layout?: string } }).rendition?.layout === "pre-paginated";
      onLayoutChangeRef.current?.(isFixedLayout);
      if (detail.format !== "txt" && !publication) installFoliateSectionCache(book, detail, requestController.signal);

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
        const chapterIndex = typeof section.current === "number" ? section.current : 0;
        onProgressRef.current({
          chapter_index: chapterIndex,
          page_index: typeof page.current === "number" ? page.current : 0,
          percent: Math.min(100, Math.max(0, fraction * 100)),
          cfi: typeof location.cfi === "string" ? location.cfi : undefined,
        });
      });

      await element.open(book);
      if (cancelled) return;
      viewRef.current = element;

      // The renderer is created by `open()`, so layout settings apply after.
      // Fixed-layout EPUBs use `foliate-fxl`, which intentionally has no
      // `setStyles` method: injecting reflow CSS there would both crash the
      // reader and violate the publication's fixed geometry.
      const renderer = element.renderer as typeof element.renderer & { setStyles?: (css: string) => void };
      if (typeof renderer.setStyles === "function") {
        renderer.setAttribute("flow", "paginated");
        renderer.setAttribute("margin", `${settingsRef.current.margin}px`);
        renderer.setStyles(readerCss(settingsRef.current));
      }

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
      setError(err);
      setLoading(false);
    });

    return () => {
      cancelled = true;
      restoredRef.current = false;
      requestController.abort();
      removeTapNavigation?.();
      void zipLoader?.close().catch(() => undefined);
      view?.close();
      view?.remove();
      viewRef.current = null;
      onLayoutChangeRef.current?.(false);
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
    const renderer = view.renderer as typeof view.renderer & { setStyles?: (css: string) => void };
    // Fixed-layout EPUB renderers preserve their own page geometry and do
    // not expose style injection. Theme controls still affect the outer
    // reader chrome through the app-level theme.
    if (typeof renderer.setStyles !== "function") return;
    const currentLocation = view.lastLocation?.cfi
      ?? (typeof view.lastLocation?.fraction === "number" ? { fraction: view.lastLocation.fraction } : undefined);
    renderer.setStyles(readerCss(settings));
    renderer.setAttribute("margin", `${settings.margin}px`);
    // Changing font metrics causes Foliate to reflow its columns. Re-resolve
    // the current CFI/fraction after the reflow so a slider change does not
    // unexpectedly jump to the beginning of a chapter.
    if (currentLocation !== undefined) {
      requestAnimationFrame(() => {
        if (viewRef.current === view) void view.goTo(currentLocation);
      });
    }
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
      <ReaderTapHint />
      <div ref={hostRef} className="reader-host" />
      {loading && <div className="reader-loading">{t("Opening…")}</div>}
      {error !== null && (
        <div className="reader-error">
            <p>{translateError(error, t)}</p>
          <button type="button" onClick={() => {
            if (onBack) onBack();
            else window.history.back();
          }}>
            {t("Back to library")}
          </button>
        </div>
      )}
      <div className="reader-bottom-bar" data-reader-controls="true">
        <button type="button" onClick={prev} disabled={loading || !!error} aria-label={t("Previous page")}>
          ← {t("Prev")}
        </button>
        {toc.length > 0 && (
        <button
          type="button"
          ref={tocButtonRef}
          onClick={() => setTocOpen((open) => !open)}
          aria-expanded={tocOpen}
          aria-label={t("Contents")}
        >
          {t("Contents")}
        </button>
        )}
        <button type="button" onClick={next} disabled={loading || !!error} aria-label={t("Next page")}>
          {t("Next")} →
        </button>
      </div>
      {tocOpen && toc.length > 0 && (
        <div
          className="reader-toc"
          role="dialog"
          aria-label={t("Contents")}
          tabIndex={-1}
          ref={tocListRef}
        >
          <div className="reader-toc-head">
            <span>{t("Contents")}</span>
            <button type="button" onClick={() => setTocOpen(false)} aria-label={t("Close contents")}>
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
                    if (item.href) goTo(item.href);
                    setTocOpen(false);
                  }}
                  disabled={!item.href}
                >
                  {item.label || `${t("Chapter")} ${index + 1}`}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
