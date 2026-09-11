import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, pageThumbnailUrl, type BookDetail, type ProgressBody, type PublicationSummary, type ReadingPosition } from "../api";
import { ComicReader } from "./ComicReader";
import { FoliateTextReader } from "./FoliateTextReader";
import type { ReaderNavigationItem, ReaderNavigationRequest } from "./navigation";
import { loadComicSettings, loadSettings, saveComicSettings, saveSettings, type ComicSettings, type ReaderSettings } from "./settings";
import { useProgressSaver } from "./useProgressSaver";
import type { ReaderReadingState } from "./readingState";
import type { ReaderKeyboardAction } from "./keyboard";

type Theme = "light" | "dark";
type Props = { theme: Theme; onToggleTheme: () => void };
type LoadRequest = { id: number; encoding: string; progress: ProgressBody | null; token: number };

const MOBI_POLL_ATTEMPTS = 120;
const MOBI_POLL_DELAY_MS = 250;
const MOBILE_MEDIA_QUERY = "(max-width: 760px), (pointer: coarse) and (max-height: 600px)";

type CompletionState = {
  loading: boolean;
  nextBook: PublicationSummary | null;
  error: string;
  advancing: boolean;
};

function isMobileViewport(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(MOBILE_MEDIA_QUERY).matches;
}

function naturalFilenameCompare(left: string, right: string): number {
  const leftChars = [...left];
  const rightChars = [...right];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < leftChars.length && rightIndex < rightChars.length) {
    const leftChar = leftChars[leftIndex];
    const rightChar = rightChars[rightIndex];
    if (/\d/.test(leftChar) && /\d/.test(rightChar)) {
      let leftEnd = leftIndex;
      let rightEnd = rightIndex;
      while (leftEnd < leftChars.length && /\d/.test(leftChars[leftEnd])) leftEnd += 1;
      while (rightEnd < rightChars.length && /\d/.test(rightChars[rightEnd])) rightEnd += 1;
      const leftDigits = leftChars.slice(leftIndex, leftEnd).join("").replace(/^0+/, "") || "0";
      const rightDigits = rightChars.slice(rightIndex, rightEnd).join("").replace(/^0+/, "") || "0";
      if (leftDigits.length !== rightDigits.length) return leftDigits.length - rightDigits.length;
      if (leftDigits < rightDigits) return -1;
      if (leftDigits > rightDigits) return 1;
      leftIndex = leftEnd;
      rightIndex = rightEnd;
      continue;
    }
    const leftLower = leftChar.toLowerCase();
    const rightLower = rightChar.toLowerCase();
    if (leftLower < rightLower) return -1;
    if (leftLower > rightLower) return 1;
    leftIndex += 1;
    rightIndex += 1;
  }
  return (leftChars.length - leftIndex) - (rightChars.length - rightIndex);
}

function nextBookInSeries(publications: PublicationSummary[], currentId: number): PublicationSummary | null {
  const sorted = [...publications].sort((left, right) => {
    const natural = naturalFilenameCompare(left.filename, right.filename);
    if (natural !== 0) return natural;
    const leftFilename = left.filename.toLowerCase();
    const rightFilename = right.filename.toLowerCase();
    return leftFilename < rightFilename ? -1 : leftFilename > rightFilename ? 1 : left.id - right.id;
  });
  const currentIndex = sorted.findIndex((book) => book.id === currentId);
  return currentIndex >= 0 ? sorted[currentIndex + 1] ?? null : null;
}

export function ReaderPage({ theme, onToggleTheme }: Props) {
  const { id: rawId } = useParams();
  const id = Number(rawId);
  const navigate = useNavigate();
  const [detail, setDetail] = useState<BookDetail | null>(null);
  const [progress, setProgress] = useState<ProgressBody | null>(null);
  const [error, setError] = useState("");
  const [settings, setSettings] = useState<ReaderSettings>(loadSettings);
  const [comicSettings, setComicSettings] = useState<ComicSettings>(loadComicSettings);
  const [encoding, setEncoding] = useState("auto");
  const [loadingStage, setLoadingStage] = useState("读取进度");
  const [loadRequest, setLoadRequest] = useState<LoadRequest | null>(null);
  const [retryToken, setRetryToken] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [textNavigation, setTextNavigation] = useState<ReaderNavigationItem[]>([]);
  const [activeNavigationId, setActiveNavigationId] = useState("");
  const [navigationRequest, setNavigationRequest] = useState<ReaderNavigationRequest | null>(null);
  const [toolbarVisible, setToolbarVisible] = useState(() => !isMobileViewport());
  const [completion, setCompletion] = useState<CompletionState | null>(null);
  const [readingState, setReadingState] = useState<ReaderReadingState>({ progress: 0, atStart: true, atEnd: false, loading: true, direction: "ltr" });
  const navigationToken = useRef(0);
  const activePublicationIdRef = useRef(id);
  const latestPositionRef = useRef<ReadingPosition | null>(null);
  const completionBusyRef = useRef(false);
  const advancingRef = useRef(false);
  activePublicationIdRef.current = id;
  const { save: saveProgress, flush, error: progressError, retry: retrySave } = useProgressSaver({
    publicationId: id,
    contentVersion: detail?.content_version ?? "",
  });

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(MOBILE_MEDIA_QUERY);
    const sync = () => setToolbarVisible(media.matches ? false : true);
    sync();
    media.addEventListener?.("change", sync);
    return () => media.removeEventListener?.("change", sync);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const initialize = async () => {
      try {
        if (!Number.isInteger(id) || id <= 0) throw new Error("无效的书籍编号");
        setDetail(null);
        setProgress(null);
        setError("");
        setLoadingStage("读取进度");
        setLoadRequest(null);
        setNavigationRequest(null);
        setCompletion(null);
        setToolbarVisible(!isMobileViewport());
        setReadingState({ progress: 0, atStart: true, atEnd: false, loading: true, direction: "ltr" });
        completionBusyRef.current = false;
        advancingRef.current = false;
        latestPositionRef.current = null;
        const saved = await api.progress(id, controller.signal);
        if (cancelled) return;
        const requestedEncoding = saved?.position.type === "txt"
          ? saved.position.encoding.toLowerCase()
          : "auto";
        setEncoding(requestedEncoding);
        setTextNavigation([]);
        setActiveNavigationId("");
        setLoadRequest({ id, encoding: requestedEncoding, progress: saved, token: Date.now() });
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "书籍打开失败");
      }
    };
    void initialize();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [id, retryToken]);

  useEffect(() => {
    if (!loadRequest || loadRequest.id !== id) return;
    let cancelled = false;
    const controller = new AbortController();
    const open = async () => {
      try {
        setError("");
        setLoadingStage("读取书籍");
        const book = await api.book(id, loadRequest.encoding, controller.signal);
        if (cancelled) return;
        if (book.source_format === "mobi") {
          setLoadingStage("准备转换");
          let status = await api.conversion(id, controller.signal);
          if (status.status === "pending" || status.status === "failed") {
            status = await api.startConversion(id, controller.signal);
          }
          if (status.status === "pending" || status.status === "preparing") {
            setLoadingStage("转换中");
            for (let attempt = 0; attempt < MOBI_POLL_ATTEMPTS; attempt += 1) {
              await new Promise((resolve) => window.setTimeout(resolve, MOBI_POLL_DELAY_MS));
              if (cancelled) return;
              status = await api.conversion(id, controller.signal);
              if (status.status === "ready" || status.status === "failed") break;
            }
          }
          if (status.status === "failed") throw new Error(status.error ?? "MOBI 转换失败，请重试");
          if (status.status !== "ready" && status.status !== "not_required") throw new Error("MOBI 转换超时，请重试");
        }
        if (cancelled) return;
        setLoadingStage("打开阅读器");
        setDetail(book);
        setProgress(loadRequest.progress);
        setTextNavigation([]);
        setActiveNavigationId("");
      } catch (reason) {
        if (cancelled || (reason instanceof DOMException && reason.name === "AbortError")) return;
        setError(reason instanceof Error ? reason.message : "书籍打开失败，请重试");
      }
    };
    void open();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [id, loadRequest]);

  useEffect(() => { saveSettings(settings); }, [settings]);
  useEffect(() => { saveComicSettings(comicSettings); }, [comicSettings]);

  useEffect(() => {
    if (!settingsOpen && !navigationOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setSettingsOpen(false);
      setNavigationOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigationOpen, settingsOpen]);

  const save = useCallback((position: ReadingPosition, contentVersion?: string) => {
    if (!detail || detail.id !== activePublicationIdRef.current) return;
    if (completionBusyRef.current && position.progress < 1) return;
    latestPositionRef.current = position;
    const value: ProgressBody = {
      content_version: contentVersion ?? detail.content_version,
      position,
    };
    setProgress(value);
    saveProgress(position, contentVersion ?? detail.content_version);
  }, [detail, saveProgress]);

  const loadNextBook = useCallback(async () => {
    if (!detail) return;
    try {
      const series = await api.browse(detail.directory_path);
      if (!series.publications.some((book) => book.id === detail.id)) throw new Error("无法定位当前书籍在系列中的位置，请重试");
      const nextBook = nextBookInSeries(series.publications, detail.id);
      setCompletion((current) => current ? { ...current, loading: false, nextBook, error: "" } : current);
    } catch (reason) {
      setCompletion((current) => current ? { ...current, loading: false, nextBook: null, error: reason instanceof Error ? reason.message : "系列读取失败，请重试" } : current);
    }
  }, [detail]);

  const finishReading = useCallback(() => {
    if (!detail || completionBusyRef.current) return;
    completionBusyRef.current = true;
    const base = latestPositionRef.current ?? (progress?.content_version === detail.content_version ? progress.position : null);
    if (base) {
      const finalPosition = { ...base, progress: 1 } as ReadingPosition;
      latestPositionRef.current = finalPosition;
      setProgress({ content_version: detail.content_version, position: finalPosition });
      saveProgress(finalPosition, detail.content_version);
    }
    setSettingsOpen(false);
    setNavigationOpen(false);
    setToolbarVisible(true);
    advancingRef.current = false;
    setReadingState((current) => ({ ...current, progress: 1, atEnd: true, loading: false }));
    setCompletion({ loading: true, nextBook: null, error: "", advancing: false });
    void loadNextBook();
  }, [detail, loadNextBook, progress, saveProgress]);

  const advanceToNextBook = useCallback(async () => {
    const nextBook = completion?.nextBook;
    if (!nextBook || completion?.advancing || advancingRef.current) return;
    advancingRef.current = true;
    setCompletion((current) => current ? { ...current, advancing: true, error: "" } : current);
    try {
      await flush();
      navigate(`/reader/${nextBook.id}`);
    } catch (reason) {
      advancingRef.current = false;
      setCompletion((current) => current ? { ...current, advancing: false, error: reason instanceof Error ? reason.message : "进度保存失败，请重试" } : current);
    }
  }, [completion, flush, navigate]);

  const retryCompletion = useCallback(() => {
    if (completion?.nextBook && completion.error) {
      void advanceToNextBook();
      return;
    }
    setCompletion((current) => current ? { ...current, loading: true, error: "" } : current);
    void loadNextBook();
  }, [advanceToNextBook, completion, loadNextBook]);

  const returnToLastPage = useCallback(() => {
    if (advancingRef.current) return;
    completionBusyRef.current = false;
    advancingRef.current = false;
    setCompletion(null);
  }, []);

  const onKeyboardAction = useCallback((action: ReaderKeyboardAction) => {
    if (!completion) return false;
    if (action === "previous") returnToLastPage();
    else if (completion.nextBook && !completion.advancing) void advanceToNextBook();
    return true;
  }, [advanceToNextBook, completion, returnToLastPage]);

  useEffect(() => {
    if (!completion) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      const target = event.target as Element | null;
      if (target?.closest?.("input,textarea,select,button,a,label,[role=button],[role=link],[role=slider],[contenteditable]:not([contenteditable=false])")) return;
      const previous = readingState.direction === "rtl" ? "ArrowRight" : "ArrowLeft";
      const next = readingState.direction === "rtl" ? "ArrowLeft" : "ArrowRight";
      if (event.key !== previous && event.key !== next && event.key !== " " && event.code !== "Space") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === previous) returnToLastPage();
      else void advanceToNextBook();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [advanceToNextBook, completion, readingState.direction, returnToLastPage]);

  const toggleToolbar = () => {
    if (!isMobileViewport()) return;
    if (settingsOpen || navigationOpen) {
      setToolbarVisible(true);
      return;
    }
    setToolbarVisible((value) => !value);
  };
  const hideToolbar = (force = false) => {
    if (!isMobileViewport() || (!force && (settingsOpen || navigationOpen))) return;
    const active = document.activeElement as HTMLElement | null;
    if (active?.closest(".reader-titlebar")) active.blur();
    setToolbarVisible(false);
  };

  const text = detail?.reader_format !== "cbz";
  const pageNavigation = useMemo<ReaderNavigationItem[]>(() => detail?.pages.map((page) => ({
    id: String(page.idx),
    label: `第 ${page.idx + 1} 页`,
    thumbnailUrl: pageThumbnailUrl(id, page.idx),
  })) ?? [], [detail?.pages, id]);
  const navigationItems = text ? textNavigation : pageNavigation;

  const openSettings = () => {
    setToolbarVisible(true);
    setNavigationOpen(false);
    setSettingsOpen((value) => !value);
  };
  const openNavigation = () => {
    setToolbarVisible(true);
    setSettingsOpen(false);
    setNavigationOpen((value) => !value);
  };
  const selectNavigation = (item: ReaderNavigationItem) => {
    navigationToken.current += 1;
    setNavigationRequest({ id: item.id, token: navigationToken.current });
    setActiveNavigationId(item.id);
    setSettingsOpen(false);
    setNavigationOpen(false);
    hideToolbar(true);
  };

  const onEncodingChange = (value: string) => {
    if (!detail || detail.source_format !== "txt" || value === encoding) return;
    setEncoding(value);
    setNavigationRequest(null);
    setDetail(null);
    setProgress(null);
    setTextNavigation([]);
    setActiveNavigationId("");
    setLoadRequest({ id, encoding: value, progress, token: Date.now() });
  };

  const retryOpen = () => {
    setError("");
    setDetail(null);
    setProgress(null);
    setRetryToken((value) => value + 1);
  };

  if (error) return <main className="state-screen"><h1>打开失败</h1><p>{error}</p><div><button className="primary-button" type="button" onClick={retryOpen}>重试</button><button className="quiet-button" type="button" onClick={() => navigate(-1)}>返回书库</button></div></main>;
  if (!detail) return <main className="state-screen"><p>{loadingStage}…</p></main>;

  return <main className={`reader-shell ${toolbarVisible ? "toolbar-visible" : "toolbar-hidden"}`}>
    <MobileClock />
    <header className="reader-titlebar" aria-hidden={!toolbarVisible}>
      <button className="quiet-button reader-control-button reader-back-button" type="button" onClick={() => navigate(-1)}>← 返回</button>
      <button className="quiet-button reader-control-button reader-icon-button" type="button" onClick={openNavigation} aria-label={text ? "打开章节" : "打开页码"} aria-expanded={navigationOpen}>☰</button>
      <strong>{detail.title}</strong>
      <span className="reader-format">{detail.source_format.toUpperCase()}</span>
      <button className="quiet-button reader-control-button reader-theme-button" type="button" onClick={onToggleTheme} aria-label="切换主题">{theme === "dark" ? "日间" : "夜间"}</button>
      <button className="quiet-button reader-control-button reader-icon-button" type="button" onClick={openSettings} aria-label="阅读设置" aria-expanded={settingsOpen}>Aa</button>
    </header>
    {settingsOpen && <ReaderSettingsPanel detail={detail} settings={settings} setSettings={setSettings} comicSettings={comicSettings} setComicSettings={setComicSettings} encoding={encoding} onEncodingChange={onEncodingChange} text={text} />}
    {navigationOpen && <ReaderNavigationDrawer items={navigationItems} activeId={activeNavigationId} kind={text ? "chapters" : "pages"} onSelect={selectNavigation} onClose={() => setNavigationOpen(false)} />}
    {progressError && <div className="reader-save-status" role="status">{progressError}<button className="reader-control-button" type="button" onClick={() => void retrySave()}>重试保存</button></div>}
    {text
      ? <FoliateTextReader key={`${detail.id}:${detail.content_version}`} detail={detail} progress={progress} settings={settings} theme={theme} encoding={encoding} navigationRequest={navigationRequest} onProgress={save} onNavigationChange={(items, activeId) => { setTextNavigation(items); if (activeId) setActiveNavigationId(activeId); }} onReadingStateChange={setReadingState} onAdvanceAtEnd={finishReading} onCenterTap={toggleToolbar} onPageTurn={hideToolbar} keyboardEnabled={() => !settingsOpen && !navigationOpen} onKeyboardAction={onKeyboardAction} />
      : <ComicReader key={`${detail.id}:${detail.content_version}`} detail={detail} progress={progress} settings={comicSettings} navigationRequest={navigationRequest} onCurrentPageChange={(page) => setActiveNavigationId(String(page))} onProgress={save} onReadingStateChange={setReadingState} onAdvanceAtEnd={finishReading} onCenterTap={toggleToolbar} onPageTurn={hideToolbar} keyboardEnabled={() => !settingsOpen && !navigationOpen} onKeyboardAction={onKeyboardAction} />}
    {completion && <CompletionOverlay detail={detail} value={completion} readingState={readingState} direction={readingState.direction ?? "ltr"} onPrevious={returnToLastPage} onNext={() => void advanceToNextBook()} onRetry={retryCompletion} onBackToSeries={() => navigate(`/browse?view=browse&path=${encodeURIComponent(detail.directory_path)}`)} />}
  </main>;
}

function MobileClock() {
  const [now, setNow] = useState(() => new Date());
  const intervalRef = useRef<number | null>(null);
  useEffect(() => {
    const update = () => setNow(new Date());
    const timeout = window.setTimeout(() => {
      update();
      intervalRef.current = window.setInterval(update, 60_000);
    }, 60_000 - (Date.now() % 60_000));
    const onVisibilityChange = () => { if (document.visibilityState === "visible") update(); };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearTimeout(timeout);
      if (intervalRef.current !== null) window.clearInterval(intervalRef.current);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);
  return <time className="reader-clock" dateTime={now.toISOString()}>{`${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`}</time>;
}

function CompletionOverlay({ detail, value, readingState, direction, onPrevious, onNext, onRetry, onBackToSeries }: {
  detail: BookDetail;
  value: CompletionState;
  readingState: ReaderReadingState;
  direction: "ltr" | "rtl";
  onPrevious: () => void;
  onNext: () => void;
  onRetry: () => void;
  onBackToSeries: () => void;
}) {
  const sameTitle = value.nextBook && value.nextBook.title === detail.title;
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  return <section className="reader-completion" role="status" aria-live="polite" onTouchStart={(event) => {
    if (event.touches.length === 1) touchStart.current = { x: event.touches[0].clientX, y: event.touches[0].clientY };
  }} onTouchEnd={(event) => {
    const start = touchStart.current;
    touchStart.current = null;
    const touch = event.changedTouches[0];
    if (!start || !touch || Math.abs(touch.clientX - start.x) < 48 || Math.abs(touch.clientX - start.x) <= Math.abs(touch.clientY - start.y)) return;
    const forward = direction === "rtl" ? touch.clientX - start.x > 0 : touch.clientX - start.x < 0;
    if (value.advancing) return;
    if (forward) onNext(); else onPrevious();
  }}>
    <div className="reader-completion-card">
      <p className="reader-completion-title">此部书籍已读完</p>
      {value.loading && <p className="reader-completion-detail">正在读取下一本书…</p>}
      {!value.loading && value.error && <><p className="reader-completion-detail">{value.error}</p><button className="quiet-button" type="button" onClick={onRetry}>重试</button></>}
      {!value.loading && !value.error && value.nextBook && <p className="reader-completion-detail">点击下一页进入到《{value.nextBook.title}》{sameTitle ? `（${value.nextBook.filename}）` : ""}</p>}
      {!value.loading && !value.error && !value.nextBook && <p className="reader-completion-detail">本系列已读完</p>}
      <div className="reader-completion-actions">
        <button className="quiet-button reader-control-button" type="button" disabled={value.advancing} onClick={onPrevious}>上一页</button>
        {!value.loading && !value.error && value.nextBook
          ? <button className="primary-button reader-control-button" type="button" disabled={value.advancing} onClick={onNext}>{value.advancing ? "正在打开…" : "下一页"}</button>
          : !value.loading && !value.error
            ? <button className="primary-button reader-control-button" type="button" onClick={onBackToSeries}>返回系列</button>
            : null}
      </div>
    </div>
    <p className="reader-completion-progress">已读 100%{readingStatePageLabel(readingState) ? ` · ${readingStatePageLabel(readingState)}` : ""}</p>
  </section>;
}

function readingStatePageLabel(value: ReaderReadingState): string {
  return value.visiblePages?.length && value.totalPages ? `${value.visiblePages.map((page) => page + 1).join("–")} / ${value.totalPages} 页` : "";
}

function ReaderSettingsPanel({ detail, settings, setSettings, comicSettings, setComicSettings, encoding, onEncodingChange, text }: {
  detail: BookDetail;
  settings: ReaderSettings;
  setSettings: (value: ReaderSettings) => void;
  comicSettings: ComicSettings;
  setComicSettings: (value: ComicSettings) => void;
  encoding: string;
  onEncodingChange: (value: string) => void;
  text: boolean;
}) {
  return <div className="reader-tools" aria-label="阅读设置">
    {text && <><label>字号 <input aria-label="字号" type="range" min="12" max="36" value={settings.fontSize} onChange={(event) => setSettings({ ...settings, fontSize: Number(event.target.value) })} /></label><label>行距 <input aria-label="行距" type="range" min="13" max="22" value={Math.round(settings.lineHeight * 10)} onChange={(event) => setSettings({ ...settings, lineHeight: Number(event.target.value) / 10 })} /></label><select aria-label="阅读模式" value={settings.flow} onChange={(event) => setSettings({ ...settings, flow: event.target.value as ReaderSettings["flow"] })}><option value="paginated">分页</option><option value="scrolled">滚动</option></select>{detail.source_format === "txt" && <label>编码 <select aria-label="编码" value={encoding} onChange={(event) => onEncodingChange(event.target.value)}><option value="auto">自动检测</option><option value="utf-8">UTF-8</option><option value="utf-16le">UTF-16 LE</option><option value="utf-16be">UTF-16 BE</option><option value="gbk">GBK</option><option value="gb18030">GB18030</option><option value="big5">Big5</option></select></label>}</>}
    {!text && <><select aria-label="漫画模式" value={comicSettings.mode} onChange={(event) => setComicSettings({ ...comicSettings, mode: event.target.value as ComicSettings["mode"] })}><option value="single">单页</option><option value="double">双页</option><option value="webtoon">连续滚动</option></select><select aria-label="适应方式" value={comicSettings.fit} onChange={(event) => setComicSettings({ ...comicSettings, fit: event.target.value as ComicSettings["fit"] })}><option value="screen">适应屏幕</option><option value="width">适应宽度</option><option value="height">适应高度</option></select><select aria-label="阅读方向" value={comicSettings.direction} onChange={(event) => setComicSettings({ ...comicSettings, direction: event.target.value as ComicSettings["direction"] })}><option value="ltr">从左到右</option><option value="rtl">从右到左</option></select></>}
  </div>;
}

function ReaderNavigationDrawer({ items, activeId, kind, onSelect, onClose }: { items: ReaderNavigationItem[]; activeId: string; kind: "chapters" | "pages"; onSelect: (item: ReaderNavigationItem) => void; onClose: () => void }) {
  return <><button className="reader-drawer-backdrop" type="button" aria-label="关闭导航" onClick={onClose} /><aside className={`reader-drawer ${kind === "pages" ? "reader-page-drawer" : ""}`} aria-label={kind === "pages" ? "页码选择器" : "章节选择器"}><div className="reader-drawer-header"><h2>{kind === "pages" ? "页码" : "章节"}</h2><button className="quiet-button reader-control-button reader-icon-button" type="button" onClick={onClose} aria-label="关闭">×</button></div>{items.length === 0 ? <p className="shelf-hint">正在读取…</p> : <div className="reader-navigation-list">{items.map((item) => <button className={`reader-navigation-item ${item.id === activeId ? "is-active" : ""}`} style={item.depth ? { paddingInlineStart: `${14 + Math.min(item.depth, 4) * 14}px` } : undefined} type="button" key={item.id} onClick={() => onSelect(item)}>{item.thumbnailUrl ? <img src={item.thumbnailUrl} alt="" loading="lazy" /> : <span>{item.label}</span>}{item.thumbnailUrl && <small>{item.label}</small>}</button>)}</div>}</aside></>;
}
