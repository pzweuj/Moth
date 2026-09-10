//! Plain-text parsing: encoding detection, decoding, and chapter splitting.

use std::sync::OnceLock;
use std::{
    fs::File,
    io::{BufRead, BufReader, BufWriter, Read, Seek, SeekFrom, Write},
    path::Path,
};

use chardetng::EncodingDetector;
use encoding_rs::{Encoding, UTF_8, UTF_16BE, UTF_16LE};
use regex::Regex;

use crate::ParseError;

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

/// A chapter index generated while scanning a TXT file. The chapter body is
/// written to the UTF-8 cache and is deliberately not retained here.
#[derive(Debug, Clone)]
pub struct TextChapter {
    pub title: String,
    pub byte_start: i64,
    pub byte_end: i64,
    pub character_count: i64,
}

/// Result of the streaming TXT scanner. `title` is the first non-empty
/// heading, when one exists; callers use the filename as a fallback.
#[derive(Debug, Clone)]
pub struct TextIndex {
    pub title: Option<String>,
    pub chapters: Vec<TextChapter>,
}

/// Translate decoded text to the normalized line format used by the reader
/// without retaining the whole file. A CR at the end of one decoder chunk is
/// held until the next chunk so CRLF pairs are emitted as a single LF.
struct NewlineNormalizer<W> {
    inner: W,
    pending_cr: bool,
}

impl<W: Write> NewlineNormalizer<W> {
    fn new(inner: W) -> Self {
        Self {
            inner,
            pending_cr: false,
        }
    }

    fn finish(mut self) -> std::io::Result<W> {
        if self.pending_cr {
            self.inner.write_all(b"\n")?;
            self.pending_cr = false;
        }
        self.inner.flush()?;
        Ok(self.inner)
    }
}

impl<W: Write> Write for NewlineNormalizer<W> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        let mut start = 0;
        let mut index = 0;
        if self.pending_cr {
            if bytes.first() == Some(&b'\n') {
                self.inner.write_all(b"\n")?;
                start = 1;
                index = 1;
            } else {
                self.inner.write_all(b"\n")?;
            }
            self.pending_cr = false;
        }

        while index < bytes.len() {
            if bytes[index] == b'\r' {
                if start < index {
                    self.inner.write_all(&bytes[start..index])?;
                }
                self.pending_cr = true;
                index += 1;
                start = index;
                if index < bytes.len() {
                    self.inner.write_all(b"\n")?;
                    if bytes[index] == b'\n' {
                        index += 1;
                        start = index;
                    }
                    self.pending_cr = false;
                }
            } else {
                index += 1;
            }
        }
        if !self.pending_cr && start < bytes.len() {
            self.inner.write_all(&bytes[start..])?;
        }
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

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

/// Decode a text file into a writer while keeping only the decoder buffers in
/// memory. The output is UTF-8 with CRLF/CR normalized to LF.
fn decode_file_to_writer(
    path: &Path,
    requested: Option<&str>,
    writer: impl Write,
) -> Result<(), ParseError> {
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
    let mut normalizer = NewlineNormalizer::new(writer);
    let mut output = String::with_capacity(BUFFER_SIZE * 2);
    let mut feed = |bytes: &[u8], last: bool| -> Result<(), ParseError> {
        let mut offset = 0;
        while offset < bytes.len() {
            output.clear();
            let (_, read, _) = decoder.decode_to_string(&bytes[offset..], &mut output, last);
            normalizer.write_all(output.as_bytes())?;
            if read == 0 {
                break;
            }
            offset += read;
        }
        if last {
            output.clear();
            let _ = decoder.decode_to_string(&[], &mut output, true);
            normalizer.write_all(output.as_bytes())?;
        }
        Ok(())
    };

    feed(sample, false)?;
    let mut buffer = vec![0_u8; BUFFER_SIZE];
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            feed(&[], true)?;
            break;
        }
        feed(&buffer[..read], false)?;
    }
    let _ = normalizer.finish()?;
    Ok(())
}

fn normalize(text: &str) -> String {
    let text = text.replace("\r\n", "\n").replace('\r', "\n");
    text.trim_matches('\u{feff}').to_owned()
}

/// Split decoded text into `(title, body)` chapters. Heading markers
/// (`第N章`, `Chapter N`, ...) start chapters; without them, separator rules
/// (`----`, `* * *`) split sections; with neither, the text is chunked into
/// fixed-size pieces so the reader can still paginate. When a chapter has a
/// title, that title is removed from the body so the reader can render it
/// exactly once and keep its UTF-16 locator stable.
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
            chapters.push((String::new(), body));
        }
    }

    for (index, &start) in cuts.iter().enumerate() {
        let end = cuts.get(index + 1).copied().unwrap_or(lines.len());
        let slice = &lines[start..end];
        let (title, body_start) = if use_headings {
            (slice[0].trim().to_owned(), 1)
        } else {
            (String::new(), 0)
        };
        let body = strip_separators(&slice[body_start..].join("\n"))
            .trim_matches('\n')
            .to_owned();
        if body.trim().is_empty() && title.is_empty() {
            continue;
        }
        chapters.push((title, body));
    }

    if chapters.is_empty() {
        chapters.push(("".to_owned(), text.to_owned()));
    }
    chapters
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

fn for_each_normalized_line<F>(path: &Path, mut callback: F) -> Result<(), ParseError>
where
    F: FnMut(&str, bool, bool) -> Result<(), ParseError>,
{
    let file = File::open(path)?;
    let mut reader = BufReader::with_capacity(64 * 1024, file);
    let mut current = String::new();
    let mut next = String::new();
    if reader.read_line(&mut current)? == 0 {
        return Ok(());
    }
    let mut first = true;
    loop {
        next.clear();
        let has_next = reader.read_line(&mut next)? > 0;
        let is_last = !has_next;
        let had_newline = current.ends_with('\n');
        if had_newline {
            current.pop();
        }
        if current.ends_with('\r') {
            current.pop();
        }
        if first {
            let trimmed = current.trim_start_matches('\u{feff}').to_owned();
            current = trimmed;
        }
        if is_last {
            let trimmed = current.trim_end_matches('\u{feff}').to_owned();
            current = trimmed;
        }

        // `str::lines` does not produce an extra empty line when trimming a
        // final BOM turns the final, unterminated line into the newline that
        // precedes it (for example: "text\n<BOM>").
        let bom_only_tail = is_last && !had_newline && current.is_empty();
        if !bom_only_tail {
            callback(&current, first, is_last)?;
        }
        if is_last {
            break;
        }
        std::mem::swap(&mut current, &mut next);
        first = false;
    }
    Ok(())
}

fn scan_flags(path: &Path) -> Result<(bool, bool, bool), ParseError> {
    let mut has_heading = false;
    let mut has_separator = false;
    let mut has_non_whitespace = false;
    for_each_normalized_line(path, |line, _, _| {
        let trimmed = line.trim();
        has_non_whitespace |= !trimmed.is_empty();
        if chapter_marker().is_match(trimmed) || cjk_marker().is_match(trimmed) {
            has_heading = true;
        }
        if separator().is_match(line) {
            has_separator = true;
        }
        Ok(())
    })?;
    Ok((has_heading, has_separator, has_non_whitespace))
}

fn normalized_file_ends_with_newline(path: &Path) -> Result<bool, ParseError> {
    let mut file = File::open(path)?;
    let mut end = file.metadata()?.len();
    let mut bom = [0_u8; 3];
    while end >= 3 {
        file.seek(SeekFrom::Start(end - 3))?;
        file.read_exact(&mut bom)?;
        if bom == [0xef, 0xbb, 0xbf] {
            end -= 3;
        } else {
            break;
        }
    }
    if end == 0 {
        return Ok(false);
    }
    file.seek(SeekFrom::Start(end - 1))?;
    let mut byte = [0_u8; 1];
    file.read_exact(&mut byte)?;
    Ok(byte[0] == b'\n')
}

struct CacheWriter {
    inner: BufWriter<File>,
    offset: i64,
    has_chapter: bool,
}

impl CacheWriter {
    fn new(file: File) -> Self {
        Self {
            inner: BufWriter::with_capacity(64 * 1024, file),
            offset: 0,
            has_chapter: false,
        }
    }

    fn position(&self) -> i64 {
        self.offset
    }

    fn write_bytes(&mut self, bytes: &[u8]) -> Result<(), ParseError> {
        self.inner.write_all(bytes)?;
        let length = i64::try_from(bytes.len()).map_err(|_| {
            ParseError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "TXT cache is too large",
            ))
        })?;
        self.offset = self.offset.checked_add(length).ok_or_else(|| {
            ParseError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "TXT cache is too large",
            ))
        })?;
        Ok(())
    }

    fn write_newlines(&mut self, mut count: usize) -> Result<(), ParseError> {
        const CHUNK: usize = 1024;
        let newlines = [b'\n'; CHUNK];
        while count > 0 {
            let amount = count.min(CHUNK);
            self.write_bytes(&newlines[..amount])?;
            count -= amount;
        }
        Ok(())
    }

    fn rollback(&mut self, position: i64) -> Result<(), ParseError> {
        self.inner.flush()?;
        let file = self.inner.get_mut();
        file.set_len(u64::try_from(position).map_err(|_| {
            ParseError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "invalid TXT cache offset",
            ))
        })?)?;
        file.seek(SeekFrom::Start(u64::try_from(position).map_err(|_| {
            ParseError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "invalid TXT cache offset",
            ))
        })?))?;
        self.offset = position;
        Ok(())
    }

    fn finish(mut self) -> Result<(), ParseError> {
        self.inner.flush()?;
        Ok(())
    }
}

struct OpenChapter {
    checkpoint: i64,
    body_start: i64,
    title: String,
    trim_edges: bool,
    has_line: bool,
    pending_empty: usize,
    has_non_whitespace: bool,
    character_count: i64,
}

impl OpenChapter {
    fn start(cache: &mut CacheWriter, title: String, trim_edges: bool) -> Result<Self, ParseError> {
        let checkpoint = cache.position();
        // Match the legacy cache layout: one newline separates adjacent
        // chapter bodies, while that separator stays outside both ranges.
        if cache.has_chapter {
            cache.write_bytes(b"\n")?;
        }
        let body_start = cache.position();
        Ok(Self {
            checkpoint,
            body_start,
            title,
            trim_edges,
            has_line: false,
            pending_empty: 0,
            has_non_whitespace: false,
            character_count: 0,
        })
    }

    fn push_line(&mut self, cache: &mut CacheWriter, line: &str) -> Result<(), ParseError> {
        self.has_non_whitespace |= !line.trim().is_empty();
        let line_characters = i64::try_from(line.encode_utf16().count()).map_err(|_| {
            ParseError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "TXT chapter is too large",
            ))
        })?;
        self.add_characters(line_characters)?;

        if !self.trim_edges {
            if self.has_line {
                cache.write_bytes(b"\n")?;
                self.add_characters(1)?;
            }
            cache.write_bytes(line.as_bytes())?;
            self.has_line = true;
            return Ok(());
        }

        if line.is_empty() {
            self.pending_empty = self.pending_empty.saturating_add(1);
            return Ok(());
        }
        if self.has_line {
            let newlines = self.pending_empty.saturating_add(1);
            cache.write_newlines(newlines)?;
            self.add_characters(i64::try_from(newlines).map_err(|_| {
                ParseError::Io(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "TXT chapter is too large",
                ))
            })?)?;
        }
        cache.write_bytes(line.as_bytes())?;
        self.has_line = true;
        self.pending_empty = 0;
        Ok(())
    }

    fn add_characters(&mut self, amount: i64) -> Result<(), ParseError> {
        self.character_count = self.character_count.checked_add(amount).ok_or_else(|| {
            ParseError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "TXT chapter is too large",
            ))
        })?;
        Ok(())
    }

    fn finish(
        self,
        cache: &mut CacheWriter,
        index: &mut Vec<TextChapter>,
    ) -> Result<(), ParseError> {
        let include = !self.title.trim().is_empty() || self.has_non_whitespace;
        if !include {
            cache.rollback(self.checkpoint)?;
            return Ok(());
        }
        let title_characters = i64::try_from(self.title.encode_utf16().count()).map_err(|_| {
            ParseError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "TXT title is too large",
            ))
        })?;
        let title_break = i64::from(!self.title.trim().is_empty());
        let character_count = title_characters
            .checked_add(title_break)
            .and_then(|value| value.checked_add(self.character_count))
            .ok_or_else(|| {
                ParseError::Io(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "TXT chapter is too large",
                ))
            })?;
        index.push(TextChapter {
            title: self.title,
            byte_start: self.body_start,
            byte_end: cache.position(),
            character_count,
        });
        cache.has_chapter = true;
        Ok(())
    }
}

fn build_indexed_cache(normalized: &Path, target: &Path) -> Result<TextIndex, ParseError> {
    let (has_heading, has_separator, has_non_whitespace) = scan_flags(normalized)?;
    if !has_non_whitespace {
        return Err(ParseError::NoContent);
    }

    let file = File::create(target)?;
    let mut cache = CacheWriter::new(file);
    let mut chapters = Vec::new();
    let mut open: Option<OpenChapter> = None;
    let mut seen_separator = false;
    let mut line_index = 0usize;
    let mut chunk_start = 0usize;
    let mut chunk_length = 0usize;

    for_each_normalized_line(normalized, |line, _, _| {
        if has_heading {
            let trimmed = line.trim();
            if chapter_marker().is_match(trimmed) || cjk_marker().is_match(trimmed) {
                if let Some(chapter) = open.take() {
                    chapter.finish(&mut cache, &mut chapters)?;
                }
                open = Some(OpenChapter::start(&mut cache, trimmed.to_owned(), true)?);
            } else if !separator().is_match(line) {
                if open.is_none() {
                    open = Some(OpenChapter::start(&mut cache, String::new(), false)?);
                }
                if let Some(chapter) = open.as_mut() {
                    chapter.push_line(&mut cache, line)?;
                }
            }
        } else if has_separator {
            if separator().is_match(line) {
                if let Some(chapter) = open.take() {
                    chapter.finish(&mut cache, &mut chapters)?;
                }
                seen_separator = true;
            } else {
                if open.is_none() {
                    open = Some(OpenChapter::start(
                        &mut cache,
                        String::new(),
                        seen_separator,
                    )?);
                }
                if let Some(chapter) = open.as_mut() {
                    chapter.push_line(&mut cache, line)?;
                }
            }
        } else {
            let line_length = line.chars().count();
            let would_exceed = chunk_length.saturating_add(line_length) >= MAX_CHAPTER_CHARS;
            if would_exceed && line_index > chunk_start && !line.trim().is_empty() {
                if let Some(chapter) = open.take() {
                    chapter.finish(&mut cache, &mut chapters)?;
                }
                chunk_start = line_index;
                chunk_length = 0;
            }
            if open.is_none() {
                open = Some(OpenChapter::start(&mut cache, String::new(), false)?);
            }
            if let Some(chapter) = open.as_mut() {
                chapter.push_line(&mut cache, line)?;
            }
            chunk_length = chunk_length.saturating_add(line_length);
        }
        line_index = line_index.saturating_add(1);
        Ok(())
    })?;
    if let Some(chapter) = open.take() {
        chapter.finish(&mut cache, &mut chapters)?;
    }
    if chapters.is_empty() {
        // The legacy splitter falls back to the complete normalized text if
        // it sees only separator lines. Rebuild that small edge case as a
        // single streamed chapter so the public semantics stay unchanged.
        cache.rollback(0)?;
        let mut fallback = OpenChapter::start(&mut cache, String::new(), false)?;
        for_each_normalized_line(normalized, |line, _, _| {
            fallback.push_line(&mut cache, line)
        })?;
        if normalized_file_ends_with_newline(normalized)? {
            cache.write_bytes(b"\n")?;
            fallback.add_characters(1)?;
        }
        fallback.finish(&mut cache, &mut chapters)?;
    }
    cache.finish()?;

    if chapters.is_empty() {
        return Err(ParseError::NoContent);
    }
    let title = chapters
        .iter()
        .find_map(|chapter| (!chapter.title.trim().is_empty()).then(|| chapter.title.clone()));
    Ok(TextIndex { title, chapters })
}

/// Decode and index a TXT file while writing its normalized UTF-8 cache to
/// `target`. Only chapter metadata is retained in memory; chapter bodies are
/// streamed through temporary files and read later by byte range.
pub fn write_indexed_cache(
    source: &Path,
    requested_encoding: Option<&str>,
    target: &Path,
) -> Result<TextIndex, ParseError> {
    if let Some(parent) = target
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        std::fs::create_dir_all(parent)?;
    }
    let normalized = target.with_extension("normalized.tmp");
    let cache_temp = target.with_extension("utf8.tmp");
    let legacy_cache_temp = target.with_extension("tmp");
    let _ = std::fs::remove_file(&normalized);
    let _ = std::fs::remove_file(&cache_temp);
    let _ = std::fs::remove_file(&legacy_cache_temp);
    let result = (|| {
        let file = File::create(&normalized)?;
        let writer = BufWriter::with_capacity(64 * 1024, file);
        decode_file_to_writer(source, requested_encoding, writer)?;
        let index = build_indexed_cache(&normalized, &cache_temp)?;
        if target.exists() {
            std::fs::remove_file(target)?;
        }
        std::fs::rename(&cache_temp, target)?;
        Ok(index)
    })();
    let _ = std::fs::remove_file(&normalized);
    if result.is_err() {
        let _ = std::fs::remove_file(&cache_temp);
    }
    result
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
        assert!(chapters.iter().all(|(title, _)| title.is_empty()));
        assert!(chapters[0].1.contains("Part one"));
        assert!(chapters[1].1.contains("Part two"));
    }

    #[test]
    fn removes_only_recognized_heading_from_body() {
        let text = "第一章 标题\n\n正文第一行\n正文第二行";
        let chapters = split_chapters(text);
        assert_eq!(
            chapters,
            vec![(
                "第一章 标题".to_owned(),
                "正文第一行\n正文第二行".to_owned()
            )]
        );
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

    fn assert_streaming_matches_legacy(source: &Path, encoding: Option<&str>) {
        let dir = tempfile::tempdir().expect("temporary directory");
        let target = dir.path().join("book.utf8");
        let index = write_indexed_cache(source, encoding, &target).expect("streaming index");
        let chapters = normalized_chapters(source, encoding).expect("legacy chapters");
        let mut expected_cache = Vec::new();
        let mut expected_ranges = Vec::new();
        let mut offset = 0_i64;
        for (idx, (title, body)) in chapters.iter().enumerate() {
            if idx > 0 {
                expected_cache.push(b'\n');
                offset += 1;
            }
            let start = offset;
            expected_cache.extend_from_slice(body.as_bytes());
            offset += i64::try_from(body.len()).expect("body length");
            let character_count = i64::try_from(
                title.encode_utf16().count()
                    + usize::from(!title.trim().is_empty())
                    + body.encode_utf16().count(),
            )
            .expect("character count");
            expected_ranges.push((title.as_str(), start, offset, character_count));
        }
        assert_eq!(std::fs::read(&target).expect("cache"), expected_cache);
        assert_eq!(index.chapters.len(), expected_ranges.len());
        for (chapter, (title, start, end, character_count)) in
            index.chapters.iter().zip(expected_ranges)
        {
            assert_eq!(chapter.title, title);
            assert_eq!(chapter.byte_start, start);
            assert_eq!(chapter.byte_end, end);
            assert_eq!(chapter.character_count, character_count);
        }
        assert_eq!(
            index.title.as_deref(),
            chapters
                .iter()
                .find_map(|(title, _)| (!title.trim().is_empty()).then_some(title.as_str()))
        );
    }

    #[test]
    fn streams_heading_separator_and_chunked_caches() {
        let dir = tempfile::tempdir().expect("temporary directory");
        let heading = dir.path().join("heading.txt");
        std::fs::write(
            &heading,
            "\u{feff}第一章 标题\r\n\r\n第二章\r正文\r\n第三章\r\n结尾",
        )
        .expect("heading fixture");
        assert_streaming_matches_legacy(&heading, None);

        let separator = dir.path().join("separator.txt");
        std::fs::write(&separator, "第一段\n\n----\n\n第二段\n\n***\n\n第三段")
            .expect("separator fixture");
        assert_streaming_matches_legacy(&separator, None);

        let separator_only = dir.path().join("separator-only.txt");
        std::fs::write(&separator_only, "----\n\n").expect("separator-only fixture");
        assert_streaming_matches_legacy(&separator_only, None);

        let chunked = dir.path().join("chunked.txt");
        std::fs::write(&chunked, "字".repeat(MAX_CHAPTER_CHARS + 100)).expect("chunked fixture");
        assert_streaming_matches_legacy(&chunked, None);
    }

    #[test]
    fn streams_explicit_utf16_without_loading_the_source() {
        let dir = tempfile::tempdir().expect("temporary directory");
        let source = dir.path().join("utf16.txt");
        let mut bytes = vec![0xff, 0xfe];
        bytes.extend("第一章\n正文".encode_utf16().flat_map(u16::to_le_bytes));
        std::fs::write(&source, bytes).expect("UTF-16 fixture");
        assert_streaming_matches_legacy(&source, Some("utf-16le"));
    }

    #[test]
    fn streams_characters_split_across_decode_buffers() {
        let dir = tempfile::tempdir().expect("temporary directory");
        let source = dir.path().join("split.txt");
        let text = format!("{}界", "a".repeat(64 * 1024 - 1));
        std::fs::write(&source, text).expect("UTF-8 fixture");
        assert_streaming_matches_legacy(&source, Some("utf-8"));
    }
}
