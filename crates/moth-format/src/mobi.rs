//! MOBI parsing via the `mobi` crate: PDB/PalmDOC/MOBI/EXTH headers, LZ77 and
//! HUFF/CDIC text decompression, title/author/cover and body text.
//!
//! Classic, unencrypted MOBI is the supported input. DRM, KF8 and damaged
//! containers are reported to the caller with a request to convert to EPUB.

use std::path::Path;

use crate::{ParseError, ParsedBook};

/// Parse a MOBI file. Text is emitted as a small number of heuristically
/// split chapters, rendered as HTML.
pub fn parse(path: &Path) -> Result<ParsedBook, ParseError> {
    let book = mobi::Mobi::from_path(path).map_err(|error| ParseError::Mobi(error.to_string()))?;
    let text = match book.content_as_string() {
        Ok(text) => text,
        Err(_) => book.content_as_string_lossy(),
    };
    if text.trim().is_empty() {
        return Err(ParseError::NoContent);
    }

    let title = book.title();
    let author = book.author();
    let cover = first_cover(&book);

    let chapters = crate::txt::split_and_render(&text, path);

    Ok(ParsedBook {
        format: crate::BookFormat::Mobi,
        title,
        author,
        cover,
        chapters,
        resources: Vec::new(),
        pages: Vec::new(),
    })
}

/// Extract only MOBI metadata and the conventional first image cover. The
/// scanner uses this path so opening a large MOBI is the only operation that
/// decompresses its full text.
pub fn parse_metadata(path: &Path) -> Result<ParsedBook, ParseError> {
    let book = mobi::Mobi::from_path(path).map_err(|error| ParseError::Mobi(error.to_string()))?;
    Ok(ParsedBook {
        format: crate::BookFormat::Mobi,
        title: book.title(),
        author: book.author(),
        cover: first_cover(&book),
        chapters: Vec::new(),
        resources: Vec::new(),
        pages: Vec::new(),
    })
}

fn first_cover(book: &mobi::Mobi) -> Option<crate::Cover> {
    book.image_records().first().map(|record| crate::Cover {
        data: record.content.to_vec(),
        mime: crate::detect_image_mime(record.content).to_owned(),
    })
}
