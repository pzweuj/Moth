import { afterEach, describe, expect, it, vi } from "vitest";
import { installTapNavigation, isMobileReadingLayout } from "./readerInteractions";

function pointerEvent(type: string, x: number, y: number, timeStamp: number): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    clientX: { value: x },
    clientY: { value: y },
    isPrimary: { value: true },
    timeStamp: { value: timeStamp },
  });
  return event;
}

describe("mobile reader tap navigation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("recognizes narrow touch layouts", () => {
    const originalWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 640 });
    expect(isMobileReadingLayout()).toBe(true);
    Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth });
  });

  it("turns only on a short tap in the outer zones", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 400 });
    const root = document.createElement("div");
    document.body.append(root);
    const previous = vi.fn();
    const next = vi.fn();
    const remove = installTapNavigation(root, { previous, next });

    root.dispatchEvent(pointerEvent("pointerdown", 20, 20, 10));
    root.dispatchEvent(pointerEvent("click", 20, 20, 40));
    root.dispatchEvent(pointerEvent("pointerdown", 380, 20, 50));
    root.dispatchEvent(pointerEvent("click", 380, 20, 80));
    root.dispatchEvent(pointerEvent("pointerdown", 200, 20, 90));
    root.dispatchEvent(pointerEvent("click", 200, 20, 120));

    expect(previous).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
    remove();
    root.remove();
  });

  it("ignores drags and interactive controls", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 400 });
    const root = document.createElement("div");
    const button = document.createElement("button");
    root.append(button);
    document.body.append(root);
    const previous = vi.fn();
    const next = vi.fn();
    const remove = installTapNavigation(root, { previous, next });

    root.dispatchEvent(pointerEvent("pointerdown", 20, 20, 10));
    root.dispatchEvent(pointerEvent("click", 50, 20, 40));
    button.dispatchEvent(pointerEvent("pointerdown", 20, 20, 50));
    button.dispatchEvent(pointerEvent("click", 20, 20, 80));

    expect(previous).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    remove();
    root.remove();
  });

  it("ignores long presses and text selections", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 400 });
    const root = document.createElement("div");
    const text = document.createTextNode("selectable text");
    root.append(text);
    document.body.append(root);
    const previous = vi.fn();
    const next = vi.fn();
    const remove = installTapNavigation(root, { previous, next });

    root.dispatchEvent(pointerEvent("pointerdown", 20, 20, 0));
    root.dispatchEvent(pointerEvent("click", 20, 20, 600));

    const selection = document.getSelection();
    const range = document.createRange();
    range.selectNodeContents(root);
    selection?.removeAllRanges();
    selection?.addRange(range);
    root.dispatchEvent(pointerEvent("pointerdown", 20, 20, 700));
    root.dispatchEvent(pointerEvent("click", 20, 20, 720));

    expect(previous).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    selection?.removeAllRanges();
    remove();
    root.remove();
  });
});
