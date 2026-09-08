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
    let text_dir = target.join("小说").join("夜色入海");
    let legacy_dir = target.join("小说").join("Legacy GBK");
    let cbz_dir = target.join("漫画").join("晨光短篇");
    let fixture_dir = target.join("英文").join("The Fixture Novel");
    let no_cover_dir = target.join("英文").join("No Cover Novel");
    for directory in [
        &text_dir,
        &legacy_dir,
        &cbz_dir,
        &fixture_dir,
        &no_cover_dir,
    ] {
        std::fs::create_dir_all(directory).expect("create nested fixture directory");
    }

    // Original, redistributable text long enough to exercise pagination.
    let mut text = String::new();
    for chapter in ["第一章 夜色入海", "第二章 路上", "第三章 归来"] {
        text.push_str(&format!("{chapter}\n\n"));
        for paragraph in 0..60 {
            text.push_str(&format!(
                "第{paragraph}段。天亮了，我们沿着海岸出发。微风掠过书页，远方的灯塔渐渐清晰。\n\n"
            ));
        }
    }
    std::fs::write(text_dir.join("第一部.txt"), &text).expect("write txt");
    let legacy_text = text.replace("第一章 夜色入海", "第一章 Legacy GBK");
    let (gbk, _, _) = encoding_rs::GBK.encode(&legacy_text);
    std::fs::write(legacy_dir.join("第一部.txt"), gbk).expect("write gbk");
    std::fs::write(fixture_dir.join("Broken.epub"), b"not a zip").expect("broken epub");

    // CBZ: three pages exercising natural sort order.
    let cbz = std::fs::File::create(cbz_dir.join("第一部.cbz")).expect("create cbz");
    let mut zip = zip::ZipWriter::new(cbz);
    let options = zip::write::SimpleFileOptions::default();
    for number in [1, 2, 3, 4, 5, 6, 10, 11] {
        let name = format!("page_{number}.png");
        let color = (number * 20, 40, 200);
        zip.start_file(name, options).expect("cbz entry");
        zip.write_all(&png_bytes(color.0, color.1, color.2))
            .expect("cbz page");
    }
    zip.finish().expect("finish cbz");

    // EPUB with two chapters, a cover image, and CSS.
    let epub = std::fs::File::create(fixture_dir.join("第一部.epub")).expect("create epub");
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
    let paragraphs =
        "<p>The adventure begins beside the quiet sea. The lighthouse is our destination.</p>"
            .repeat(80);
    zip.write_all(
        format!(
            r#"<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Chapter One</title><link rel="stylesheet" href="../css/main.css"/></head>
<body><h1>Chapter One</h1>{paragraphs}<img src="../Images/cover.png" alt="cover"/>
<script>window.__mothBookScriptRan = true; fetch('https://moth-fixture.invalid/script');</script>
<img src="https://moth-fixture.invalid/image" onerror="window.__mothBookScriptRan=true"/>
</body></html>"#
        )
        .as_bytes(),
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
    zip.start_file("OEBPS/nav.xhtml", deflated).expect("nav");
    zip.write_all(br#"<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol><li><a href="text/ch1.xhtml">Chapter One</a><ol><li><a href="text/ch2.xhtml">Chapter Two</a></li></ol></li></ol></nav></body></html>"#).expect("nav");
    zip.start_file("OEBPS/Images/cover.png", deflated)
        .expect("cover img");
    zip.write_all(&png_bytes(40, 40, 180)).expect("cover img");
    zip.start_file("OEBPS/css/main.css", deflated).expect("css");
    zip.write_all(
        b"@import url('https://moth-fixture.invalid/style'); body { font-family: serif; }",
    )
    .expect("css");
    zip.finish().expect("finish epub");

    // A valid EPUB without a declared cover exercises the bookshelf
    // placeholder and keeps the missing-cover state distinct from a parse
    // failure.
    let no_cover =
        std::fs::File::create(no_cover_dir.join("第一部.epub")).expect("create no-cover epub");
    let mut zip = zip::ZipWriter::new(no_cover);
    zip.start_file("mimetype", stored).expect("mimetype");
    zip.write_all(b"application/epub+zip").expect("mimetype");
    zip.start_file("META-INF/container.xml", deflated)
        .expect("container");
    zip.write_all(
        br#"<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>"#,
    )
    .expect("container");
    zip.start_file("OEBPS/content.opf", deflated).expect("opf");
    zip.write_all(
        br#"<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>No Cover Novel</dc:title><dc:creator>Moth Author</dc:creator></metadata>
  <manifest><item id="chapter" href="text/chapter.xhtml" media-type="application/xhtml+xml"/></manifest>
  <spine><itemref idref="chapter"/></spine>
</package>"#,
    )
    .expect("opf");
    zip.start_file("OEBPS/text/chapter.xhtml", deflated)
        .expect("chapter");
    zip.write_all(
        br#"<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>No Cover Chapter</title></head><body><h1>No Cover Chapter</h1><p>This valid EPUB intentionally has no cover.</p></body></html>"#,
    )
    .expect("chapter");
    zip.finish().expect("finish no-cover epub");

    println!("fixture books written to {}", target.display());
}
