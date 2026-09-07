import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BookDetail } from "../api";
import { TextPublication } from "./textPublication";

const createObjectURL = vi.fn(() => "blob:mock-url");

beforeEach(() => {
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL,
    revokeObjectURL: vi.fn(),
  });
  vi.mocked(api.getChapter).mockClear();
});

const detail: BookDetail = {
  id: 7,
  title: "夜色入海",
  author: undefined,
  format: "txt",
  has_cover: false,
  cover_url: undefined,
  page_count: 0,
  parse_status: "ok",
  percent: 0,
  content_version: "fixture-version",
  file_size: 0,
  chapters: [
    { idx: 0, title: "第一章 启程", size: 120 },
    { idx: 1, title: "第二章 路上", size: 200 },
  ],
};

vi.mock("../api", () => ({
  api: {
    getChapter: vi.fn(async (id: number, idx: number) => ({
      idx,
      title: `Chapter ${idx}`,
      content: `<h2>Chapter ${idx}</h2><p>body ${id}</p>`,
    })),
  },
}));

import { api } from "../api";

describe("TextPublication", () => {
  it("builds one section and TOC entry per chapter", () => {
    const publication = new TextPublication(detail);
    expect(publication.sections).toHaveLength(2);
    expect(publication.toc).toEqual([
      { label: "第一章 启程", href: "#0" },
      { label: "第二章 路上", href: "#1" },
    ]);
    expect(publication.sections[0].size).toBe(120);
    expect(publication.sections[0].linear).toBe("yes");
  });

  it("exposes metadata and an ltr direction", () => {
    const publication = new TextPublication(detail);
    expect(publication.metadata.title).toBe("夜色入海");
    expect(publication.dir).toBe("ltr");
  });

  it("resolves #N hrefs to the matching section", () => {
    const publication = new TextPublication(detail);
    const resolved = publication.resolveHref("#1");
    expect(resolved.index).toBe(1);
    expect(resolved.anchor()).toBeNull();
  });

  it("splits TOC hrefs into section ids", () => {
    const publication = new TextPublication(detail);
    expect(publication.splitTOCHref("#0")).toEqual(["0", null]);
    expect(publication.splitTOCHref("other")).toBeNull();
  });

  it("loads a chapter into a blob URL document", async () => {
    const publication = new TextPublication(detail);
    const url = await publication.sections[1].load();
    expect(url).toBe("blob:mock-url");
    expect(api.getChapter).toHaveBeenCalledWith(7, 1, undefined, "fixture-version");
  });

  it("passes an explicit encoding to the chapter API", async () => {
    const publication = new TextPublication(detail, "gb18030");
    await publication.sections[0].load();
    expect(api.getChapter).toHaveBeenCalledWith(7, 0, "gb18030", "fixture-version");
  });

  it("caches blob URLs across loads and revokes on destroy", async () => {
    const publication = new TextPublication(detail);
    const first = await publication.sections[0].load();
    const second = await publication.sections[0].load();
    expect(second).toBe(first);
    publication.destroy();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock-url");
  });
});
