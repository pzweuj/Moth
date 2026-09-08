import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, type BookDetail, type ProgressBody, type ReadingPosition } from "../api";
import { ComicReader, type ComicSettings } from "./ComicReader";
import { FoliateTextReader } from "./FoliateTextReader";
import { loadSettings, saveSettings, type ReaderSettings } from "./settings";
import { useProgressSaver } from "./useProgressSaver";

export function ReaderPage() {
  const { id: rawId } = useParams();
  const id = Number(rawId);
  const navigate = useNavigate();
  const [detail, setDetail] = useState<BookDetail | null>(null);
  const [progress, setProgress] = useState<ProgressBody | null>(null);
  const [error, setError] = useState("");
  const [settings, setSettings] = useState<ReaderSettings>(loadSettings);
  const [comicSettings, setComicSettings] = useState<ComicSettings>({ mode: "single", direction: "ltr", fit: "screen" });
  const [fullscreen, setFullscreen] = useState(false);
  const readerShellRef = useRef<HTMLElement | null>(null);
  const { save: saveProgress, error: progressError, retry: retrySave } = useProgressSaver({
    publicationId: id,
    contentVersion: detail?.content_version ?? "",
  });

  useEffect(() => {
    let cancelled = false;
    const open = async () => {
      try {
        const book = await api.book(id);
        const saved = await api.progress(id);
        if (book.source_format === "mobi") {
          let status = await api.conversion(id);
          // A failed conversion is retryable. Starting it here keeps a
          // transient converter/filesystem failure from becoming a permanent
          // dead end after the first attempt.
          if (status.status === "pending" || status.status === "failed") {
            await api.startConversion(id);
          }
          if (status.status === "pending" || status.status === "preparing" || status.status === "failed") {
            for (let attempt = 0; attempt < 120; attempt += 1) {
              await new Promise((resolve) => setTimeout(resolve, 250));
              status = await api.conversion(id);
              if (status.status === "ready" || status.status === "failed") break;
            }
          }
          if (status.status === "failed") throw new Error(status.error ?? "MOBI 转换失败，请先转换为 EPUB");
          if (status.status !== "ready" && status.status !== "not_required") throw new Error("MOBI 转换超时，请重试");
        }
        if (!cancelled) {
          setDetail(book);
          setProgress(saved);
        }
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "书籍打开失败");
      }
    };
    void open();
    return () => {
      cancelled = true;
    };
  }, [id]);

  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  useEffect(() => {
    const update = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", update);
    return () => document.removeEventListener("fullscreenchange", update);
  }, []);

  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await readerShellRef.current?.requestFullscreen?.();
    } catch {
      // Fullscreen may be unavailable or denied; reading still works normally.
    }
  };

  const save = useCallback((position: ReadingPosition, contentVersion?: string) => {
    if (!detail) return;
    const value: ProgressBody = {
      content_version: contentVersion ?? detail.content_version,
      position,
    };
    setProgress(value);
    saveProgress(position, contentVersion ?? detail.content_version);
  }, [detail, saveProgress]);

  if (error) return <main className="state-screen"><h1>打开失败</h1><p>{error}</p><button className="primary-button" type="button" onClick={() => navigate(-1)}>返回书库</button></main>;
  if (!detail) return <main className="state-screen"><p>正在准备阅读器…</p></main>;

  const text = detail.reader_format !== "cbz";
  const title = <div className="reader-titlebar"><button className="quiet-button" type="button" onClick={() => navigate(-1)}>← 返回</button><strong>{detail.title}</strong><span>{detail.source_format.toUpperCase()}</span><button className="quiet-button" type="button" onClick={() => void toggleFullscreen()} aria-label="切换全屏">{fullscreen ? "退出全屏" : "全屏"}</button></div>;
  return <main className="reader-shell" ref={readerShellRef}>{title}<div className="reader-tools"><label>字号 <input type="range" min="12" max="36" value={settings.fontSize} onChange={(event) => setSettings({ ...settings, fontSize: Number(event.target.value) })} /></label><label>行距 <input type="range" min="13" max="22" value={Math.round(settings.lineHeight * 10)} onChange={(event) => setSettings({ ...settings, lineHeight: Number(event.target.value) / 10 })} /></label>{text && <select aria-label="阅读模式" value={settings.flow} onChange={(event) => setSettings({ ...settings, flow: event.target.value as ReaderSettings["flow"] })}><option value="paginated">分页</option><option value="scrolled">滚动</option></select>}{text ? null : <><select value={comicSettings.mode} onChange={(event) => setComicSettings({ ...comicSettings, mode: event.target.value as ComicSettings["mode"] })}><option value="single">单页</option><option value="double">双页</option><option value="webtoon">连续滚动</option></select><select value={comicSettings.fit} onChange={(event) => setComicSettings({ ...comicSettings, fit: event.target.value as ComicSettings["fit"] })}><option value="screen">适应屏幕</option><option value="width">适应宽度</option><option value="height">适应高度</option></select><select value={comicSettings.direction} onChange={(event) => setComicSettings({ ...comicSettings, direction: event.target.value as ComicSettings["direction"] })}><option value="ltr">从左到右</option><option value="rtl">从右到左</option></select></>}<button className="quiet-button" type="button" onClick={() => setSettings({ ...settings, theme: settings.theme === "dark" ? "light" : "dark" })}>{settings.theme === "dark" ? "日间" : "夜间"}</button></div>{progressError && <div className="reader-save-status" role="status">{progressError}<button type="button" onClick={() => void retrySave()}>重试保存</button></div>}{text ? <FoliateTextReader detail={detail} progress={progress} settings={settings} onProgress={save} onBack={() => navigate(-1)} /> : <ComicReader detail={detail} progress={progress} settings={comicSettings} onProgress={save} onBack={() => navigate(-1)} />}</main>;
}
