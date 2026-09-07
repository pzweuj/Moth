import { useCallback, useEffect, useRef, useState } from "react";
import type { BookDetail, ProgressBody } from "../api";
import { bookFileUrl } from "../api";
import { makeRangeLoader, type ZipLoader } from "./zipLoader";
import { sortComicEntries } from "./comicPages";
import { getOfflinePage, getOfflinePages, saveOfflinePage } from "../offline/db";

interface ComicReaderProps {
  detail: BookDetail;
  onProgress: (progress: ProgressBody) => void;
}

type FitMode = "width" | "height";

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
 * loaded lazily; only the current page (plus a small window for the thumbnail
 * strip and one ahead/behind) is fetched from the server.
 */
export function ComicReader({ detail, onProgress }: ComicReaderProps) {
  const [pages, setPages] = useState<string[]>([]);
  const [index, setIndex] = useState(0);
  const [src, setSrc] = useState<string | null>(null);
  const [fit, setFit] = useState<FitMode>("width");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
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
  const onProgressRef = useRef(onProgress);
  onProgressRef.current = onProgress;
  currentIndexRef.current = index;
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
      if (Math.abs(pageIndex - currentIndexRef.current) > THUMB_RADIUS) return null;
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
  }, [detail.content_version, detail.id, pages]);

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
      setError(err instanceof Error ? err.message : "Could not open this comic.");
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
          setPageError(err instanceof Error ? err.message : "Could not load this page.");
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

  const goTo = useCallback(
    (target: number) => {
      setIndex(Math.min(Math.max(0, target), pages.length - 1));
    },
    [pages.length],
  );

  const prev = useCallback(() => goTo(index - 1), [goTo, index]);
  const next = useCallback(() => goTo(index + 1), [goTo, index]);

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
      setPageError(err instanceof Error ? err.message : "Could not load this page.");
    });
  }, [index, loadPage]);

  // Keyboard navigation. Space only pages when nothing interactive is focused
  // so it still activates buttons.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
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

  const min = Math.max(0, index - THUMB_RADIUS);
  const max = Math.min(pages.length, index + THUMB_RADIUS + 1);
  const windowPages = pages.slice(min, max);
  const thumbIndexOffset = min;

  return (
    <div className="reader-stage">
      <div
        className={`comic-viewport comic-fit-${fit}`}
        onPointerDown={(event) => {
          if (event.pointerType === "touch") {
            touchStartRef.current = { x: event.clientX, y: event.clientY };
            touchHandledRef.current = false;
          }
        }}
        onPointerUp={(event) => {
          if (event.pointerType !== "touch" || !touchStartRef.current) return;
          const start = touchStartRef.current;
          touchStartRef.current = null;
          const deltaX = event.clientX - start.x;
          const deltaY = event.clientY - start.y;
          if (Math.abs(deltaX) > 44 && Math.abs(deltaX) > Math.abs(deltaY)) {
            touchHandledRef.current = true;
            if (deltaX < 0) next();
            else prev();
          }
        }}
        onClick={(event) => {
          if (touchHandledRef.current) {
            touchHandledRef.current = false;
            return;
          }
          const rect = event.currentTarget.getBoundingClientRect();
          if (event.clientX < rect.left + rect.width / 2) prev();
          else next();
        }}
      >
        {src ? (
          <img src={src} alt={`Page ${(pageNumbersRef.current[index] ?? index) + 1} of ${detail.page_count || pages.length}`} />
        ) : pageError ? (
          <div className="reader-error">
            <p>{pageError}</p>
            <button type="button" onClick={(event) => { event.stopPropagation(); retryPage(); }}>Retry page</button>
          </div>
        ) : (
          !error && <div className="reader-loading">Loading page…</div>
        )}
        {error && (
          <div className="reader-error">
            <p>{error}</p>
            <button type="button" onClick={() => window.history.back()}>
              Back to library
            </button>
          </div>
        )}
      </div>
      <div className="reader-bottom-bar">
        <button type="button" onClick={(event) => { event.stopPropagation(); prev(); }} disabled={index <= 0}>
          ← Prev
        </button>
        <span className="comic-counter">
          {pages.length === 0 ? "—" : `${(pageNumbersRef.current[index] ?? index) + 1} / ${detail.page_count || pages.length}`}
        </span>
        <button
          type="button"
          onClick={(event) => { event.stopPropagation(); setFit((mode) => (mode === "width" ? "height" : "width")); }}
        >
          Fit {fit === "width" ? "width" : "height"}
        </button>
        <button type="button" onClick={(event) => { event.stopPropagation(); next(); }} disabled={index >= pages.length - 1}>
          Next →
        </button>
      </div>
      {windowPages.length > 0 && (
        <div className="comic-thumbs" role="list" aria-label="Pages">
          {windowPages.map((name, offset) => {
            const i = thumbIndexOffset + offset;
            const thumbUrl = urlsRef.current.get(i);
            return (
              <button
                key={name}
                type="button"
                className={`comic-thumb ${i === index ? "is-active" : ""}`}
                onClick={(event) => { event.stopPropagation(); goTo(i); }}
                role="listitem"
                aria-label={`Go to page ${i + 1}`}
                aria-current={i === index ? "page" : undefined}
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
      )}
      {loading && <div className="reader-loading">Opening comic…</div>}
    </div>
  );
}
