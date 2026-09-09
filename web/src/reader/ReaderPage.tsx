import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, pageThumbnailUrl, type BookDetail, type ProgressBody, type ReadingPosition } from "../api";
import { ComicReader } from "./ComicReader";
import { FoliateTextReader } from "./FoliateTextReader";
import type { ReaderNavigationItem, ReaderNavigationRequest } from "./navigation";
import { loadComicSettings, loadSettings, saveComicSettings, saveSettings, type ComicSettings, type ReaderSettings } from "./settings";
import { useProgressSaver } from "./useProgressSaver";

type Theme = "light" | "dark";
type Props = { theme: Theme; onToggleTheme: () => void };
type LoadRequest = { id: number; encoding: string; progress: ProgressBody | null; token: number };

const MOBI_POLL_ATTEMPTS = 120;
const MOBI_POLL_DELAY_MS = 250;

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
  const navigationToken = useRef(0);
  const { save: saveProgress, error: progressError, retry: retrySave } = useProgressSaver({
    publicationId: id,
    contentVersion: detail?.content_version ?? "",
  });

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
    if (!detail) return;
    const value: ProgressBody = {
      content_version: contentVersion ?? detail.content_version,
      position,
    };
    setProgress(value);
    saveProgress(position, contentVersion ?? detail.content_version);
  }, [detail, saveProgress]);

  const text = detail?.reader_format !== "cbz";
  const pageNavigation = useMemo<ReaderNavigationItem[]>(() => detail?.pages.map((page) => ({
    id: String(page.idx),
    label: `第 ${page.idx + 1} 页`,
    thumbnailUrl: pageThumbnailUrl(id, page.idx),
  })) ?? [], [detail?.pages, id]);
  const navigationItems = text ? textNavigation : pageNavigation;

  const openSettings = () => {
    setNavigationOpen(false);
    setSettingsOpen((value) => !value);
  };
  const openNavigation = () => {
    setSettingsOpen(false);
    setNavigationOpen((value) => !value);
  };
  const selectNavigation = (item: ReaderNavigationItem) => {
    navigationToken.current += 1;
    setNavigationRequest({ id: item.id, token: navigationToken.current });
    setActiveNavigationId(item.id);
    setSettingsOpen(false);
    setNavigationOpen(false);
  };

  const onEncodingChange = (value: string) => {
    if (!detail || detail.source_format !== "txt" || value === encoding) return;
    setEncoding(value);
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

  return <main className="reader-shell">
    <header className="reader-titlebar">
      <button className="quiet-button reader-back-button" type="button" onClick={() => navigate(-1)}>← 返回</button>
      <button className="quiet-button reader-icon-button" type="button" onClick={openNavigation} aria-label={text ? "打开章节" : "打开页码"} aria-expanded={navigationOpen}>☰</button>
      <strong>{detail.title}</strong>
      <span className="reader-format">{detail.source_format.toUpperCase()}</span>
      <MobileClock />
      <button className="quiet-button reader-theme-button" type="button" onClick={onToggleTheme} aria-label="切换主题">{theme === "dark" ? "日间" : "夜间"}</button>
      <button className="quiet-button reader-icon-button" type="button" onClick={openSettings} aria-label="阅读设置" aria-expanded={settingsOpen}>Aa</button>
    </header>
    {settingsOpen && <ReaderSettingsPanel detail={detail} settings={settings} setSettings={setSettings} comicSettings={comicSettings} setComicSettings={setComicSettings} encoding={encoding} onEncodingChange={onEncodingChange} text={text} />}
    {navigationOpen && <ReaderNavigationDrawer items={navigationItems} activeId={activeNavigationId} kind={text ? "chapters" : "pages"} onSelect={selectNavigation} onClose={() => setNavigationOpen(false)} />}
    {progressError && <div className="reader-save-status" role="status">{progressError}<button type="button" onClick={() => void retrySave()}>重试保存</button></div>}
    {text
      ? <FoliateTextReader key={`${detail.id}:${detail.content_version}`} detail={detail} progress={progress} settings={settings} theme={theme} encoding={encoding} navigationRequest={navigationRequest} onProgress={save} onNavigationChange={(items, activeId) => { setTextNavigation(items); if (activeId) setActiveNavigationId(activeId); }} />
      : <ComicReader key={`${detail.id}:${detail.content_version}`} detail={detail} progress={progress} settings={comicSettings} navigationRequest={navigationRequest} onCurrentPageChange={(page) => setActiveNavigationId(String(page))} onProgress={save} />}
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
    return () => {
      window.clearTimeout(timeout);
      if (intervalRef.current !== null) window.clearInterval(intervalRef.current);
    };
  }, []);
  return <time className="reader-clock" dateTime={now.toISOString()}>{`${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`}</time>;
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
  return <><button className="reader-drawer-backdrop" type="button" aria-label="关闭导航" onClick={onClose} /><aside className={`reader-drawer ${kind === "pages" ? "reader-page-drawer" : ""}`} aria-label={kind === "pages" ? "页码选择器" : "章节选择器"}><div className="reader-drawer-header"><h2>{kind === "pages" ? "页码" : "章节"}</h2><button className="quiet-button reader-icon-button" type="button" onClick={onClose} aria-label="关闭">×</button></div>{items.length === 0 ? <p className="shelf-hint">正在读取…</p> : <div className="reader-navigation-list">{items.map((item) => <button className={`reader-navigation-item ${item.id === activeId ? "is-active" : ""}`} style={item.depth ? { paddingInlineStart: `${14 + Math.min(item.depth, 4) * 14}px` } : undefined} type="button" key={item.id} onClick={() => onSelect(item)}>{item.thumbnailUrl ? <img src={item.thumbnailUrl} alt="" loading="lazy" /> : <span>{item.label}</span>}{item.thumbnailUrl && <small>{item.label}</small>}</button>)}</div>}</aside></>;
}
