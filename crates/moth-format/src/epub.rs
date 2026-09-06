//! EPUB parsing. A hand-rolled `zip` + `quick-xml` reader walks
//! `container.xml` → OPF (metadata, manifest, spine) and extracts spine
//! chapters as XHTML plus embedded resources. This gives exact control over
//! spine ordering and resource resolution that the higher-level `epub` crate
//! does not reliably provide.

use std::collections::HashMap;
use std::io::{Read, Seek};
use std::path::Path;

use quick_xml::Reader;
use quick_xml::events::{BytesStart, Event};
use zip::ZipArchive;

use crate::{Chapter, Cover, ParseError, ParsedBook, Resource, resolve_reference};

struct ManifestItem {
    id: String,
    path: String,
    mime: String,
    properties: String,
}

struct Package {
    title: String,
    author: Option<String>,
    manifest: Vec<ManifestItem>,
    /// Manifest ids in spine order.
    spine: Vec<String>,
    cover_id: Option<String>,
}

fn zip_bytes<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    name: &str,
) -> Result<Vec<u8>, ParseError> {
    let mut entry = archive
        .by_name(name)
        .map_err(|error| ParseError::Epub(format!("missing entry {name}: {error}")))?;
    let mut bytes = Vec::with_capacity(entry.size() as usize);
    entry
        .read_to_end(&mut bytes)
        .map_err(|error| ParseError::Epub(format!("reading {name}: {error}")))?;
    Ok(bytes)
}

/// Locate the OPF package path from `META-INF/container.xml`.
fn find_opf<R: Read + Seek>(archive: &mut ZipArchive<R>) -> Result<String, ParseError> {
    let bytes = zip_bytes(archive, "META-INF/container.xml")?;
    let mut reader = Reader::from_reader(bytes.as_slice());
    reader.config_mut().trim_text(true);
    let mut found = None;
    loop {
        match reader.read_event() {
            Ok(Event::Start(start)) => {
                if start.local_name().as_ref() == "rootfile"
                    && let Some(value) = attr(&start, "full-path")
                {
                    found = Some(value);
                }
            }
            Ok(Event::Empty(start)) => {
                if start.local_name().as_ref() == "rootfile"
                    && let Some(value) = attr(&start, "full-path")
                {
                    found = Some(value);
                }
            }
            Ok(Event::Eof) => break,
            Err(error) => return Err(ParseError::Epub(format!("container.xml: {error}"))),
            _ => {}
        }
    }
    found.ok_or_else(|| ParseError::Epub("container.xml has no rootfile".to_owned()))
}

fn attr(start: &BytesStart<'_>, key: &str) -> Option<String> {
    start
        .attributes()
        .flatten()
        .find(|attribute| attribute.key.as_ref() == key)
        .map(|attribute| attribute.value.into_owned())
}

/// Read the text content of an element until its end tag, matching by local
/// name so namespaced metadata (`dc:title`) is handled regardless of prefix.
fn read_until_end(reader: &mut Reader<&[u8]>, local: &str) -> String {
    let mut text = String::new();
    loop {
        match reader.read_event() {
            Ok(Event::Text(t)) => text.push_str(t.as_ref()),
            Ok(Event::End(e)) if e.local_name().as_ref() == local => break,
            Ok(Event::Eof) => break,
            _ => {}
        }
    }
    text.trim().to_owned()
}

/// Parse the OPF package: metadata, manifest, spine, and cover declaration.
fn read_package<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    opf_path: &str,
) -> Result<Package, ParseError> {
    let opf_dir = opf_path.rsplit_once('/').map(|(dir, _)| dir).unwrap_or("");
    let bytes = zip_bytes(archive, opf_path)?;
    let mut reader = Reader::from_reader(bytes.as_slice());
    reader.config_mut().trim_text(true);

    let mut package = Package {
        title: String::new(),
        author: None,
        manifest: Vec::new(),
        spine: Vec::new(),
        cover_id: None,
    };

    let mut in_metadata = false;
    let mut in_manifest = false;
    let mut in_spine = false;

    loop {
        match reader.read_event() {
            Ok(Event::Start(start)) => {
                let name = start.local_name();
                match name.as_ref() {
                    "metadata" => in_metadata = true,
                    "manifest" => in_manifest = true,
                    "spine" => in_spine = true,
                    "title" if in_metadata => {
                        if package.title.is_empty() {
                            package.title = read_until_end(&mut reader, "title");
                        }
                    }
                    "creator" if in_metadata => {
                        if package.author.is_none() {
                            package.author = Some(read_until_end(&mut reader, "creator"));
                        }
                    }
                    "meta" if in_metadata && attr(&start, "name").as_deref() == Some("cover") => {
                        package.cover_id = attr(&start, "content");
                    }
                    "item" if in_manifest => push_item(&mut package, &start, opf_dir),
                    "itemref" if in_spine => {
                        if let Some(idref) = attr(&start, "idref") {
                            package.spine.push(idref);
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Empty(start)) => {
                let name = start.local_name();
                match name.as_ref() {
                    "item" if in_manifest => push_item(&mut package, &start, opf_dir),
                    "itemref" if in_spine => {
                        if let Some(idref) = attr(&start, "idref") {
                            package.spine.push(idref);
                        }
                    }
                    "meta" if in_metadata && attr(&start, "name").as_deref() == Some("cover") => {
                        package.cover_id = attr(&start, "content");
                    }
                    _ => {}
                }
            }
            Ok(Event::End(end)) => match end.local_name().as_ref() {
                "metadata" => in_metadata = false,
                "manifest" => in_manifest = false,
                "spine" => in_spine = false,
                _ => {}
            },
            Ok(Event::Eof) => break,
            Err(error) => return Err(ParseError::Epub(format!("opf: {error}"))),
            _ => {}
        }
    }

    // EPUB3 declares the cover with `properties="cover-image"`.
    if package.cover_id.is_none() {
        package.cover_id = package
            .manifest
            .iter()
            .find(|item| {
                item.properties
                    .split_whitespace()
                    .any(|p| p == "cover-image")
            })
            .map(|item| item.id.clone());
    }

    Ok(package)
}

fn push_item(package: &mut Package, start: &BytesStart<'_>, opf_dir: &str) {
    if let (Some(id), Some(href)) = (attr(start, "id"), attr(start, "href")) {
        let path = resolve_reference(opf_dir, &href);
        package.manifest.push(ManifestItem {
            id,
            path,
            mime: attr(start, "media-type").unwrap_or_default(),
            properties: attr(start, "properties").unwrap_or_default(),
        });
    }
}

fn decode_xhtml(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        String::from_utf8_lossy(&bytes[3..]).into_owned()
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

/// Parse an EPUB file.
pub fn parse(path: &Path) -> Result<ParsedBook, ParseError> {
    let file = std::fs::File::open(path)?;
    let mut archive =
        ZipArchive::new(file).map_err(|error| ParseError::Archive(error.to_string()))?;
    let opf_path = find_opf(&mut archive)?;
    let package = read_package(&mut archive, &opf_path)?;

    let by_id: HashMap<String, &ManifestItem> = package
        .manifest
        .iter()
        .map(|item| (item.id.clone(), item))
        .collect();

    // Chapters follow the spine, skipping nav and scripted documents.
    let mut chapters: Vec<Chapter> = Vec::new();
    for id in &package.spine {
        let Some(item) = by_id.get(id) else {
            continue;
        };
        if item
            .properties
            .split_whitespace()
            .any(|p| p == "nav" || p == "scripted")
        {
            continue;
        }
        let mime = item.mime.clone();
        if !(mime == "application/xhtml+xml" || mime == "text/html") {
            continue;
        }
        let Ok(bytes) = zip_bytes(&mut archive, &item.path) else {
            continue;
        };
        let content = decode_xhtml(&bytes);
        let title = title_from_xhtml(&content)
            .or_else(|| {
                item.path.rsplit('/').next().map(|name| {
                    name.trim_end_matches(".xhtml")
                        .trim_end_matches(".html")
                        .to_owned()
                })
            })
            .unwrap_or_else(|| format!("Chapter {}", chapters.len() + 1));
        chapters.push(Chapter {
            title,
            content,
            base_dir: item
                .path
                .rsplit_once('/')
                .map(|(dir, _)| dir.to_owned())
                .unwrap_or_default(),
        });
    }
    if chapters.is_empty() {
        return Err(ParseError::NoContent);
    }

    // Resources: manifest entries referenced by chapters. Chapters themselves
    // are `application/xhtml+xml`/`text/html`; everything else (images, CSS,
    // fonts) is kept as an embeddable resource.
    let mut resources: Vec<Resource> = Vec::new();
    for item in &package.manifest {
        if item.mime == "application/xhtml+xml" || item.mime == "text/html" {
            continue;
        }
        if resources.iter().any(|r| r.path == item.path) {
            continue;
        }
        if let Ok(bytes) = zip_bytes(&mut archive, &item.path) {
            resources.push(Resource {
                path: item.path.clone(),
                mime: item.mime.clone(),
                data: bytes,
            });
        }
    }

    // Cover: explicit metadata, or the first image resource.
    let cover = package
        .cover_id
        .and_then(|id| by_id.get(&id).map(|item| item.path.clone()))
        .or_else(|| {
            resources
                .iter()
                .find(|r| r.mime.starts_with("image/"))
                .map(|r| r.path.clone())
        })
        .and_then(|path| {
            resources.iter().find(|r| r.path == path).map(|r| Cover {
                data: r.data.clone(),
                mime: r.mime.clone(),
            })
        });

    Ok(ParsedBook {
        format: crate::BookFormat::Epub,
        title: package.title,
        author: package.author,
        cover,
        chapters,
        resources,
        pages: Vec::new(),
    })
}

fn title_from_xhtml(html: &str) -> Option<String> {
    let re = regex::Regex::new(r"(?is)<title[^>]*>(.*?)</title>").expect("title regex");
    re.captures(html)
        .and_then(|caps| caps.get(1))
        .map(|m| m.as_str().trim().to_owned())
        .filter(|s| !s.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn build_minimal_epub() -> Vec<u8> {
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let stored = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        let deflated = zip::write::SimpleFileOptions::default();
        zip.start_file("mimetype", stored).unwrap();
        zip.write_all(b"application/epub+zip").unwrap();
        zip.start_file("META-INF/container.xml", deflated).unwrap();
        zip.write_all(br#"<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>"#).unwrap();
        zip.start_file("OEBPS/content.opf", deflated).unwrap();
        zip.write_all(br#"<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>T</dc:title><dc:creator>A</dc:creator></metadata><manifest><item id="ch1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="ch1"/></spine></package>"#).unwrap();
        zip.start_file("OEBPS/text/ch1.xhtml", deflated).unwrap();
        zip.write_all(br#"<html xmlns="http://www.w3.org/1999/xhtml"><head><title>C1</title></head><body><p>hello</p></body></html>"#).unwrap();
        zip.finish().unwrap().into_inner()
    }

    #[test]
    fn parses_minimal_epub() {
        let bytes = build_minimal_epub();
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        let opf = find_opf(&mut archive).unwrap();
        assert_eq!(opf, "OEBPS/content.opf");
        let package = read_package(&mut archive, &opf).unwrap();
        assert_eq!(package.title, "T");
        assert_eq!(package.author.as_deref(), Some("A"));
        assert_eq!(package.spine, vec!["ch1".to_owned()]);
        assert_eq!(package.manifest.len(), 1);
        assert_eq!(package.manifest[0].path, "OEBPS/text/ch1.xhtml");
    }

    #[test]
    fn extracts_title_from_xhtml() {
        assert_eq!(
            title_from_xhtml("<html><head><title>Hello</title></head></html>").as_deref(),
            Some("Hello")
        );
        assert_eq!(title_from_xhtml("<html><body>x</body></html>"), None);
    }
}
