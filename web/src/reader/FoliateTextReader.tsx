import { useEffect, useRef, useState, type MutableRefObject } from "react";
import type { BookDetail, ProgressBody, ReadingPosition } from "../api";
import { api, bookFileUrl } from "../api";
import { makeRangeLoader } from "./zipLoader";
import { readerCss } from "./readerCss";
import type { ReaderSettings } from "./settings";
import type { ReaderNavigationItem, ReaderNavigationRequest } from "./navigation";
import type { FoliateBook, FoliateViewElement } from "../../vendor/foliate-js/view.js";
import { EPUB } from "../../vendor/foliate-js/epub.js";
import "../../vendor/foliate-js/view.js";

type Props = {
  detail: BookDetail;
  progress?: ProgressBody | null;
  settings: ReaderSettings;
  theme: "light" | "dark";
  encoding: string;
  navigationRequest: ReaderNavigationRequest | null;
  onProgress: (position: ReadingPosition, contentVersion?: string) => void;
  onNavigationChange: (items: ReaderNavigationItem[], activeId: string) => void;
};

type TocItem = { label: string; href: string; depth: number };

type TextSection = {
  id: string;
  size: number;
  linear: string;
  load: () => Promise<string>;
  unload: () => void;
};

type RelocateLocation = {
  fraction?: unknown;
  section?: { current?: unknown };
  range?: unknown;
  cfi?: unknown;
  tocItem?: { href?: unknown };
};

type ResolvedNavigation = { index?: unknown };

const LOAD_TIMEOUT_MS = 30_000;

function sectionCount(book: FoliateBook): number {
  const sections = (book as { sections?: unknown }).sections;
  return Array.isArray(sections) ? sections.length : 0;
}

function sectionId(book: FoliateBook, index: number): string {
  const sections = (book as { sections?: Array<{ id?: unknown }> }).sections ?? [];
  return typeof sections[index]?.id === "string" ? sections[index].id : String(index);
}

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

function spineNavigation(book: FoliateBook): TocItem[] {
  const sections = (book as { sections?: Array<{ id?: unknown }> }).sections ?? [];
  return sections.flatMap((section, index) => {
    const href = typeof section.id === "string" ? section.id : "";
    return href ? [{ label: `第 ${index + 1} 节`, href, depth: 0 }] : [];
  });
}

function normalizedHref(value: string): string {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}

function activeTocHref(items: TocItem[], location: RelocateLocation, sectionHref: string): string {
  const locationHref = typeof location.tocItem?.href === "string" ? normalizedHref(location.tocItem.href) : "";
  const exact = locationHref && items.find((item) => normalizedHref(item.href) === locationHref);
  if (exact) return exact.href;

  const currentHref = locationHref || normalizedHref(sectionHref);
  const currentPath = currentHref.split("#", 1)[0];
  return items
    .filter((item) => normalizedHref(item.href).split("#", 1)[0] === currentPath)
    .sort((left, right) => right.href.length - left.href.length)[0]?.href ?? "";
}

class TextPublication {
  readonly sections: TextSection[];
  readonly toc: { label: string; href: string }[];
  readonly metadata: { title: string };
  readonly dir = "ltr";
  #blobs = new Map<string, string>();

  constructor(
    private readonly detail: BookDetail,
    private readonly encoding: string,
    private readonly signal: AbortSignal,
    private readonly onVersion: (version: string) => void,
  ) {
    this.metadata = { title: detail.title };
    this.sections = detail.chapters.map((chapter) => {
      const id = String(chapter.idx);
      return {
        id,
        size: Math.max(1, chapter.character_count),
        linear: "yes",
        load: () => this.load(id),
        unload: () => this.unload(id),
      };
    });
    this.toc = detail.chapters.map((chapter) => ({
      label: chapter.title || `第 ${chapter.idx + 1} 章`,
      href: `#${chapter.idx}`,
    }));
  }

  resolveHref(href: string): { index: number; anchor: () => null } {
    const target = String(href).replace(/^#/, "").split("#", 1)[0];
    const index = this.sections.findIndex((section) => section.id === target);
    return { index: Math.max(0, index), anchor: () => null };
  }

  splitTOCHref(href: string): [string, null] | null {
    const match = /^#(\d+)$/.exec(String(href));
    return match ? [match[1], null] : null;
  }

  getTOCFragment(): null { return null; }
  isExternal(): boolean { return false; }
  async getCover(): Promise<Blob | null> { return null; }

  destroy(): void {
    for (const url of this.#blobs.values()) URL.revokeObjectURL(url);
    this.#blobs.clear();
  }

  async load(id: string): Promise<string> {
    if (this.signal.aborted) throw new DOMException("阅读器已关闭", "AbortError");
    const cached = this.#blobs.get(id);
    if (cached) return cached;
    const chapter = await api.chapter(
      this.detail.id,
      Number(id),
      this.encoding === "auto" ? undefined : this.encoding,
      this.signal,
    );
    if (this.signal.aborted) throw new DOMException("阅读器已关闭", "AbortError");
    this.onVersion(chapter.content_version);
    const title = chapter.title.trim();
    const heading = title ? `<h1>${escapeHtml(title)}</h1>\n` : "";
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>body{white-space:normal}.txt-body{white-space:pre-wrap}</style></head><body>${heading}<div class="txt-body">${escapeHtml(chapter.text)}</div></body></html>`;
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

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function rangeOffset(range: Range): number {
  const before = range.startContainer.ownerDocument?.createRange();
  if (!before || !range.startContainer.ownerDocument?.body) return 0;
  before.selectNodeContents(range.startContainer.ownerDocument.body);
  before.setEnd(range.startContainer, range.startOffset);
  return before.toString().length;
}

function offsetRange(doc: Document, offset: number): Range {
  const range = doc.createRange();
  const textNodeFilter = doc.defaultView?.NodeFilter.SHOW_TEXT ?? 4;
  const walker = doc.createTreeWalker(doc.body, textNodeFilter);
  let node: Node | null;
  let remaining = Math.max(0, offset);
  while ((node = walker.nextNode())) {
    const length = node.textContent?.length ?? 0;
    if (remaining <= length) {
      range.setStart(node, remaining);
      range.collapse(true);
      return range;
    }
    remaining -= length;
  }
  range.selectNodeContents(doc.body);
  range.collapse(false);
  return range;
}

function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), LOAD_TIMEOUT_MS);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (reason: unknown) => {
        window.clearTimeout(timer);
        reject(reason);
      },
    );
  });
}

function validResolved(value: unknown, count: number): value is ResolvedNavigation & { index: number } {
  if (!value || typeof value !== "object") return false;
  const index = (value as ResolvedNavigation).index;
  return typeof index === "number" && Number.isInteger(index) && index >= 0 && index < count;
}

function clampProgress(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

export function FoliateTextReader({ detail, progress, settings, theme, encoding, navigationRequest, onProgress, onNavigationChange }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<FoliateViewElement | null>(null);
  const publicationRef = useRef<TextPublication | null>(null);
  const progressRef = useRef(progress);
  const settingsRef = useRef(settings);
  const themeRef = useRef(theme);
  const onProgressRef = useRef(onProgress);
  const textVersionRef = useRef(detail.content_version);
  const onNavigationChangeRef = useRef(onNavigationChange);
  const [loading, setLoading] = useState(true);
  const [loadingStage, setLoadingStage] = useState("读取资源");
  const [error, setError] = useState("");
  const [retryToken, setRetryToken] = useState(0);
  const tocRef = useRef<TocItem[]>([]);

  useEffect(() => { progressRef.current = progress; }, [progress]);
  useEffect(() => { onNavigationChangeRef.current = onNavigationChange; }, [onNavigationChange]);
  useEffect(() => { onProgressRef.current = onProgress; }, [onProgress]);
  useEffect(() => {
    settingsRef.current = settings;
    themeRef.current = theme;
    const renderer = viewRef.current?.renderer;
    if (!renderer) return;
    renderer.setAttribute("flow", settings.flow);
    renderer.setStyles(readerCss(settings, theme));
  }, [settings, theme]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let loader: Awaited<ReturnType<typeof makeRangeLoader>> | null = null;
    let view: FoliateViewElement | null = null;
    let publication: TextPublication | null = null;
    let suppressRelocate = true;
    const controller = new AbortController();
    const cleanups: Array<() => void> = [];
    const saved = progressRef.current;
    const isTxt = detail.source_format === "txt";

    const publishLocation = (location: RelocateLocation, persist: boolean) => {
      const fraction = clampProgress(typeof location.fraction === "number" ? location.fraction : 0);
      const sectionIndex = typeof location.section?.current === "number" && Number.isInteger(location.section.current)
        ? location.section.current
        : 0;
      const sectionHref = view ? sectionId(view.book, sectionIndex) : String(sectionIndex);
      const tocHref = activeTocHref(tocRef.current, location, sectionHref);
      if (isTxt) {
        const range = location.range && typeof location.range === "object" ? location.range as Range : null;
        const offset = range ? rangeOffset(range) : 0;
        if (persist) {
          onProgressRef.current({
            type: "txt",
            chapter_index: sectionIndex,
            character_offset: offset,
            encoding,
            progress: fraction,
          }, textVersionRef.current);
        }
        onNavigationChangeRef.current(toNavigationItems(tocRef.current), tocHref || `#${sectionIndex}`);
        return;
      }

      const cfi = typeof location.cfi === "string" ? location.cfi : "";
      if (persist && cfi) {
        onProgressRef.current({ type: "epub", href: tocHref || sectionHref, cfi, progress: fraction });
      }
      onNavigationChangeRef.current(toNavigationItems(tocRef.current), tocHref);
    };

    const handleRelocate = (event: Event) => {
      if (cancelled) return;
      const location = ((event as CustomEvent).detail ?? {}) as RelocateLocation;
      if (!suppressRelocate) publishLocation(location, true);
    };

    const open = async () => {
      setLoading(true);
      setLoadingStage("读取资源");
      setError("");

      let book: FoliateBook;
      if (isTxt) {
        publication = new TextPublication(detail, encoding, controller.signal, (version) => {
          textVersionRef.current = version;
        });
        publicationRef.current = publication;
        book = publication as unknown as FoliateBook;
        const items = publication.toc.map((item) => ({ ...item, depth: 0 }));
        tocRef.current = items;
        onNavigationChangeRef.current(toNavigationItems(items), "");
      } else {
        loader = await withTimeout(
          makeRangeLoader(bookFileUrl(detail.id), controller.signal, detail.content_version),
          "读取 EPUB 资源超时，请重试",
        );
        if (cancelled) return;
        setLoadingStage("解析书籍");
        const epub = await withTimeout(new EPUB(loader).init(), "解析 EPUB 失败或超时，请重试");
        if (cancelled) return;
        book = epub as unknown as FoliateBook;
        const parsedToc = flattenToc((epub as { toc?: unknown }).toc);
        const items = parsedToc.length > 0 ? parsedToc : spineNavigation(book);
        tocRef.current = items;
        onNavigationChangeRef.current(toNavigationItems(items), "");
      }

      if (cancelled) return;
      setLoadingStage("排版");
      view = document.createElement("foliate-view") as unknown as FoliateViewElement;
      view.addEventListener("relocate", handleRelocate);
      view.addEventListener("open-stage", ((event: Event) => {
        if (cancelled) return;
        const stage = (event as CustomEvent<unknown>).detail;
        if (typeof stage === "string" && stage) setLoadingStage(stage);
      }) as EventListener);
      view.addEventListener("load", ((event: Event) => {
        if (cancelled) return;
        const detail = (event as CustomEvent<{ doc?: Document; index?: number }>).detail;
        const doc = detail?.doc;
        if (doc && view) {
          cleanups.push(installMobileTapNavigation(doc, view, settingsRef));
        }
      }) as EventListener);
      host.append(view);
      viewRef.current = view;
      if (publication) publicationRef.current = publication;

      await withTimeout(view.open(book), "排版书籍超时，请重试");
      if (cancelled) return;
      view.renderer.setAttribute("flow", settingsRef.current.flow);
      view.renderer.setStyles(readerCss(settingsRef.current, themeRef.current));

      const position = saved?.position;
      let restored = false;
      let persistAfterRestore = false;
      if (isTxt && position?.type === "txt"
        && saved?.content_version === detail.content_version
        && position.encoding === encoding) {
        const index = Math.min(Math.max(0, position.chapter_index), Math.max(0, detail.chapters.length - 1));
        if (index === position.chapter_index && index < detail.chapters.length) {
          await withTimeout(view.renderer.goTo({
            index,
            anchor: (doc: Document) => offsetRange(doc, position.character_offset),
          }), "恢复 TXT 阅读位置超时，请重试");
          restored = true;
        }
      } else if (!isTxt && position?.type === "epub" && saved?.content_version === detail.content_version) {
        const cfi = position.cfi.trim();
        if (cfi) {
          let resolved: unknown;
          try {
            resolved = view.resolveNavigation(cfi);
          } catch {
            resolved = null;
          }
          if (validResolved(resolved, sectionCount(view.book))) {
            try {
              await withTimeout(view.renderer.goTo(resolved), "恢复 EPUB 阅读位置超时，请重试");
              restored = true;
            } catch {
              persistAfterRestore = true;
            }
          } else {
            persistAfterRestore = true;
          }
        } else {
          persistAfterRestore = true;
        }
        if (!restored && position.progress > 0) {
          await withTimeout(view.init({ lastLocation: { fraction: clampProgress(position.progress) } }), "恢复 EPUB 阅读位置超时，请重试");
          restored = true;
        }
      }

      if (cancelled) return;
      if (!restored) {
        suppressRelocate = false;
        await withTimeout(view.init({ showTextStart: true }), "打开正文超时，请重试");
        // A stale/invalid CFI or content version deliberately falls back to
        // the text start. Persist the freshly generated CFI immediately so a
        // close/background event cannot leave the server with the unusable
        // locator that caused the fallback.
        const location = view.lastLocation;
        if (location) publishLocation(location as RelocateLocation, true);
      } else {
        suppressRelocate = false;
        const location = view.lastLocation;
        if (location) publishLocation(location as RelocateLocation, persistAfterRestore);
      }
      if (!cancelled) setLoading(false);
    };

    void open().catch((reason: unknown) => {
      if (cancelled) return;
      setError(reason instanceof Error ? reason.message : "打开书籍失败，请重试");
      setLoading(false);
    });

    return () => {
      cancelled = true;
      controller.abort();
      cleanups.forEach((cleanup) => cleanup());
      if (viewRef.current === view) viewRef.current = null;
      view?.close();
      view?.remove();
      if (publicationRef.current === publication) publicationRef.current = null;
      publication?.destroy();
      void loader?.close();
    };
  }, [detail, encoding, retryToken]);

  useEffect(() => {
    const view = viewRef.current;
    if (!navigationRequest || !view) return;
    let cancelled = false;
    void view.goTo(navigationRequest.id).then((resolved) => {
      if (!cancelled && !validResolved(resolved, sectionCount(view.book))) {
        setError("章节跳转失败，请重试");
      }
    }).catch(() => {
      if (!cancelled) setError("章节跳转失败，请重试");
    });
    return () => { cancelled = true; };
  }, [navigationRequest]);

  const retry = () => {
    setError("");
    setRetryToken((value) => value + 1);
  };
  const move = (direction: "prev" | "next") => {
    const view = viewRef.current;
    if (!view) return;
    void (direction === "prev" ? view.prev() : view.next()).catch(() => setError("翻页失败，请重试"));
  };

  return <div className={`reader-stage text-reader theme-${theme}`}>
    <div className="reader-content">
      <div ref={hostRef} className="reader-host" />
      {loading && <div className="reader-loading" role="status" aria-live="polite"><span>{loadingStage}…</span></div>}
      {error && <div className="reader-error" role="alert"><p>{error}</p><button className="reader-control-button reader-control-button--danger" type="button" onClick={retry}>重试</button></div>}
    </div>
    <div className="reader-bottom-bar">
      <button className="reader-control-button" type="button" onClick={() => move("prev")} disabled={loading}>上一页</button>
      <button className="reader-control-button" type="button" onClick={() => move("next")} disabled={loading}>下一页</button>
    </div>
  </div>;
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
