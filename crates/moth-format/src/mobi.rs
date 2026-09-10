//! MOBI parsing via the `mobi` crate: PDB/PalmDOC/MOBI/EXTH headers, LZ77 and
//! HUFF/CDIC text decompression, title/author/cover and body text.
//!
//! Classic, unencrypted MOBI is the supported input. DRM, KF8 and damaged
//! containers are reported to the caller with a request to convert to EPUB.

use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::Path,
};

use crate::{Metadata, ParseError};

/// Extract only MOBI metadata and the conventional first image cover. The
/// scanner uses this path so it can read headers and locate the cover without
/// loading or decompressing the book text.
pub fn parse_metadata(path: &Path) -> Result<Metadata, ParseError> {
    let metadata =
        mobi::MobiMetadata::from_path(path).map_err(|error| ParseError::Mobi(error.to_string()))?;
    let mut cover_error = None;
    let cover = first_cover(path, &metadata, &mut cover_error);
    Ok(Metadata {
        title: metadata.title(),
        author: metadata.author(),
        cover,
        cover_error,
    })
}

const COVER_MAX_BYTES: u64 = 16 * 1024 * 1024;

fn first_cover(
    path: &Path,
    metadata: &mobi::MobiMetadata,
    cover_error: &mut Option<String>,
) -> Option<crate::Cover> {
    let first_image = metadata.mobi.first_image_index as usize;
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(error) => {
            *cover_error = Some(format!("could not read MOBI cover: {error}"));
            return None;
        }
    };
    let file_len = match file.metadata() {
        Ok(metadata) => metadata.len(),
        Err(error) => {
            *cover_error = Some(format!("could not read MOBI cover: {error}"));
            return None;
        }
    };
    for index in first_image..metadata.records.records.len() {
        let start = metadata.records.records[index].offset as u64;
        let end = metadata
            .records
            .records
            .get(index + 1)
            .map(|record| record.offset as u64)
            .unwrap_or(file_len);
        if end <= start {
            continue;
        }
        if end - start > COVER_MAX_BYTES {
            *cover_error = Some("MOBI cover exceeds the 16 MiB scan limit".to_owned());
            return None;
        }
        if let Err(error) = file.seek(SeekFrom::Start(start)) {
            *cover_error = Some(format!("could not read MOBI cover: {error}"));
            return None;
        }
        let mut data = Vec::with_capacity((end - start) as usize);
        if let Err(error) = (&mut file).take(end - start).read_to_end(&mut data) {
            *cover_error = Some(format!("could not read MOBI cover: {error}"));
            return None;
        }
        if data.len() as u64 > COVER_MAX_BYTES {
            *cover_error = Some("MOBI cover exceeds the 16 MiB scan limit".to_owned());
            return None;
        }
        if is_image_record(&data) {
            return Some(crate::Cover {
                mime: crate::detect_image_mime(&data).to_owned(),
                data,
            });
        }
    }
    None
}

fn is_image_record(data: &[u8]) -> bool {
    if data.len() < 4 {
        return false;
    }
    !matches!(
        &data[..4],
        b"FLIS"
            | b"FCIS"
            | b"SRCS"
            | b"RESC"
            | b"BOUN"
            | b"FDST"
            | b"DATP"
            | b"AUDI"
            | b"VIDE"
            | b"\xe9\x8e\r\n"
    )
}
