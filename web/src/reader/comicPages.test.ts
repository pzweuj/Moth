import { describe, expect, it } from "vitest";
import {
  comparePageNames,
  isComicImage,
  sortComicEntries,
} from "./comicPages";

describe("isComicImage", () => {
  it("accepts common image extensions case-insensitively", () => {
    expect(isComicImage("001.jpg")).toBe(true);
    expect(isComicImage("page_2.JPG")).toBe(true);
    expect(isComicImage("cover.webp")).toBe(true);
    expect(isComicImage("p.png")).toBe(true);
  });

  it("rejects non-image entries", () => {
    expect(isComicImage("ComicInfo.xml")).toBe(false);
    expect(isComicImage("folder/")).toBe(false);
    expect(isComicImage("notes.txt")).toBe(false);
  });
});

describe("comparePageNames", () => {
  it("sorts page numbers naturally", () => {
    const names = ["page_10.jpg", "page_2.jpg", "page_1.jpg"];
    names.sort(comparePageNames);
    expect(names).toEqual(["page_1.jpg", "page_2.jpg", "page_10.jpg"]);
  });
});

describe("sortComicEntries", () => {
  it("keeps only image entries in natural order", () => {
    const entries = [
      { filename: "ComicInfo.xml" },
      { filename: "page_10.png" },
      { filename: "notes.txt" },
      { filename: "page_2.png" },
    ];
    expect(sortComicEntries(entries).map((entry) => entry.filename)).toEqual([
      "page_2.png",
      "page_10.png",
    ]);
  });
});
