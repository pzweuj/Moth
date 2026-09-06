//! MOBI parsing via the `mobi` crate: PDB/PalmDOC/MOBI/EXTH headers, LZ77 and
//! HUFF/CDIC text decompression, title/author/cover and body text.
//!
//! KF8/AZW3 is only partially supported and KFX/DRM is not parseable at all;
//! the reader surfaces those as best-effort with a hint to re-export to EPUB.

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

    // The first embedded image record is conventionally the cover.
    let cover = book.image_records().first().map(|record| crate::Cover {
        data: record.content.to_vec(),
        mime: crate::detect_image_mime(record.content).to_owned(),
    });

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
