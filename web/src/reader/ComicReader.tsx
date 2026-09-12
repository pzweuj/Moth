import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BookDetail, ProgressBody, ReadingPosition } from "../api";
import type { ComicSettings } from "./settings";
import type { ReaderNavigationRequest } from "./navigation";
import type { ReaderReadingState } from "./readingState";
import { installReaderKeyboard, type ReaderKeyboardAction } from "./keyboard";

type Props = {
  detail: BookDetail;
  progress?: ProgressBody | null;
  settings: ComicSettings;
  navigationRequest: ReaderNavigationRequest | null;
  onCurrentPageChange: (page: number) => void;
  onProgress: (position: ReadingPosition, contentVersion?: string) => void;
  onReadingStateChange?: (state: ReaderReadingState) => void;
  onAdvanceAtEnd?: () => void;
  onCenterTap?: () => void;
  onPageTurn?: () => void;
  keyboardEnabled?: () => boolean;
  onKeyboardAction?: (action: ReaderKeyboardAction) => boolean;
};

import { installPageGestures } from "./pageGestures";

type PagePosition = { page: number; progress: number };

const WEBTOON_WINDOW_BUFFER_PX = 900;
const FALLBACK_PAGE_WIDTH = 2;
const FALLBACK_PAGE_HEIGHT = 3;

function clampPage(page: number, count: number): number {
  return Math.min(Math.max(0, page), Math.max(0, count - 1));
}

function clampProgress(progress: number): number {
  return Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0;
}

export function ComicReader({ detail, progress, settings, navigationRequest, onCurrentPageChange, onProgress, onReadingStateChange, onAdvanceAtEnd, onCenterTap, onPageTurn, keyboardEnabled, onKeyboardAction }: Props) {
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
  const [windowPages, setWindowPages] = useState<Set<number>>(() => new Set(pageCount ? [initialPage] : []));
  const [measuredSizes, setMeasuredSizes] = useState<Map<number, { width: number; height: number }>>(() => new Map());
  const [failed, setFailed] = useState<Set<number>>(() => new Set());
  const [retryNonce, setRetryNonce] = useState<Map<number, number>>(() => new Map());
  const [imageLoading, setImageLoading] = useState(true);
  const [webtoonStart, setWebtoonStart] = useState(initialPage === 0 && initialPosition.progress <= 0);
  const [webtoonEnd, setWebtoonEnd] = useState(false);
  const [webtoonProgress, setWebtoonProgress] = useState(() => clampProgress((initialPage + 1) / Math.max(1, pageCount)));
  const [webtoonVisiblePages, setWebtoonVisiblePages] = useState<number[]>(() => pageCount ? [initialPage] : []);
  const contentRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef(new Map<number, HTMLDivElement>());
  const windowPagesRef = useRef(new Set<number>(pageCount ? [initialPage] : []));
  const measuredSizesRef = useRef(new Map<number, { width: number; height: number }>());
  const indexRef = useRef(initialPage);
  const positionRef = useRef<PagePosition>(initialPosition);
  const initialSavedRef = useRef(saved);
  const initialPositionConsumedRef = useRef(false);
  const processedNavigationRef = useRef<number | null>(null);
  const pendingScrollRef = useRef<PagePosition | null>(settings.mode === "webtoon" ? initialPosition : null);
  const restoreFrameRef = useRef<number | null>(null);
  const settingsSnapshotRef = useRef(settings);
  const scrollFrameRef = useRef<number | null>(null);
  const webtoonAtStartRef = useRef(initialPage === 0 && initialPosition.progress <= 0);
  const webtoonAtEndRef = useRef(false);
  const onProgressRef = useRef(onProgress);
  const onCurrentPageChangeRef = useRef(onCurrentPageChange);
  const keyboardEnabledRef = useRef(keyboardEnabled);
  const onKeyboardActionRef = useRef(onKeyboardAction);
  const keyboardTurnRef = useRef(false);

  useEffect(() => { onProgressRef.current = onProgress; }, [onProgress]);
  useEffect(() => { onCurrentPageChangeRef.current = onCurrentPageChange; }, [onCurrentPageChange]);
  useEffect(() => { keyboardEnabledRef.current = keyboardEnabled; }, [keyboardEnabled]);
  useEffect(() => { onKeyboardActionRef.current = onKeyboardAction; }, [onKeyboardAction]);
  useEffect(() => { indexRef.current = index; }, [index]);
  useEffect(() => { onCurrentPageChangeRef.current(index); }, [index]);

  const setWebtoonWindow = useCallback((next: Set<number>) => {
    const previous = windowPagesRef.current;
    if (previous.size === next.size && Array.from(next).every((page) => previous.has(page))) return;
    windowPagesRef.current = next;
    setWindowPages(next);
  }, []);

  const retainWebtoonPage = useCallback((page: number) => {
    if (page < 0 || page >= pageCount) return;
    const next = new Set(windowPagesRef.current);
    next.add(page);
    setWebtoonWindow(next);
  }, [pageCount, setWebtoonWindow]);

  const updateWebtoonWindow = useCallback(() => {
    if (settings.mode !== "webtoon") return;
    const container = contentRef.current;
    if (!container) return;
    const containerRect = container.getBoundingClientRect();
    const viewportTop = containerRect.top;
    const viewportBottom = viewportTop + container.clientHeight;
    const next = new Set<number>();
    for (const [page, node] of pageRefs.current) {
      const rect = node.getBoundingClientRect();
      if (rect.bottom >= viewportTop - WEBTOON_WINDOW_BUFFER_PX
        && rect.top <= viewportBottom + WEBTOON_WINDOW_BUFFER_PX) {
        next.add(page);
      }
    }
    // Keep the active and explicitly requested pages available while their
    // positions are being restored, even before all placeholders are laid out.
    if (indexRef.current >= 0 && indexRef.current < pageCount) next.add(indexRef.current);
    const pending = pendingScrollRef.current;
    if (pending && pending.page >= 0 && pending.page < pageCount) next.add(pending.page);
    setWebtoonWindow(next);
  }, [pageCount, setWebtoonWindow, settings.mode]);

  const scheduleWebtoonRestore = useCallback((target: PagePosition) => {
    if (settings.mode !== "webtoon") return;
    const intent = {
      page: clampPage(target.page, pageCount),
      progress: clampProgress(target.progress),
    };
    pendingScrollRef.current = intent;
    retainWebtoonPage(intent.page);
    if (restoreFrameRef.current !== null) window.cancelAnimationFrame(restoreFrameRef.current);
    restoreFrameRef.current = window.requestAnimationFrame(() => {
      restoreFrameRef.current = null;
      const container = contentRef.current;
      const pendingIntent = pendingScrollRef.current;
      if (!container || !pendingIntent) return;
      const node = pageRefs.current.get(pendingIntent.page);
      if (!node) return;
      const containerRect = container.getBoundingClientRect();
      const nodeRect = node.getBoundingClientRect();
      const nodeHeight = nodeRect.height > 0 ? nodeRect.height : node.offsetHeight;
      if (nodeHeight <= 0) return;
      const nodeTop = nodeRect.top - containerRect.top + container.scrollTop;
      const desired = nodeTop + nodeHeight * pendingIntent.progress - container.clientHeight / 2;
      const maximum = Math.max(0, container.scrollHeight - container.clientHeight);
      container.scrollTop = Math.max(0, Math.min(maximum, desired));
      pendingScrollRef.current = null;
      updateWebtoonWindow();
    });
  }, [pageCount, retainWebtoonPage, settings.mode, updateWebtoonWindow]);

  useEffect(() => {
    if (settings.mode !== "webtoon") return;
    const frame = window.requestAnimationFrame(updateWebtoonWindow);
    return () => window.cancelAnimationFrame(frame);
  }, [pageCount, settings.mode, updateWebtoonWindow]);

  const updateWebtoonProgress = useCallback(() => {
    const container = contentRef.current;
    if (!container || !pageCount) return;
    updateWebtoonWindow();
    if (pendingScrollRef.current) return;
    const containerRect = container.getBoundingClientRect();
    const atStart = container.scrollTop <= 2;
    const atEnd = container.scrollTop + container.clientHeight >= container.scrollHeight - 2;
    webtoonAtStartRef.current = atStart;
    webtoonAtEndRef.current = atEnd;
    setWebtoonStart((current) => current === atStart ? current : atStart);
    setWebtoonEnd((current) => current === atEnd ? current : atEnd);
    const viewportTop = containerRect.top;
    const viewportBottom = viewportTop + container.clientHeight;
    const viewportCenter = viewportTop + container.clientHeight / 2;
    const visiblePages: number[] = [];
    let closest: { page: number; distance: number; progress: number } | null = null;
    for (const [page, node] of pageRefs.current) {
      const rect = node.getBoundingClientRect();
      if (rect.height <= 0) continue;
      if (rect.bottom > viewportTop && rect.top < viewportBottom) visiblePages.push(page);
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
    updateWebtoonWindow();
    const activeFailed = failed.has(closest.page);
    const activeImage = pageRefs.current.get(closest.page)?.querySelector("img");
    const activeReady = activeFailed || Boolean(activeImage?.complete && activeImage.naturalWidth > 0);
    setImageLoading((current) => current === !activeReady ? current : !activeReady);
    const lastVisible = visiblePages.at(-1) ?? closest.page;
    const lastNode = pageRefs.current.get(lastVisible);
    const lastRect = lastNode?.getBoundingClientRect();
    const lastHeight = lastRect && lastRect.height > 0 ? lastRect.height : lastNode?.offsetHeight ?? 0;
    const lastProgress = lastNode
      ? clampProgress((viewportBottom - (lastRect?.top ?? 0)) / lastHeight)
      : closest.progress;
    const overall = clampProgress((lastVisible + lastProgress) / pageCount);
    const visibleForState = visiblePages.length ? visiblePages : [closest.page];
    setWebtoonProgress((current) => current === overall ? current : overall);
    setWebtoonVisiblePages((current) => current.length === visibleForState.length && current.every((page, index) => page === visibleForState[index]) ? current : visibleForState);
    onProgressRef.current({
      type: "cbz",
      page_index: closest.page,
      page_progress: closest.progress,
      progress: overall,
    });
    onReadingStateChange?.({
      progress: overall,
      atStart,
      atEnd,
      loading: imageLoading,
      direction: settings.direction,
      visiblePages: visibleForState,
      totalPages: pageCount,
    });
  }, [failed, imageLoading, onReadingStateChange, pageCount, settings.direction, updateWebtoonWindow]);

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
    if (settings.mode !== "webtoon") {
      setWebtoonStart(index <= 0);
      setWebtoonEnd(false);
      setWebtoonVisiblePages(pageCount ? [index] : []);
    }
  }, [index, pageCount, settings.mode]);

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
    if (settings.mode !== "webtoon") setImageLoading(true);
    setIndex(page);
    if (settings.mode === "webtoon") scheduleWebtoonRestore(position);
  }, [navigationRequest, pageCount, scheduleWebtoonRestore, settings.mode]);

  useEffect(() => {
    if (settings.mode === "webtoon" || !pageCount) return;
    const initialSaved = initialSavedRef.current;
    if (!initialPositionConsumedRef.current && initialSaved && initialSaved.page_index === index) {
      initialPositionConsumedRef.current = true;
      positionRef.current = { page: index, progress: clampProgress(initialSaved.page_progress) };
      const lastPage = Math.min(pageCount - 1, index + (settings.mode === "double" ? 1 : 0));
      onProgressRef.current({
        ...initialSaved,
        progress: clampProgress((lastPage + 1) / pageCount),
      });
      return;
    }
    initialPositionConsumedRef.current = true;
    const position = { page: index, progress: positionRef.current.page === index ? positionRef.current.progress : 0 };
    positionRef.current = position;
    onProgressRef.current({
      type: "cbz",
      page_index: index,
      page_progress: position.progress,
      progress: clampProgress((Math.min(pageCount - 1, index + (settings.mode === "double" ? 1 : 0)) + 1) / pageCount),
    });
  }, [index, pageCount, settings.mode]);

  const move = useCallback((delta: number) => {
    if (!pageCount) return;
    if (settings.mode === "webtoon") {
      const container = contentRef.current;
      if (!container) return;
      if (delta > 0 && webtoonAtEndRef.current) {
        onAdvanceAtEnd?.();
        return;
      }
      if (delta < 0 && webtoonAtStartRef.current) return;
      onPageTurn?.();
      const distance = Math.max(1, container.clientHeight * 0.9) * Math.sign(delta);
      const maximum = Math.max(0, container.scrollHeight - container.clientHeight);
      container.scrollTop = Math.max(0, Math.min(maximum, container.scrollTop + distance));
      return;
    }
    // The final spread is already visible; do not shift it by one page.
    const finalVisiblePage = indexRef.current + (settings.mode === "double" ? 1 : 0);
    if (delta > 0 && finalVisiblePage >= pageCount - 1) {
      onAdvanceAtEnd?.();
      return;
    }
    if (delta < 0 && indexRef.current <= 0) return;
    onPageTurn?.();
    const page = clampPage(indexRef.current + delta, pageCount);
    const position = { page, progress: 0 };
    indexRef.current = page;
    positionRef.current = position;
    setImageLoading(true);
    setIndex(page);
  }, [onAdvanceAtEnd, onPageTurn, pageCount, settings.mode]);

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
    if (settings.mode === "webtoon") {
      retainWebtoonPage(page);
      updateWebtoonWindow();
    }
  };

  const visible = useMemo(() => settings.mode === "webtoon"
    ? detail.pages.map((_, page) => page)
    : settings.mode === "double"
      ? [index, index + 1].filter((page) => page < pageCount)
      : pageCount ? [index] : [], [detail.pages, index, pageCount, settings.mode]);
  const step = settings.mode === "double" ? 2 : 1;
  const displayedProgress = settings.mode === "webtoon"
    ? webtoonProgress
    : pageCount && visible.length ? clampProgress((Math.max(...visible) + 1) / pageCount) : 0;
  const displayedPages = settings.mode === "webtoon" ? webtoonVisiblePages : visible;

  useEffect(() => {
    if (settings.mode === "webtoon") return;
    const progress = pageCount && visible.length ? clampProgress((Math.max(...visible) + 1) / pageCount) : 0;
    onReadingStateChange?.({
      progress,
      atStart: index <= 0,
      atEnd: pageCount > 0 && visible.length > 0 && Math.max(...visible) >= pageCount - 1,
      loading: imageLoading,
      direction: settings.direction,
      visiblePages: visible,
      totalPages: pageCount,
    });
  }, [imageLoading, index, onReadingStateChange, pageCount, settings.direction, settings.mode, step, visible]);

  useEffect(() => installReaderKeyboard(window, {
    direction: () => settings.direction,
    previous: () => {
      if (keyboardTurnRef.current) return;
      keyboardTurnRef.current = true;
      move(-step);
      window.setTimeout(() => { keyboardTurnRef.current = false; }, 0);
    },
    next: () => {
      if (keyboardTurnRef.current) return;
      keyboardTurnRef.current = true;
      move(step);
      window.setTimeout(() => { keyboardTurnRef.current = false; }, 0);
    },
    enabled: () => keyboardEnabledRef.current?.() ?? true,
    onKey: (action) => onKeyboardActionRef.current?.(action) ?? false,
  }), [move, onPageTurn, settings.direction, step]);

  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const left = () => move(settings.direction === "rtl" ? step : -step);
    const right = () => move(settings.direction === "rtl" ? -step : step);
    return installPageGestures(content, {
      enabled: () => settings.mode !== "webtoon",
      centerEnabled: () => true,
      bounds: () => content.getBoundingClientRect(),
      left, right,
      center: onCenterTap,
      swipe: (direction) => direction === "left" ? right() : left(),
    });
  }, [move, onCenterTap, settings.direction, settings.mode, step]);

  return <div className={`reader-stage comic-reader comic-${settings.mode} comic-${settings.fit}`} dir={settings.direction}>
    <div className="reader-content" ref={contentRef}>
      {!pageCount && <div className="reader-error"><p>CBZ 中没有可阅读的图片</p></div>}
      <div className="comic-pages">
        {visible.map((page) => {
          const info = detail.pages[page];
          const measured = measuredSizes.get(page);
          const width = measured && measured.width > 0
            ? measured.width
            : info?.width && info.width > 0 ? info.width : FALLBACK_PAGE_WIDTH;
          const height = measured && measured.height > 0
            ? measured.height
            : info?.height && info.height > 0 ? info.height : FALLBACK_PAGE_HEIGHT;
          const aspectRatio = `${width} / ${height}`;
          const hasInfoDimensions = Boolean(info?.width && info.width > 0 && info.height && info.height > 0);
          const pageStyle = settings.mode === "webtoon" || hasInfoDimensions
            ? { aspectRatio }
            : undefined;
          const attempt = retryNonce.get(page) ?? 0;
          return <div className="comic-page" data-page={page} key={page} ref={(node) => {
            if (node) pageRefs.current.set(page, node);
            else pageRefs.current.delete(page);
          }} style={pageStyle}>
            {failed.has(page) && (settings.mode !== "webtoon" || windowPages.has(page))
              ? <div className="reader-error"><p>第 {page + 1} 页加载失败</p><button className="reader-control-button reader-control-button--danger" type="button" onClick={() => retryPage(page)}>重试</button></div>
              : settings.mode !== "webtoon" || windowPages.has(page)
                ? <img key={`${page}-${attempt}`} src={`/api/v1/publications/${detail.id}/pages/${page}${attempt ? `?retry=${attempt}` : ""}`} draggable={false} alt={`第 ${page + 1} 页`} loading="eager" decoding="async" onLoad={(event) => {
                  if (settings.mode !== "webtoon" || page === indexRef.current) setImageLoading(false);
                  const image = event.currentTarget;
                  if (!hasInfoDimensions && image.naturalWidth > 0 && image.naturalHeight > 0) {
                    const container = contentRef.current;
                    const anchor = pageRefs.current.get(indexRef.current);
                    const before = container && anchor
                      ? anchor.getBoundingClientRect().top - container.getBoundingClientRect().top
                      : null;
                    const size = { width: image.naturalWidth, height: image.naturalHeight };
                    measuredSizesRef.current.set(page, size);
                    setMeasuredSizes(new Map(measuredSizesRef.current));
                    window.requestAnimationFrame(() => {
                      if (container && anchor && before !== null) {
                        const after = anchor.getBoundingClientRect().top - container.getBoundingClientRect().top;
                        container.scrollTop += after - before;
                      }
                      updateWebtoonWindow();
                      const restore = pendingScrollRef.current?.page === page
                        ? pendingScrollRef.current
                        : page === indexRef.current ? positionRef.current : null;
                      if (settings.mode === "webtoon" && restore) scheduleWebtoonRestore(restore);
                    });
                  } else if (settings.mode === "webtoon" && pendingScrollRef.current?.page === page) {
                    scheduleWebtoonRestore(pendingScrollRef.current);
                  }
                }} onError={() => {
                  if (settings.mode !== "webtoon" || page === indexRef.current) setImageLoading(false);
                  setFailed((current) => new Set(current).add(page));
                }} />
                : <div className="comic-page-placeholder" aria-hidden="true" />}
          </div>;
        })}
      </div>
      {settings.mode === "webtoon" && webtoonEnd && <button className="primary-button comic-end-next" type="button" onClick={() => move(1)}>下一页</button>}
    </div>
    <div className="reader-bottom-bar">
      <button className="reader-control-button" type="button" onClick={() => move(-step)} disabled={settings.mode === "webtoon" ? webtoonStart : index <= 0}>上一页</button>
      <span className="reader-progress-label">{imageLoading ? "" : pageCount ? `已读 ${Math.round(displayedProgress * 1000) / 10}% · ${displayedPages.map((page) => page + 1).join("–")} / ${pageCount} 页` : "0 / 0"}</span>
      <button className="reader-control-button" type="button" onClick={() => move(step)} disabled={!pageCount || (settings.mode === "webtoon" ? (!onAdvanceAtEnd && webtoonEnd) : (!onAdvanceAtEnd && visible.length > 0 && Math.max(...visible) >= pageCount - 1))}>下一页</button>
    </div>
  </div>;
}

export type { ComicSettings };
