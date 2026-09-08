import { useCallback, useEffect, useRef, useState } from "react";
import type { BookDetail, ProgressBody, ReadingPosition } from "../api";

type ComicSettings = { mode: "single" | "double" | "webtoon"; direction: "ltr" | "rtl"; fit: "screen" | "width" | "height" };
type Props = { detail: BookDetail; progress?: ProgressBody | null; settings: ComicSettings; onProgress: (position: ReadingPosition, contentVersion?: string) => void; onBack: () => void };

export function ComicReader({ detail, progress, settings, onProgress, onBack }: Props) {
  const saved = progress?.content_version === detail.content_version && progress.position.type === "cbz" ? progress.position : null;
  const [index, setIndex] = useState(saved?.page_index ?? 0);
  const [urls, setUrls] = useState<Record<number, string>>({});
  const [error, setError] = useState("");
  const urlsRef = useRef<Record<number, string>>({});
  const touchStart = useRef<number | null>(null);
  useEffect(() => { urlsRef.current = urls; }, [urls]);
  const load = useCallback(async (page: number) => {
    if (page < 0 || page >= detail.pages.length || urlsRef.current[page]) return;
    try {
      const response = await fetch(`/api/v1/publications/${detail.id}/pages/${page}`, { credentials: "same-origin" });
      if (!response.ok) throw new Error("页面加载失败");
      const url = URL.createObjectURL(await response.blob());
      setUrls((current) => current[page] ? current : ({ ...current, [page]: url }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "页面加载失败");
    }
  }, [detail.id, detail.pages.length]);
  useEffect(() => {
    void load(index);
    if (settings.mode === "double") void load(index + 1);
    if (settings.mode === "webtoon") detail.pages.forEach((_, page) => void load(page));
  }, [detail.pages, index, load, settings.mode]);
  useEffect(() => () => { Object.values(urlsRef.current).forEach((url) => URL.revokeObjectURL(url)); }, []);
  useEffect(() => { onProgress({ type: "cbz", page_index: index, page_progress: 0, progress: detail.pages.length ? index / Math.max(1, detail.pages.length - 1) : 0 }); }, [detail.pages.length, index, onProgress]);
  const move = (delta: number) => setIndex((value) => Math.min(Math.max(0, value + delta), Math.max(0, detail.pages.length - 1)));
  const visible = settings.mode === "webtoon" ? detail.pages.map((_, page) => page) : settings.mode === "double" ? [index, index + 1].filter((page) => page < detail.pages.length) : [index];
  return <div className={`reader-stage comic-reader comic-${settings.mode} comic-${settings.fit}`} dir={settings.direction}><div className="reader-content"><button className="reader-back-link" type="button" onClick={onBack}>← 返回书库</button>{error && <div className="reader-error"><p>{error}</p><button type="button" onClick={() => setError("")}>关闭</button></div>}<div className="comic-pages" onTouchStart={(event) => { touchStart.current = event.changedTouches[0]?.clientX ?? null; }} onTouchEnd={(event) => { const start = touchStart.current; touchStart.current = null; const end = event.changedTouches[0]?.clientX; if (start === null || end === undefined || settings.mode === "webtoon") return; const distance = end - start; if (Math.abs(distance) < 48) return; const forward = settings.direction === "rtl" ? distance > 0 : distance < 0; move(forward ? (settings.mode === "double" ? 2 : 1) : -1); }}>{visible.map((page) => urls[page] ? <img key={page} src={urls[page]} alt={`第 ${page + 1} 页`} /> : <div className="reader-loading" key={page}>正在加载第 {page + 1} 页…</div>)}</div></div><div className="reader-bottom-bar"><button type="button" onClick={() => move(-1)} disabled={index <= 0}>上一页</button><span>{index + 1} / {detail.pages.length}</span><button type="button" onClick={() => move(settings.mode === "double" ? 2 : 1)} disabled={index >= detail.pages.length - 1}>下一页</button></div></div>;
}

export type { ComicSettings };
