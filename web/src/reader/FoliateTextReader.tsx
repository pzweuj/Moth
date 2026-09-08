import { useEffect, useRef, useState } from "react";
import type { BookDetail, ProgressBody, ReadingPosition } from "../api";
import { api, bookFileUrl } from "../api";
import { makeRangeLoader } from "./zipLoader";
import { readerCss } from "./readerCss";
import type { ReaderSettings } from "./settings";
import type { FoliateBook, FoliateViewElement } from "../../vendor/foliate-js/view.js";
import "../../vendor/foliate-js/view.js";

type Props = { detail: BookDetail; progress?: ProgressBody | null; settings: ReaderSettings; onProgress: (position: ReadingPosition, contentVersion?: string) => void; onBack: () => void };

type TocItem = { label: string; href: string; subitems?: TocItem[] | null };

function flattenToc(value: unknown): TocItem[] {
  if (!Array.isArray(value)) return [];
  const output: TocItem[] = [];
  const visit = (item: unknown, depth: number) => {
    if (!item || typeof item !== "object") return;
    const value = item as { label?: unknown; href?: unknown; subitems?: unknown };
    const href = typeof value.href === "string" ? value.href : "";
    const label = typeof value.label === "string" && value.label.trim() ? value.label.trim() : href;
    if (href && label) output.push({ label: `${"　".repeat(Math.min(depth, 4))}${label}`, href });
    if (Array.isArray(value.subitems)) value.subitems.forEach((child) => visit(child, depth + 1));
  };
  value.forEach((item) => visit(item, 0));
  return output;
}

export function FoliateTextReader({ detail, progress, settings, onProgress, onBack }: Props) {
  if (detail.source_format === "txt") return <TxtReader detail={detail} progress={progress} settings={settings} onProgress={onProgress} onBack={onBack} />;
  return <EpubReader detail={detail} progress={progress} settings={settings} onProgress={onProgress} onBack={onBack} />;
}

function TxtReader({ detail, progress, settings, onProgress, onBack }: Props) {
  const saved = progress?.position.type === "txt" ? progress.position : null;
  const [index, setIndex] = useState(saved?.chapter_index ?? 0);
  const [encoding, setEncoding] = useState(saved?.encoding ?? "auto");
  const [chapter, setChapter] = useState<{ title: string; content: string; content_version: string } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { let cancelled = false; setError(""); void api.chapter(detail.id, index, encoding === "auto" ? undefined : encoding).then((value) => { if (!cancelled) setChapter(value); }).catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : "章节加载失败"); }); return () => { cancelled = true; }; }, [detail.id, index, encoding]);
  useEffect(() => { if (chapter && index >= 0) { const offset = saved?.chapter_index === index && saved.encoding === encoding ? saved.character_offset : 0; onProgress({ type: "txt", chapter_index: index, character_offset: offset, encoding, progress: Math.min(1, Math.max(0, (index + 1) / Math.max(1, detail.chapters.length))) }, chapter.content_version); } }, [chapter, detail.chapters.length, index, onProgress, saved?.chapter_index, saved?.character_offset, saved?.encoding, encoding]);
  const next = () => setIndex((value) => Math.min(detail.chapters.length - 1, value + 1)); const prev = () => setIndex((value) => Math.max(0, value - 1));
  return <div className={`reader-stage text-reader theme-${settings.theme}`} style={{ fontSize: `${settings.fontSize}px`, lineHeight: settings.lineHeight, padding: `0 ${settings.margin}px` }}><div className="reader-content"><button className="reader-back-link" type="button" onClick={onBack}>← 返回书库</button><div className="reader-inline-tools"><label className="reader-encoding">编码 <select value={encoding} onChange={(event) => { setEncoding(event.target.value); setIndex(saved?.chapter_index ?? 0); }}><option value="auto">自动检测</option><option value="utf-8">UTF-8</option><option value="utf-16le">UTF-16 LE</option><option value="utf-16be">UTF-16 BE</option><option value="gbk">GBK</option><option value="gb18030">GB18030</option><option value="big5">Big5</option></select></label>{detail.chapters.length > 0 && <label className="reader-encoding">目录 <select aria-label="目录" value={index} onChange={(event) => setIndex(Number(event.target.value))}>{detail.chapters.map((item) => <option key={item.idx} value={item.idx}>{item.title || `第 ${item.idx + 1} 章`}</option>)}</select></label>}</div>{error ? <div className="reader-error"><p>{error}</p><button type="button" onClick={() => setIndex(index)}>重试</button></div> : chapter ? <><h1>{chapter.title || detail.title}</h1><article dangerouslySetInnerHTML={{ __html: chapter.content }} /></> : <p>正在加载章节…</p>}</div><div className="reader-bottom-bar"><button type="button" onClick={prev} disabled={index <= 0}>上一章</button><span>{index + 1} / {Math.max(1, detail.chapters.length)}</span><button type="button" onClick={next} disabled={index >= detail.chapters.length - 1}>下一章</button></div></div>;
}

function EpubReader({ detail, progress, settings, onProgress, onBack }: Props) {
  const hostRef = useRef<HTMLDivElement>(null); const viewRef = useRef<FoliateViewElement | null>(null); const [loading, setLoading] = useState(true); const [error, setError] = useState("");
  const progressRef = useRef(progress); const settingsRef = useRef(settings); const onProgressRef = useRef(onProgress);
  useEffect(() => { progressRef.current = progress; }, [progress]);
  useEffect(() => { settingsRef.current = settings; }, [settings]);
  useEffect(() => { onProgressRef.current = onProgress; }, [onProgress]);
  useEffect(() => {
    const host = hostRef.current; if (!host) return; let cancelled = false; let loader: Awaited<ReturnType<typeof makeRangeLoader>> | null = null; let view: FoliateViewElement | null = null;
    const open = async () => {
      loader = await makeRangeLoader(bookFileUrl(detail.id), undefined, detail.content_version);
      const { EPUB } = await import("../../vendor/foliate-js/epub.js");
      const book = await new EPUB(loader).init();
      view = document.createElement("foliate-view") as unknown as FoliateViewElement; host.append(view); viewRef.current = view;
      view.addEventListener("relocate", (event: Event) => { const location = (event as CustomEvent).detail ?? {}; const fraction = typeof location.fraction === "number" ? location.fraction : 0; const section = location.section ?? {}; const cfi = typeof location.cfi === "string" ? location.cfi : ""; const href = typeof location.href === "string" ? location.href : String(section.current ?? ""); if (cfi) onProgressRef.current({ type: "epub", href, cfi, progress: Math.max(0, Math.min(1, fraction)) }); });
      await view.open(book as FoliateBook); const renderer = view.renderer as typeof view.renderer & { setStyles?: (css: string) => void }; renderer.setAttribute("flow", "paginated"); renderer.setAttribute("margin", `${settingsRef.current.margin}px`); renderer.setStyles?.(readerCss(settingsRef.current));
      const saved = progressRef.current?.content_version === detail.content_version && progressRef.current.position.type === "epub" ? progressRef.current.position : null;
      if (saved?.cfi) await view.init({ lastLocation: saved.cfi }); else if (saved) await view.init({ lastLocation: { fraction: saved.progress } }); else await view.init({ showTextStart: true });
      if (!cancelled) setLoading(false);
    };
    void open().catch((reason) => { if (!cancelled) { setError(reason instanceof Error ? reason.message : "EPUB 打开失败"); setLoading(false); } });
    return () => { cancelled = true; view?.close(); view?.remove(); viewRef.current = null; void loader?.close(); };
  }, [detail.id, detail.content_version]);
  useEffect(() => { const view = viewRef.current; if (!view) return; const renderer = view.renderer as typeof view.renderer & { setStyles?: (css: string) => void }; renderer.setStyles?.(readerCss(settings)); renderer.setAttribute("margin", `${settings.margin}px`); }, [settings]);
  return <div className={`reader-stage foliate-reader theme-${settings.theme}`}><div className="reader-content"><button className="reader-back-link" type="button" onClick={onBack}>← 返回书库</button><div ref={hostRef} className="reader-host" />{loading && <p>正在打开书籍…</p>}{error && <div className="reader-error"><p>{error}</p><button type="button" onClick={onBack}>返回书库</button></div>}</div><div className="reader-bottom-bar"><button type="button" onClick={() => void viewRef.current?.prev()}>上一页</button><button type="button" onClick={() => void viewRef.current?.next()}>下一页</button></div></div>;
}
