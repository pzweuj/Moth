//! CBZ (comic book zip) parsing: page list with natural filename ordering.

use std::io::Read;
use std::path::Path;

use zip::ZipArchive;

use crate::{Page, ParseError, ParsedBook};

/// Image extensions accepted as comic pages.
const IMAGE_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "gif", "webp", "bmp"];

fn mime_for(extension: &str) -> &'static str {
    match extension {
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        _ => "image/jpeg",
    }
}

/// Compare entry names naturally: `page_2` sorts before `page_10`.
fn natural_compare(a: &str, b: &str) -> std::cmp::Ordering {
    let a_chars: Vec<char> = a.chars().collect();
    let b_chars: Vec<char> = b.chars().collect();
    let (mut i, mut j) = (0, 0);
    while i < a_chars.len() && j < b_chars.len() {
        let ca = a_chars[i];
        let cb = b_chars[j];
        if ca.is_ascii_digit() && cb.is_ascii_digit() {
            let (mut end_a, mut end_b) = (i, j);
            while end_a < a_chars.len() && a_chars[end_a].is_ascii_digit() {
                end_a += 1;
            }
            while end_b < b_chars.len() && b_chars[end_b].is_ascii_digit() {
                end_b += 1;
            }
            let num_a: u64 = a[i..end_a].parse().unwrap_or(0);
            let num_b: u64 = b[j..end_b].parse().unwrap_or(0);
            match num_a.cmp(&num_b) {
                std::cmp::Ordering::Equal => {
                    i = end_a;
                    j = end_b;
                }
                other => return other,
            }
        } else {
            match ca.to_ascii_lowercase().cmp(&cb.to_ascii_lowercase()) {
                std::cmp::Ordering::Equal => {
                    i += 1;
                    j += 1;
                }
                other => return other,
            }
        }
    }
    (a_chars.len() - i).cmp(&(b_chars.len() - j))
}

/// Parse a CBZ archive into its ordered page list. Page bytes are served
/// lazily from the original (read-only) archive by the library layer.
pub fn parse(path: &Path) -> Result<ParsedBook, ParseError> {
    let file = std::fs::File::open(path)?;
    let mut archive =
        ZipArchive::new(file).map_err(|error| ParseError::Archive(error.to_string()))?;

    let mut pages: Vec<Page> = Vec::new();
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|error| ParseError::Archive(error.to_string()))?;
        if entry.is_dir() {
            continue;
        }
        let name = entry.name().replace('\\', "/");
        let Some(extension) = name.rsplit('.').next() else {
            continue;
        };
        let extension = extension.to_ascii_lowercase();
        if IMAGE_EXTENSIONS.contains(&extension.as_str()) {
            pages.push(Page {
                path: name,
                mime: mime_for(&extension).to_owned(),
            });
        }
    }

    if pages.is_empty() {
        return Err(ParseError::NoContent);
    }
    pages.sort_by(|a, b| natural_compare(&a.path, &b.path));

    // The first page doubles as the cover.
    let cover = {
        let first = &pages[0];
        let mut archive = ZipArchive::new(std::fs::File::open(path)?)
            .map_err(|error| ParseError::Archive(error.to_string()))?;
        let mut buffer = Vec::new();
        archive
            .by_name(&first.path)
            .map_err(|error| ParseError::Archive(error.to_string()))?
            .read_to_end(&mut buffer)
            .map_err(|error| ParseError::Archive(error.to_string()))?;
        Some(crate::Cover {
            data: buffer,
            mime: first.mime.clone(),
        })
    };

    Ok(ParsedBook {
        format: crate::BookFormat::Cbz,
        title: String::new(),
        author: None,
        cover,
        chapters: Vec::new(),
        resources: Vec::new(),
        pages,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn natural_ordering_sorts_page_numbers() {
        let mut names = vec!["page_10.jpg", "page_2.jpg", "page_1.jpg"];
        names.sort_by(|a, b| natural_compare(a, b));
        assert_eq!(names, vec!["page_1.jpg", "page_2.jpg", "page_10.jpg"]);
    }
}
