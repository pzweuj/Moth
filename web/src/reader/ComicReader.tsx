import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BookDetail, ProgressBody, ReadingPosition } from "../api";
import type { ComicSettings } from "./settings";
import type { ReaderNavigationRequest } from "./navigation";

type Props = {
  detail: BookDetail;
  progress?: ProgressBody | null;
  settings: ComicSettings;
  navigationRequest: ReaderNavigationRequest | null;
  onCurrentPageChange: (page: number) => void;
  onProgress: (position: ReadingPosition, contentVersion?: string) => void;
};

import { installPageGestures } from "./pageGestures";

type PagePosition = { page: number; progress: number };

function clampPage(page: number, count: number): number {
  return Math.min(Math.max(0, page), Math.max(0, count - 1));
}

function clampProgress(progress: number): number {
  return Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0;
}

export function ComicReader({ detail, progress, settings, navigationRequest, onCurrentPageChange, onProgress }: Props) {
  const pageCount = detail.pages.length;
  const saved = progress?.content_version === detail.content_version && progress.position.type === "cbz"
    ? progress.position
    : null;
  const initialPage = clampPage(saved?.page_index ?? 0, pageCount);
  const initialPosition: PagePosition = {
    page: initialPage,
    progress: saved?.page_index === initialPage ? clampProgress(saved.page_progress) : 0,
  };
  const [index, setIndex] = useState(initialPage);
  const [eligible, setEligible] = useState<Set<number>>(() => new Set());
  const [failed, setFailed] = useState<Set<number>>(() => new Set());
  const [retryNonce, setRetryNonce] = useState<Map<number, number>>(() => new Map());
  const contentRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef(new Map<number, HTMLDivElement>());
  const indexRef = useRef(initialPage);
  const positionRef = useRef<PagePosition>(initialPosition);
  const initialSavedRef = useRef(saved);
  const initialPositionConsumedRef = useRef(false);
  const processedNavigationRef = useRef<number | null>(null);
  const pendingScrollRef = useRef<PagePosition | null>(settings.mode === "webtoon" ? initialPosition : null);
  const restoreFrameRef = useRef<number | null>(null);
  const settingsSnapshotRef = useRef(settings);
  const scrollFrameRef = useRef<number | null>(null);
  const onProgressRef = useRef(onProgress);
  const onCurrentPageChangeRef = useRef(onCurrentPageChange);

  useEffect(() => { onProgressRef.current = onProgress; }, [onProgress]);
  useEffect(() => { onCurrentPageChangeRef.current = onCurrentPageChange; }, [onCurrentPageChange]);
  useEffect(() => { indexRef.current = index; }, [index]);
  useEffect(() => { onCurrentPageChangeRef.current(index); }, [index]);

  const markEligible = useCallback((page: number) => {
    if (page < 0 || page >= pageCount) return;
    setEligible((current) => current.has(page) ? current : new Set(current).add(page));
  }, [pageCount]);

  const scheduleWebtoonRestore = useCallback((target: PagePosition) => {
    if (settings.mode !== "webtoon") return;
    pendingScrollRef.current = {
      page: clampPage(target.page, pageCount),
      progress: clampProgress(target.progress),
    };
    if (restoreFrameRef.current !== null) window.cancelAnimationFrame(restoreFrameRef.current);
    restoreFrameRef.current = window.requestAnimationFrame(() => {
      restoreFrameRef.current = null;
      const container = contentRef.current;
      const intent = pendingScrollRef.current;
      if (!container || !intent) return;
      const node = pageRefs.current.get(intent.page);
      if (!node || node.offsetHeight <= 0) return;
      const containerRect = container.getBoundingClientRect();
      const nodeTop = node.getBoundingClientRect().top - containerRect.top + container.scrollTop;
      const desired = nodeTop + node.offsetHeight * intent.progress - container.clientHeight / 2;
      const maximum = Math.max(0, container.scrollHeight - container.clientHeight);
      container.scrollTop = Math.max(0, Math.min(maximum, desired));
      pendingScrollRef.current = null;
    });
  }, [pageCount, settings.mode]);

  useEffect(() => {
    if (settings.mode !== "webtoon") return;
    const root = contentRef.current;
    if (!root) return;
    if (typeof IntersectionObserver === "undefined") {
      markEligible(indexRef.current);
      markEligible(indexRef.current + 1);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) markEligible(Number((entry.target as HTMLElement).dataset.page));
      }
    }, { root, rootMargin: "900px 0px" });
    for (const node of pageRefs.current.values()) observer.observe(node);
    return () => observer.disconnect();
  }, [markEligible, pageCount, settings.mode]);

  const updateWebtoonProgress = useCallback(() => {
    const container = contentRef.current;
    if (!container || !pageCount || pendingScrollRef.current) return;
    const containerRect = container.getBoundingClientRect();
    const viewportTop = containerRect.top;
    const viewportCenter = viewportTop + container.clientHeight / 2;
    let closest: { page: number; distance: number; progress: number } | null = null;
    for (const [page, node] of pageRefs.current) {
      const rect = node.getBoundingClientRect();
      if (rect.height <= 0) continue;
      const progress = clampProgress((viewportCenter - rect.top) / rect.height);
      const distance = viewportCenter < rect.top
        ? rect.top - viewportCenter
        : viewportCenter > rect.bottom
          ? viewportCenter - rect.bottom
          : 0;
      if (!closest || distance < closest.distance) closest = { page, distance, progress };
    }
    if (!closest) return;
    const nextPosition: PagePosition = { page: closest.page, progress: closest.progress };
    positionRef.current = nextPosition;
    indexRef.current = closest.page;
    setIndex((current) => current === closest.page ? current : closest.page);
    const overall = clampProgress((closest.page + closest.progress) / pageCount);
    onProgressRef.current({
      type: "cbz",
      page_index: closest.page,
      page_progress: closest.progress,
      progress: overall,
    });
  }, [pageCount]);

  useEffect(() => {
    if (settings.mode !== "webtoon") return;
    const container = contentRef.current;
    if (!container) return;
    const onScroll = () => {
      if (scrollFrameRef.current !== null) return;
      scrollFrameRef.current = window.requestAnimationFrame(() => {
        scrollFrameRef.current = null;
        updateWebtoonProgress();
      });
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    const frame = window.requestAnimationFrame(updateWebtoonProgress);
    return () => {
      container.removeEventListener("scroll", onScroll);
      window.cancelAnimationFrame(frame);
      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
        scrollFrameRef.current = null;
      }
    };
  }, [settings.mode, updateWebtoonProgress]);

  useEffect(() => {
    const previous = settingsSnapshotRef.current;
    const modeChanged = previous.mode !== settings.mode;
    const layoutChanged = previous.fit !== settings.fit || previous.direction !== settings.direction;
    settingsSnapshotRef.current = settings;
    if (settings.mode === "webtoon" && (modeChanged || layoutChanged)) {
      scheduleWebtoonRestore(positionRef.current);
    }
  }, [scheduleWebtoonRestore, settings]);

  useEffect(() => {
    if (settings.mode !== "webtoon" || initialPositionConsumedRef.current) return;
    initialPositionConsumedRef.current = true;
    scheduleWebtoonRestore(positionRef.current);
  }, [scheduleWebtoonRestore, settings.mode]);

  useEffect(() => {
    if (settings.mode !== "webtoon") return;
    const onResize = () => scheduleWebtoonRestore(positionRef.current);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [scheduleWebtoonRestore, settings.mode]);

  useEffect(() => {
    if (!navigationRequest || processedNavigationRef.current === navigationRequest.token) return;
    processedNavigationRef.current = navigationRequest.token;
    const target = Number(navigationRequest.id);
    if (!Number.isInteger(target) || !pageCount) return;
    const page = clampPage(target, pageCount);
    const position = { page, progress: 0 };
    indexRef.current = page;
    positionRef.current = position;
    setIndex(page);
    if (settings.mode === "webtoon") scheduleWebtoonRestore(position);
  }, [navigationRequest, pageCount, scheduleWebtoonRestore, settings.mode]);

  useEffect(() => {
    if (settings.mode === "webtoon" || !pageCount) return;
    const initialSaved = initialSavedRef.current;
    if (!initialPositionConsumedRef.current && initialSaved && initialSaved.page_index === index) {
      initialPositionConsumedRef.current = true;
      positionRef.current = { page: index, progress: clampProgress(initialSaved.page_progress) };
      onProgressRef.current(initialSaved);
      return;
    }
    initialPositionConsumedRef.current = true;
    const position = { page: index, progress: positionRef.current.page === index ? positionRef.current.progress : 0 };
    positionRef.current = position;
    onProgressRef.current({
      type: "cbz",
      page_index: index,
      page_progress: position.progress,
      progress: clampProgress((index + position.progress) / pageCount),
    });
  }, [index, pageCount, settings.mode]);

  const move = useCallback((delta: number) => {
    if (!pageCount) return;
    // The final spread is already visible; do not shift it by one page.
    if (delta > 0 && indexRef.current + (settings.mode === "double" ? 2 : 1) >= pageCount) return;
    const page = clampPage(indexRef.current + delta, pageCount);
    const position = { page, progress: 0 };
    indexRef.current = page;
    positionRef.current = position;
    setIndex(page);
    if (settings.mode === "webtoon") scheduleWebtoonRestore(position);
  }, [pageCount, scheduleWebtoonRestore, settings.mode]);

  const retryPage = (page: number) => {
    setFailed((current) => {
      if (!current.has(page)) return current;
      const next = new Set(current);
      next.delete(page);
      return next;
    });
    setRetryNonce((current) => {
      const next = new Map(current);
      next.set(page, (next.get(page) ?? 0) + 1);
      return next;
    });
    markEligible(page);
  };

  const visible = useMemo(() => settings.mode === "webtoon"
    ? detail.pages.map((_, page) => page)
    : settings.mode === "double"
      ? [index, index + 1].filter((page) => page < pageCount)
      : pageCount ? [index] : [], [detail.pages, index, pageCount, settings.mode]);
  const step = settings.mode === "double" ? 2 : 1;

  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const left = () => move(settings.direction === "rtl" ? step : -step);
    const right = () => move(settings.direction === "rtl" ? -step : step);
    return installPageGestures(content, {
      enabled: () => settings.mode !== "webtoon",
      bounds: () => content.getBoundingClientRect(),
      left, right,
      swipe: (direction) => direction === "left" ? right() : left(),
    });
  }, [move, settings.direction, settings.mode, step]);

  return <div className={`reader-stage comic-reader comic-${settings.mode} comic-${settings.fit}`} dir={settings.direction}>
    <div className="reader-content" ref={contentRef}>
      {!pageCount && <div className="reader-error"><p>CBZ 中没有可阅读的图片</p></div>}
      <div className="comic-pages">
        {visible.map((page) => {
          const info = detail.pages[page];
          const aspectRatio = info?.width && info.height ? `${info.width} / ${info.height}` : undefined;
          const attempt = retryNonce.get(page) ?? 0;
          return <div className="comic-page" data-page={page} key={page} ref={(node) => {
            if (node) pageRefs.current.set(page, node);
            else pageRefs.current.delete(page);
          }} style={aspectRatio ? { aspectRatio } : undefined}>
            {failed.has(page)
              ? <div className="reader-error"><p>第 {page + 1} 页加载失败</p><button className="reader-control-button reader-control-button--danger" type="button" onClick={() => retryPage(page)}>重试</button></div>
              : settings.mode !== "webtoon" || eligible.has(page)
                ? <img key={`${page}-${attempt}`} src={`/api/v1/publications/${detail.id}/pages/${page}${attempt ? `?retry=${attempt}` : ""}`} draggable={false} alt={`第 ${page + 1} 页`} loading={settings.mode === "webtoon" ? "lazy" : "eager"} decoding="async" onLoad={() => {
                  if (settings.mode === "webtoon" && pendingScrollRef.current?.page === page) scheduleWebtoonRestore(pendingScrollRef.current);
                }} onError={() => setFailed((current) => new Set(current).add(page))} />
                : <div className="reader-loading">正在加载第 {page + 1} 页…</div>}
          </div>;
        })}
      </div>
    </div>
    <div className="reader-bottom-bar">
      <button className="reader-control-button" type="button" onClick={() => move(-step)} disabled={index <= 0}>上一页</button>
      <span>{pageCount ? `${index + 1} / ${pageCount}` : "0 / 0"}</span>
      <button className="reader-control-button" type="button" onClick={() => move(step)} disabled={!pageCount || index + step >= pageCount}>下一页</button>
    </div>
  </div>;
}

export type { ComicSettings };
