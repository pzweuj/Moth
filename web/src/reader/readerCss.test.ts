import { describe, expect, it } from "vitest";
import { readerCss } from "./readerCss";

describe("readerCss", () => {
  const base = { fontSize: 18, lineHeight: 1.7, margin: 16 };

  it("renders concrete values from settings", () => {
    const css = readerCss({ ...base, theme: "light" });
    expect(css).toContain("font-size: 18px");
    expect(css).toContain("line-height: 1.7");
    expect(css).toContain("padding: 0 16px");
  });

  it("switches color scheme and palette by theme", () => {
    const dark = readerCss({ ...base, theme: "dark" });
    expect(dark).toContain("color-scheme: dark");
    expect(dark).toContain("background: #14161a");

    const sepia = readerCss({ ...base, theme: "sepia" });
    expect(sepia).toContain("color-scheme: light");
    expect(sepia).toContain("background: #f2e8d5");
  });

  it("wraps long content and preserves pre wrapping", () => {
    const css = readerCss({ ...base, theme: "light" });
    expect(css).toContain("overflow-wrap: break-word");
    expect(css).toContain("white-space: pre-wrap !important");
  });
});
