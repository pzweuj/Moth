import { describe, expect, it } from "vitest";
import { layoutPageThumbnails, visibleThumbnailIndexes } from "./pageThumbnails";

describe("CBZ thumbnail layout", () => {
  it("gives a portrait page a taller cell than a landscape page", () => {
    const layout = layoutPageThumbnails(
      [{ width: 200, height: 300 }, { width: 300, height: 150 }],
      340,
      { columns: 2, gap: 12, padding: 10, caption: 22 },
    );
    expect(layout.boxes).toHaveLength(2);
    expect(layout.boxes[0].imageHeight).toBeGreaterThan(layout.boxes[1].imageHeight);
    expect(layout.boxes[0].height).toBe(layout.boxes[1].height);
    expect(layout.boxes[0].top).toBe(layout.boxes[1].top);
    expect(layout.boxes[1].left).toBeGreaterThan(layout.boxes[0].left);
  });

  it("stacks webtoon pages in one column and caps an extreme strip", () => {
    const layout = layoutPageThumbnails(
      [{ width: 800, height: 20000 }, { width: 800, height: 1200 }],
      300,
      { columns: 1, gap: 12, padding: 10, caption: 22 },
    );
    expect(layout.boxes[0].cropped).toBe(true);
    expect(layout.boxes[0].imageHeight).toBe(420);
    expect(layout.boxes[1].cropped).toBe(false);
    expect(layout.boxes[1].top).toBeGreaterThan(layout.boxes[0].top);
    expect(layout.boxes[1].left).toBe(layout.boxes[0].left);
  });

  it("falls back to a portrait frame when dimensions are missing", () => {
    const known = layoutPageThumbnails([{ width: 2, height: 3 }], 200, { columns: 1 });
    const unknown = layoutPageThumbnails([{}], 200, { columns: 1 });
    expect(unknown.boxes[0].imageHeight).toBeCloseTo(known.boxes[0].imageHeight);
  });

  it("returns only the boxes that intersect the viewport", () => {
    const layout = layoutPageThumbnails(
      Array.from({ length: 6 }, () => ({ width: 2, height: 3 })),
      340,
      { columns: 3, gap: 12, padding: 10, caption: 22 },
    );
    const firstRow = visibleThumbnailIndexes(layout.boxes, 0, 80, 0);
    expect(firstRow).toEqual([0, 1, 2]);
    const secondTop = layout.boxes[3].top;
    expect(visibleThumbnailIndexes(layout.boxes, secondTop, 80, 0)).toEqual([3, 4, 5]);
  });
});
