import { describe, expect, it } from "vitest";
import { navigationListScrollTop, navigationScrubIndex } from "./navigation";

describe("navigation scrub index", () => {
  it("stays on the only entry", () => {
    expect(navigationScrubIndex(1, 4)).toBe(0);
    expect(navigationScrubIndex(0, 1)).toBe(0);
  });

  it("rounds and clamps a dragged value into the list", () => {
    expect(navigationScrubIndex(20, 19.2)).toBe(19);
    expect(navigationScrubIndex(20, -3)).toBe(0);
    expect(navigationScrubIndex(20, 40)).toBe(19);
  });
});

describe("navigation list scroll", () => {
  it("stays at the top when the current item is already in the first screen", () => {
    expect(navigationListScrollTop(0, 400, 0, 40)).toBe(0);
  });

  it("centers a later item in the list", () => {
    expect(navigationListScrollTop(0, 400, 1800, 40)).toBe(1620);
  });

  it("does not move when the item is already centered", () => {
    expect(navigationListScrollTop(500, 400, 180, 40)).toBe(500);
  });

  it("leaves the current offset alone before the list has a height", () => {
    expect(navigationListScrollTop(120, 0, 800, 40)).toBe(120);
  });
});
