export type TapNavigation = {
  previous: () => void;
  next: () => void;
};

type TapPoint = { x: number; y: number; time: number };

/** Mobile reading layouts include narrow viewports and touch-first devices. */
export function isMobileReadingLayout(view?: Window): boolean {
  const current = view ?? (typeof window !== "undefined" ? window : undefined);
  if (!current) return false;
  if (current.innerWidth <= 840) return true;
  const matchMedia = current.matchMedia?.bind(current);
  return Boolean(
    matchMedia?.("(pointer: coarse)")?.matches
      && matchMedia("(hover: none)")?.matches,
  );
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  // Elements inside a publication iframe belong to a different global realm,
  // so `target instanceof Element` is false in some browsers. Duck typing
  // keeps links, controls and text inputs interactive in both documents.
  if (!target || typeof target !== "object") return false;
  const closest = (target as { closest?: unknown }).closest;
  return typeof closest === "function"
    && Boolean((closest as (selectors: string) => Element | null).call(target, "a,button,input,select,textarea,summary,label,video,audio,[contenteditable]"));
}

function isReaderOverlayTarget(target: EventTarget | null): boolean {
  if (!target || typeof target !== "object") return false;
  const closest = (target as { closest?: unknown }).closest;
  return typeof closest === "function"
    && Boolean((closest as (selectors: string) => Element | null).call(target, ".reader-tap-hint, .reader-error, .reader-loading"));
}

function isTextSelected(document: Document): boolean {
  const selection = document.getSelection?.();
  return Boolean(selection && !selection.isCollapsed && selection.toString());
}

function tapDirection(
  point: TapPoint,
  event: MouseEvent,
  left: number,
  width: number,
): "previous" | "next" | null {
  const dx = event.clientX - point.x;
  const dy = event.clientY - point.y;
  const elapsed = Number.isFinite(event.timeStamp) && Number.isFinite(point.time)
    ? event.timeStamp - point.time
    : 0;
  if (Math.abs(dx) > 10 || Math.abs(dy) > 10 || elapsed > 550) return null;
  const x = event.clientX - left;
  if (x < width * 0.3) return "previous";
  if (x > width * 0.7) return "next";
  return null;
}

function targetDocument(target: HTMLElement | Document): Document {
  return target.nodeType === 9
    ? target as Document
    : target.ownerDocument ?? document;
}

function targetBounds(target: HTMLElement | Document, view: Window | null): { left: number; width: number } {
  if (target.nodeType !== 9) {
    const element = target as HTMLElement;
    const rect = element.getBoundingClientRect();
    const width = rect.width || element.clientWidth || view?.innerWidth || 0;
    return { left: rect.left, width };
  }
  return { left: 0, width: view?.innerWidth || (target as Document).documentElement?.clientWidth || 0 };
}

function navigationSuppressed(document: Document): boolean {
  return Boolean(document.querySelector(".settings-panel, .reader-toc, [aria-modal='true']"));
}

/**
 * Add short-tap navigation to the custom element and each loaded publication
 * document. The middle 40% is deliberately inert so reading and selection do
 * not unexpectedly change pages. Links and controls remain fully interactive.
 */
export function installTapNavigation(root: HTMLElement, navigation: TapNavigation): () => void {
  const cleanups: Array<() => void> = [];
  const documentCleanups = new Map<Document, () => void>();

  const attach = (target: HTMLElement | Document, view: Window | null) => {
    const document = targetDocument(target);
    const previousCleanup = documentCleanups.get(document);
    if (previousCleanup) {
      previousCleanup();
      documentCleanups.delete(document);
    }
    let pointer: TapPoint | null = null;
    let pointerTimer: number | undefined;
    const clearPointer = () => {
      pointer = null;
      if (pointerTimer !== undefined) {
        (view ?? window).clearTimeout(pointerTimer);
        pointerTimer = undefined;
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!isMobileReadingLayout(view ?? window) || event.isPrimary === false) return;
      if (isInteractiveTarget(event.target) || isReaderOverlayTarget(event.target) || navigationSuppressed(root.ownerDocument)) return;
      clearPointer();
      pointer = { x: event.clientX, y: event.clientY, time: event.timeStamp };
      // A long press may not produce a click (for example when the browser
      // opens its context menu). Expire the pending tap so a later click can
      // never reuse an old pointer-down coordinate.
      pointerTimer = (view ?? window).setTimeout(clearPointer, 700);
    };
    const onPointerCancel = clearPointer;
    const onClick = (event: MouseEvent) => {
      const point = pointer;
      clearPointer();
      if (!point || !isMobileReadingLayout(view ?? window) || isInteractiveTarget(event.target) || isReaderOverlayTarget(event.target)) return;
      if (navigationSuppressed(root.ownerDocument) || isTextSelected(document) || event.defaultPrevented) return;
      const { left, width } = targetBounds(target, view);
      const direction = tapDirection(point, event, left, width);
      if (direction === "previous") {
        event.preventDefault();
        navigation.previous();
      } else if (direction === "next") {
        event.preventDefault();
        navigation.next();
      }
    };
    target.addEventListener("pointerdown", onPointerDown as EventListener, { passive: true });
    target.addEventListener("pointercancel", onPointerCancel);
    target.addEventListener("click", onClick as EventListener);
    const cleanup = () => {
      clearPointer();
      target.removeEventListener("pointerdown", onPointerDown as EventListener);
      target.removeEventListener("pointercancel", onPointerCancel);
      target.removeEventListener("click", onClick as EventListener);
    };
    documentCleanups.set(document, cleanup);
  };

  const onLoad = (event: Event) => {
    const document = (event as CustomEvent<{ doc?: Document }>).detail?.doc;
    if (document) {
      const rootDocument = targetDocument(root);
      // Foliate calls the old section's unload hook before emitting load for
      // the next one. Remove its handlers here because that unload lifecycle
      // is internal and does not produce a DOM event we can observe.
      for (const [loadedDocument, cleanup] of documentCleanups) {
        if (loadedDocument !== rootDocument && loadedDocument !== document) {
          cleanup();
          documentCleanups.delete(loadedDocument);
        }
      }
      attach(document, document.defaultView);
    }
  };
  root.addEventListener("load", onLoad);
  cleanups.push(() => {
    root.removeEventListener("load", onLoad);
    for (const cleanup of documentCleanups.values()) cleanup();
    documentCleanups.clear();
  });
  // The root itself is the blank space around an iframe. Loaded iframe
  // documents are replaced in the map when Foliate destroys a chapter.
  attach(root, root.ownerDocument?.defaultView ?? window);
  return () => cleanups.splice(0).forEach((cleanup) => cleanup());
}
