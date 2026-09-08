import { describe, expect, it } from "vitest";
import { sanitizeBookDocument, sanitizeCssText } from "./bookSanitizer";

describe("sanitizeBookDocument", () => {
  it("removes external resource attributes before the browser can request them", () => {
    const document = new DOMParser().parseFromString('<html><head><link rel="stylesheet" href="https://remote.invalid/style"></head><body><img src="https://remote.invalid/image"><img srcset="//remote.invalid/x 2x"><a href="https://example.com">Reference</a></body></html>', "text/html");
    sanitizeBookDocument(document);
    expect(document.querySelector("img[src], img[srcset], link[href]")).toBeNull();
    expect(document.querySelector("a")?.getAttribute("href")).toBe("https://example.com");
  });
  it("removes active elements, handlers, and dangerous URLs while keeping resources", () => {
    const document = new DOMParser().parseFromString(
      `<html><head></head><body onload="evil()"><script>evil()</script><form action="javascript:evil()"><input></form><img src="javascript:evil()"><img srcset="javascript:evil() 1x"><div style="background:url(javascript:evil())"></div><img src="blob:cover"></body></html>`,
      "text/html",
    );

    sanitizeBookDocument(document);

    expect(document.querySelector("script")).toBeNull();
    expect(document.querySelector("form")).toBeNull();
    expect(document.body.hasAttribute("onload")).toBe(false);
    expect(document.querySelector('img[src^="javascript:"]')).toBeNull();
    expect(document.querySelector("img[srcset]")).toBeNull();
    expect(document.querySelector("div[style]")).toBeNull();
    expect(document.querySelector('img[src="blob:cover"]')).not.toBeNull();
    expect(document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content"))
      .toContain("script-src 'none'");
    expect(document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content"))
      .toContain("img-src 'self' blob: data:");
  });

  it("sanitizes malformed XHTML through the HTML fallback", () => {
    const document = new DOMParser().parseFromString(
      "<html><body><script>alert(1)<p>chapter",
      "text/html",
    );
    sanitizeBookDocument(document);
    expect(document.querySelector("script")).toBeNull();
  });

  it("normalizes obfuscated URL schemes before checking them", () => {
    const document = new DOMParser().parseFromString(
      `<html><body><a href="java\nscript:alert(1)">x</a><img src="data:\u0000text/html,<script>x</script>"><div style="background:url( java\nscript:evil() )"></div></body></html>`,
      "text/html",
    );

    sanitizeBookDocument(document);

    expect(document.querySelector("a")?.hasAttribute("href")).toBe(false);
    expect(document.querySelector("img")?.hasAttribute("src")).toBe(false);
    expect(document.querySelector("div")?.hasAttribute("style")).toBe(false);
  });

  it("removes external CSS imports and URLs while keeping materialized resources", () => {
    const css = sanitizeCssText(
      `@import url("https://evil.example/style.css"); .remote { background: url(https://evil.example/x.png) } .local { background: url(blob:local) }`,
    );
    expect(css).not.toContain("evil.example");
    expect(css).toContain("url(blob:local)");
  });
});
