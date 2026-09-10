import { fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { framePointToViewport, installPageGestures } from "./pageGestures";

const rect = { left: 0, right: 1000, top: 0, bottom: 700, width: 1000, height: 700 } as DOMRect;
const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach((fn) => fn()); document.body.replaceChildren(); vi.restoreAllMocks(); });

function fixture(enabled = true) {
  const surface = document.createElement("div");
  document.body.append(surface);
  const left = vi.fn(), right = vi.fn(), swipe = vi.fn();
  cleanups.push(installPageGestures(surface, { enabled: () => enabled, bounds: () => rect, left, right, swipe }));
  return { surface, left, right, swipe };
}
const touch = (x: number, y = 200, identifier = 1) => ({ clientX: x, clientY: y, identifier });
function gesture(surface: Element, points: ReturnType<typeof touch>[], cancel = false) {
  fireEvent.touchStart(surface, { touches: [points[0]], changedTouches: [points[0]] });
  for (const point of points.slice(1)) fireEvent.touchMove(surface, { touches: [point], changedTouches: [point] });
  fireEvent[cancel ? "touchCancel" : "touchEnd"](surface, { touches: [], changedTouches: [points.at(-1)] });
}

describe("reader gestures", () => {
  it("uses 30/40/30 zones and suppresses duplicate touch clicks", () => {
    const { surface, left, right, swipe } = fixture();
    fireEvent.click(surface, { clientX: 100, clientY: 200 });
    fireEvent.click(surface, { clientX: 500, clientY: 200 });
    fireEvent.click(surface, { clientX: 900, clientY: 200 });
    expect(left).toHaveBeenCalledTimes(1); expect(right).toHaveBeenCalledTimes(1);
    gesture(surface, [touch(900)]);
    fireEvent.click(surface, { clientX: 900, clientY: 200 });
    expect(right).toHaveBeenCalledTimes(2); expect(swipe).not.toHaveBeenCalled();
  });

  it.each([
    ["vertical", [touch(900), touch(899, 400)], false],
    ["diagonal", [touch(900), touch(800, 300)], false],
    ["excursion returning to start", [touch(900), touch(920, 300), touch(900)], false],
    ["cancel", [touch(900)], true],
  ])("ignores %s and any subsequent synthetic click", (_name, points, cancel) => {
    const { surface, left, right, swipe } = fixture();
    gesture(surface, points, cancel);
    fireEvent.click(surface, { clientX: 900, clientY: 200 });
    expect(left).not.toHaveBeenCalled(); expect(right).not.toHaveBeenCalled(); expect(swipe).not.toHaveBeenCalled();
  });

  it("accepts horizontal swipes only once and leaves scrolled mode alone", () => {
    const { surface, swipe, right } = fixture();
    gesture(surface, [touch(900), touch(820), touch(750)]);
    fireEvent.click(surface, { clientX: 900, clientY: 200 });
    expect(swipe).toHaveBeenCalledExactlyOnceWith("left"); expect(right).not.toHaveBeenCalled();
    const scrolled = fixture(false);
    gesture(scrolled.surface, [touch(900), touch(750)]);
    expect(scrolled.swipe).not.toHaveBeenCalled();
  });

  it("excludes long presses, selection, controls and multi-touch", () => {
    const { surface, left, right, swipe } = fixture();
    vi.spyOn(Date, "now").mockReturnValue(1000);
    fireEvent.touchStart(surface, { touches: [touch(900)], changedTouches: [touch(900)] });
    vi.spyOn(Date, "now").mockReturnValue(1600);
    fireEvent.touchEnd(surface, { touches: [], changedTouches: [touch(900)] });
    const button = document.createElement("button"); surface.append(button);
    gesture(button, [touch(900), touch(750)]);
    fireEvent.touchStart(surface, { touches: [touch(900)], changedTouches: [touch(900)] });
    fireEvent.touchStart(surface, { touches: [touch(900), touch(800, 200, 2)], changedTouches: [touch(800, 200, 2)] });
    fireEvent.touchEnd(surface, { touches: [touch(900)], changedTouches: [touch(800, 200, 2)] });
    fireEvent.touchEnd(surface, { touches: [], changedTouches: [touch(900)] });
    surface.append("selected text");
    document.getSelection()!.selectAllChildren(surface);
    gesture(surface, [touch(900)]);
    expect(left).not.toHaveBeenCalled(); expect(right).not.toHaveBeenCalled(); expect(swipe).not.toHaveBeenCalled();
    document.getSelection()!.removeAllRanges();
  });

  it("translates shifted chapter iframe coordinates, including scaled layouts and iframe controls", () => {
    const frame = document.createElement("iframe"); document.body.append(frame);
    const doc = frame.contentDocument!;
    frame.getBoundingClientRect = () => ({ left: -2000, right: 4000, top: 0, bottom: 700, width: 6000, height: 700 } as DOMRect);
    Object.defineProperty(frame, "offsetWidth", { value: 3000 });
    Object.defineProperty(frame, "offsetHeight", { value: 700 });
    const left = vi.fn(), right = vi.fn();
    cleanups.push(installPageGestures(doc, { enabled: () => true, bounds: () => rect, toViewport: (point) => framePointToViewport(doc, point), left, right }));
    fireEvent.click(doc.body, { clientX: 1450, clientY: 200 }); // visible x=900
    fireEvent.click(doc.body, { clientX: 1050, clientY: 200 }); // visible x=100
    fireEvent.click(doc.body, { clientX: 1250, clientY: 200 }); // visible x=500
    const link = doc.createElement("a"); link.href = "#test"; doc.body.append(link);
    gesture(link, [touch(1450)]);
    expect(left).toHaveBeenCalledTimes(1); expect(right).toHaveBeenCalledTimes(1);
  });

  it("turns pages on iframe images and SVG artwork but preserves linked images", () => {
    const frame = document.createElement("iframe"); document.body.append(frame);
    const doc = frame.contentDocument!;
    const left = vi.fn(), right = vi.fn();
    cleanups.push(installPageGestures(doc, { enabled: () => true, bounds: () => rect, left, right }));
    doc.body.innerHTML = '<img/><svg xmlns="http://www.w3.org/2000/svg"><image/></svg><a href="#chapter"><img/></a>';
    gesture(doc.querySelector("img")!, [touch(900)]);
    gesture(doc.querySelector("image")!, [touch(100)]);
    gesture(doc.querySelector("a img")!, [touch(900)]);
    fireEvent.click(doc.querySelector("img")!, { clientX: 900, clientY: 200 });
    expect(left).toHaveBeenCalledTimes(1);
    expect(right).toHaveBeenCalledTimes(1);
  });

  it("suppresses the compatibility click even after a touch replaces the chapter", () => {
    const state = { lastTouch: -Infinity };
    const right = vi.fn();
    const chapter = () => {
      const frame = document.createElement("iframe"); document.body.append(frame);
      const doc = frame.contentDocument!;
      doc.body.innerHTML = "<img/>";
      cleanups.push(installPageGestures(doc, { state, enabled: () => true, bounds: () => rect, left: vi.fn(), right }));
      return { frame, image: doc.querySelector("img")! };
    };
    const first = chapter();
    gesture(first.image, [touch(900)]);
    first.frame.remove();
    const next = chapter();
    fireEvent.click(next.image, { clientX: 900, clientY: 200 });
    expect(right).toHaveBeenCalledTimes(1);
    gesture(next.image, [touch(900)]);
    expect(right).toHaveBeenCalledTimes(2);
  });
});
