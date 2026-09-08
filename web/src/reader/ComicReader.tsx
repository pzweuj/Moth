import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BookDetail, ProgressBody, ReadingPosition } from "../api";

type ComicSettings = { mode: "single" | "double" | "webtoon"; direction: "ltr" | "rtl"; fit: "screen" | "width" | "height" };
type Props = { detail: BookDetail; progress?: ProgressBody | null; settings: ComicSettings; onProgress: (position: ReadingPosition, contentVersion?: string) => void; onBack: () => void };

export function ComicReader({ detail, progress, settings, onProgress, onBack }: Props) {
  const saved = progress?.content_version === detail.content_version && progress.position.type === "cbz" ? progress.position : null;
  const initialPage = Math.min(Math.max(0, saved?.page_index ?? 0), Math.max(0, detail.pages.length - 1));
  const [index, setIndex] = useState(initialPage);
  const [loaded, setLoaded] = useState<Set<number>>(() => new Set());
  const [error, setError] = useState("");
  const contentRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef(new Map<number, HTMLDivElement>());
  const indexRef = useRef(initialPage);
  const initialSavedRef = useRef(saved);
  const restoreProgressRef = useRef(0);
  const touchStart = useRef<number | null>(null);

  useEffect(() => { indexRef.current = index; }, [index]);

  const pageUrl = (page: number) => `/api/v1/publications/${detail.id}/pages/${page}`;
  const markLoaded = useCallback((page: number) => {
    if (page < 0 || page >= detail.pages.length) return;
    setLoaded((current) => current.has(page) ? current : new Set(current).add(page));
  }, [detail.pages.length]);

  // Single and double-page modes only request what is visible (plus the
  // second half of a spread). Webtoon observes every placeholder but loads
  // only the pages near the viewport.
  useEffect(() => {
    if (settings.mode !== "webtoon") {
      markLoaded(index);
      if (settings.mode === "double") markLoaded(index + 1);
      return;
    }
    const root = contentRef.current;
    if (!root || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) markLoaded(Number((entry.target as HTMLElement).dataset.page));
      }
    }, { root, rootMargin: "900px 0px" });
    for (const node of pageRefs.current.values()) observer.observe(node);
    return () => observer.disconnect();
  }, [index, markLoaded, settings.mode]);

  const updateWebtoonProgress = useCallback(() => {
    const container = contentRef.current;
    if (!container || !detail.pages.length) return;
    const containerRect = container.getBoundingClientRect();
    const viewportTop = containerRect.top;
    const viewportBottom = containerRect.bottom;
    const viewportCenter = viewportTop + container.clientHeight / 2;
    let best = { index: indexRef.current, ratio: -1, distance: Number.POSITIVE_INFINITY, progress: 0 };
    for (const [page, node] of pageRefs.current) {
      const rect = node.getBoundingClientRect();
      const visible = Math.max(0, Math.min(rect.bottom, viewportBottom) - Math.max(rect.top, viewportTop));
      const ratio = visible / Math.max(1, rect.height);
      const distance = Math.abs((rect.top + rect.bottom) / 2 - viewportCenter);
      if (ratio > best.ratio || (ratio === best.ratio && distance < best.distance)) {
        const progress = Math.max(0, Math.min(1, (viewportCenter - rect.top) / Math.max(1, rect.height)));
        best = { index: page, ratio, distance, progress };
      }
    }
    if (best.ratio < 0) return;
    indexRef.current = best.index;
    setIndex(best.index);
    const overall = detail.pages.length > 1
      ? (best.index + best.progress) / detail.pages.length
      : best.progress;
    onProgress({ type: "cbz", page_index: best.index, page_progress: best.progress, progress: Math.max(0, Math.min(1, overall)) });
  }, [detail.pages.length, onProgress]);

  useEffect(() => {
    if (settings.mode !== "webtoon") return;
    const container = contentRef.current;
    if (!container) return;
    container.addEventListener("scroll", updateWebtoonProgress, { passive: true });
    updateWebtoonProgress();
    return () => container.removeEventListener("scroll", updateWebtoonProgress);
  }, [settings.mode, updateWebtoonProgress]);

  useEffect(() => {
    if (settings.mode === "webtoon") return;
    const initialSaved = initialSavedRef.current;
    if (initialSaved && initialSaved.page_index === index) {
      onProgress(initialSaved);
      return;
    }
    const last = Math.max(0, detail.pages.length - 1);
    const progress = last > 0 ? index / last : 0;
    onProgress({ type: "cbz", page_index: index, page_progress: 0, progress });
  }, [detail.pages.length, index, onProgress, settings.mode]);

  // Restore the page when entering webtoon mode. The target may initially be
  // a placeholder, so the same calculation is repeated after each image load.
  const restoreWebtoonPosition = useCallback(() => {
    if (settings.mode !== "webtoon") return;
    const container = contentRef.current;
    const node = pageRefs.current.get(indexRef.current);
    if (!container || !node) return;
    container.scrollTop = Math.max(0, node.offsetTop + node.offsetHeight * restoreProgressRef.current - 24);
  }, [settings.mode]);

  useEffect(() => {
    if (settings.mode !== "webtoon") return;
    const savedPosition = initialSavedRef.current;
    restoreProgressRef.current = savedPosition?.page_index === indexRef.current ? (savedPosition.page_progress ?? 0) : 0;
    const frame = window.requestAnimationFrame(restoreWebtoonPosition);
    return () => window.cancelAnimationFrame(frame);
  }, [restoreWebtoonPosition, settings.mode]);

  const move = (delta: number) => setIndex((value) => Math.min(Math.max(0, value + delta), Math.max(0, detail.pages.length - 1)));
  const visible = useMemo(() => settings.mode === "webtoon"
    ? detail.pages.map((_, page) => page)
    : settings.mode === "double"
      ? [index, index + 1].filter((page) => page < detail.pages.length)
      : [index], [detail.pages, index, settings.mode]);

  return <div className={`reader-stage comic-reader comic-${settings.mode} comic-${settings.fit}`} dir={settings.direction}>
    <div className="reader-content" ref={contentRef}>
      <button className="reader-back-link" type="button" onClick={onBack}>← 返回书库</button>
      {error && <div className="reader-error"><p>{error}</p><button type="button" onClick={() => setError("")}>关闭</button></div>}
      <div className="comic-pages" onTouchStart={(event) => { touchStart.current = event.changedTouches[0]?.clientX ?? null; }} onTouchEnd={(event) => {
        const start = touchStart.current;
        touchStart.current = null;
        const end = event.changedTouches[0]?.clientX;
        if (start === null || end === undefined || settings.mode === "webtoon") return;
        const distance = end - start;
        if (Math.abs(distance) < 48) return;
        const forward = settings.direction === "rtl" ? distance > 0 : distance < 0;
        move(forward ? (settings.mode === "double" ? 2 : 1) : -1);
      }}>
        {visible.map((page) => <div className="comic-page" data-page={page} key={page} ref={(node) => {
          if (node) pageRefs.current.set(page, node);
          else pageRefs.current.delete(page);
        }}>
          {loaded.has(page)
            ? <img src={pageUrl(page)} alt={`第 ${page + 1} 页`} loading={settings.mode === "webtoon" ? "lazy" : "eager"} onLoad={() => { if (page === indexRef.current) restoreWebtoonPosition(); }} onError={() => setError(`第 ${page + 1} 页加载失败`)} />
            : <div className="reader-loading">正在加载第 {page + 1} 页…</div>}
        </div>)}
      </div>
    </div>
    <div className="reader-bottom-bar"><button type="button" onClick={() => move(-1)} disabled={index <= 0}>上一页</button><span>{index + 1} / {detail.pages.length}</span><button type="button" onClick={() => move(settings.mode === "double" ? 2 : 1)} disabled={index >= detail.pages.length - 1}>下一页</button></div>
  </div>;
}

export type { ComicSettings };
