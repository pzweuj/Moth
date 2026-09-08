import { useCallback, useEffect, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import type { BookDetail, ProgressBody } from "../api";
import { bookFileUrl } from "../api";
import { makeRangeLoader, type ZipLoader } from "./zipLoader";
import { sortComicEntries } from "./comicPages";
import { getOfflinePage, getOfflinePages, saveOfflinePage } from "../offline/db";
import type { ComicSettings } from "./comicSettings";
import { isMobileReadingLayout } from "./readerInteractions";
import { translateError, useUi } from "../i18n";
import { ReaderTapHint } from "./ReaderTapHint";

interface ComicReaderProps {
  detail: BookDetail;
  onProgress: (progress: ProgressBody) => void;
  settings: ComicSettings;
  onBack?: () => void;
  pagesOpen?: boolean;
  onPagesOpenChange?: (open: boolean) => void;
}

const THUMB_RADIUS = 3;

function mapPageNumbers(names: string[], serverPages?: string[]): number[] {
  if (!serverPages?.length) return names.map((_, index) => index);
  // Keep duplicate archive names deterministic by consuming each matching
  // server position once instead of using indexOf for every entry.
  const positions = new Map<string, number[]>();
  serverPages.forEach((name, index) => {
    const values = positions.get(name);
    if (values) values.push(index);
    else positions.set(name, [index]);
  });
  return names.map((name, index) => positions.get(name)?.shift() ?? index);
}

/**
 * CBZ reader. The archive is read over HTTP Range via zip.js and pages are
 * loaded lazily; the current page and nearby pages are prefetched, while the
 * page drawer requests visible thumbnails as they enter its scroll window.
 */
export function ComicReader({ detail, onProgress, settings, onBack, pagesOpen: controlledPagesOpen, onPagesOpenChange }: ComicReaderProps) {
  const { t } = useUi();
  const [pages, setPages] = useState<string[]>([]);
  const [index, setIndex] = useState(0);
  const [src, setSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown | null>(null);
  const [pageError, setPageError] = useState<unknown | null>(null);
  // Keep the page strip tucked away on touch layouts so the image gets the
  // full viewport by default. Desktop readers start with the panel visible.
  const [internalPagesOpen, setInternalPagesOpen] = useState(false);
  const [, refreshCache] = useState(0);

  const loaderRef = useRef<ZipLoader | null>(null);
  const urlsRef = useRef(new Map<number, string>());
  const inflightRef = useRef(new Map<number, Promise<Blob | null>>());
  const offlineOnlyRef = useRef(false);
  const generationRef = useRef(0);
  const restoredRef = useRef(false);
  const currentIndexRef = useRef(0);
  const pageNumbersRef = useRef<number[]>([]);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const touchHandledRef = useRef(false);
  const tapStartRef = useRef<{ x: number; y: number; time: number } | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const onProgressRef = useRef(onProgress);
  onProgressRef.current = onProgress;
  currentIndexRef.current = index;
  const pagesOpen = controlledPagesOpen ?? internalPagesOpen;
  const setPagesOpen = useCallback((open: boolean) => {
    onPagesOpenChange?.(open);
    if (controlledPagesOpen === undefined) setInternalPagesOpen(open);
  }, [controlledPagesOpen, onPagesOpenChange]);
  const loadPage = useCallback(async (pageIndex: number): Promise<string | null> => {
    const cached = urlsRef.current.get(pageIndex);
    if (cached) return cached;
    const inflight = inflightRef.current.get(pageIndex);
    if (inflight) {
      const blob = await inflight;
      return blob ? urlsRef.current.get(pageIndex) ?? null : null;
    }
    const loader = loaderRef.current;
    if (!loader && !offlineOnlyRef.current) return null;
    if (!pages[pageIndex]) return null;
    const generation = generationRef.current;
    const actualIndex = pageNumbersRef.current[pageIndex] ?? pageIndex;
    const promise = loader
      ? loader.loadBlob(pages[pageIndex])
      : getOfflinePage(detail.id, detail.content_version, actualIndex).then((page) => page?.data ?? null);
    inflightRef.current.set(pageIndex, promise);
    try {
      const blob = await promise;
      if (!blob) {
        throw new Error(
          offlineOnlyRef.current || (typeof navigator !== "undefined" && !navigator.onLine)
            ? "This page is not cached yet. Connect to the server to continue reading."
            : "Could not load this page.",
        );
      }
      if (generationRef.current !== generation) return null;
      if (loader && loaderRef.current !== loader) return null;
      if (!pagesOpen && Math.abs(pageIndex - currentIndexRef.current) > THUMB_RADIUS) return null;
      // A successful display is the cache boundary. Preloaded pages may also
      // be stored, but they never affect the progress percentage.
      void saveOfflinePage(detail.id, detail.content_version, actualIndex, blob, pages[pageIndex], blob.type).catch(() => undefined);
      const url = URL.createObjectURL(blob);
      urlsRef.current.set(pageIndex, url);
      refreshCache((value) => value + 1);
      return url;
    } finally {
      inflightRef.current.delete(pageIndex);
    }
  }, [detail.content_version, detail.id, pages, pagesOpen]);

  useEffect(() => {
    let cancelled = false;
    const requestController = new AbortController();
    setPages([]);
    setSrc(null);
    setIndex(0);
    setLoading(true);
    setError(null);
    setPageError(null);
    offlineOnlyRef.current = false;
    restoredRef.current = false;
    generationRef.current += 1;
    const generation = generationRef.current;
    const open = async () => {
      const cachedPages = await getOfflinePages(detail.id, detail.content_version).catch(() => []);
      let loader: ZipLoader | null = null;
      try {
        if (typeof navigator === "undefined" || navigator.onLine) {
          loader = await makeRangeLoader(
            bookFileUrl(detail.id),
            undefined,
            requestController.signal,
            detail.content_version,
          );
        }
      } catch (error) {
        if (cachedPages.length === 0) throw error;
      }
      if (!loader) {
        if (cachedPages.length === 0) throw new Error("This comic has no cached pages. Connect to the server to begin reading.");
        offlineOnlyRef.current = true;
      }
      if (cancelled) {
        await loader?.close().catch(() => undefined);
        return;
      }
      loaderRef.current = loader;
      const sortedEntries = loader ? sortComicEntries(loader.entries) : [];
      const names = loader
        ? sortedEntries.map((entry) => entry.filename)
        : (() => {
          // Keep the complete page sequence in the offline reader. Cached
          // pages remain selectable while a gap produces the explicit
          // "needs internet" error instead of silently jumping over an
          // uncached page (for example when progress came from another
          // device).
          const cachedByIndex = new Map(cachedPages.map((page) => [page.idx, page.name || String(page.idx)]));
          const total = Math.max(detail.page_count, detail.pages?.length ?? 0, ...cachedPages.map((page) => page.idx + 1), 0);
          return Array.from({ length: total }, (_, pageIndex) => detail.pages?.[pageIndex] ?? cachedByIndex.get(pageIndex) ?? String(pageIndex));
        })();
      pageNumbersRef.current = mapPageNumbers(names, detail.pages);
      if (names.length === 0) {
        loaderRef.current = null;
        await loader?.close().catch(() => undefined);
        throw new Error("No readable pages in this archive.");
      }
      setPages(names);
      const progress = detail.progress;
      const sameContent = !progress?.content_version
        || progress.content_version === detail.content_version;
      const restoredIndex = progress && sameContent
        ? pageNumbersRef.current.indexOf(progress.page_index)
        : -1;
      const start = progress
        ? sameContent
          ? (restoredIndex >= 0 ? restoredIndex : 0)
          : Math.round((Math.min(100, Math.max(0, progress.percent)) / 100) * (names.length - 1))
        : 0;
      setIndex(Math.min(Math.max(0, start), names.length - 1));
      if (generationRef.current !== generation) return;
      restoredRef.current = true;
      setLoading(false);
    };
    open().catch((err: unknown) => {
      if (cancelled) return;
      console.error("could not open comic", err);
      setError(err);
      setLoading(false);
    });
    const urls = urlsRef.current;
    const inflight = inflightRef.current;
    return () => {
      cancelled = true;
      restoredRef.current = false;
      generationRef.current += 1;
      requestController.abort();
      void loaderRef.current?.close().catch(() => undefined);
      loaderRef.current = null;
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
      inflight.clear();
    };
    // detail.progress is intentionally not a dependency: a progress refetch
    // must not tear down and reopen the archive mid-read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.id, detail.content_version]);

  // Load the current page image into an object URL.
  useEffect(() => {
    if (pages.length === 0) return;
    let cancelled = false;
    setSrc(urlsRef.current.get(index) ?? null);
    loadPage(index)
      .then((url) => {
        if (!cancelled && url) {
          setPageError(null);
          setSrc(url);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          console.error("page load failed", err);
          setPageError(err);
          setSrc(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [pages, index, loadPage]);

  // Preload the adjacent page and the thumbnail window around the current one.
  useEffect(() => {
    if (pages.length === 0) return;
    const loader = loaderRef.current;
    if (!loader && !offlineOnlyRef.current) return;
    const wanted = new Set<number>([index - 1, index + 1]);
    for (let i = index - THUMB_RADIUS; i <= index + THUMB_RADIUS; i++) {
      if (i >= 0 && i < pages.length) wanted.add(i);
    }
    for (const i of wanted) {
      if (i >= 0 && i < pages.length) void loadPage(i).catch(() => {
        // Adjacent and thumbnail failures are retried when selected.
      });
    }
    for (const [cachedIndex, url] of urlsRef.current) {
      if (cachedIndex < index - THUMB_RADIUS || cachedIndex > index + THUMB_RADIUS) {
        URL.revokeObjectURL(url);
        urlsRef.current.delete(cachedIndex);
      }
    }
    refreshCache((value) => value + 1);
  }, [pages, index, loadPage]);

  // Report progress whenever the page changes.
  useEffect(() => {
    if (pages.length === 0 || !restoredRef.current) return;
    const totalPages = detail.page_count > 0 ? detail.page_count : pages.length;
    onProgressRef.current({
      chapter_index: 0,
      page_index: pageNumbersRef.current[index] ?? index,
      percent: (((pageNumbersRef.current[index] ?? index) + 1) / totalPages) * 100,
    });
  }, [detail.page_count, pages, index]);

  // A newly selected page always starts at its top-left origin. This matters
  // when a custom zoom leaves a scroll position on the previous image.
  useEffect(() => {
    const viewport = viewportRef.current;
    viewport?.scrollTo?.({ left: 0, top: 0, behavior: "auto" });
  }, [index]);

  const goTo = useCallback(
    (target: number) => {
      if (pages.length === 0) return;
      setIndex(Math.min(Math.max(0, target), pages.length - 1));
    },
    [pages.length],
  );

  const prev = useCallback(() => goTo(index - 1), [goTo, index]);
  const next = useCallback(() => goTo(index + 1), [goTo, index]);
  const zoomed = settings.mode === "custom" && settings.scale > 100;

  const handleViewportClick = useCallback((event: MouseEvent<HTMLDivElement>) => {
    if (touchHandledRef.current) {
      touchHandledRef.current = false;
      return;
    }
    const target = event.target as Element | null;
    if (target?.closest("button,a,input,select,textarea,[contenteditable],.reader-tap-hint,.reader-error,.reader-loading")) return;
    if (document.querySelector(".settings-panel, .reader-toc")) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (isMobileReadingLayout() && tapStartRef.current) {
      const start = tapStartRef.current;
      tapStartRef.current = null;
      if (event.timeStamp - start.time > 550 || Math.abs(event.clientX - start.x) > 10 || Math.abs(event.clientY - start.y) > 10) return;
      if (event.clientX < rect.left + rect.width * 0.3) prev();
      else if (event.clientX > rect.left + rect.width * 0.7) next();
      return;
    }
    if (!isMobileReadingLayout()) {
      if (event.clientX < rect.left + rect.width / 2) prev();
      else next();
    }
  }, [next, prev]);

  const retryPage = useCallback(() => {
    setPageError(null);
    setSrc(null);
    void loadPage(index).then((url) => {
      if (url) {
        setSrc(url);
        return;
      }
      setPageError("Could not load this page.");
    }).catch((err: unknown) => {
      setPageError(err);
    });
  }, [index, loadPage]);

  // Keyboard navigation. Space only pages when nothing interactive is focused
  // so it still activates buttons.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("button, a, input, select, textarea, [contenteditable], .settings-panel")) {
        return;
      }
      if (event.key === "ArrowRight" || event.key === "PageDown") {
        event.preventDefault();
        next();
      } else if (event.key === "ArrowLeft" || event.key === "PageUp") {
        event.preventDefault();
        prev();
      } else if (event.key === " ") {
        event.preventDefault();
        next();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [next, prev]);

  useEffect(() => {
    if (!pagesOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPagesOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pagesOpen, setPagesOpen]);

  const windowPages = pages;
  const thumbIndexOffset = 0;

  useEffect(() => {
    if (!pagesOpen || windowPages.length === 0 || typeof IntersectionObserver === "undefined") return;
    const drawer = document.getElementById("comic-pages-panel");
    if (!drawer) return;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const pageIndex = Number((entry.target as HTMLElement).dataset.pageIndex);
        if (Number.isInteger(pageIndex)) {
          void loadPage(pageIndex);
          observer.unobserve(entry.target);
        }
      }
    }, { root: drawer, rootMargin: "120px" });
    drawer.querySelectorAll<HTMLElement>("[data-page-index]").forEach((button) => observer.observe(button));
    return () => observer.disconnect();
  }, [loadPage, pagesOpen, windowPages.length]);

  return (
    <div className="reader-stage">
      <ReaderTapHint />
      <div
        ref={viewportRef}
        className={`comic-viewport comic-scale-${settings.mode}${zoomed ? " comic-is-zoomed" : ""}`}
        style={settings.mode === "custom" ? { "--comic-scale": `${settings.scale / 100}` } as CSSProperties : undefined}
        onPointerDown={(event) => {
          if (event.isPrimary === false) return;
          const target = event.target as Element | null;
          if (target?.closest("button,a,input,select,textarea,[contenteditable],.reader-tap-hint,.reader-error,.reader-loading")) return;
          if (document.querySelector(".settings-panel, .reader-toc, [aria-modal='true']")) return;
          if (event.pointerType === "touch" || isMobileReadingLayout() || zoomed) {
            touchStartRef.current = { x: event.clientX, y: event.clientY };
            tapStartRef.current = { x: event.clientX, y: event.clientY, time: event.timeStamp };
            touchHandledRef.current = false;
          }
        }}
        onPointerUp={(event) => {
          if (!touchStartRef.current) return;
          const start = touchStartRef.current;
          touchStartRef.current = null;
          const deltaX = event.clientX - start.x;
          const deltaY = event.clientY - start.y;
          const viewport = viewportRef.current;
          const canScroll = zoomed || Boolean(
            viewport
            && (viewport.scrollWidth > viewport.clientWidth + 1
              || viewport.scrollHeight > viewport.clientHeight + 1),
          );
          // A zoomed image is a scroll surface. Once the pointer moved more
          // than a tap threshold, consume the click so a horizontal drag
          // cannot also turn the page after the browser scrolls the image.
          if (canScroll && (Math.abs(deltaX) > 10 || Math.abs(deltaY) > 10)) {
            touchHandledRef.current = true;
            tapStartRef.current = null;
            return;
          }
          if (Math.abs(deltaX) > 44 && Math.abs(deltaX) > Math.abs(deltaY)) {
            touchHandledRef.current = true;
            if (deltaX < 0) next();
            else prev();
          }
        }}
        onPointerCancel={() => {
          touchStartRef.current = null;
          tapStartRef.current = null;
        }}
        onClick={handleViewportClick}
      >
        {src ? (
          <div className="comic-image-frame">
            <img src={src} alt={t("Page {{page}} of {{total}}", { page: (pageNumbersRef.current[index] ?? index) + 1, total: detail.page_count || pages.length })} />
          </div>
        ) : pageError !== null ? (
          <div className="reader-error">
            <p>{translateError(pageError, t)}</p>
            <button type="button" onClick={(event) => { event.stopPropagation(); retryPage(); }}>{t("Retry page")}</button>
          </div>
        ) : (
          !error && <div className="reader-loading">{t("Loading page…")}</div>
        )}
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
      </div>
      <div className="reader-bottom-bar" data-reader-controls="true">
        <button type="button" onClick={(event) => { event.stopPropagation(); prev(); }} disabled={index <= 0} aria-label={t("Previous page")}>
          ← {t("Prev")}
        </button>
        <span className="comic-counter">
          {pages.length === 0 ? "—" : t("Page {{page}} of {{total}}", { page: (pageNumbersRef.current[index] ?? index) + 1, total: detail.page_count || pages.length })}
        </span>
        <span className="comic-mode-label" aria-label={t("Image size")}>
          {t(settings.mode === "fit-screen" ? "Fit screen" : settings.mode === "fit-width" ? "Fit width" : "Custom zoom")}
        </span>
        <button type="button" onClick={(event) => { event.stopPropagation(); next(); }} disabled={index >= pages.length - 1} aria-label={t("Next page")}>
          {t("Next")} →
        </button>
      </div>
      {pagesOpen && <button className="reader-drawer-backdrop" type="button" aria-label={t("Close pages")} onClick={() => setPagesOpen(false)} />}
      {pagesOpen && (
        <div id="comic-pages-panel" className="comic-thumbs" role="dialog" aria-label={t("Pages")}>
          <div className="reader-drawer-head">
            <span>{t("Pages")} {pages.length ? `(${pages.length})` : ""}</span>
            <button type="button" onClick={() => setPagesOpen(false)} aria-label={t("Close pages")}>✕</button>
          </div>
          {windowPages.length > 0 ? (
            <div className="comic-thumb-grid" role="list">
              {windowPages.map((name, offset) => {
                const i = thumbIndexOffset + offset;
                const thumbUrl = urlsRef.current.get(i);
                return (
                  <button
                    key={name}
                    type="button"
                    className={`comic-thumb ${i === index ? "is-active" : ""}`}
                    onClick={(event) => { event.stopPropagation(); goTo(i); setPagesOpen(false); }}
                    role="listitem"
                    aria-label={t("Go to page {{page}}", { page: i + 1 })}
                    aria-current={i === index ? "page" : undefined}
                    data-page-index={i}
                    onMouseEnter={() => { void loadPage(i); }}
                    onFocus={() => { void loadPage(i); }}
                  >
                    {thumbUrl ? (
                      <img src={thumbUrl} alt="" loading="lazy" />
                    ) : (
                      <span>{i + 1}</span>
                    )}
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="reader-drawer-empty">{t("No pages available")}</p>
          )}
        </div>
      )}
      {loading && <div className="reader-loading">{t("Opening comic…")}</div>}
    </div>
  );
}
