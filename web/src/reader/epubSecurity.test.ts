import { describe, expect, it, vi } from "vitest";
import { EPUB } from "../../vendor/foliate-js/epub.js";

const CONTAINER = `<?xml version="1.0"?>
<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OPS/package.opf" media-type="application/oebps-package+xml" /></rootfiles>
</container>`;

const PACKAGE = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Security test</dc:title></metadata>
  <manifest>
    <item id="chapter" href="ch.xhtml" media-type="application/xhtml+xml" />
  </manifest>
  <spine><itemref idref="chapter" /></spine>
</package>`;

// Notice: No <head> tag, contains an active <script> tag and inline event attributes
const MALICIOUS_CHAPTER = `<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <body onload="evil()">
    <script>evil_code()</script>
    <p onclick="steal()">Hello world</p>
  </body>
</html>`;

describe("EPUB security sanitization", () => {
  it("strips scripts and event attributes, and injects CSP even when head is missing", async () => {
    let capturedBlobContent: string | null = null;
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn((blob: Blob) => {
      const reader = new FileReader();
      reader.onload = () => {
        capturedBlobContent = reader.result as string;
      };
      reader.readAsText(blob);
      return "blob:security-test-url";
    });
    URL.revokeObjectURL = vi.fn();

    const loadText = vi.fn(async (name: string) => ({
      "META-INF/container.xml": CONTAINER,
      "OPS/package.opf": PACKAGE,
      "OPS/ch.xhtml": MALICIOUS_CHAPTER,
    }[name] ?? null));
    const loadBlob = vi.fn(async () => null);
    const getSize = vi.fn(() => 100);

    const epub = await new EPUB({ loadText, loadBlob, getSize }).init();
    const url = await epub.sections[0].load();
    expect(url).toBe("blob:security-test-url");

    // Wait for FileReader onload
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(capturedBlobContent).not.toBeNull();
    // 1. Script tag should be removed
    expect(capturedBlobContent).not.toContain("<script");
    expect(capturedBlobContent).not.toContain("evil_code()");
    // 2. Inline on* attributes should be removed
    expect(capturedBlobContent).not.toContain("onload");
    expect(capturedBlobContent).not.toContain("onclick");
    // 3. Head element and CSP must be injected
    expect(capturedBlobContent).toContain("<head>");
    expect(capturedBlobContent).toContain("Content-Security-Policy");
    expect(capturedBlobContent).toContain("script-src 'none'");

    epub.sections[0].unload();
    epub.destroy();
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  });
});
