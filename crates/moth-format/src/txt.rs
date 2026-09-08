//! Plain-text parsing: encoding detection, decoding, and chapter splitting.

use std::sync::OnceLock;
use std::{
    fs::File,
    io::{BufReader, Read},
    path::Path,
};

use chardetng::EncodingDetector;
use encoding_rs::{Encoding, UTF_8, UTF_16BE, UTF_16LE};
use regex::Regex;

use crate::{Chapter, ParseError, ParsedBook};

/// Chapter heading markers, checked case-insensitively against a line. CJK
/// covers 第N章/节/回/卷/部/篇; Latin covers chapter/part/volume/book/section.
fn chapter_marker() -> &'static Regex {
    static MARKER: OnceLock<Regex> = OnceLock::new();
    MARKER.get_or_init(|| {
        Regex::new(r"(?i)^\s*(chapter|part|volume|book|section)\s+[0-9ivxlcdm]+")
            .expect("chapter marker")
    })
}

fn cjk_marker() -> &'static Regex {
    static MARKER: OnceLock<Regex> = OnceLock::new();
    MARKER.get_or_init(|| {
        Regex::new(
            r"^\s*(?:第\s*[0-9０-９一二三四五六七八九十百千零〇]+\s*[章节回卷部篇]|卷\s*[0-9０-９一二三四五六七八九十百千零〇]+|楔子|序章|序言|终章|终回|番外(?:篇|章)?|后记|尾声|引子)",
        )
        .expect("cjk marker")
    })
}

/// A horizontal rule used to separate sections, e.g. `----` or `* * *`.
fn separator() -> &'static Regex {
    static SEPARATOR: OnceLock<Regex> = OnceLock::new();
    SEPARATOR.get_or_init(|| Regex::new(r"^\s*([-*_＝=~]|\* ?\* ?\*){3,}\s*$").expect("separator"))
}

/// A paragraph break is one or more blank lines.
const MAX_CHAPTER_CHARS: usize = 8_000;

fn detect_encoding(bytes: &[u8]) -> &'static Encoding {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return UTF_8;
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        return UTF_16LE;
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        return UTF_16BE;
    }
    let mut detector = EncodingDetector::new(chardetng::Iso2022JpDetection::Allow);
    let sample_len = bytes.len().min(64 * 1024);
    detector.feed(&bytes[..sample_len], true);
    detector.guess(None, chardetng::Utf8Detection::Allow)
}

fn decode(bytes: &[u8]) -> String {
    let encoding = detect_encoding(bytes);
    let (decoded, _, had_errors) = encoding.decode(bytes);
    if had_errors {
        // Fall back to UTF-8, replacing invalid sequences rather than failing
        // to render a book.
        String::from_utf8_lossy(bytes).into_owned()
    } else {
        decoded.into_owned()
    }
}

/// Decode a text file incrementally.  Encoding detection only needs a small
/// prefix; the remainder is fed through `encoding_rs`'s stateful decoder so a
/// multi-byte character split across read buffers is handled correctly.
fn decode_file(path: &Path, requested: Option<&str>) -> Result<String, ParseError> {
    const SAMPLE_SIZE: usize = 64 * 1024;
    const BUFFER_SIZE: usize = 64 * 1024;
    let file = File::open(path)?;
    let mut reader = BufReader::with_capacity(BUFFER_SIZE, file);
    let mut sample = vec![0_u8; SAMPLE_SIZE];
    let sample_len = reader.read(&mut sample)?;
    let sample = &sample[..sample_len];
    let encoding = requested
        .and_then(|label| match label.to_ascii_lowercase().as_str() {
            "utf-8" => Some(UTF_8),
            "gb18030" => Some(encoding_rs::GB18030),
            "gbk" => Some(encoding_rs::GBK),
            "big5" => Some(encoding_rs::BIG5),
            "utf-16le" => Some(UTF_16LE),
            "utf-16be" => Some(UTF_16BE),
            _ => None,
        })
        .unwrap_or_else(|| detect_encoding(sample));

    let mut decoder = encoding.new_decoder();
    let mut output = String::new();
    let mut feed = |bytes: &[u8], last: bool| {
        let mut offset = 0;
        while offset < bytes.len() {
            // UTF-8 output can be up to four times larger than the input.
            // Reserve enough room so the decoder normally consumes a whole
            // chunk, while retaining a loop for pathological replacement
            // expansion or an unexpectedly full String capacity.
            output.reserve(bytes[offset..].len().saturating_mul(4).saturating_add(4));
            let (_, read, _) = decoder.decode_to_string(&bytes[offset..], &mut output, last);
            if read == 0 {
                break;
            }
            offset += read;
        }
        if last {
            let _ = decoder.decode_to_string(&[], &mut output, true);
        }
    };
    feed(sample, false);

    let mut buffer = vec![0_u8; BUFFER_SIZE];
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            feed(&[], true);
            break;
        }
        feed(&buffer[..read], false);
    }
    Ok(output)
}

fn normalize(text: &str) -> String {
    let text = text.replace("\r\n", "\n").replace('\r', "\n");
    text.trim_matches('\u{feff}').to_owned()
}

/// Split decoded text into `(title, body)` chapters. Heading markers
/// (`第N章`, `Chapter N`, ...) start chapters; without them, separator rules
/// (`----`, `* * *`) split sections; with neither, the text is chunked into
/// fixed-size pieces so the reader can still paginate.
fn split_chapters(text: &str) -> Vec<(String, String)> {
    let lines: Vec<&str> = text.lines().collect();
    if lines.is_empty() {
        return Vec::new();
    }

    let mut heading_cuts: Vec<usize> = Vec::new();
    let mut separator_cuts: Vec<usize> = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if chapter_marker().is_match(trimmed) || cjk_marker().is_match(trimmed) {
            heading_cuts.push(index);
        } else if separator().is_match(line) {
            // The rule belongs to the section it ends; the next chapter starts
            // on the line after it.
            separator_cuts.push(index + 1);
        }
    }

    let use_headings = !heading_cuts.is_empty();
    let cuts = if use_headings {
        heading_cuts
    } else {
        separator_cuts
    };

    if cuts.is_empty() {
        return chunked(&lines, text);
    }

    let mut chapters: Vec<(String, String)> = Vec::new();

    // Content before the first cut: front matter for heading markers, a real
    // section for separator rules.
    if cuts[0] > 0 {
        let front = &lines[..cuts[0]];
        let body = strip_separators(&front.join("\n"));
        if !body.trim().is_empty() {
            let title = if use_headings {
                String::new()
            } else {
                first_non_empty(front).to_owned()
            };
            chapters.push((title, body));
        }
    }

    for (index, &start) in cuts.iter().enumerate() {
        let end = cuts.get(index + 1).copied().unwrap_or(lines.len());
        let slice = &lines[start..end];
        let body = strip_separators(&slice.join("\n"));
        if body.trim().is_empty() {
            continue;
        }
        let title = if use_headings {
            slice[0].trim().to_owned()
        } else {
            first_non_empty(slice).to_owned()
        };
        chapters.push((title, body));
    }

    if chapters.is_empty() {
        chapters.push(("".to_owned(), text.to_owned()));
    }
    chapters
}

fn first_non_empty<'a>(lines: &[&'a str]) -> &'a str {
    lines
        .iter()
        .find(|line| !line.trim().is_empty())
        .map(|line| line.trim())
        .unwrap_or("")
}

fn strip_separators(body: &str) -> String {
    body.lines()
        .filter(|line| !separator().is_match(line))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Fixed-size chunking for continuous prose without any section markers.
/// Lengths are counted in characters, not bytes, so CJK prose (3 bytes per
/// character in UTF-8) produces the same chapter sizes as Latin text.
fn chunked(lines: &[&str], text: &str) -> Vec<(String, String)> {
    let mut chapters: Vec<(String, String)> = Vec::new();
    let mut start = 0;
    let mut length = 0usize;
    for (index, line) in lines.iter().enumerate() {
        length += line.chars().count();
        if length >= MAX_CHAPTER_CHARS && index > start && !line.trim().is_empty() {
            chapters.push(("".to_owned(), lines[start..index].join("\n")));
            start = index;
            length = line.chars().count();
        }
    }
    if start < lines.len() {
        chapters.push(("".to_owned(), lines[start..].join("\n")));
    }
    if chapters.is_empty() {
        chapters.push(("".to_owned(), text.to_owned()));
    }
    chapters
}

/// Render plain text as an HTML fragment: paragraphs split on blank lines,
/// heading lines wrapped in a heading tag when they look like one.
fn render_html(body: &str) -> String {
    let mut out = String::with_capacity(body.len() + 64);
    for paragraph in body.split("\n\n") {
        let paragraph = paragraph.trim();
        if paragraph.is_empty() {
            continue;
        }
        let paragraph = escape_html(paragraph);
        if is_heading(&paragraph) {
            out.push_str("<h2>");
            out.push_str(&paragraph);
            out.push_str("</h2>");
        } else {
            out.push_str("<p>");
            // Preserve intentional line breaks inside a paragraph.
            let with_breaks = paragraph.replace('\n', "<br/>");
            out.push_str(&with_breaks);
            out.push_str("</p>");
        }
    }
    out
}

/// Render a normalized UTF-8 TXT slice only after it has been read from the
/// byte-range cache. Keeping this separate from indexing avoids storing a
/// complete HTML copy of a large novel in SQLite or the cache directory.
pub fn render_plain_html(body: &str) -> String {
    render_html(body)
}

fn is_heading(text: &str) -> bool {
    let text = text.trim();
    if text.len() > 60 || text.is_empty() {
        return false;
    }
    // A heading has no sentence-ending punctuation.
    !text.ends_with(['。', '.', '！', '!', '？', '?', ';', '；'])
        && (text.starts_with("第") || chapter_marker().is_match(text))
}

fn escape_html(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// Decode bytes with a specific encoding label (`utf-8`, `gb18030`, `gbk`,
/// `big5`, `utf-16le`, `utf-16be`). Unknown labels fall back to auto-detection
/// so a bad client value never fails a read.
pub fn decode_with(label: &str, bytes: &[u8]) -> String {
    let encoding = match label.to_ascii_lowercase().as_str() {
        "utf-8" => UTF_8,
        "gb18030" => encoding_rs::GB18030,
        "gbk" => encoding_rs::GBK,
        "big5" => encoding_rs::BIG5,
        "utf-16le" => UTF_16LE,
        "utf-16be" => UTF_16BE,
        _ => return decode(bytes),
    };
    let (decoded, _, had_errors) = encoding.decode(bytes);
    if had_errors {
        // Fall back rather than failing to render a book.
        decode(bytes)
    } else {
        decoded.into_owned()
    }
}

/// Parse a plain-text book.
pub fn parse(path: &Path) -> Result<ParsedBook, ParseError> {
    parse_with_encoding(path, None)
}

/// Parse a plain-text book, optionally decoding with an explicit encoding
/// label (see [`decode_with`]) instead of auto-detection.
pub fn parse_with_encoding(path: &Path, encoding: Option<&str>) -> Result<ParsedBook, ParseError> {
    let plain_chapters = normalized_chapters(path, encoding)?;
    let chapters = plain_chapters
        .iter()
        .map(|(title, body)| Chapter {
            title: title.clone(),
            content: render_html(body),
            base_dir: String::new(),
        })
        .collect::<Vec<_>>();
    // First title as the book title; the filename stem is the fallback.
    let has_named_chapter = chapters.iter().any(|chapter| !chapter.title.is_empty());
    let title = if has_named_chapter {
        chapters
            .iter()
            .find_map(|chapter| {
                if chapter.title.is_empty() {
                    None
                } else {
                    Some(chapter.title.clone())
                }
            })
            .unwrap_or_default()
    } else {
        path.file_stem()
            .map(|stem| stem.to_string_lossy().into_owned())
            .unwrap_or_default()
    };

    Ok(ParsedBook {
        format: crate::BookFormat::Txt,
        title,
        author: None,
        cover: None,
        chapters,
        resources: Vec::new(),
        pages: Vec::new(),
    })
}

/// Decode and split a TXT file into normalized UTF-8 chapter bodies. The
/// server uses this during a scan to build the byte-range cache; HTML is
/// rendered later for the specific chapter requested by the reader.
pub fn normalized_chapters(
    path: &Path,
    encoding: Option<&str>,
) -> Result<Vec<(String, String)>, ParseError> {
    let decoded = decode_file(path, encoding)?;
    let text = normalize(&decoded);
    if text.trim().is_empty() {
        return Err(ParseError::NoContent);
    }
    Ok(split_chapters(&text))
}

/// Split decoded text into chapters and render each as an HTML fragment.
/// Shared with the MOBI parser, whose decompressed text follows the same
/// conventions as plain text.
pub fn split_and_render(text: &str, path: &Path) -> Vec<Chapter> {
    let mut chapters: Vec<Chapter> = Vec::new();
    for (title, body) in split_chapters(text) {
        chapters.push(Chapter {
            title,
            content: render_html(&body),
            base_dir: String::new(),
        });
    }
    if chapters.is_empty() {
        chapters.push(Chapter {
            title: path
                .file_stem()
                .map(|stem| stem.to_string_lossy().into_owned())
                .unwrap_or_default(),
            content: render_html(text),
            base_dir: String::new(),
        });
    }
    chapters
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_utf8_and_cjk_chapters() {
        let text = "第一章 出发\n\n天亮了。\n\n第二章 路上\n\n他们继续走。";
        let chapters = split_chapters(text);
        assert_eq!(chapters.len(), 2);
        assert_eq!(chapters[0].0, "第一章 出发");
        assert!(chapters[0].1.contains("天亮了"));
    }

    #[test]
    fn detects_latin_chapters() {
        let text = "Chapter 1\n\nIt began.\n\nChapter 2: The Road\n\nThey walked.";
        let chapters = split_chapters(text);
        assert_eq!(chapters.len(), 2);
        assert_eq!(chapters[0].0, "Chapter 1");
        assert_eq!(chapters[1].0, "Chapter 2: The Road");
    }

    #[test]
    fn detects_common_cjk_special_chapters() {
        let text =
            "卷一 初遇\n\n甲\n\n楔子\n\n乙\n\n番外篇\n\n丙\n\n终章\n\n丁\n\n第一章出发\n\n戊";
        let chapters = split_chapters(text);
        assert_eq!(chapters.len(), 5);
        assert_eq!(chapters[0].0, "卷一 初遇");
        assert_eq!(chapters[1].0, "楔子");
        assert_eq!(chapters[2].0, "番外篇");
        assert_eq!(chapters[3].0, "终章");
        assert_eq!(chapters[4].0, "第一章出发");
    }

    #[test]
    fn splits_by_separators_without_markers() {
        let text = "Part one\n\n----\n\nPart two";
        let chapters = split_chapters(text);
        assert_eq!(chapters.len(), 2);
    }

    #[test]
    fn chunks_cjk_prose_by_character_count() {
        // 200 lines of 100 CJK characters (300 UTF-8 bytes) each. Counted in
        // characters this is 20,000 chars -> 3 chapters; counted in bytes it
        // would be 60,000 bytes -> 8 chapters.
        let line = "字".repeat(100);
        let text = std::iter::repeat_n(line.as_str(), 200)
            .collect::<Vec<_>>()
            .join("\n");
        let chapters = split_chapters(&text);
        assert_eq!(chapters.len(), 3);
        for chapter in &chapters[..2] {
            let chars = chapter.1.chars().count();
            assert!(
                (MAX_CHAPTER_CHARS - 200..MAX_CHAPTER_CHARS).contains(&chars),
                "unexpected chapter length: {chars}"
            );
        }
    }

    #[test]
    fn decodes_legacy_encodings_by_label() {
        // "中文" encoded in the three CJK encodings.
        let utf8 = "中文".as_bytes().to_vec();
        assert_eq!(decode_with("utf-8", &utf8), "中文");

        let gb18030 = [0xD6, 0xD0, 0xCE, 0xC4];
        assert_eq!(decode_with("gb18030", &gb18030), "中文");
        assert_eq!(decode_with("gbk", &gb18030), "中文");

        let big5 = [0xA4, 0xA4, 0xA4, 0xE5];
        assert_eq!(decode_with("big5", &big5), "中文");

        // BOM-free UTF-16LE with an explicit label.
        let utf16le = [0x2D, 0x4E, 0x87, 0x65];
        assert_eq!(decode_with("utf-16le", &utf16le), "中文");

        // An unknown label falls back to auto-detection (UTF-8 here).
        assert_eq!(decode_with("bogus", &utf8), "中文");
    }

    #[test]
    fn renders_paragraph_html() {
        let html = render_html("Hello\n\nWorld");
        assert!(html.contains("<p>Hello</p>"));
        assert!(html.contains("<p>World</p>"));
    }
}
