export type ReaderKeyboardAction = "previous" | "next";

type KeyboardOptions = {
  direction: () => "ltr" | "rtl";
  previous: () => void;
  next: () => void;
  enabled?: () => boolean;
  onKey?: (action: ReaderKeyboardAction) => boolean;
  onInteraction?: () => void;
};

const editable = "input, textarea, select, button, a, label, [role=button], [role=link], [role=slider], [contenteditable]:not([contenteditable=false])";

function shouldIgnore(target: EventTarget | null): boolean {
  const element = target as Element | null;
  return !!element?.closest?.(editable);
}

/** Install the desktop reader shortcuts on an outer document or an EPUB frame. */
export function installReaderKeyboard(surface: Window | Document, options: KeyboardOptions): () => void {
  const keydown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.repeat || event.isComposing
      || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey
      || shouldIgnore(event.target)
      || surface.getSelection?.()?.toString()
      || options.enabled?.() === false) return;
    const direction = options.direction();
    const previous = direction === "rtl" ? "ArrowRight" : "ArrowLeft";
    const next = direction === "rtl" ? "ArrowLeft" : "ArrowRight";
    if (event.key !== previous && event.key !== next && event.key !== " " && event.code !== "Space") return;
    event.preventDefault();
    const action: ReaderKeyboardAction = event.key === previous ? "previous" : "next";
    if (options.onKey?.(action)) {
      event.stopImmediatePropagation();
      return;
    }
    options.onInteraction?.();
    if (action === "previous") options.previous();
    else options.next();
  };
  surface.addEventListener("keydown", keydown as EventListener, true);
  return () => surface.removeEventListener("keydown", keydown as EventListener, true);
}
