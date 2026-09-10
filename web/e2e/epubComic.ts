import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";

/** Image-only chapters exercise the archive loader and both EPUB renderers. */
export async function makeEpubComic(books: string, fixed: boolean) {
  const title = fixed ? "Fixed EPUB Comic" : "Reflowable EPUB Comic";
  const directory = join(books, "漫画", title);
  await mkdir(directory, { recursive: true });
  const zip = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
  const add = (name: string, text: string) => zip.add(name, new TextReader(text));
  await add("mimetype", "application/epub+zip");
  await add("META-INF/container.xml", '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  const pages = Array.from({ length: 8 }, (_, index) => index);
  await add("content.opf", `<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
    <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">moth-${title}</dc:identifier><dc:title>${title}</dc:title><dc:language>en</dc:language>
      ${fixed ? '<meta property="rendition:layout">pre-paginated</meta><meta property="rendition:spread">none</meta>' : ''}
    </metadata>
    <manifest>${pages.map((i) => `<item id="p${i}" href="page${i}.xhtml" media-type="application/xhtml+xml"/><item id="i${i}" href="image${i}.svg" media-type="image/svg+xml"/>`).join("")}</manifest>
    <spine page-progression-direction="${fixed ? "rtl" : "ltr"}">${pages.map((i) => `<itemref idref="p${i}"/>`).join("")}</spine>
  </package>`);
  for (const index of pages) {
    await add(`image${index}.svg`, `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="900" viewBox="0 0 600 900"><rect width="600" height="900" fill="hsl(${index * 40} 50% 70%)"/><text x="260" y="450" font-size="100">${index + 1}</text></svg>`);
    const artwork = index % 2
      ? `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 600 900"><image width="600" height="900" xlink:href="image${index}.svg"/></svg>`
      : `<img src="image${index}.svg" alt="Comic page ${index + 1}"/>`;
    await add(`page${index}.xhtml`, `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Page ${index + 1}</title><meta name="viewport" content="width=600,height=900"/><style>html,body{margin:0;padding:0}img,svg{display:block;width:100%;height:auto}</style></head><body>${artwork}</body></html>`);
  }
  await writeFile(join(directory, "第一部.epub"), await zip.close());
  return title;
}
