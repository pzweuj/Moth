type Point = { x: number; y: number };
export type PageGestureState = { lastTouch: number };
type Options = {
  enabled: () => boolean;
  bounds: () => DOMRect;
  toViewport?: (point: Point) => Point;
  left: () => void;
  right: () => void;
  center?: () => void;
  centerEnabled?: () => boolean;
  swipe?: (direction: "left" | "right") => void;
  state?: PageGestureState;
};

const controls = "a,button,input,select,textarea,video,audio,label,summary,[role=button],[role=link],[role=slider],[contenteditable]:not([contenteditable=false])";

/** Capture taps without replacing a reader's native scrolling/swiping. */
export function installPageGestures(surface: Document | HTMLElement, options: Options): () => void {
  const doc = surface.nodeType === 9 ? surface as Document : surface.ownerDocument!;
  let start: (Point & { at: number; maxX: number; maxY: number }) | null = null;
  let invalid = false;
  // A touch can replace the iframe before the browser sends its compatibility
  // click. Share this timestamp across chapter documents and outer margins.
  const state = options.state ?? { lastTouch: -Infinity };
  const blocked = (target: EventTarget | null) => {
    // DOM elements in book iframes belong to a different JavaScript realm.
    const element = target as Element | null;
    return !!element?.closest?.(controls)
      || !!doc.getSelection()?.toString()
      || (window.visualViewport?.scale ?? 1) > 1;
  };
  const tap = (point: Point) => {
    const { x, y } = options.toViewport?.(point) ?? point;
    const rect = options.bounds();
    if (rect.width <= 0 || x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return;
    const relative = (x - rect.left) / rect.width;
    if (relative <= 0.3) {
      if (options.enabled()) options.left();
    } else if (relative >= 0.7) {
      if (options.enabled()) options.right();
    } else if (options.center && (options.centerEnabled?.() ?? options.enabled())) options.center();
  };
  const touchStart = (event: TouchEvent) => {
    state.lastTouch = Date.now();
    if (start || event.touches.length !== 1 || event.changedTouches.length !== 1) {
      invalid = true;
      return;
    }
    const touch = event.changedTouches[0];
    invalid = blocked(event.target);
    start = { x: touch.clientX, y: touch.clientY, at: state.lastTouch, maxX: 0, maxY: 0 };
  };
  const touchMove = (event: TouchEvent) => {
    if (event.touches.length !== 1) invalid = true;
    if (!start || !event.touches[0]) return;
    start.maxX = Math.max(start.maxX, Math.abs(event.touches[0].clientX - start.x));
    start.maxY = Math.max(start.maxY, Math.abs(event.touches[0].clientY - start.y));
  };
  const touchEnd = (event: TouchEvent) => {
    state.lastTouch = Date.now();
    const origin = start;
    if (event.touches.length !== 0) { invalid = true; return; }
    start = null;
    const wasInvalid = invalid;
    invalid = false;
    const touch = event.changedTouches[0];
    if (!origin || wasInvalid || !touch || event.changedTouches.length !== 1
      || (!(options.enabled() || (options.center && (options.centerEnabled?.() ?? false))))
      || blocked(event.target) || state.lastTouch - origin.at > 500) return;
    const dx = touch.clientX - origin.x;
    const dy = touch.clientY - origin.y;
    const maxY = Math.max(origin.maxY, Math.abs(dy));
    if (options.enabled() && options.swipe && Math.abs(dx) >= 48 && Math.abs(dx) > maxY) {
      options.swipe(dx < 0 ? "left" : "right");
    } else if (Math.max(origin.maxX, Math.abs(dx), maxY) <= 12) {
      tap({ x: touch.clientX, y: touch.clientY });
    }
  };
  const cancel = () => { start = null; invalid = false; state.lastTouch = Date.now(); };
  const click = (event: MouseEvent) => {
    if (Date.now() - state.lastTouch < 800 || event.button !== 0 || event.ctrlKey || event.metaKey
      || event.altKey || event.shiftKey
      || (!(options.enabled() || (options.center && (options.centerEnabled?.() ?? false))))
      || blocked(event.target)) return;
    tap({ x: event.clientX, y: event.clientY });
  };
  const handlers = { touchstart: touchStart, touchmove: touchMove, touchend: touchEnd, touchcancel: cancel, click };
  for (const [type, handler] of Object.entries(handlers)) {
    surface.addEventListener(type, handler as EventListener, { capture: true, passive: true });
  }
  return () => {
    for (const [type, handler] of Object.entries(handlers)) surface.removeEventListener(type, handler as EventListener, true);
  };
}

/** Chapter iframes can be several viewport widths wide and shift on each page. */
export function framePointToViewport(doc: Document, point: Point): Point {
  const frame = doc.defaultView?.frameElement as HTMLIFrameElement | null;
  if (!frame) return point;
  const rect = frame.getBoundingClientRect();
  const scaleX = frame.offsetWidth > 0 ? rect.width / frame.offsetWidth : 1;
  const scaleY = frame.offsetHeight > 0 ? rect.height / frame.offsetHeight : 1;
  return {
    x: rect.left + (frame.clientLeft + point.x) * scaleX,
    y: rect.top + (frame.clientTop + point.y) * scaleY,
  };
}
