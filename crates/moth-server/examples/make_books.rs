//! Generate a handful of fixture books (TXT, CBZ, EPUB) into a target
//! directory, for manual testing without a browser. Usage:
//!
//! ```text
//! cargo run -p moth-server --example make_books -- .local/books
//! ```

use std::io::Write;
use std::path::PathBuf;

fn png_bytes(r: u8, g: u8, b: u8) -> Vec<u8> {
    let image = image::RgbImage::from_pixel(60, 90, image::Rgb([r, g, b]));
    let mut bytes = Vec::new();
    image
        .write_to(
            &mut std::io::Cursor::new(&mut bytes),
            image::ImageFormat::Png,
        )
        .expect("encode png");
    bytes
}

fn main() {
    let target = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(".local/books"));
    std::fs::create_dir_all(&target).expect("create target directory");

    // TXT with CJK chapter markers.
    std::fs::write(
        target.join("夜色入海.txt"),
        "第一章 启程\n\n天亮了,我们出发。\n\n第二章 路上\n\n他们继续走,一路无言。\n",
    )
    .expect("write txt");

    // CBZ: three pages exercising natural sort order.
    let cbz = std::fs::File::create(target.join("晨光短篇.cbz")).expect("create cbz");
    let mut zip = zip::ZipWriter::new(cbz);
    let options = zip::write::SimpleFileOptions::default();
    for (name, color) in [
        ("page_1.png", (200, 30, 30)),
        ("page_2.png", (30, 200, 30)),
        ("page_10.png", (30, 30, 200)),
    ] {
        zip.start_file(name, options).expect("cbz entry");
        zip.write_all(&png_bytes(color.0, color.1, color.2))
            .expect("cbz page");
    }
    zip.finish().expect("finish cbz");

    // EPUB with two chapters, a cover image, and CSS.
    let epub = std::fs::File::create(target.join("The Fixture Novel.epub")).expect("create epub");
    let mut zip = zip::ZipWriter::new(epub);
    let stored =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    let deflated = zip::write::SimpleFileOptions::default();
    zip.start_file("mimetype", stored).expect("mimetype");
    zip.write_all(b"application/epub+zip").expect("mimetype");
    zip.start_file("META-INF/container.xml", deflated)
        .expect("container");
    zip.write_all(
        br#"<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>"#,
    )
    .expect("container");
    zip.start_file("OEBPS/content.opf", deflated).expect("opf");
    zip.write_all(
        br#"<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>The Fixture Novel</dc:title>
    <dc:creator>Moth Author</dc:creator>
    <meta name="cover" content="cover-img"/>
  </metadata>
  <manifest>
    <item id="cover-img" href="Images/cover.png" media-type="image/png"/>
    <item id="css" href="css/main.css" media-type="text/css"/>
    <item id="ch1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
  </spine>
</package>"#,
    )
    .expect("opf");
    zip.start_file("OEBPS/text/ch1.xhtml", deflated)
        .expect("ch1");
    zip.write_all(
        br#"<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Chapter One</title><link rel="stylesheet" href="../css/main.css"/></head>
<body><h1>Chapter One</h1><p>The adventure begins.</p><img src="../Images/cover.png" alt="cover"/></body>
</html>"#,
    )
    .expect("ch1");
    zip.start_file("OEBPS/text/ch2.xhtml", deflated)
        .expect("ch2");
    zip.write_all(
        br#"<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Chapter Two</title></head>
<body><h1>Chapter Two</h1><p>And then it continued.</p></body>
</html>"#,
    )
    .expect("ch2");
    zip.start_file("OEBPS/Images/cover.png", deflated)
        .expect("cover img");
    zip.write_all(&png_bytes(40, 40, 180)).expect("cover img");
    zip.start_file("OEBPS/css/main.css", deflated).expect("css");
    zip.write_all(b"body { font-family: serif; }").expect("css");
    zip.finish().expect("finish epub");

    println!("fixture books written to {}", target.display());
}
