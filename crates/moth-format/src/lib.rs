//! Book parsing for Moth. Each supported format is parsed into a unified
//! [`ParsedBook`]: metadata, chapters of HTML, embedded resources, and (for
//! comics) a page list. Parsing is CPU-bound and must run off the async
//! runtime (see `spawn_blocking`).

pub mod cbz;
pub mod epub;
pub mod html;
pub mod mobi;
pub mod txt;

use std::path::Path;

use thiserror::Error;

/// The book formats Moth can read. Moth is self-hosted with a single user;
/// formats are parsed server-side into a normalized form.
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
            "mobi" | "azw" | "azw3" => Some(Self::Mobi),
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
}

#[derive(Debug, Clone)]
pub struct Cover {
    pub data: Vec<u8>,
    pub mime: String,
}

/// A single reading unit. For text formats this is a chapter rendered as an
/// HTML fragment (EPUB spine items keep their XHTML; TXT/MOBI become generated
/// HTML). Relative resource URLs are preserved here and rewritten to served
/// endpoints by [`ParsedBook::rewrite_resource_urls`].
#[derive(Debug, Clone)]
pub struct Chapter {
    pub title: String,
    pub content: String,
    /// Directory of the source file inside its archive (EPUB only), used to
    /// resolve relative resource URLs. Empty for non-EPUB formats.
    pub base_dir: String,
}

/// A resource embedded in an EPUB archive (image, stylesheet, font) that
/// chapters reference.
#[derive(Debug, Clone)]
pub struct Resource {
    /// Normalized path inside the archive (for example `OEBPS/Images/x.jpg`).
    pub path: String,
    pub mime: String,
    pub data: Vec<u8>,
}

/// A comic page from a CBZ archive.
#[derive(Debug, Clone)]
pub struct Page {
    /// Entry name inside the archive.
    pub path: String,
    pub mime: String,
}

/// The normalized result of parsing one book.
#[derive(Debug, Clone)]
pub struct ParsedBook {
    pub format: BookFormat,
    pub title: String,
    pub author: Option<String>,
    pub cover: Option<Cover>,
    pub chapters: Vec<Chapter>,
    pub resources: Vec<Resource>,
    pub pages: Vec<Page>,
}

impl ParsedBook {
    /// Parse a book file. The format is detected from the extension.
    pub fn parse(path: &Path) -> Result<Self, ParseError> {
        let format = BookFormat::from_path(path).ok_or(ParseError::UnsupportedFormat)?;
        Self::parse_as(path, format)
    }

    /// Parse a book file with an explicit format.
    pub fn parse_as(path: &Path, format: BookFormat) -> Result<Self, ParseError> {
        let mut book = match format {
            BookFormat::Epub => epub::parse(path)?,
            BookFormat::Mobi => mobi::parse(path)?,
            BookFormat::Cbz => cbz::parse(path)?,
            BookFormat::Txt => txt::parse(path)?,
        };
        if book.title.trim().is_empty() {
            book.title = path
                .file_stem()
                .map(|stem| stem.to_string_lossy().into_owned())
                .unwrap_or_else(|| "Untitled".to_owned());
        }
        Ok(book)
    }

    /// Sanitize chapter HTML and rewrite internal resource URLs to served
    /// endpoints. Called by the library layer once the book's id (which is
    /// part of the endpoint path) is known.
    pub fn rewrite_resource_urls(&mut self, prefix: &str) {
        let resources: std::collections::HashMap<String, usize> = self
            .resources
            .iter()
            .enumerate()
            .map(|(index, resource)| (resource.path.clone(), index))
            .collect();
        for chapter in &mut self.chapters {
            let base_dir = std::mem::take(&mut chapter.base_dir);
            chapter.content =
                html::sanitize_and_rewrite(&chapter.content, &base_dir, &resources, prefix);
        }
    }
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
        assert_eq!(
            BookFormat::from_path(Path::new("a.azw3")),
            Some(BookFormat::Mobi)
        );
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
