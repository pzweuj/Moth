import { afterEach, describe, expect, it, vi } from "vitest";
import { installReaderKeyboard } from "./keyboard";

describe("reader keyboard navigation", () => {
  afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

  it("maps arrows to reading direction and space to next", () => {
    const previous = vi.fn();
    const next = vi.fn();
    const cleanup = installReaderKeyboard(window, { direction: () => "rtl", previous, next });
    const left = new KeyboardEvent("keydown", { key: "ArrowLeft", cancelable: true });
    const right = new KeyboardEvent("keydown", { key: "ArrowRight", cancelable: true });
    const space = new KeyboardEvent("keydown", { key: " ", code: "Space", cancelable: true });
    window.dispatchEvent(left);
    window.dispatchEvent(right);
    window.dispatchEvent(space);
    expect(previous).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(2);
    expect(left.defaultPrevented).toBe(true);
    expect(space.defaultPrevented).toBe(true);
    cleanup();
  });

  it("ignores controls, composition, modifiers and repeated keys", () => {
    const next = vi.fn();
    const cleanup = installReaderKeyboard(window, { direction: () => "ltr", previous: vi.fn(), next });
    const input = document.createElement("input");
    document.body.append(input);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", isComposing: true, cancelable: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", ctrlKey: true, cancelable: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", repeat: true, cancelable: true }));
    expect(next).not.toHaveBeenCalled();
    cleanup();
  });

  it("leaves an active text selection alone", () => {
    const next = vi.fn();
    const cleanup = installReaderKeyboard(window, { direction: () => "ltr", previous: vi.fn(), next });
    const text = document.createTextNode("selected");
    document.body.append(text);
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(text);
    selection.removeAllRanges();
    selection.addRange(range);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", cancelable: true }));
    expect(next).not.toHaveBeenCalled();
    selection.removeAllRanges();
    cleanup();
  });

  it("pauses while reader panels are open", () => {
    const next = vi.fn();
    let enabled = false;
    const cleanup = installReaderKeyboard(window, { direction: () => "ltr", previous: vi.fn(), next, enabled: () => enabled });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", cancelable: true }));
    enabled = true;
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", cancelable: true }));
    expect(next).toHaveBeenCalledOnce();
    cleanup();
  });
});
