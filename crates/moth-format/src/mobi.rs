//! MOBI parsing via the `mobi` crate: PDB/PalmDOC/MOBI/EXTH headers, LZ77 and
//! HUFF/CDIC text decompression, title/author/cover and body text.
//!
//! Classic, unencrypted MOBI is the supported input. DRM, KF8 and damaged
//! containers are reported to the caller with a request to convert to EPUB.

use std::path::Path;

use crate::{Metadata, ParseError};

/// Extract only MOBI metadata and the conventional first image cover. The
/// scanner uses this path so opening a large MOBI is the only operation that
/// decompresses its full text.
pub fn parse_metadata(path: &Path) -> Result<Metadata, ParseError> {
    let book = mobi::Mobi::from_path(path).map_err(|error| ParseError::Mobi(error.to_string()))?;
    Ok(Metadata {
        title: book.title(),
        author: book.author(),
        cover: first_cover(&book),
    })
}

fn first_cover(book: &mobi::Mobi) -> Option<crate::Cover> {
    book.image_records().first().map(|record| crate::Cover {
        data: record.content.to_vec(),
        mime: crate::detect_image_mime(record.content).to_owned(),
    })
}
