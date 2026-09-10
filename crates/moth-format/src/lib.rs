//! Small format-specific parsers for Moth's read-only book root. EPUB and
//! MOBI expose metadata, TXT exposes normalized chapter ranges, and CBZ
//! exposes an ordered page index. Parsing is CPU-bound and must run off the
//! async runtime (see `spawn_blocking`).

pub mod cbz;
pub mod epub;
pub mod html;
pub mod mobi;
pub mod txt;

use std::path::Path;

use thiserror::Error;

/// The book formats Moth can read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BookFormat {
    Epub,
    Mobi,
    Cbz,
    Txt,
}

impl BookFormat {
    /// Recognize a format from a file extension, case-insensitively.
    pub fn from_path(path: &Path) -> Option<Self> {
        let ext = path.extension()?.to_str()?.to_ascii_lowercase();
        match ext.as_str() {
            "epub" => Some(Self::Epub),
            "mobi" => Some(Self::Mobi),
            "cbz" => Some(Self::Cbz),
            "txt" => Some(Self::Txt),
            _ => None,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Epub => "epub",
            Self::Mobi => "mobi",
            Self::Cbz => "cbz",
            Self::Txt => "txt",
        }
    }
}

/// Errors produced while parsing a single book. They never stop a library
/// scan; the book is recorded with `parse_status = error` and the message is
/// surfaced for diagnostics.
#[derive(Debug, Error)]
pub enum ParseError {
    #[error("unsupported format")]
    UnsupportedFormat,
    #[error("could not read file: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid archive: {0}")]
    Archive(String),
    #[error("invalid epub: {0}")]
    Epub(String),
    #[error("invalid mobi: {0}")]
    Mobi(String),
    #[error("no readable text content")]
    NoContent,
    #[error("could not decode cover image: {0}")]
    Cover(String),
}

/// Metadata and cover for a book. The cover is kept in its original encoding
/// (PNG/JPEG/WebP...); thumbnail generation happens later via `image`.
#[derive(Debug, Clone, Default)]
pub struct Metadata {
    pub title: String,
    pub author: Option<String>,
    pub cover: Option<Cover>,
    /// A non-fatal cover problem. The book can still be indexed and opened.
    pub cover_error: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Cover {
    pub data: Vec<u8>,
    pub mime: String,
}

/// A comic page from a CBZ archive.
#[derive(Debug, Clone)]
pub struct Page {
    /// Entry name inside the archive.
    pub path: String,
    pub mime: String,
}

/// CBZ metadata and the naturally ordered pages served on demand.
#[derive(Debug, Clone)]
pub struct ComicIndex {
    pub pages: Vec<Page>,
    pub cover: Option<Cover>,
    pub cover_error: Option<String>,
}

/// Resolve a possibly-relative reference against a base directory and
/// normalize slashes, producing a path suitable for matching manifest entries.
/// For example `("OEBPS/text", "../Images/x.jpg")` becomes
/// `OEBPS/Images/x.jpg`.
pub fn resolve_reference(base_dir: &str, reference: &str) -> String {
    let base_dir = base_dir.replace('\\', "/");
    let reference = reference.replace('\\', "/");
    let mut parts: Vec<&str> = base_dir
        .trim_end_matches('/')
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect();
    for segment in reference.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    parts.join("/")
}

/// Sniff the MIME type of image bytes from their magic numbers. Used where a
/// format does not declare one (MOBI cover records).
pub fn detect_image_mime(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        "image/gif"
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        "image/webp"
    } else if bytes.starts_with(b"BM") {
        "image/bmp"
    } else {
        "image/jpeg"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_relative_references() {
        assert_eq!(
            resolve_reference("OEBPS/text", "../Images/x.jpg"),
            "OEBPS/Images/x.jpg"
        );
        assert_eq!(
            resolve_reference("OEBPS/text", "css/main.css"),
            "OEBPS/text/css/main.css"
        );
        assert_eq!(
            resolve_reference("OEBPS/text", "./x.png"),
            "OEBPS/text/x.png"
        );
        assert_eq!(
            resolve_reference("OEBPS", "Images/x.jpg"),
            "OEBPS/Images/x.jpg"
        );
        assert_eq!(resolve_reference("", "text/ch1.xhtml"), "text/ch1.xhtml");
    }

    #[test]
    fn recognizes_formats_from_extension() {
        assert_eq!(
            BookFormat::from_path(Path::new("a.epub")),
            Some(BookFormat::Epub)
        );
        assert_eq!(
            BookFormat::from_path(Path::new("a.MOBI")),
            Some(BookFormat::Mobi)
        );
        assert_eq!(BookFormat::from_path(Path::new("a.azw3")), None);
        assert_eq!(
            BookFormat::from_path(Path::new("a.cbz")),
            Some(BookFormat::Cbz)
        );
        assert_eq!(
            BookFormat::from_path(Path::new("a.txt")),
            Some(BookFormat::Txt)
        );
        assert_eq!(BookFormat::from_path(Path::new("a.pdf")), None);
    }
}
