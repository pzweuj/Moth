import type { Page } from "@playwright/test";

export async function contentPoint(page: Page, fraction: number) {
  const rect = await page.locator(".reader-content").boundingBox();
  if (!rect) throw new Error("No reader viewport");
  return { x: rect.x + rect.width * fraction, y: rect.y + rect.height * 0.45 };
}

// WebKit has no Playwright native swipe API. Dispatch the same event sequence
// to both engines; Chromium additionally tests real CDP touch input below.
export async function syntheticGesture(page: Page, points: Array<{ x: number; y: number }>, options: { text?: boolean; cancel?: boolean; multi?: boolean } = {}) {
  await page.evaluate(({ points, options }) => {
    const content = document.querySelector(".reader-content")!;
    const view = content.querySelector("foliate-view") as (HTMLElement & { renderer: { getContents(): Array<{ doc: Document }> } }) | null;
    const doc = options.text ? view!.renderer.getContents()[0].doc : document;
    const frame = doc.defaultView?.frameElement;
    const rect = frame?.getBoundingClientRect();
    const local = (point: { x: number; y: number }) => ({
      identifier: 1, clientX: point.x - (rect?.left ?? 0), clientY: point.y - (rect?.top ?? 0), screenX: point.x, screenY: point.y,
    });
    const first = local(points[0]);
    const target = options.text ? doc.elementFromPoint(first.clientX, first.clientY) ?? doc.body : content;
    const send = (type: string, touches: ReturnType<typeof local>[], changedTouches: ReturnType<typeof local>[]) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, { touches: { value: touches }, changedTouches: { value: changedTouches } });
      target.dispatchEvent(event);
    };
    send("touchstart", [first], [first]);
    if (options.multi) {
      const second = { ...first, identifier: 2, clientX: first.clientX - 30 };
      send("touchstart", [first, second], [second]);
      send("touchend", [first], [second]);
    }
    for (const point of points.slice(1)) send("touchmove", [local(point)], [local(point)]);
    send(options.cancel ? "touchcancel" : "touchend", [], [local(points.at(-1)!)]);
    // Browsers may emit a compatibility click after a touch; it must not turn twice.
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: first.clientX, clientY: first.clientY }));
  }, { points, options });
}

export async function textLocation(page: Page) {
  return page.locator("foliate-view").evaluate((element) => {
    const view = element as HTMLElement & { lastLocation?: { cfi: string; section: { current: number } } };
    return { cfi: view.lastLocation?.cfi ?? "", chapter: view.lastLocation?.section.current ?? -1 };
  });
}
