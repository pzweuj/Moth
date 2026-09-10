"""Generate a deterministic synthetic 1,000-book acceptance library (requires Pillow)."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import shutil
import zipfile

from PIL import Image

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("destination", type=Path)
args = parser.parse_args()
root = args.destination.resolve()
root.mkdir(parents=True, exist_ok=False)
image = Image.new("RGB", (1600, 2400), (132, 173, 211))
png = io.BytesIO()
image.save(png, "PNG")
bmp = io.BytesIO()
image.save(bmp, "BMP")
text = "A bounded memory reading fixture. " * 32_000
container = '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'
for index in range(970):
    path = root / f"book-{index:04}.epub"
    opf = f'''<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">synthetic-{index}</dc:identifier><dc:title>Memory {index}</dc:title><dc:language>en</dc:language></metadata><manifest><item id="cover" href="cover.png" media-type="image/png" properties="cover-image"/><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest><spine><itemref idref="chapter"/></spine></package>'''
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED, compresslevel=1) as book:
        book.writestr("mimetype", "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        book.writestr("META-INF/container.xml", container)
        book.writestr("content.opf", opf)
        book.writestr("cover.png", png.getvalue())
        book.writestr("chapter.xhtml", '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>' + text + '</p></body></html>')
        book.writestr("nav.xhtml", '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><a href="chapter.xhtml">Chapter 1</a></li></ol></nav></body></html>')
        if index == 0:
            book.writestr("reading-payload.bin", b"x" * (24 * 1024 * 1024), compress_type=zipfile.ZIP_STORED)
for index in range(20):
    (root / f"text-{index:02}.txt").write_text(f"Chapter {index + 1}\n\n" + text, encoding="utf-8")
for index in range(9):
    with zipfile.ZipFile(root / f"comic-{index:02}.cbz", "w", zipfile.ZIP_DEFLATED, compresslevel=1) as book:
        for page in range(8):
            book.writestr(f"{page:02}.bmp", bmp.getvalue())
        book.comment = f"synthetic-{index}".encode()
shutil.copyfile(Path(__file__).resolve().parents[1] / "crates/moth-format/tests/fixtures/alice.mobi", root / "alice.mobi")
files = sorted(root.iterdir())
manifest = {"synthetic": True, "count": len(files), "bytes": sum(path.stat().st_size for path in files), "cover_pixels": [1600, 2400], "files": {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in files}}
(root.parent / f"{root.name}-manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
print(json.dumps({key: value for key, value in manifest.items() if key != "files"}), flush=True)
