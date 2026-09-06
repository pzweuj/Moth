//! Book API handlers: the library shelf, reading content, and progress.

use std::io::Read;
use std::path::Path;

use axum::{
    Json,
    body::Body,
    extract::{Path as AxumPath, Query, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use sqlx::Row;
use tokio::io::{AsyncReadExt, AsyncSeekExt, SeekFrom};
use tokio_util::io::ReaderStream;
use zip::ZipArchive;

use crate::auth::Authenticated;
use crate::error::AppError;
use crate::state::AppState;

#[derive(Serialize)]
pub struct BookListItem {
    pub id: i64,
    pub title: String,
    pub author: Option<String>,
    pub format: String,
    pub has_cover: bool,
    pub cover_url: Option<String>,
    pub page_count: i64,
    pub parse_status: String,
    pub percent: f64,
}

#[derive(Serialize)]
pub struct ChapterInfo {
    pub idx: i64,
    pub title: String,
    /// Byte size of the rendered chapter content, for client-side progress
    /// estimation (each chapter is a section in the paginator).
    pub size: i64,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct ProgressBody {
    pub chapter_index: i64,
    pub page_index: i64,
    pub percent: f64,
}

#[derive(Serialize)]
pub struct BookDetail {
    pub id: i64,
    pub title: String,
    pub author: Option<String>,
    pub format: String,
    pub has_cover: bool,
    pub cover_url: Option<String>,
    pub page_count: i64,
    pub parse_status: String,
    pub parse_error: Option<String>,
    pub chapters: Vec<ChapterInfo>,
    pub progress: Option<ProgressBody>,
}

#[derive(Serialize)]
pub struct ChapterContent {
    pub idx: i64,
    pub title: String,
    pub content: String,
}

#[derive(Serialize)]
pub struct ScanStatusResponse {
    pub scanning: bool,
    pub processed: u64,
    pub total: u64,
    pub errors: u64,
    pub message: String,
}

fn cover_url(id: i64, has_cover: bool) -> Option<String> {
    has_cover.then(|| format!("/api/v1/books/{id}/cover"))
}

pub async fn list_books(
    State(state): State<AppState>,
    _user: Authenticated,
) -> Result<Json<Vec<BookListItem>>, AppError> {
    let rows = sqlx::query(
        "SELECT b.id, b.title, b.author, b.format, b.has_cover, b.page_count, \
         b.parse_status, COALESCE(p.percent, 0.0) AS percent \
         FROM books b LEFT JOIN reading_progress p ON p.book_id = b.id \
         ORDER BY b.title COLLATE NOCASE",
    )
    .fetch_all(&state.db)
    .await?;

    let mut books = Vec::with_capacity(rows.len());
    for row in rows {
        let id: i64 = row.try_get("id")?;
        books.push(BookListItem {
            id,
            title: row.try_get("title")?,
            author: row.try_get("author")?,
            format: row.try_get("format")?,
            has_cover: row.try_get("has_cover")?,
            cover_url: cover_url(id, row.try_get("has_cover")?),
            page_count: row.try_get("page_count")?,
            parse_status: row.try_get("parse_status")?,
            percent: row.try_get("percent")?,
        });
    }
    Ok(Json(books))
}

pub async fn get_book(
    State(state): State<AppState>,
    _user: Authenticated,
    AxumPath(id): AxumPath<i64>,
) -> Result<Json<BookDetail>, AppError> {
    let book = sqlx::query(
        "SELECT title, author, format, has_cover, page_count, parse_status, parse_error \
         FROM books WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound)?;

    let title: String = book.try_get("title")?;
    let author: Option<String> = book.try_get("author")?;
    let format: String = book.try_get("format")?;
    let has_cover: bool = book.try_get("has_cover")?;
    let page_count: i64 = book.try_get("page_count")?;
    let parse_status: String = book.try_get("parse_status")?;
    let parse_error: Option<String> = book.try_get("parse_error")?;

    let chapters: Vec<ChapterInfo> = if format == "cbz" {
        Vec::new()
    } else {
        sqlx::query_as::<_, (i64, String, i64)>(
            "SELECT idx, title, length(content) FROM chapters WHERE book_id = ? ORDER BY idx",
        )
        .bind(id)
        .fetch_all(&state.db)
        .await?
        .into_iter()
        .map(|(idx, title, size)| ChapterInfo { idx, title, size })
        .collect()
    };

    let progress = sqlx::query_as::<_, (i64, i64, f64)>(
        "SELECT chapter_index, page_index, percent FROM reading_progress WHERE book_id = ?",
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await?
    .map(|(chapter_index, page_index, percent)| ProgressBody {
        chapter_index,
        page_index,
        percent,
    });

    Ok(Json(BookDetail {
        id,
        title,
        author,
        format,
        has_cover,
        cover_url: cover_url(id, has_cover),
        page_count,
        parse_status,
        parse_error,
        chapters,
        progress,
    }))
}

pub async fn get_cover(
    State(state): State<AppState>,
    _user: Authenticated,
    AxumPath(id): AxumPath<i64>,
) -> Result<Response, AppError> {
    let path = state.covers_dir().join(format!("{id}.jpg"));
    let bytes = match tokio::fs::read(&path).await {
        Ok(bytes) => bytes,
        Err(_) => return Err(AppError::NotFound),
    };
    Ok((
        [
            (header::CONTENT_TYPE, "image/jpeg"),
            (header::CACHE_CONTROL, "public, max-age=86400"),
        ],
        bytes,
    )
        .into_response())
}

/// A single byte range, inclusive endpoints, parsed from a `Range` header.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ByteRange {
    start: u64,
    end: u64,
}

/// How a `Range` header should be handled. A request that cannot be satisfied
/// is answered with `416`; a header we choose not to honor (multi-range,
/// malformed) falls back to the full `200` response.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RangeParse {
    Satisfiable(ByteRange),
    Unsatisfiable,
    Ignore,
}

/// Parse a single `bytes=a-b` range against a known size.
fn parse_range(header: &str, size: u64) -> RangeParse {
    let Some(spec) = header.strip_prefix("bytes=") else {
        return RangeParse::Ignore;
    };
    // Only single ranges are handled; a multi-range request falls back to the
    // full representation, which RFC 7233 permits.
    if spec.contains(',') {
        return RangeParse::Ignore;
    }
    let Some((start_str, end_str)) = spec.split_once('-') else {
        return RangeParse::Ignore;
    };

    let parse = |value: &str| -> Option<u64> {
        if value.is_empty() {
            return None;
        }
        value.parse::<u64>().ok()
    };

    let start = parse(start_str);
    let end = parse(end_str);
    let range = match (start, end) {
        // `bytes=start-end`
        (Some(start), Some(end)) => {
            if start > end || start >= size {
                return RangeParse::Unsatisfiable;
            }
            ByteRange {
                start,
                end: end.min(size - 1),
            }
        }
        // `bytes=start-`
        (Some(start), None) => {
            if start >= size {
                return RangeParse::Unsatisfiable;
            }
            ByteRange {
                start,
                end: size - 1,
            }
        }
        // `bytes=-N`: the last N bytes.
        (None, Some(suffix)) => {
            if suffix == 0 {
                return RangeParse::Unsatisfiable;
            }
            ByteRange {
                start: size.saturating_sub(suffix),
                end: size - 1,
            }
        }
        (None, None) => return RangeParse::Ignore,
    };
    RangeParse::Satisfiable(range)
}

/// Serve a raw book file with HTTP Range support, for `zip.js HttpRangeReader`
/// and client-side readers. Bytes are streamed so large archives are never
/// fully buffered server-side.
pub async fn get_file(
    State(state): State<AppState>,
    _user: Authenticated,
    AxumPath(id): AxumPath<i64>,
    headers: HeaderMap,
) -> Result<Response, AppError> {
    let (relative_path, format) = sqlx::query_as::<_, (String, String)>(
        "SELECT relative_path, format FROM books WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound)?;

    let full_path = state.config.books_dir.join(&relative_path);
    let metadata = tokio::fs::metadata(&full_path).await?;
    let size = metadata.len();
    let content_type = content_type_for_format(&format);

    let range = headers
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok());

    let Some(range) = range else {
        let file = tokio::fs::File::open(&full_path).await?;
        return Ok((
            [
                (header::CONTENT_TYPE, content_type.to_owned()),
                (header::ACCEPT_RANGES, "bytes".to_owned()),
                (header::CONTENT_LENGTH, size.to_string()),
                (header::CACHE_CONTROL, "no-cache".to_owned()),
            ],
            Body::from_stream(ReaderStream::new(file)),
        )
            .into_response());
    };

    match parse_range(range, size) {
        RangeParse::Satisfiable(ByteRange { start, end }) => {
            let mut file = tokio::fs::File::open(&full_path).await?;
            file.seek(SeekFrom::Start(start)).await?;
            let length = end - start + 1;
            let body = Body::from_stream(ReaderStream::new(file.take(length)));
            Ok((
                StatusCode::PARTIAL_CONTENT,
                [
                    (header::CONTENT_TYPE, content_type.to_owned()),
                    (header::ACCEPT_RANGES, "bytes".to_owned()),
                    (header::CONTENT_RANGE, format!("bytes {start}-{end}/{size}")),
                    (header::CONTENT_LENGTH, length.to_string()),
                    (header::CACHE_CONTROL, "no-cache".to_owned()),
                ],
                body,
            )
                .into_response())
        }
        RangeParse::Unsatisfiable => Ok((
            StatusCode::RANGE_NOT_SATISFIABLE,
            [
                (header::ACCEPT_RANGES, "bytes".to_owned()),
                (header::CONTENT_RANGE, format!("bytes */{size}")),
            ],
            (),
        )
            .into_response()),
        RangeParse::Ignore => {
            let file = tokio::fs::File::open(&full_path).await?;
            Ok((
                [
                    (header::CONTENT_TYPE, content_type.to_owned()),
                    (header::ACCEPT_RANGES, "bytes".to_owned()),
                    (header::CONTENT_LENGTH, size.to_string()),
                    (header::CACHE_CONTROL, "no-cache".to_owned()),
                ],
                Body::from_stream(ReaderStream::new(file)),
            )
                .into_response())
        }
    }
}

fn content_type_for_format(format: &str) -> &'static str {
    match format {
        "epub" => "application/epub+zip",
        "mobi" => "application/x-mobipocket-ebook",
        "cbz" => "application/vnd.comicbook+zip",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

#[derive(Deserialize)]
pub struct ChapterQuery {
    /// Optional explicit encoding label for TXT books (`utf-8`, `gb18030`,
    /// `gbk`, `big5`, `utf-16le`, `utf-16be`). When set, the chapter is
    /// re-decoded from the original file with that encoding instead of the
    /// auto-detected one the scan used.
    pub encoding: Option<String>,
}

pub async fn get_chapter(
    State(state): State<AppState>,
    _user: Authenticated,
    AxumPath((book_id, idx)): AxumPath<(i64, i64)>,
    Query(query): Query<ChapterQuery>,
) -> Result<Json<ChapterContent>, AppError> {
    let row = sqlx::query(
        "SELECT b.format, b.relative_path, c.title, c.content \
         FROM chapters c JOIN books b ON b.id = c.book_id \
         WHERE c.book_id = ? AND c.idx = ?",
    )
    .bind(book_id)
    .bind(idx)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound)?;
    let format: String = row.try_get("format")?;

    let (title, content) = if format == "txt" && query.encoding.is_some() {
        // The stored chapters were rendered with the detected encoding. For a
        // manual override, re-read the original file, re-decode it, and serve
        // the requested chapter so a wrong guess is fixed without a rescan.
        let relative_path: String = row.try_get("relative_path")?;
        let path = state.config.books_dir.join(&relative_path);
        let encoding = query.encoding.clone().unwrap_or_default();
        let book = tokio::task::spawn_blocking(move || {
            moth_format::txt::parse_with_encoding(&path, Some(&encoding))
        })
        .await
        .map_err(|error| AppError::Io(std::io::Error::other(error)))?
        .map_err(|error| AppError::Io(std::io::Error::other(error.to_string())))?;
        let chapter = book
            .chapters
            .get(idx as usize)
            .ok_or_else(|| AppError::NotFound)?;
        (chapter.title.clone(), chapter.content.clone())
    } else {
        (row.try_get("title")?, row.try_get("content")?)
    };

    Ok(Json(ChapterContent {
        idx,
        title,
        content,
    }))
}

pub async fn get_resource(
    State(state): State<AppState>,
    _user: Authenticated,
    AxumPath((book_id, idx)): AxumPath<(i64, i64)>,
) -> Result<Response, AppError> {
    let row = sqlx::query("SELECT mime FROM resources WHERE book_id = ? AND idx = ?")
        .bind(book_id)
        .bind(idx)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| AppError::NotFound)?;
    let mime: String = row.try_get("mime")?;
    let path = state
        .resources_dir()
        .join(book_id.to_string())
        .join(idx.to_string());
    let bytes = match tokio::fs::read(&path).await {
        Ok(bytes) => bytes,
        Err(_) => return Err(AppError::NotFound),
    };
    Ok((
        [
            (header::CONTENT_TYPE, mime),
            (
                header::CACHE_CONTROL,
                "public, max-age=31536000, immutable".to_owned(),
            ),
        ],
        bytes,
    )
        .into_response())
}

pub async fn get_page(
    State(state): State<AppState>,
    _user: Authenticated,
    AxumPath((book_id, idx)): AxumPath<(i64, i64)>,
) -> Result<Response, AppError> {
    let (entry_name, mime, file_path) = sqlx::query_as::<_, (String, String, String)>(
        "SELECT p.path, p.mime, b.relative_path FROM pages p \
         JOIN books b ON b.id = p.book_id WHERE p.book_id = ? AND p.idx = ?",
    )
    .bind(book_id)
    .bind(idx)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound)?;

    let full_path = state.config.books_dir.join(file_path);
    let bytes = tokio::task::spawn_blocking(move || read_cbz_page(&full_path, &entry_name))
        .await
        .map_err(|error| AppError::Io(std::io::Error::other(error)))??;

    Ok((
        [
            (header::CONTENT_TYPE, mime),
            (
                header::CACHE_CONTROL,
                "public, max-age=31536000, immutable".to_owned(),
            ),
        ],
        bytes,
    )
        .into_response())
}

fn read_cbz_page(path: &Path, entry_name: &str) -> Result<Vec<u8>, AppError> {
    let file = std::fs::File::open(path)?;
    let mut archive =
        ZipArchive::new(file).map_err(|error| AppError::Archive(error.to_string()))?;
    let mut entry = archive
        .by_name(entry_name)
        .map_err(|error| AppError::Archive(error.to_string()))?;
    let mut bytes = Vec::with_capacity(entry.size() as usize);
    entry.read_to_end(&mut bytes).map_err(AppError::Io)?;
    Ok(bytes)
}

pub async fn get_progress(
    State(state): State<AppState>,
    _user: Authenticated,
    AxumPath(book_id): AxumPath<i64>,
) -> Result<Json<ProgressBody>, AppError> {
    let progress = sqlx::query_as::<_, (i64, i64, f64)>(
        "SELECT chapter_index, page_index, percent FROM reading_progress WHERE book_id = ?",
    )
    .bind(book_id)
    .fetch_optional(&state.db)
    .await?
    .map(|(chapter_index, page_index, percent)| ProgressBody {
        chapter_index,
        page_index,
        percent,
    })
    .unwrap_or(ProgressBody {
        chapter_index: 0,
        page_index: 0,
        percent: 0.0,
    });
    Ok(Json(progress))
}

pub async fn put_progress(
    State(state): State<AppState>,
    _user: Authenticated,
    AxumPath(book_id): AxumPath<i64>,
    Json(body): Json<ProgressBody>,
) -> Result<StatusCode, AppError> {
    let exists: bool =
        sqlx::query_scalar::<_, i64>("SELECT EXISTS(SELECT 1 FROM books WHERE id = ?)")
            .bind(book_id)
            .fetch_one(&state.db)
            .await?
            != 0;
    if !exists {
        return Err(AppError::NotFound);
    }
    let now = time::OffsetDateTime::now_utc().unix_timestamp();
    let percent = body.percent.clamp(0.0, 100.0);
    sqlx::query(
        "INSERT INTO reading_progress (book_id, chapter_index, page_index, percent, updated_at) \
         VALUES (?, ?, ?, ?, ?) \
         ON CONFLICT(book_id) DO UPDATE SET chapter_index = excluded.chapter_index, \
         page_index = excluded.page_index, percent = excluded.percent, \
         updated_at = excluded.updated_at",
    )
    .bind(book_id)
    .bind(body.chapter_index.max(0))
    .bind(body.page_index.max(0))
    .bind(percent)
    .bind(now)
    .execute(&state.db)
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn scan_status(
    State(state): State<AppState>,
    _user: Authenticated,
) -> Result<Json<ScanStatusResponse>, AppError> {
    let status = state.scan_status.lock().await.clone();
    Ok(Json(ScanStatusResponse {
        scanning: status.scanning,
        processed: status.processed,
        total: status.total,
        errors: status.errors,
        message: status.message,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn satisfied(header: &str, size: u64) -> Option<ByteRange> {
        match parse_range(header, size) {
            RangeParse::Satisfiable(range) => Some(range),
            _ => None,
        }
    }

    #[test]
    fn parses_closed_ranges() {
        assert_eq!(
            satisfied("bytes=0-4", 100),
            Some(ByteRange { start: 0, end: 4 })
        );
        assert_eq!(
            satisfied("bytes=95-200", 100),
            Some(ByteRange { start: 95, end: 99 })
        );
        assert_eq!(
            satisfied("bytes=10-10", 100),
            Some(ByteRange { start: 10, end: 10 })
        );
    }

    #[test]
    fn parses_open_ended_and_suffix_ranges() {
        assert_eq!(
            satisfied("bytes=90-", 100),
            Some(ByteRange { start: 90, end: 99 })
        );
        assert_eq!(
            satisfied("bytes=-10", 100),
            Some(ByteRange { start: 90, end: 99 })
        );
        // A suffix longer than the file covers the whole file.
        assert_eq!(
            satisfied("bytes=-500", 100),
            Some(ByteRange { start: 0, end: 99 })
        );
    }

    #[test]
    fn rejects_unsatisfiable_ranges() {
        assert!(matches!(
            parse_range("bytes=100-", 100),
            RangeParse::Unsatisfiable
        ));
        assert!(matches!(
            parse_range("bytes=100-200", 100),
            RangeParse::Unsatisfiable
        ));
        assert!(matches!(
            parse_range("bytes=5-2", 100),
            RangeParse::Unsatisfiable
        ));
        assert!(matches!(
            parse_range("bytes=-0", 100),
            RangeParse::Unsatisfiable
        ));
    }

    #[test]
    fn ignores_other_or_malformed_headers() {
        assert!(matches!(parse_range("items=0-1", 100), RangeParse::Ignore));
        assert!(matches!(
            parse_range("bytes=0-1,4-5", 100),
            RangeParse::Ignore
        ));
        assert!(matches!(parse_range("bytes=abc", 100), RangeParse::Ignore));
        assert!(matches!(parse_range("bytes=-", 100), RangeParse::Ignore));
    }
}
