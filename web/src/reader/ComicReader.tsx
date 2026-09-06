import { useCallback, useEffect, useRef, useState } from "react";
import type { BookDetail, ProgressBody } from "../api";
import { bookFileUrl } from "../api";
import { makeRangeLoader, type ZipLoader } from "./zipLoader";
import { sortComicEntries } from "./comicPages";

interface ComicReaderProps {
  detail: BookDetail;
  onProgress: (progress: ProgressBody) => void;
}

type FitMode = "width" | "height";

const THUMB_RADIUS = 3;

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

  const loaderRef = useRef<ZipLoader | null>(null);
  const urlsRef = useRef(new Map<number, string>());
  const onProgressRef = useRef(onProgress);
  onProgressRef.current = onProgress;
  // The initial page is read once; detail.progress is deliberately excluded
  // from the effect deps so a progress refetch cannot tear down and reopen
  // the archive mid-read.
  const initialPageRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const open = async () => {
      const loader = await makeRangeLoader(bookFileUrl(detail.id));
      if (cancelled) return;
      loaderRef.current = loader;
      const names = sortComicEntries(loader.entries).map((entry) => entry.filename);
      if (names.length === 0) throw new Error("No readable pages in this archive.");
      setPages(names);
      const start = initialPageRef.current ?? detail.progress?.page_index ?? 0;
      initialPageRef.current = start;
      setIndex(Math.min(Math.max(0, start), names.length - 1));
      setLoading(false);
    };
    open().catch((err: unknown) => {
      if (cancelled) return;
      console.error("could not open comic", err);
      setError(err instanceof Error ? err.message : "Could not open this comic.");
      setLoading(false);
    });
    const urls = urlsRef.current;
    return () => {
      cancelled = true;
      loaderRef.current = null;
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
    };
    // detail.progress is intentionally not a dependency: the archive is only
    // opened once per book, and a progress refetch must not tear it down.
    // The initial page is read through initialPageRef instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.id]);

  // Load the current page image into an object URL.
  useEffect(() => {
    if (pages.length === 0) return;
    let cancelled = false;
    const cached = urlsRef.current.get(index);
    if (cached) {
      setSrc(cached);
      return;
    }
    setSrc(null);
    const name = pages[index];
    const loader = loaderRef.current;
    if (!loader) return;
    loader
      .loadBlob(name)
      .then((blob) => {
        if (cancelled || !blob) return;
        const url = URL.createObjectURL(blob);
        urlsRef.current.set(index, url);
        setSrc(url);
      })
      .catch((err: unknown) => console.error("page load failed", err));
    return () => {
      cancelled = true;
    };
  }, [pages, index]);

  // Preload the adjacent page and the thumbnail window around the current one.
  useEffect(() => {
    if (pages.length === 0) return;
    const loader = loaderRef.current;
    if (!loader) return;
    const wanted = new Set<number>([index - 1, index + 1]);
    for (let i = index - THUMB_RADIUS; i <= index + THUMB_RADIUS; i++) {
      if (i >= 0 && i < pages.length) wanted.add(i);
    }
    for (const i of wanted) {
      if (i < 0 || i >= pages.length || urlsRef.current.has(i)) continue;
      loader
        .loadBlob(pages[i])
        .then((blob) => {
          if (blob && !urlsRef.current.has(i)) {
            urlsRef.current.set(i, URL.createObjectURL(blob));
          }
        })
        .catch(() => {
          // A failing adjacent page is not fatal; it is retried on demand.
        });
    }
  }, [pages, index]);

  // Report progress whenever the page changes.
  useEffect(() => {
    if (pages.length === 0) return;
    onProgressRef.current({
      chapter_index: 0,
      page_index: index,
      percent: ((index + 1) / pages.length) * 100,
    });
  }, [pages, index]);

  const goTo = useCallback(
    (target: number) => {
      setIndex(Math.min(Math.max(0, target), pages.length - 1));
    },
    [pages.length],
  );

  const prev = useCallback(() => goTo(index - 1), [goTo, index]);
  const next = useCallback(() => goTo(index + 1), [goTo, index]);

  // Keyboard navigation. Space only pages when nothing interactive is focused
  // so it still activates buttons.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowRight" || event.key === "PageDown") {
        event.preventDefault();
        next();
      } else if (event.key === "ArrowLeft" || event.key === "PageUp") {
        event.preventDefault();
        prev();
      } else if (event.key === " ") {
        const target = event.target as HTMLElement | null;
        if (target?.closest("button, a, input, select, textarea, [contenteditable]")) {
          return;
        }
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
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          if (event.clientX < rect.left + rect.width / 2) prev();
          else next();
        }}
      >
        {src ? (
          <img src={src} alt={`Page ${index + 1} of ${pages.length}`} />
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
        <button type="button" onClick={prev} disabled={index <= 0}>
          ← Prev
        </button>
        <span className="comic-counter">
          {pages.length === 0 ? "—" : `${index + 1} / ${pages.length}`}
        </span>
        <button
          type="button"
          onClick={() => setFit((mode) => (mode === "width" ? "height" : "width"))}
        >
          Fit {fit === "width" ? "width" : "height"}
        </button>
        <button type="button" onClick={next} disabled={index >= pages.length - 1}>
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
                onClick={() => goTo(i)}
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
