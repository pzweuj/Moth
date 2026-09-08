import { useEffect, useRef, useState, type MutableRefObject } from "react";
import type { BookDetail, ProgressBody, ReadingPosition } from "../api";
import { api, bookFileUrl } from "../api";
import { makeRangeLoader } from "./zipLoader";
import { readerCss } from "./readerCss";
import type { ReaderSettings } from "./settings";
import type { ReaderNavigationItem, ReaderNavigationRequest } from "./navigation";
import type { FoliateBook, FoliateViewElement } from "../../vendor/foliate-js/view.js";
import "../../vendor/foliate-js/view.js";

type Props = { detail: BookDetail; progress?: ProgressBody | null; settings: ReaderSettings; theme: "light" | "dark"; encoding: string; navigationRequest: ReaderNavigationRequest | null; onProgress: (position: ReadingPosition, contentVersion?: string) => void; onNavigationChange: (items: ReaderNavigationItem[], activeId: string) => void };
type TocItem = { label: string; href: string; depth: number };

function toNavigationItems(items: TocItem[]): ReaderNavigationItem[] {
  return items.map((item) => ({ id: item.href, label: item.label, depth: item.depth }));
}

function flattenToc(value: unknown): TocItem[] {
  if (!Array.isArray(value)) return [];
  const output: TocItem[] = [];
  const visit = (item: unknown, depth: number) => {
    if (!item || typeof item !== "object") return;
    const entry = item as { label?: unknown; href?: unknown; subitems?: unknown };
    const href = typeof entry.href === "string" ? entry.href : "";
    const label = typeof entry.label === "string" && entry.label.trim() ? entry.label.trim() : href;
    if (href && label) output.push({ label, href, depth });
    if (Array.isArray(entry.subitems)) entry.subitems.forEach((child) => visit(child, depth + 1));
  };
  value.forEach((item) => visit(item, 0));
  return output;
}

type TextSection = { id: string; size: number; linear: string; load: () => Promise<string>; unload: () => void };

class TextPublication {
  readonly sections: TextSection[];
  readonly toc: { label: string; href: string }[];
  readonly metadata: { title: string };
  readonly dir = "ltr";
  #blobs = new Map<string, string>();

  constructor(private readonly detail: BookDetail, private readonly encoding: string, private readonly onVersion: (version: string) => void) {
    this.metadata = { title: detail.title };
    this.sections = detail.chapters.map((chapter) => {
      const id = String(chapter.idx);
      return { id, size: Math.max(1, chapter.character_count), linear: "yes", load: () => this.load(id), unload: () => this.unload(id) };
    });
    this.toc = detail.chapters.map((chapter) => ({ label: chapter.title || `第 ${chapter.idx + 1} 章`, href: `#${chapter.idx}` }));
  }

  resolveHref(href: string): { index: number; anchor: () => null } {
    const index = this.sections.findIndex((section) => section.id === String(href).replace(/^#/, ""));
    return { index: Math.max(0, index), anchor: () => null };
  }
  splitTOCHref(href: string): [string, null] | null { const match = /^#(\d+)$/.exec(String(href)); return match ? [match[1], null] : null; }
  getTOCFragment(): null { return null; }
  isExternal(): boolean { return false; }
  async getCover(): Promise<Blob | null> { return null; }
  destroy(): void { for (const url of this.#blobs.values()) URL.revokeObjectURL(url); this.#blobs.clear(); }

  async load(id: string): Promise<string> {
    const cached = this.#blobs.get(id);
    if (cached) return cached;
    const chapter = await api.chapter(this.detail.id, Number(id), this.encoding === "auto" ? undefined : this.encoding);
    this.onVersion(chapter.content_version);
    // Keep the locator's source text exact: the newline between the heading
    // and body plus the raw normalized chapter text matches character_count
    // (UTF-16 code units) recorded by the scanner.
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>body{white-space:normal}.txt-body{white-space:pre-wrap}</style></head><body><h1>${escapeHtml(chapter.title)}</h1>\n<div class="txt-body">${escapeHtml(chapter.text)}</div></body></html>`;
    const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    this.#blobs.set(id, url);
    return url;
  }
  unload(id: string): void {
    const url = this.#blobs.get(id);
    if (!url) return;
    URL.revokeObjectURL(url);
    this.#blobs.delete(id);
  }
}

function escapeHtml(value: string): string { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"); }

function rangeOffset(range: Range): number {
  const before = range.startContainer.ownerDocument?.createRange();
  if (!before || !range.startContainer.ownerDocument?.body) return 0;
  before.selectNodeContents(range.startContainer.ownerDocument.body);
  before.setEnd(range.startContainer, range.startOffset);
  return before.toString().length;
}

function offsetRange(doc: Document, offset: number): Range {
  const range = doc.createRange();
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  let remaining = Math.max(0, offset);
  while ((node = walker.nextNode())) {
    const length = node.textContent?.length ?? 0;
    if (remaining <= length) { range.setStart(node, remaining); range.collapse(true); return range; }
    remaining -= length;
  }
  range.selectNodeContents(doc.body); range.collapse(false); return range;
}

export function FoliateTextReader({ detail, progress, settings, theme, encoding, navigationRequest, onProgress, onNavigationChange }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<FoliateViewElement | null>(null);
  const publicationRef = useRef<TextPublication | null>(null);
  const progressRef = useRef(progress);
  const settingsRef = useRef(settings);
  const onProgressRef = useRef(onProgress);
  const textVersionRef = useRef(detail.content_version);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const tocRef = useRef<TocItem[]>([]);
  const onNavigationChangeRef = useRef(onNavigationChange);

  useEffect(() => { progressRef.current = progress; }, [progress]);
  useEffect(() => { onNavigationChangeRef.current = onNavigationChange; }, [onNavigationChange]);
  useEffect(() => { settingsRef.current = settings; const renderer = viewRef.current?.renderer; if (renderer) { renderer.setAttribute("flow", settings.flow); renderer.setStyles(readerCss(settings, theme)); } }, [settings, theme]);
  useEffect(() => { onProgressRef.current = onProgress; }, [onProgress]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let loader: Awaited<ReturnType<typeof makeRangeLoader>> | null = null;
    let view: FoliateViewElement | null = null;
    const cleanups: Array<() => void> = [];
    const saved = progressRef.current;
    const txtSaved = saved?.position.type === "txt" ? saved.position : null;
    const open = async () => {
      setLoading(true);
      setError("");
      const isTxt = detail.source_format === "txt";
      let book: FoliateBook;
      if (isTxt) {
        const publication = new TextPublication(detail, encoding, (version) => { textVersionRef.current = version; });
        publicationRef.current = publication;
        book = publication as unknown as FoliateBook;
        const items = publication.toc.map((item) => ({ ...item, depth: 0 }));
        tocRef.current = items;
        onNavigationChangeRef.current(toNavigationItems(items), "");
      } else {
        loader = await makeRangeLoader(bookFileUrl(detail.id), undefined, detail.content_version);
        const { EPUB } = await import("../../vendor/foliate-js/epub.js");
        const epub = await new EPUB(loader).init();
        book = epub as unknown as FoliateBook;
        const items = flattenToc((epub as { toc?: unknown }).toc);
        tocRef.current = items;
        onNavigationChangeRef.current(toNavigationItems(items), "");
      }
      view = document.createElement("foliate-view") as unknown as FoliateViewElement;
      host.append(view); viewRef.current = view;
      view.addEventListener("relocate", (event: Event) => {
        const location = (event as CustomEvent).detail ?? {};
        const fraction = typeof location.fraction === "number" ? Math.max(0, Math.min(1, location.fraction)) : 0;
        const section = location.section ?? {};
        const index = Number.isInteger(section.current) ? section.current : 0;
        const range = location.range as Range | undefined;
        if (isTxt) {
          const offset = range ? rangeOffset(range) : 0;
          onProgressRef.current({ type: "txt", chapter_index: index, character_offset: offset, encoding, progress: fraction }, textVersionRef.current);
        } else {
          const cfi = typeof location.cfi === "string" ? location.cfi : "";
          const href = typeof location.href === "string" ? location.href : String(location.tocItem?.href ?? section.current ?? "");
          if (cfi) onProgressRef.current({ type: "epub", href, cfi, progress: fraction });
        }
        const href = isTxt ? `#${index}` : typeof location.href === "string" ? location.href : String(location.tocItem?.href ?? section.current ?? "");
        const active = tocRef.current.find((item) => item.href === href || (href && item.href.startsWith(href.split("#")[0])))?.href ?? (isTxt ? `#${index}` : "");
        onNavigationChangeRef.current(toNavigationItems(tocRef.current), active);
      });
      view.addEventListener("load", ((event: Event) => {
        const doc = (event as CustomEvent<{ doc?: Document }>).detail?.doc;
        if (doc) cleanups.push(installMobileTapNavigation(doc, view!, settingsRef));
      }) as EventListener);
      await view.open(book);
      view.renderer.setAttribute("flow", settingsRef.current.flow);
      view.renderer.setStyles(readerCss(settingsRef.current, theme));
      if (isTxt && txtSaved && txtSaved.encoding === encoding && saved?.content_version) {
        const index = txtSaved.chapter_index;
        await view.renderer.goTo({ index, anchor: (doc: Document) => offsetRange(doc, txtSaved.character_offset) });
      } else if (!isTxt && saved?.position.type === "epub" && saved.position.cfi) {
        await view.init({ lastLocation: saved.position.cfi });
      } else if (saved?.position.type === "epub" && saved.position.progress > 0) {
        await view.init({ lastLocation: { fraction: saved.position.progress } });
      } else {
        await view.init({ showTextStart: true });
      }
      if (!cancelled) setLoading(false);
    };
    void open().catch((reason) => { if (!cancelled) { setError(reason instanceof Error ? reason.message : "打开书籍失败"); setLoading(false); } });
    return () => { cancelled = true; cleanups.forEach((cleanup) => cleanup()); view?.close(); view?.remove(); viewRef.current = null; publicationRef.current?.destroy(); publicationRef.current = null; void loader?.close(); };
  }, [detail, encoding, theme]);

  useEffect(() => {
    if (!navigationRequest || !viewRef.current) return;
    void viewRef.current.goTo(navigationRequest.id);
  }, [navigationRequest]);

  return <div className={`reader-stage text-reader theme-${theme}`}><div className="reader-content"><div ref={hostRef} className="reader-host" />{loading && <p>正在打开书籍…</p>}{error && <div className="reader-error"><p>{error}</p></div>}</div><div className="reader-bottom-bar"><button type="button" onClick={() => void viewRef.current?.prev()}>上一页</button><button type="button" onClick={() => void viewRef.current?.next()}>下一页</button></div></div>;
}

function installMobileTapNavigation(doc: Document, view: FoliateViewElement, settingsRef: MutableRefObject<ReaderSettings>): () => void {
  let startX: number | null = null;
  let moved = false;
  const touchStart = (event: TouchEvent) => {
    startX = event.changedTouches[0]?.clientX ?? null;
    moved = false;
  };
  const touchMove = (event: TouchEvent) => {
    if (startX === null) return;
    const x = event.changedTouches[0]?.clientX;
    if (x !== undefined && Math.abs(x - startX) > 12) moved = true;
  };
  const touchEnd = (event: TouchEvent) => {
    const start = startX;
    startX = null;
    if (start === null || moved || settingsRef.current.flow !== "paginated" || !window.matchMedia("(max-width: 760px)").matches) return;
    if (event.changedTouches.length !== 1) return;
    const target = event.target as Element | null;
    if (target instanceof Element && target.closest("a,button,input,select,textarea,video,img")) return;
    const selection = doc.getSelection();
    if (selection && !selection.isCollapsed) return;
    const x = event.changedTouches[0]?.clientX ?? start;
    const width = doc.documentElement.clientWidth || window.innerWidth;
    if (x < width * 0.3) view.goLeft();
    else if (x > width * 0.7) view.goRight();
  };
  doc.addEventListener("touchstart", touchStart, { capture: true, passive: true });
  doc.addEventListener("touchmove", touchMove, { capture: true, passive: true });
  doc.addEventListener("touchend", touchEnd, { capture: true, passive: true });
  return () => {
    doc.removeEventListener("touchstart", touchStart, true);
    doc.removeEventListener("touchmove", touchMove, true);
    doc.removeEventListener("touchend", touchEnd, true);
  };
}
