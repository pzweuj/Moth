import { describe, expect, it, vi } from "vitest";
import { EPUB } from "../../vendor/foliate-js/epub.js";

const CONTAINER = `<?xml version="1.0"?>
<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OPS/package.opf" media-type="application/oebps-package+xml" /></rootfiles>
</container>`;

const PACKAGE = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Budget fixture</dc:title></metadata>
  <manifest>
    <item id="chapter" href="ch.xhtml" media-type="application/xhtml+xml" />
    <item id="art" href="image.jpg" media-type="image/jpeg" />
  </manifest>
  <spine><itemref idref="chapter" /></spine>
</package>`;

const CHAPTER = `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><img src="image.jpg" /></body></html>`;

describe("EPUB speculative resource budget", () => {
  it("stops an oversized prefetch and allows the foreground retry", async () => {
    let objectUrl = 0;
    const createObjectURL = vi.fn(() => `blob:budget-${objectUrl++}`);
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });

    const loadText = vi.fn(async (name: string) => ({
      "META-INF/container.xml": CONTAINER,
      "OPS/package.opf": PACKAGE,
      "OPS/ch.xhtml": CHAPTER,
    }[name] ?? null));
    const loadBlob = vi.fn(async () => new Blob([new Uint8Array(800)]));
    const getSize = vi.fn((name: string) => name === "OPS/image.jpg" ? 800 : name === "OPS/ch.xhtml" ? 200 : 0);
    const epub = await new EPUB({ loadText, loadBlob, getSize }, { resourceBudget: 512 }).init();

    await expect(epub.sections[0].load({ speculative: true })).rejects.toThrow(/budget exceeded/);
    expect(loadBlob).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();

    await expect(epub.sections[0].load()).resolves.toMatch(/^blob:budget-/);
    expect(loadBlob).toHaveBeenCalledTimes(1);
    epub.sections[0].unload();
    expect(revokeObjectURL).toHaveBeenCalledTimes(2);

    epub.destroy();
  });
});
