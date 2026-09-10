//! EPUB metadata parsing. The browser's Foliate adapter owns spine, CFI,
//! resource and TOC loading; the server only reads the OPF metadata and cover
//! needed for indexing.

use std::collections::HashMap;
use std::io::{Read, Seek};
use std::path::Path;

use quick_xml::Reader;
use quick_xml::events::{BytesStart, Event};
use zip::ZipArchive;

use crate::{Cover, Metadata, ParseError, resolve_reference};

const CONTAINER_MAX_BYTES: u64 = 1024 * 1024;
const OPF_MAX_BYTES: u64 = 8 * 1024 * 1024;
const COVER_MAX_BYTES: u64 = 16 * 1024 * 1024;

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
    cover_id: Option<String>,
}

fn zip_bytes_limited<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    name: &str,
    max_bytes: u64,
) -> Result<Vec<u8>, ParseError> {
    let entry = archive
        .by_name(name)
        .map_err(|error| ParseError::Epub(format!("missing entry {name}: {error}")))?;
    if entry.size() > max_bytes {
        return Err(ParseError::Epub(format!(
            "{name} exceeds the {} MiB scan limit",
            max_bytes / (1024 * 1024)
        )));
    }
    let capacity = usize::try_from(entry.size()).unwrap_or(usize::MAX);
    let mut bytes =
        Vec::with_capacity(capacity.min(usize::try_from(max_bytes).unwrap_or(usize::MAX)));
    entry
        .take(max_bytes.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|error| ParseError::Epub(format!("reading {name}: {error}")))?;
    if bytes.len() as u64 > max_bytes {
        return Err(ParseError::Epub(format!(
            "{name} exceeds the {} MiB scan limit",
            max_bytes / (1024 * 1024)
        )));
    }
    Ok(bytes)
}

/// Locate the OPF package path from `META-INF/container.xml`.
fn find_opf<R: Read + Seek>(archive: &mut ZipArchive<R>) -> Result<String, ParseError> {
    let bytes = zip_bytes_limited(archive, "META-INF/container.xml", CONTAINER_MAX_BYTES)?;
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

/// Parse the OPF package metadata, manifest and cover declaration.
fn read_package<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    opf_path: &str,
) -> Result<Package, ParseError> {
    let opf_dir = opf_path.rsplit_once('/').map(|(dir, _)| dir).unwrap_or("");
    let bytes = zip_bytes_limited(archive, opf_path, OPF_MAX_BYTES)?;
    let mut reader = Reader::from_reader(bytes.as_slice());
    reader.config_mut().trim_text(true);

    let mut package = Package {
        title: String::new(),
        author: None,
        manifest: Vec::new(),
        cover_id: None,
    };

    let mut in_metadata = false;
    let mut in_manifest = false;

    loop {
        match reader.read_event() {
            Ok(Event::Start(start)) => {
                let name = start.local_name();
                match name.as_ref() {
                    "metadata" => in_metadata = true,
                    "manifest" => in_manifest = true,
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
                    _ => {}
                }
            }
            Ok(Event::Empty(start)) => {
                let name = start.local_name();
                match name.as_ref() {
                    "item" if in_manifest => push_item(&mut package, &start, opf_dir),
                    "meta" if in_metadata && attr(&start, "name").as_deref() == Some("cover") => {
                        package.cover_id = attr(&start, "content");
                    }
                    _ => {}
                }
            }
            Ok(Event::End(end)) => match end.local_name().as_ref() {
                "metadata" => in_metadata = false,
                "manifest" => in_manifest = false,
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

/// Parse only EPUB metadata and its declared cover. The scanner uses this
/// lightweight path; chapter XHTML, stylesheets and other resources remain in
/// the read-only source and are fetched later through the browser's Range
/// loader.
pub fn parse_metadata(path: &Path) -> Result<Metadata, ParseError> {
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
    let cover_path = package
        .cover_id
        .as_ref()
        .and_then(|id| by_id.get(id))
        .filter(|item| item.mime.starts_with("image/"))
        .map(|item| item.path.clone())
        .or_else(|| {
            package
                .manifest
                .iter()
                .find(|item| {
                    item.properties
                        .split_whitespace()
                        .any(|property| property == "cover-image")
                        || item.mime.starts_with("image/")
                })
                .map(|item| item.path.clone())
        });
    let mut cover_error = None;
    let cover =
        cover_path.and_then(
            |path| match zip_bytes_limited(&mut archive, &path, COVER_MAX_BYTES) {
                Ok(data) => Some(Cover {
                    mime: package
                        .manifest
                        .iter()
                        .find(|item| item.path == path)
                        .map(|item| item.mime.clone())
                        .unwrap_or_else(|| crate::detect_image_mime(&data).to_owned()),
                    data,
                }),
                Err(error) => {
                    cover_error = Some(error.to_string());
                    None
                }
            },
        );
    Ok(Metadata {
        title: package.title,
        author: package.author,
        cover,
        cover_error,
    })
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
        assert_eq!(package.manifest.len(), 1);
        assert_eq!(package.manifest[0].path, "OEBPS/text/ch1.xhtml");
    }

    #[test]
    fn metadata_parse_does_not_load_spine_content() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("book.epub");
        std::fs::write(&path, build_minimal_epub()).unwrap();
        let metadata = parse_metadata(&path).unwrap();
        assert_eq!(metadata.title, "T");
        assert!(metadata.cover.is_none());
    }

    #[test]
    fn rejects_oversized_metadata_entries_before_allocating_them() {
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        zip.start_file(
            "META-INF/container.xml",
            zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
        zip.write_all(&vec![b'x'; (CONTAINER_MAX_BYTES + 1) as usize])
            .unwrap();
        let bytes = zip.finish().unwrap().into_inner();
        let mut archive = ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        assert!(
            zip_bytes_limited(&mut archive, "META-INF/container.xml", CONTAINER_MAX_BYTES).is_err()
        );
    }
}
