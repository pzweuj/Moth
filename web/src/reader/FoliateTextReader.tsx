import { useEffect, useRef, useState, type MutableRefObject } from "react";
import type { BookDetail, ProgressBody, ReadingPosition } from "../api";
import { api, bookFileUrl } from "../api";
import { makeRangeLoader } from "./zipLoader";
import { framePointToViewport, installPageGestures, type PageGestureState } from "./pageGestures";
import { readerCss } from "./readerCss";
import { cacheSections } from "./sectionCache";
import type { ReaderSettings } from "./settings";
import type { ReaderNavigationItem, ReaderNavigationRequest } from "./navigation";
import type { ReaderReadingState } from "./readingState";
import { installReaderKeyboard, type ReaderKeyboardAction } from "./keyboard";
import type { FoliateBook, FoliateRenderer, FoliateViewElement } from "../../vendor/foliate-js/view.js";
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
  onReadingStateChange?: (state: ReaderReadingState) => void;
  onAdvanceAtEnd?: () => void;
  onCenterTap?: () => void;
  onPageTurn?: () => void;
  keyboardEnabled?: () => boolean;
  onKeyboardAction?: (action: ReaderKeyboardAction) => boolean;
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
  index?: unknown;
  fraction?: unknown;
  section?: { current?: unknown };
  range?: unknown;
  cfi?: unknown;
  tocItem?: { href?: unknown };
};

type ResolvedNavigation = { index?: unknown };

const LOAD_TIMEOUT_MS = 30_000;
const READER_PAGE_GAP = "2%";
const READER_PAGE_MARGIN = "16px";

function applyReaderLayout(renderer: FoliateRenderer, settings: ReaderSettings): void {
  // Foliate's paginator defaults to a 7% page gap and 48px top/bottom
  // margins. Keep the layout compact for every reflowable format, including
  // TXT and MOBI after MOBI conversion.
  renderer.setAttribute("gap", READER_PAGE_GAP);
  renderer.setAttribute("margin", READER_PAGE_MARGIN);
  renderer.setAttribute("flow", settings.flow);
}

function applyFixedDocumentTheme(doc: Document, theme: "light" | "dark"): void {
  const root = doc.head ?? doc.documentElement;
  if (!root) return;
  const background = theme === "dark" ? "#101615" : "#f5f5ef";
  const foreground = theme === "dark" ? "#e8eee5" : "#27312d";
  let style = doc.getElementById("moth-reader-theme") as HTMLStyleElement | null;
  if (!style) {
    style = doc.createElement("style");
    style.id = "moth-reader-theme";
    root.append(style);
  }
  style.textContent = `html, body { background: ${background}; color: ${foreground}; }`;
}

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

function fixedVisiblePages(renderer: FoliateRenderer | undefined, total: number, fallback: number): number[] | undefined {
  if (!renderer || total <= 0) return undefined;
  const pages = (renderer as unknown as { visiblePages?: unknown }).visiblePages;
  if (Array.isArray(pages)) {
    const visible = pages.filter((page): page is number => typeof page === "number" && Number.isInteger(page) && page >= 0 && page < total);
    if (visible.length) return visible.sort((left, right) => left - right);
  }
  return [Math.min(Math.max(0, fallback), total - 1)];
}

export function FoliateTextReader({ detail, progress, settings, theme, encoding, navigationRequest, onProgress, onNavigationChange, onReadingStateChange, onAdvanceAtEnd, onCenterTap, onPageTurn, keyboardEnabled, onKeyboardAction }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<FoliateViewElement | null>(null);
  const publicationRef = useRef<TextPublication | null>(null);
  const progressRef = useRef(progress);
  const settingsRef = useRef(settings);
  const themeRef = useRef(theme);
  const onProgressRef = useRef(onProgress);
  const textVersionRef = useRef(detail.content_version);
  const onNavigationChangeRef = useRef(onNavigationChange);
  const onReadingStateChangeRef = useRef(onReadingStateChange);
  const onAdvanceAtEndRef = useRef(onAdvanceAtEnd);
  const onCenterTapRef = useRef(onCenterTap);
  const onPageTurnRef = useRef(onPageTurn);
  const keyboardEnabledRef = useRef(keyboardEnabled);
  const onKeyboardActionRef = useRef(onKeyboardAction);
  const directionRef = useRef<"ltr" | "rtl">("ltr");
  const moveViewRef = useRef<(direction: "prev" | "next") => void>(() => undefined);
  const [loading, setLoading] = useState(true);
  const [loadingStage, setLoadingStage] = useState("读取资源");
  const [error, setError] = useState("");
  const [retryToken, setRetryToken] = useState(0);
  const [readerState, setReaderState] = useState<ReaderReadingState>({ progress: 0, atStart: true, atEnd: false, loading: true });
  const tocRef = useRef<TocItem[]>([]);
  const movingRef = useRef(false);

  useEffect(() => { progressRef.current = progress; }, [progress]);
  useEffect(() => { onNavigationChangeRef.current = onNavigationChange; }, [onNavigationChange]);
  useEffect(() => { onProgressRef.current = onProgress; }, [onProgress]);
  useEffect(() => { onReadingStateChangeRef.current = onReadingStateChange; }, [onReadingStateChange]);
  useEffect(() => { onAdvanceAtEndRef.current = onAdvanceAtEnd; }, [onAdvanceAtEnd]);
  useEffect(() => { onCenterTapRef.current = onCenterTap; }, [onCenterTap]);
  useEffect(() => { onPageTurnRef.current = onPageTurn; }, [onPageTurn]);
  useEffect(() => { keyboardEnabledRef.current = keyboardEnabled; }, [keyboardEnabled]);
  useEffect(() => { onKeyboardActionRef.current = onKeyboardAction; }, [onKeyboardAction]);
  useEffect(() => {
    settingsRef.current = settings;
    themeRef.current = theme;
    const renderer = viewRef.current?.renderer;
    if (!renderer) return;
    if (viewRef.current?.isFixedLayout) {
      for (const content of renderer.getContents()) {
        if (content.doc) applyFixedDocumentTheme(content.doc, theme);
      }
      return;
    }
    applyReaderLayout(renderer, settings);
    renderer.setStyles(readerCss(settings, theme));
  }, [settings, theme]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let loader: Awaited<ReturnType<typeof makeRangeLoader>> | null = null;
    let view: FoliateViewElement | null = null;
    let publication: TextPublication | null = null;
    let epub: EPUB | null = null;
    let sectionCache: ReturnType<typeof cacheSections> | null = null;
    let suppressRelocate = true;
    const controller = new AbortController();
    const cleanups = new Map<Document, () => void>();
    const gestureState: PageGestureState = { lastTouch: -Infinity };
    let cleanupMargins: (() => void) | undefined;
    const saved = progressRef.current;
    const isTxt = detail.source_format === "txt";

    const publishLocation = (location: RelocateLocation, persist: boolean) => {
      const fraction = clampProgress(typeof location.fraction === "number" ? location.fraction : 0);
      const sectionIndex = typeof location.section?.current === "number" && Number.isInteger(location.section.current)
        ? location.section.current
        : typeof location.index === "number" && Number.isInteger(location.index)
          ? location.index
          : 0;
      const sectionHref = view ? sectionId(view.book, sectionIndex) : String(sectionIndex);
      const tocHref = activeTocHref(tocRef.current, location, sectionHref);
      const renderer = view?.renderer;
      const atStart = renderer ? Boolean(renderer.atStart) : sectionIndex <= 0 && fraction <= 0;
      const atEnd = renderer ? Boolean(renderer.atEnd) : false;
      const visiblePages = view?.isFixedLayout ? fixedVisiblePages(renderer, sectionCount(view.book), sectionIndex) : undefined;
      const overallProgress = visiblePages?.length
        ? clampProgress((Math.max(...visiblePages) + 1) / sectionCount(view!.book))
        : fraction;
      const nextState: ReaderReadingState = { progress: overallProgress, atStart, atEnd, loading: false, direction: directionRef.current, visiblePages, totalPages: visiblePages ? sectionCount(view!.book) : undefined };
      setReaderState(nextState);
      onReadingStateChangeRef.current?.(nextState);
      if (isTxt) {
        const range = location.range && typeof location.range === "object" ? location.range as Range : null;
        const offset = range ? rangeOffset(range) : 0;
        if (persist) {
          onProgressRef.current({
            type: "txt",
            chapter_index: sectionIndex,
            character_offset: offset,
            encoding,
            progress: overallProgress,
          }, textVersionRef.current);
        }
        onNavigationChangeRef.current(toNavigationItems(tocRef.current), tocHref || `#${sectionIndex}`);
        return;
      }

      const cfi = typeof location.cfi === "string" ? location.cfi : "";
      if (persist && cfi) {
        onProgressRef.current({ type: "epub", href: tocHref || sectionHref, cfi, progress: overallProgress });
      }
      onNavigationChangeRef.current(toNavigationItems(tocRef.current), tocHref);
    };

    const handleRelocate = (event: Event) => {
      if (cancelled) return;
      const location = ((event as CustomEvent).detail ?? {}) as RelocateLocation;
      const sectionIndex = typeof location.section?.current === "number" && Number.isInteger(location.section.current)
        ? location.section.current
        : typeof location.index === "number" && Number.isInteger(location.index)
          ? location.index
          : null;
      if (sectionIndex !== null) sectionCache?.relocate(sectionIndex);
      if (!suppressRelocate) publishLocation(location, true);
    };

    const open = async () => {
      movingRef.current = false;
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
        epub = await withTimeout(new EPUB(loader).init(), "解析 EPUB 失败或超时，请重试");
        if (cancelled) { epub.destroy(); return; }
        sectionCache = cacheSections(epub.sections, epub.rendition?.layout === "pre-paginated", {
          getResourceBytes: () => epub?.resourceBytes ?? 0,
          resourceBudget: epub.resourceBudget,
        });
        book = epub as unknown as FoliateBook;
        const parsedToc = flattenToc((epub as { toc?: unknown }).toc);
        const items = parsedToc.length > 0 ? parsedToc : spineNavigation(book);
        tocRef.current = items;
        onNavigationChangeRef.current(toNavigationItems(items), "");
      }

      if (cancelled) return;
      directionRef.current = (book as { dir?: unknown }).dir === "rtl" ? "rtl" : "ltr";
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
          if (view.isFixedLayout) applyFixedDocumentTheme(doc, themeRef.current);
          // Release old chapter documents instead of retaining every loaded iframe.
          for (const [previous, cleanup] of cleanups) {
            if (previous === doc || !previous.defaultView?.frameElement?.isConnected) {
              cleanup();
              cleanups.delete(previous);
            }
          }
          const cleanupGestures = installMobileTapNavigation(
            doc,
            view,
            settingsRef,
            gestureState,
            () => setError("翻页失败，请重试"),
            () => onCenterTapRef.current?.(),
            () => moveViewRef.current(directionRef.current === "rtl" ? "next" : "prev"),
            () => moveViewRef.current(directionRef.current === "rtl" ? "prev" : "next"),
          );
          const cleanupKeyboard = installReaderKeyboard(doc, {
            direction: () => directionRef.current,
            previous: () => moveViewRef.current("prev"),
            next: () => moveViewRef.current("next"),
            enabled: () => keyboardEnabledRef.current?.() ?? true,
            onKey: (action) => onKeyboardActionRef.current?.(action) ?? false,
          });
          cleanups.set(doc, () => { cleanupGestures(); cleanupKeyboard(); });
        }
      }) as EventListener);
      host.append(view);
      const content = host.parentElement!;
      const currentView = view;
      cleanupMargins = installPageGestures(content, {
        state: gestureState,
        enabled: () => (!!currentView.isFixedLayout || settingsRef.current.flow === "paginated") && !cancelled,
        centerEnabled: () => !cancelled,
        bounds: () => content.getBoundingClientRect(),
        left: () => moveViewRef.current(directionRef.current === "rtl" ? "next" : "prev"),
        right: () => moveViewRef.current(directionRef.current === "rtl" ? "prev" : "next"),
        center: () => onCenterTapRef.current?.(),
      });
      viewRef.current = view;
      if (publication) publicationRef.current = publication;

      await withTimeout(view.open(book), "排版书籍超时，请重试");
      if (cancelled) return;
      if (!view.isFixedLayout) {
        applyReaderLayout(view.renderer, settingsRef.current);
        view.renderer.setStyles(readerCss(settingsRef.current, themeRef.current));
      }

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
      if (!cancelled) {
        setLoading(false);
        const location = view.lastLocation;
        const renderer = view.renderer;
        const totalPages = view.isFixedLayout ? sectionCount(view.book) : 0;
        const visiblePages = view.isFixedLayout ? fixedVisiblePages(renderer, totalPages, location?.section?.current ?? 0) : undefined;
        const nextState: ReaderReadingState = {
          progress: visiblePages?.length ? clampProgress((Math.max(...visiblePages) + 1) / totalPages) : clampProgress(typeof location?.fraction === "number" ? location.fraction : 0),
          atStart: Boolean(renderer.atStart),
          atEnd: Boolean(renderer.atEnd),
          loading: false,
          direction: directionRef.current,
          visiblePages,
          totalPages: visiblePages ? totalPages : undefined,
        };
        setReaderState(nextState);
        onReadingStateChangeRef.current?.(nextState);
      }
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
      cleanupMargins?.();
      if (viewRef.current === view) viewRef.current = null;
      view?.close();
      view?.remove();
      if (publicationRef.current === publication) publicationRef.current = null;
      publication?.destroy();
      void (async () => {
        await sectionCache?.destroy();
        epub?.destroy();
        await loader?.close();
      })();
    };
  }, [detail, encoding, retryToken]);

  useEffect(() => {
    const view = viewRef.current;
    if (!navigationRequest || !view) return;
    let cancelled = false;
    movingRef.current = true;
    setReaderState((current) => ({ ...current, loading: true }));
    void view.goTo(navigationRequest.id).then((resolved) => {
      if (!cancelled && !validResolved(resolved, sectionCount(view.book))) {
        setReaderState((current) => ({ ...current, loading: false }));
        setError("章节跳转失败，请重试");
      }
    }).catch(() => {
      if (!cancelled) {
        setReaderState((current) => ({ ...current, loading: false }));
        setError("章节跳转失败，请重试");
      }
    }).finally(() => { movingRef.current = false; });
    return () => { cancelled = true; movingRef.current = false; };
  }, [navigationRequest]);

  const retry = () => {
    setError("");
    setRetryToken((value) => value + 1);
  };
  const move = (direction: "prev" | "next") => {
    const view = viewRef.current;
    if (!view || movingRef.current) return;
    if (direction === "next" && Boolean(view.renderer.atEnd)) {
      onAdvanceAtEndRef.current?.();
      return;
    }
    if (direction === "prev" && Boolean(view.renderer.atStart)) return;
    movingRef.current = true;
    onPageTurnRef.current?.();
    setReaderState((current) => ({ ...current, loading: true }));
    void (direction === "prev" ? view.prev() : view.next()).catch(() => {
      setReaderState((current) => ({ ...current, loading: false }));
      setError("翻页失败，请重试");
    }).finally(() => { movingRef.current = false; });
  };
  moveViewRef.current = move;

  useEffect(() => installReaderKeyboard(window, {
    direction: () => directionRef.current,
    previous: () => moveViewRef.current("prev"),
    next: () => moveViewRef.current("next"),
    enabled: () => keyboardEnabledRef.current?.() ?? true,
    onKey: (action) => onKeyboardActionRef.current?.(action) ?? false,
  }), [detail, encoding, retryToken]);

  return <div className={`reader-stage text-reader theme-${theme}`}>
    <div className="reader-content">
      <div ref={hostRef} className="reader-host" />
      {loading && <div className="reader-loading" role="status" aria-live="polite"><span>{loadingStage}…</span></div>}
      {error && <div className="reader-error" role="alert"><p>{error}</p><button className="reader-control-button reader-control-button--danger" type="button" onClick={retry}>重试</button></div>}
      {settings.flow === "scrolled" && readerState.atEnd && !loading && !readerState.loading && <button className="primary-button reader-end-next" type="button" onClick={() => move("next")}>下一页</button>}
    </div>
    <div className="reader-bottom-bar">
      <button className="reader-control-button" type="button" onClick={() => move("prev")} disabled={loading || readerState.loading || readerState.atStart}>上一页</button>
      <span className="reader-progress-label">{readerState.loading ? "" : `已读 ${Math.round(readerState.progress * 1000) / 10}%${readerState.visiblePages?.length && readerState.totalPages ? ` · ${readerState.visiblePages.map((page) => page + 1).join("–")} / ${readerState.totalPages} 页` : ""}`}</span>
      <button className="reader-control-button" type="button" onClick={() => move("next")} disabled={loading || readerState.loading || (readerState.atEnd && !onAdvanceAtEnd)}>下一页</button>
    </div>
  </div>;
}

function installMobileTapNavigation(doc: Document, view: FoliateViewElement, settingsRef: MutableRefObject<ReaderSettings>, state: PageGestureState, onError: () => void, onCenter: () => void, left: () => void, right: () => void): () => void {
  return installPageGestures(doc, {
    state,
    enabled: () => !!view.isFixedLayout || settingsRef.current.flow === "paginated",
    centerEnabled: () => true,
    bounds: () => (view.closest(".reader-content") ?? view).getBoundingClientRect(),
    toViewport: (point) => framePointToViewport(doc, point),
    left: () => { try { left(); } catch { onError(); } },
    right: () => { try { right(); } catch { onError(); } },
    center: onCenter,
    swipe: (direction) => direction === "left" ? right() : left(),
  });
}
