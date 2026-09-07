import { describe, expect, it } from "vitest";
import { progressMatchesEncoding } from "./db";

describe("offline progress encoding matching", () => {
  it("treats an omitted TXT label as the auto decoder", () => {
    expect(progressMatchesEncoding({ chapter_index: 0, page_index: 1, percent: 10 }, "")).toBe(true);
    expect(progressMatchesEncoding({ chapter_index: 0, page_index: 1, percent: 10 }, "auto")).toBe(true);
    expect(progressMatchesEncoding({ chapter_index: 0, page_index: 1, percent: 10 }, "gb18030")).toBe(false);
  });

  it("does not reuse a location decoded with another codec", () => {
    const gbk = { chapter_index: 1, page_index: 0, percent: 25, encoding: "gbk" };
    expect(progressMatchesEncoding(gbk, "gbk")).toBe(true);
    expect(progressMatchesEncoding(gbk, "utf-8")).toBe(false);
  });

  it("keeps non-TXT progress unlabelled", () => {
    expect(progressMatchesEncoding({ chapter_index: 0, page_index: 2, percent: 5 }, undefined)).toBe(true);
    expect(progressMatchesEncoding({ chapter_index: 0, page_index: 2, percent: 5, encoding: "auto" }, undefined)).toBe(false);
  });
});
