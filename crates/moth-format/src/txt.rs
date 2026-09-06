//! Plain-text parsing: encoding detection, decoding, and chapter splitting.

use std::path::Path;

use chardetng::EncodingDetector;
use encoding_rs::{Encoding, UTF_8, UTF_16BE, UTF_16LE};
use regex::Regex;

use crate::{Chapter, ParseError, ParsedBook};

/// Chapter heading markers, checked case-insensitively against a line. CJK
/// covers 第N章/节/回/卷/部/篇; Latin covers chapter/part/volume/book/section.
fn chapter_marker() -> Regex {
    Regex::new(r"(?i)^\s*(chapter|part|volume|book|section)\s+[0-9ivxlcdm]+")
        .expect("chapter marker")
}

fn cjk_marker() -> Regex {
    Regex::new(r"^\s*第\s*[0-9０-９一二三四五六七八九十百千零〇]+\s*[章节回卷部篇]\b?")
        .expect("cjk marker")
}

/// A horizontal rule used to separate sections, e.g. `----` or `* * *`.
fn separator() -> Regex {
    Regex::new(r"^\s*([-*_＝=~]|\* ?\* ?\*){3,}\s*$").expect("separator")
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
fn chunked(lines: &[&str], text: &str) -> Vec<(String, String)> {
    let mut chapters: Vec<(String, String)> = Vec::new();
    let mut start = 0;
    let mut length = 0usize;
    for (index, line) in lines.iter().enumerate() {
        length += line.len();
        if length >= MAX_CHAPTER_CHARS && index > start && !line.trim().is_empty() {
            chapters.push(("".to_owned(), lines[start..index].join("\n")));
            start = index;
            length = line.len();
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

/// Parse a plain-text book.
pub fn parse(path: &Path) -> Result<ParsedBook, ParseError> {
    let bytes = std::fs::read(path)?;
    let text = normalize(&decode(&bytes));
    if text.trim().is_empty() {
        return Err(ParseError::NoContent);
    }

    let chapters = split_and_render(&text, path);
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
    fn splits_by_separators_without_markers() {
        let text = "Part one\n\n----\n\nPart two";
        let chapters = split_chapters(text);
        assert_eq!(chapters.len(), 2);
    }

    #[test]
    fn renders_paragraph_html() {
        let html = render_html("Hello\n\nWorld");
        assert!(html.contains("<p>Hello</p>"));
        assert!(html.contains("<p>World</p>"));
    }
}
