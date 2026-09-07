//! Book API handlers: the library shelf, reading content, and progress.

use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};

use axum::{
    Json,
    body::Body,
    extract::{Path as AxumPath, Query, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::Row;
use tokio::io::{AsyncReadExt, AsyncSeekExt, SeekFrom};
use tokio_util::io::ReaderStream;
use zip::ZipArchive;

use crate::auth::Authenticated;
use crate::error::AppError;
use crate::library::hash_file;
use crate::state::{AppState, TxtCacheKey};

const TXT_PARSER_VERSION: &str = "txt-v1";
static SNAPSHOT_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Serialize, Clone)]
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
    pub content_version: String,
    pub file_size: i64,
    /// Direct section for an ungrouped book. Series members inherit the
    /// section from their series and are exposed through the same field.
    pub section_id: Option<i64>,
    pub section_name: Option<String>,
    pub series_id: Option<i64>,
    pub series_name: Option<String>,
    pub series_order: Option<i64>,
    pub missing: bool,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cfi: Option<String>,
    /// TXT positions are tied to the decoded text. `auto` is the normalized
    /// value for the decoder selected during the library scan; other formats
    /// leave this field empty.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encoding: Option<String>,
}

#[derive(Deserialize)]
pub struct ProgressSyncBody {
    pub chapter_index: i64,
    pub page_index: i64,
    pub percent: f64,
    pub content_version: String,
    pub base_revision: i64,
    pub operation_id: String,
    pub cfi: Option<String>,
    pub encoding: Option<String>,
}

#[derive(Serialize)]
pub struct ProgressSyncResponse {
    pub progress: ProgressBody,
    pub revision: i64,
    pub conflict: bool,
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
    /// Server order of CBZ image entries. The browser uses this mapping when
    /// its locale-aware filename sort produces a different display order.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub pages: Vec<String>,
    pub progress: Option<ProgressBody>,
    pub content_version: String,
    pub file_size: i64,
    pub section_id: Option<i64>,
    pub section_name: Option<String>,
    pub series_id: Option<i64>,
    pub series_name: Option<String>,
    pub series_order: Option<i64>,
    pub missing: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parser_version: Option<String>,
}

#[derive(Serialize)]
pub struct ChapterContent {
    pub idx: i64,
    pub title: String,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encoding: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parser_version: Option<String>,
}

#[derive(Serialize)]
pub struct OfflineChapterManifest {
    pub idx: i64,
    pub title: String,
    pub size: i64,
    pub url: String,
}

#[derive(Serialize)]
pub struct OfflineManifest {
    pub id: i64,
    pub title: String,
    pub format: String,
    pub content_version: String,
    pub file_size: i64,
    pub cover_url: Option<String>,
    pub file_url: Option<String>,
    pub chapters: Vec<OfflineChapterManifest>,
    pub resource_urls: Vec<String>,
    pub encoding: Option<String>,
    pub parser_version: Option<String>,
}

#[derive(Serialize)]
pub struct ScanStatusResponse {
    pub scanning: bool,
    pub processed: u64,
    pub total: u64,
    pub errors: u64,
    pub message: String,
}

fn cover_url(id: i64, has_cover: bool, version: &str) -> Option<String> {
    has_cover.then(|| format!("/api/v1/books/{id}/cover?v={version}"))
}

pub async fn list_books(
    State(state): State<AppState>,
    _user: Authenticated,
    Query(query): Query<BookListQuery>,
) -> Result<Json<Vec<BookListItem>>, AppError> {
    if query.section_id.is_some() && query.series_id.is_some() {
        return Err(AppError::Validation(
            "Choose either a section or a series filter".to_owned(),
        ));
    }
    let books = fetch_book_items(&state.db, query.section_id, query.series_id).await?;
    Ok(Json(books))
}

/// Shared book projection used by the flat shelf and the organized shelf.
/// Keeping the projection in one place ensures both views expose identical
/// progress, cache-busting and classification metadata.
pub(crate) async fn fetch_book_items(
    db: &sqlx::SqlitePool,
    section_filter: Option<i64>,
    series_filter: Option<i64>,
) -> Result<Vec<BookListItem>, AppError> {
    let rows = sqlx::query(
        "SELECT b.id, b.title, b.author, b.format, b.has_cover, b.page_count, \
         b.parse_status, b.sha256, b.file_size, b.missing, b.series_order, \
         s.id AS series_id, s.name AS series_name, \
         COALESCE(s.section_id, b.section_id) AS section_id, \
         COALESCE(ss.name, ds.name) AS section_name, \
         COALESCE(CASE WHEN p.content_version IS NULL OR p.content_version = b.sha256 \
         THEN p.percent ELSE 0.0 END, 0.0) AS percent \
         FROM books b \
         LEFT JOIN series s ON s.id = b.series_id \
         LEFT JOIN sections ss ON ss.id = s.section_id \
         LEFT JOIN sections ds ON ds.id = b.section_id \
         LEFT JOIN reading_progress p ON p.book_id = b.id \
         WHERE (? IS NULL OR COALESCE(s.section_id, b.section_id) = ?) \
           AND (? IS NULL OR b.series_id = ?) \
         ORDER BY CASE WHEN ? IS NOT NULL THEN b.series_order END, b.title COLLATE NOCASE",
    )
    .bind(section_filter)
    .bind(section_filter)
    .bind(series_filter)
    .bind(series_filter)
    .bind(series_filter)
    .fetch_all(db)
    .await?;

    let mut books = Vec::with_capacity(rows.len());
    for row in rows {
        let id: i64 = row.try_get("id")?;
        let version: String = row.try_get("sha256")?;
        let has_cover: bool = row.try_get("has_cover")?;
        let series_id: Option<i64> = row.try_get("series_id")?;
        let series_order: i64 = row.try_get("series_order")?;
        books.push(BookListItem {
            id,
            title: row.try_get("title")?,
            author: row.try_get("author")?,
            format: row.try_get("format")?,
            has_cover,
            cover_url: cover_url(id, has_cover, &version),
            page_count: row.try_get("page_count")?,
            parse_status: row.try_get("parse_status")?,
            percent: row.try_get("percent")?,
            content_version: version,
            file_size: row.try_get("file_size")?,
            section_id: row.try_get("section_id")?,
            section_name: row.try_get("section_name")?,
            series_id,
            series_name: row.try_get("series_name")?,
            series_order: series_id.map(|_| series_order),
            missing: row.try_get("missing")?,
        });
    }
    Ok(books)
}

pub async fn get_book(
    State(state): State<AppState>,
    _user: Authenticated,
    AxumPath(id): AxumPath<i64>,
    Query(query): Query<ChapterQuery>,
) -> Result<Json<BookDetail>, AppError> {
    let book = sqlx::query(
        "SELECT b.title, b.author, b.format, b.relative_path, b.has_cover, b.page_count, \
         b.parse_status, b.parse_error, b.sha256, b.file_size, b.missing, b.series_order, \
         s.id AS series_id, s.name AS series_name, \
         COALESCE(s.section_id, b.section_id) AS section_id, \
         COALESCE(ss.name, ds.name) AS section_name \
         FROM books b LEFT JOIN series s ON s.id = b.series_id \
         LEFT JOIN sections ss ON ss.id = s.section_id \
         LEFT JOIN sections ds ON ds.id = b.section_id \
         WHERE b.id = ?",
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound)?;

    let title: String = book.try_get("title")?;
    let author: Option<String> = book.try_get("author")?;
    let format: String = book.try_get("format")?;
    let relative_path: String = book.try_get("relative_path")?;
    let has_cover: bool = book.try_get("has_cover")?;
    let page_count: i64 = book.try_get("page_count")?;
    let parse_status: String = book.try_get("parse_status")?;
    let parse_error: Option<String> = book.try_get("parse_error")?;
    let content_version: String = book.try_get("sha256")?;
    let file_size: i64 = book.try_get("file_size")?;
    let missing: bool = book.try_get("missing")?;
    let section_id: Option<i64> = book.try_get("section_id")?;
    let section_name: Option<String> = book.try_get("section_name")?;
    let series_id: Option<i64> = book.try_get("series_id")?;
    let series_name: Option<String> = book.try_get("series_name")?;
    let series_order_value: i64 = book.try_get("series_order")?;
    let series_order: Option<i64> = series_id.map(|_| series_order_value);

    let requested_encoding = requested_txt_encoding(&query);
    let chapters: Vec<ChapterInfo> = if format == "cbz" {
        Vec::new()
    } else if format == "txt"
        && let Some(encoding) = requested_encoding
    {
        if !valid_encoding(encoding) {
            return Err(AppError::Validation("Unsupported text encoding".to_owned()));
        }
        let path = ensure_snapshot(&state, id, &relative_path, &content_version).await?;
        cached_txt_chapters(&state, id, &content_version, encoding, path)
            .await?
            .iter()
            .enumerate()
            .map(|(idx, chapter)| ChapterInfo {
                idx: idx as i64,
                title: chapter.title.clone(),
                size: chapter.content.len() as i64,
            })
            .collect()
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
    let pages = if format == "cbz" {
        sqlx::query_scalar::<_, String>("SELECT path FROM pages WHERE book_id = ? ORDER BY idx")
            .bind(id)
            .fetch_all(&state.db)
            .await?
    } else {
        Vec::new()
    };

    let progress = sqlx::query_as::<
        _,
        (
            i64,
            i64,
            f64,
            i64,
            Option<String>,
            Option<String>,
            Option<String>,
        ),
    >(
        "SELECT chapter_index, page_index, percent, revision, content_version, cfi, encoding FROM reading_progress WHERE book_id = ?",
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await?
    .map(
        |(chapter_index, page_index, percent, revision, progress_version, cfi, encoding)| {
            ProgressBody {
                chapter_index,
                page_index,
                percent,
                revision: Some(revision),
                content_version: progress_version,
                cfi,
                encoding: stored_progress_encoding(&format, encoding),
            }
        },
    );

    Ok(Json(BookDetail {
        id,
        title,
        author,
        format: format.clone(),
        has_cover,
        cover_url: cover_url(id, has_cover, &content_version),
        page_count,
        parse_status,
        parse_error,
        chapters,
        pages,
        progress,
        content_version,
        file_size,
        section_id,
        section_name,
        series_id,
        series_name,
        series_order,
        missing,
        parser_version: (format == "txt").then(|| TXT_PARSER_VERSION.to_owned()),
    }))
}

pub async fn get_cover(
    State(state): State<AppState>,
    _user: Authenticated,
    AxumPath(id): AxumPath<i64>,
    Query(query): Query<VersionQuery>,
    headers: HeaderMap,
) -> Result<Response, AppError> {
    let current_version: String = sqlx::query_scalar("SELECT sha256 FROM books WHERE id = ?")
        .bind(id)
        .fetch_optional(&state.db)
        .await?
        .ok_or(AppError::NotFound)?;
    // Cover URLs include `?v=<sha256>`. Retain old versioned thumbnails for
    // an active reader while a rescan installs a new version, but ignore
    // malformed values so they cannot become filesystem path components.
    let version = query
        .v
        .filter(|value| is_content_version(value))
        .unwrap_or(current_version);
    let etag = format!("\"{version}\"");
    if if_match_misses(&headers, &etag) {
        return Ok((StatusCode::PRECONDITION_FAILED, [(header::ETAG, etag)]).into_response());
    }
    if if_none_match_hits(&headers, &etag) {
        return Ok((StatusCode::NOT_MODIFIED, [(header::ETAG, etag)]).into_response());
    }
    let path = state.cover_path(id, &version);
    let bytes = match tokio::fs::read(&path).await {
        Ok(bytes) => bytes,
        Err(_) => return Err(AppError::NotFound),
    };
    Ok((
        [
            (header::CONTENT_TYPE, "image/jpeg"),
            (header::CACHE_CONTROL, "public, max-age=86400"),
            (header::ETAG, etag.as_str()),
        ],
        bytes,
    )
        .into_response())
}

/// Describe every authenticated resource needed to make a book available
/// offline. The client may still choose its own download scheduling policy.
pub async fn get_offline_manifest(
    State(state): State<AppState>,
    _user: Authenticated,
    AxumPath(id): AxumPath<i64>,
    Query(query): Query<ChapterQuery>,
) -> Result<Json<OfflineManifest>, AppError> {
    let row = sqlx::query(
        "SELECT title, format, relative_path, has_cover, sha256, file_size FROM books WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound)?;
    let title: String = row.try_get("title")?;
    let format: String = row.try_get("format")?;
    let relative_path: String = row.try_get("relative_path")?;
    let has_cover: bool = row.try_get("has_cover")?;
    let content_version: String = row.try_get("sha256")?;
    let file_size: i64 = row.try_get("file_size")?;

    let requested_encoding = requested_txt_encoding(&query);
    let chapters = if format == "txt"
        && let Some(encoding) = requested_encoding
    {
        if !valid_encoding(encoding) {
            return Err(AppError::Validation("Unsupported text encoding".to_owned()));
        }
        let path = ensure_snapshot(&state, id, &relative_path, &content_version).await?;
        cached_txt_chapters(&state, id, &content_version, encoding, path)
            .await?
            .iter()
            .enumerate()
            .map(|(idx, chapter)| OfflineChapterManifest {
                idx: idx as i64,
                title: chapter.title.clone(),
                size: chapter.content.len() as i64,
                url: format!("/api/v1/books/{id}/chapter/{idx}?encoding={encoding}"),
            })
            .collect()
    } else {
        sqlx::query_as::<_, (i64, String, i64)>(
            "SELECT idx, title, length(content) FROM chapters WHERE book_id = ? ORDER BY idx",
        )
        .bind(id)
        .fetch_all(&state.db)
        .await?
        .into_iter()
        .map(|(idx, title, size)| OfflineChapterManifest {
            idx,
            title,
            size,
            url: format!("/api/v1/books/{id}/chapter/{idx}"),
        })
        .collect()
    };
    let resource_urls =
        sqlx::query_scalar::<_, i64>("SELECT idx FROM resources WHERE book_id = ? ORDER BY idx")
            .bind(id)
            .fetch_all(&state.db)
            .await?
            .into_iter()
            .map(|idx| format!("/api/v1/books/{id}/resource/{idx}"))
            .collect();

    Ok(Json(OfflineManifest {
        id,
        title,
        format: format.clone(),
        content_version: content_version.clone(),
        file_size,
        cover_url: cover_url(id, has_cover, &content_version),
        file_url: (format != "txt").then(|| format!("/api/v1/books/{id}/file")),
        chapters,
        resource_urls,
        encoding: (format == "txt").then(|| {
            query
                .encoding
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map_or_else(|| "auto".to_owned(), |value| value.to_ascii_lowercase())
        }),
        parser_version: (format == "txt").then(|| TXT_PARSER_VERSION.to_owned()),
    }))
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
    if size == 0 {
        return RangeParse::Unsatisfiable;
    }
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
    let (relative_path, format, version) = sqlx::query_as::<_, (String, String, String)>(
        "SELECT relative_path, format, sha256 FROM books WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound)?;

    let full_path = ensure_snapshot(&state, id, &relative_path, &version).await?;
    let metadata = tokio::fs::metadata(&full_path).await?;
    let size = metadata.len();
    let content_type = content_type_for_format(&format);
    let etag = format!("\"{version}\"");
    if if_match_misses(&headers, &etag) {
        return Ok((StatusCode::PRECONDITION_FAILED, [(header::ETAG, etag)]).into_response());
    }
    if if_none_match_hits(&headers, &etag) {
        return Ok((StatusCode::NOT_MODIFIED, [(header::ETAG, etag)]).into_response());
    }

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
                (header::ETAG, etag.clone()),
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
                    (header::ETAG, etag.clone()),
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
                    (header::ETAG, etag.clone()),
                ],
                Body::from_stream(ReaderStream::new(file)),
            )
                .into_response())
        }
    }
}

fn if_match_misses(headers: &HeaderMap, etag: &str) -> bool {
    headers
        .get(header::IF_MATCH)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.trim() != etag)
}

fn if_none_match_hits(headers: &HeaderMap, etag: &str) -> bool {
    headers
        .get(header::IF_NONE_MATCH)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.trim() == etag)
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

fn is_content_version(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[derive(Deserialize)]
pub struct ChapterQuery {
    /// Optional explicit encoding label for TXT books (`utf-8`, `gb18030`,
    /// `gbk`, `big5`, `utf-16le`, `utf-16be`). When set, the chapter is
    /// re-decoded from the original file with that encoding instead of the
    /// auto-detected one the scan used.
    pub encoding: Option<String>,
}

#[derive(Deserialize, Default)]
pub struct BookListQuery {
    pub section_id: Option<i64>,
    pub series_id: Option<i64>,
}

#[derive(Deserialize)]
pub struct VersionQuery {
    pub v: Option<String>,
}

/// Empty and `auto` select the encoding detected during the library scan.
/// Only an explicit supported label triggers a re-parse of the original file.
fn requested_txt_encoding(query: &ChapterQuery) -> Option<&str> {
    query
        .encoding
        .as_deref()
        .map(str::trim)
        .filter(|encoding| !encoding.is_empty() && !encoding.eq_ignore_ascii_case("auto"))
}

fn valid_encoding(label: &str) -> bool {
    matches!(
        label.to_ascii_lowercase().as_str(),
        "utf-8" | "gb18030" | "gbk" | "big5" | "utf-16le" | "utf-16be"
    )
}

/// Normalize a client supplied progress encoding. TXT locations must carry a
/// stable label so positions decoded with different codecs are never merged;
/// the other formats have no text codec and therefore always use `None`.
fn normalize_progress_encoding(
    format: &str,
    encoding: Option<&str>,
) -> Result<Option<String>, AppError> {
    if format != "txt" {
        return Ok(None);
    }
    let value = encoding.map(str::trim).unwrap_or("auto");
    if value.is_empty() || value.eq_ignore_ascii_case("auto") {
        return Ok(Some("auto".to_owned()));
    }
    if valid_encoding(value) {
        Ok(Some(value.to_ascii_lowercase()))
    } else {
        Err(AppError::Validation("Unsupported text encoding".to_owned()))
    }
}

/// Normalize a value read from the database for API responses and conflict
/// checks. Rows created before the encoding migration have NULL, which is the
/// legacy auto-detected TXT decoder.
fn stored_progress_encoding(format: &str, encoding: Option<String>) -> Option<String> {
    if format == "txt" {
        Some(
            encoding
                .filter(|value| !value.trim().is_empty())
                .map(|value| value.trim().to_ascii_lowercase())
                .unwrap_or_else(|| "auto".to_owned()),
        )
    } else {
        None
    }
}

async fn cached_txt_chapters(
    state: &AppState,
    book_id: i64,
    content_version: &str,
    encoding: &str,
    path: PathBuf,
) -> Result<Arc<Vec<moth_format::Chapter>>, AppError> {
    let key = TxtCacheKey {
        book_id,
        content_version: content_version.to_owned(),
        encoding: encoding.to_ascii_lowercase(),
        parser_version: TXT_PARSER_VERSION,
    };
    if let Some(chapters) = state.txt_cache.lock().await.get(&key).cloned() {
        return Ok(chapters);
    }
    let parser_encoding = key.encoding.clone();
    let parsed = tokio::task::spawn_blocking(move || {
        moth_format::txt::parse_with_encoding(&path, Some(&parser_encoding))
    })
    .await
    .map_err(|error| AppError::Io(std::io::Error::other(error)))?
    .map_err(|error| AppError::Io(std::io::Error::other(error.to_string())))?;
    let chapters = Arc::new(parsed.chapters);
    state
        .txt_cache
        .lock()
        .await
        .insert(key, Arc::clone(&chapters));
    Ok(chapters)
}

/// Make a verified immutable copy of a source file. The database hash is the
/// content version advertised to clients; if the source changed underneath a
/// scan, serving it with the old ETag would make Range readers mix bytes.
async fn ensure_snapshot(
    state: &AppState,
    book_id: i64,
    relative: &str,
    version: &str,
) -> Result<PathBuf, AppError> {
    let source = resolve_library_file(state, relative).await?;
    let snapshots = state.snapshots_dir().join(book_id.to_string());
    let target = snapshots.join(format!("{version}.bin"));
    let version = version.to_owned();
    let result = tokio::task::spawn_blocking(move || -> Result<PathBuf, String> {
        std::fs::create_dir_all(&snapshots).map_err(|error| error.to_string())?;

        // A snapshot is immutable once its SHA-256 matches the database
        // version. Reusing it avoids copying and hashing the read-only source
        // for every HTTP Range request. If it is missing or corrupt, rebuild
        // it atomically below.
        if target.is_file()
            && hash_file(&target)
                .map(|(hash, _)| hash == version)
                .unwrap_or(false)
        {
            return Ok(target);
        }

        let mut input = std::fs::File::open(&source).map_err(|error| error.to_string())?;
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let sequence = SNAPSHOT_COUNTER.fetch_add(1, Ordering::Relaxed);
        let temporary = snapshots.join(format!(".{}.{}.{}.tmp", version, nonce, sequence));
        // `create_new` keeps concurrent requests from ever writing the same
        // temporary file, even on filesystems whose clock has coarse
        // resolution.
        let mut output = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| error.to_string())?;
        let mut hasher = Sha256::new();
        let mut buffer = [0_u8; 128 * 1024];
        loop {
            let read = input.read(&mut buffer).map_err(|error| error.to_string())?;
            if read == 0 {
                break;
            }
            output
                .write_all(&buffer[..read])
                .map_err(|error| error.to_string())?;
            hasher.update(&buffer[..read]);
        }
        output.sync_all().map_err(|error| error.to_string())?;
        let actual = hex::encode(hasher.finalize());
        if actual != version {
            let _ = std::fs::remove_file(&temporary);
            return Err("content_changed".to_owned());
        }

        let existing_valid = if target.exists() {
            let mut file = std::fs::File::open(&target).map_err(|error| error.to_string())?;
            let mut digest = Sha256::new();
            let mut buf = [0_u8; 128 * 1024];
            loop {
                let read = file.read(&mut buf).map_err(|error| error.to_string())?;
                if read == 0 {
                    break;
                }
                digest.update(&buf[..read]);
            }
            hex::encode(digest.finalize()) == version
        } else {
            false
        };
        if existing_valid {
            let _ = std::fs::remove_file(&temporary);
        } else {
            match std::fs::rename(&temporary, &target) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    // Windows does not replace an existing destination. A
                    // competing writer either installed the same valid hash
                    // or left a corrupt partial target; retain/replace it
                    // accordingly.
                    let target_valid = std::fs::File::open(&target)
                        .ok()
                        .and_then(|mut file| {
                            let mut digest = Sha256::new();
                            let mut buf = [0_u8; 128 * 1024];
                            loop {
                                match file.read(&mut buf) {
                                    Ok(0) => break,
                                    Ok(read) => digest.update(&buf[..read]),
                                    Err(_) => return None,
                                }
                            }
                            Some(hex::encode(digest.finalize()) == version)
                        })
                        .unwrap_or(false);
                    if target_valid {
                        let _ = std::fs::remove_file(&temporary);
                    } else {
                        std::fs::remove_file(&target).map_err(|error| error.to_string())?;
                        std::fs::rename(&temporary, &target).map_err(|error| error.to_string())?;
                    }
                }
                Err(error) => return Err(error.to_string()),
            }
        }
        Ok(target)
    })
    .await
    .map_err(|error| AppError::Io(std::io::Error::other(error)))?;
    result.map_err(|error| {
        if error == "content_changed" {
            AppError::Conflict {
                code: "content_changed",
                message: "The source file changed; rescan the library before reading it",
            }
        } else {
            AppError::Io(std::io::Error::other(error))
        }
    })
}

/// Resolve a database relative path without allowing traversal or symlink
/// escapes from the configured read-only library directory.
async fn resolve_library_file(state: &AppState, relative: &str) -> Result<PathBuf, AppError> {
    let relative_path = Path::new(relative);
    if relative_path.is_absolute()
        || relative_path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        tracing::error!(%relative, "book path escaped library root");
        return Err(AppError::NotFound);
    }
    let root = tokio::fs::canonicalize(&state.config.books_dir)
        .await
        .map_err(|_| AppError::NotFound)?;
    let full = tokio::fs::canonicalize(root.join(relative_path))
        .await
        .map_err(|_| AppError::NotFound)?;
    if !full.starts_with(&root) || !full.is_file() {
        return Err(AppError::NotFound);
    }
    Ok(full)
}

pub async fn get_chapter(
    State(state): State<AppState>,
    _user: Authenticated,
    AxumPath((book_id, idx)): AxumPath<(i64, i64)>,
    Query(query): Query<ChapterQuery>,
    headers: HeaderMap,
) -> Result<Response, AppError> {
    let row = sqlx::query(
        "SELECT b.format, b.relative_path, b.sha256, b.missing, c.title, c.content \
         FROM chapters c JOIN books b ON b.id = c.book_id \
         WHERE c.book_id = ? AND c.idx = ?",
    )
    .bind(book_id)
    .bind(idx)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound)?;
    let format: String = row.try_get("format")?;
    let relative_path: String = row.try_get("relative_path")?;
    let content_version: String = row.try_get("sha256")?;
    let missing: bool = row.try_get("missing")?;
    // A missing source can still serve the last indexed chapter HTML. Only
    // explicit TXT re-decoding needs the original bytes and therefore still
    // requires a snapshot.
    let snapshot_path = if missing {
        None
    } else {
        Some(ensure_snapshot(&state, book_id, &relative_path, &content_version).await?)
    };
    let etag = format!("\"{content_version}\"");
    if if_match_misses(&headers, &etag) {
        return Ok((StatusCode::PRECONDITION_FAILED, [(header::ETAG, etag)]).into_response());
    }
    if if_none_match_hits(&headers, &etag) {
        return Ok((StatusCode::NOT_MODIFIED, [(header::ETAG, etag)]).into_response());
    }

    let requested_encoding = requested_txt_encoding(&query);
    let (title, content) = if format == "txt"
        && let Some(encoding) = requested_encoding
    {
        // The stored chapters were rendered with the detected encoding. For a
        // manual override, re-read the original file, re-decode it, and serve
        // the requested chapter so a wrong guess is fixed without a rescan.
        if !valid_encoding(encoding) {
            return Err(AppError::Validation("Unsupported text encoding".to_owned()));
        }
        let snapshot = snapshot_path.ok_or(AppError::NotFound)?;
        let book =
            cached_txt_chapters(&state, book_id, &content_version, encoding, snapshot).await?;
        let chapter = book.get(idx as usize).ok_or_else(|| AppError::NotFound)?;
        (chapter.title.clone(), chapter.content.clone())
    } else {
        (row.try_get("title")?, row.try_get("content")?)
    };

    Ok((
        [(header::ETAG, etag)],
        Json(ChapterContent {
            idx,
            title,
            content,
            encoding: (format == "txt").then(|| {
                requested_encoding
                    .map(str::to_ascii_lowercase)
                    .unwrap_or_else(|| "auto".to_owned())
            }),
            parser_version: (format == "txt").then(|| TXT_PARSER_VERSION.to_owned()),
        }),
    )
        .into_response())
}

pub async fn get_resource(
    State(state): State<AppState>,
    _user: Authenticated,
    AxumPath((book_id, idx)): AxumPath<(i64, i64)>,
    headers: HeaderMap,
) -> Result<Response, AppError> {
    let row = sqlx::query(
        "SELECT r.mime, r.path AS source_path, b.relative_path, b.sha256, b.missing FROM resources r JOIN books b ON b.id = r.book_id \
         WHERE r.book_id = ? AND r.idx = ?",
    )
    .bind(book_id)
    .bind(idx)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound)?;
    let mime: String = row.try_get("mime")?;
    let source_path: String = row.try_get("source_path")?;
    let relative_path: String = row.try_get("relative_path")?;
    let version: String = row.try_get("sha256")?;
    let missing: bool = row.try_get("missing")?;
    if !missing {
        ensure_snapshot(&state, book_id, &relative_path, &version).await?;
    }
    let etag = format!("\"{version}\"");
    if if_match_misses(&headers, &etag) {
        return Ok((StatusCode::PRECONDITION_FAILED, [(header::ETAG, etag)]).into_response());
    }
    if if_none_match_hits(&headers, &etag) {
        return Ok((StatusCode::NOT_MODIFIED, [(header::ETAG, etag)]).into_response());
    }
    let path = state.resource_path(book_id, &version, idx);
    let bytes = match tokio::fs::read(&path).await {
        Ok(bytes) => bytes,
        Err(_) => return Err(AppError::NotFound),
    };
    let mut response = (
        [
            (header::CONTENT_TYPE, mime),
            (header::ETAG, etag),
            (header::CACHE_CONTROL, "no-cache".to_owned()),
        ],
        bytes,
    )
        .into_response();
    // The client uses the original archive path to rebuild CSS dependencies
    // from cached blobs. Invalid/non-ASCII paths are simply omitted; the
    // numeric resource remains usable without dependency rewriting.
    if let Ok(value) = source_path.parse() {
        response.headers_mut().insert(
            header::HeaderName::from_static("x-moth-resource-path"),
            value,
        );
    }
    Ok(response)
}

pub async fn get_page(
    State(state): State<AppState>,
    _user: Authenticated,
    AxumPath((book_id, idx)): AxumPath<(i64, i64)>,
    headers: HeaderMap,
) -> Result<Response, AppError> {
    let (entry_name, mime, file_path, version, missing) =
        sqlx::query_as::<_, (String, String, String, String, bool)>(
            "SELECT p.path, p.mime, b.relative_path, b.sha256, b.missing FROM pages p \
         JOIN books b ON b.id = p.book_id WHERE p.book_id = ? AND p.idx = ?",
        )
        .bind(book_id)
        .bind(idx)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| AppError::NotFound)?;

    let etag = format!("\"{version}\"");
    if missing {
        return Err(AppError::NotFound);
    }
    let snapshot_path = ensure_snapshot(&state, book_id, &file_path, &version).await?;
    if if_match_misses(&headers, &etag) {
        return Ok((StatusCode::PRECONDITION_FAILED, [(header::ETAG, etag)]).into_response());
    }
    if if_none_match_hits(&headers, &etag) {
        return Ok((StatusCode::NOT_MODIFIED, [(header::ETAG, etag)]).into_response());
    }

    let bytes = tokio::task::spawn_blocking(move || read_cbz_page(&snapshot_path, &entry_name))
        .await
        .map_err(|error| AppError::Io(std::io::Error::other(error)))??;

    Ok((
        [
            (header::CONTENT_TYPE, mime),
            (header::ETAG, format!("\"{version}\"")),
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
    let format: Option<String> = sqlx::query_scalar("SELECT format FROM books WHERE id = ?")
        .bind(book_id)
        .fetch_optional(&state.db)
        .await?;
    let format = format.as_deref().unwrap_or("");
    let progress = sqlx::query_as::<
        _,
        (
            i64,
            i64,
            f64,
            i64,
            Option<String>,
            Option<String>,
            Option<String>,
        ),
    >(
        "SELECT chapter_index, page_index, percent, revision, content_version, cfi, encoding FROM reading_progress WHERE book_id = ?",
    )
    .bind(book_id)
    .fetch_optional(&state.db)
    .await?
    .map(
        |(chapter_index, page_index, percent, revision, content_version, cfi, encoding)| {
            ProgressBody {
                chapter_index,
                page_index,
                percent,
                revision: Some(revision),
                content_version,
                cfi,
                encoding: stored_progress_encoding(format, encoding),
            }
        },
    )
    .unwrap_or(ProgressBody {
        chapter_index: 0,
        page_index: 0,
        percent: 0.0,
        revision: None,
        content_version: None,
        cfi: None,
        encoding: None,
    });
    Ok(Json(progress))
}

pub async fn put_progress(
    State(state): State<AppState>,
    _user: Authenticated,
    AxumPath(book_id): AxumPath<i64>,
    Json(body): Json<ProgressBody>,
) -> Result<StatusCode, AppError> {
    let (version, format) =
        sqlx::query_as::<_, (String, String)>("SELECT sha256, format FROM books WHERE id = ?")
            .bind(book_id)
            .fetch_optional(&state.db)
            .await?
            .ok_or(AppError::NotFound)?;
    let encoding = normalize_progress_encoding(&format, body.encoding.as_deref())?;
    let now = time::OffsetDateTime::now_utc().unix_timestamp();
    let percent = body.percent.clamp(0.0, 100.0);
    sqlx::query(
        "INSERT INTO reading_progress (book_id, chapter_index, page_index, percent, updated_at, revision, content_version, cfi, encoding) \
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?) \
         ON CONFLICT(book_id) DO UPDATE SET chapter_index = excluded.chapter_index, \
         page_index = excluded.page_index, percent = excluded.percent, \
         updated_at = excluded.updated_at, revision = reading_progress.revision + 1, \
         content_version = excluded.content_version, cfi = excluded.cfi, encoding = excluded.encoding",
    )
    .bind(book_id)
    .bind(body.chapter_index.max(0))
    .bind(body.page_index.max(0))
    .bind(percent)
    .bind(now)
    .bind(version)
    .bind(body.cfi)
    .bind(encoding)
    .execute(&state.db)
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Merge an offline progress operation. The operation id makes retries
/// idempotent; when another device advanced the same book, the larger
/// percentage wins as agreed by the product contract.
pub async fn sync_progress(
    State(state): State<AppState>,
    _user: Authenticated,
    AxumPath(book_id): AxumPath<i64>,
    Json(body): Json<ProgressSyncBody>,
) -> Result<Json<ProgressSyncResponse>, AppError> {
    if body.operation_id.trim().is_empty() || body.operation_id.len() > 128 {
        return Err(AppError::Validation(
            "operation_id must contain 1–128 characters".to_owned(),
        ));
    }
    let (current_version, format) =
        sqlx::query_as::<_, (String, String)>("SELECT sha256, format FROM books WHERE id = ?")
            .bind(book_id)
            .fetch_optional(&state.db)
            .await?
            .ok_or(AppError::NotFound)?;
    if body.content_version != current_version {
        return Err(AppError::Conflict {
            code: "content_changed",
            message: "The book changed; download it again before syncing progress",
        });
    }
    let incoming_encoding = normalize_progress_encoding(&format, body.encoding.as_deref())?;

    let now = time::OffsetDateTime::now_utc().unix_timestamp();
    let mut tx = state.db.begin().await?;
    // Reserve the operation id inside the same write transaction as the
    // progress update. A plain read-then-insert check races when a browser
    // retries the same request concurrently and would turn an idempotent
    // operation into a unique-constraint error.
    let inserted = sqlx::query(
        "INSERT INTO progress_operations (book_id, operation_id, revision, created_at) VALUES (?, ?, 0, ?) \
         ON CONFLICT(book_id, operation_id) DO NOTHING",
    )
    .bind(book_id)
    .bind(&body.operation_id)
    .bind(now)
    .execute(&mut *tx)
    .await?
    .rows_affected()
        > 0;
    if !inserted {
        let progress = read_progress(&mut tx, book_id, current_version.clone(), &format).await?;
        tx.commit().await?;
        // A retry may arrive after a newer operation has advanced the book;
        // return the current revision so the client does not move its base
        // revision backwards to the operation's historical revision.
        let current_revision = progress.revision.unwrap_or(0);
        return Ok(Json(ProgressSyncResponse {
            progress,
            revision: current_revision,
            conflict: false,
        }));
    }

    let current = sqlx::query_as::<
        _,
        (
            i64,
            i64,
            f64,
            i64,
            Option<String>,
            Option<String>,
            Option<String>,
        ),
    >(
        "SELECT chapter_index, page_index, percent, revision, content_version, cfi, encoding FROM reading_progress WHERE book_id = ?",
    )
    .bind(book_id)
    .fetch_optional(&mut *tx)
    .await?;
    let (current_progress, current_revision, same_location_version) = match current {
        Some((chapter_index, page_index, percent, revision, version, cfi, encoding)) => {
            let same_content_version = version.as_deref() == Some(current_version.as_str());
            let current_encoding = stored_progress_encoding(&format, encoding);
            let same_encoding = current_encoding == incoming_encoding;
            (
                ProgressBody {
                    chapter_index: if same_content_version {
                        chapter_index
                    } else {
                        0
                    },
                    page_index: if same_content_version { page_index } else { 0 },
                    percent: if same_content_version { percent } else { 0.0 },
                    revision: Some(revision),
                    content_version: version,
                    cfi: if same_content_version && same_encoding {
                        cfi
                    } else {
                        None
                    },
                    encoding: current_encoding,
                },
                revision,
                same_content_version && same_encoding,
            )
        }
        None => (
            ProgressBody {
                chapter_index: 0,
                page_index: 0,
                percent: 0.0,
                revision: Some(0),
                content_version: Some(current_version.clone()),
                cfi: None,
                encoding: stored_progress_encoding(&format, None),
            },
            0,
            stored_progress_encoding(&format, None) == incoming_encoding,
        ),
    };
    let incoming = ProgressBody {
        chapter_index: body.chapter_index.max(0),
        page_index: body.page_index.max(0),
        percent: body.percent.clamp(0.0, 100.0),
        revision: None,
        content_version: Some(current_version.clone()),
        cfi: body.cfi.clone(),
        encoding: incoming_encoding,
    };
    let conflict = same_location_version && body.base_revision != current_revision;
    let winner = if conflict && incoming.percent <= current_progress.percent {
        current_progress
    } else {
        incoming
    };
    let revision = current_revision.saturating_add(1);
    sqlx::query(
        "INSERT INTO reading_progress (book_id, chapter_index, page_index, percent, updated_at, revision, content_version, cfi, encoding) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT(book_id) DO UPDATE SET chapter_index = excluded.chapter_index, page_index = excluded.page_index, \
         percent = excluded.percent, updated_at = excluded.updated_at, revision = excluded.revision, content_version = excluded.content_version, cfi = excluded.cfi, encoding = excluded.encoding",
    )
    .bind(book_id)
    .bind(winner.chapter_index)
    .bind(winner.page_index)
    .bind(winner.percent)
    .bind(now)
    .bind(revision)
    .bind(current_version.clone())
    .bind(winner.cfi.clone())
    .bind(winner.encoding.clone())
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "UPDATE progress_operations SET revision = ? WHERE book_id = ? AND operation_id = ?",
    )
    .bind(revision)
    .bind(book_id)
    .bind(&body.operation_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    let mut progress = winner;
    progress.revision = Some(revision);
    progress.content_version = Some(current_version);
    Ok(Json(ProgressSyncResponse {
        progress,
        revision,
        conflict,
    }))
}

async fn read_progress(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    book_id: i64,
    version: String,
    format: &str,
) -> Result<ProgressBody, AppError> {
    let row = sqlx::query_as::<
        _,
        (
            i64,
            i64,
            f64,
            i64,
            Option<String>,
            Option<String>,
            Option<String>,
        ),
    >(
        "SELECT chapter_index, page_index, percent, revision, content_version, cfi, encoding FROM reading_progress WHERE book_id = ?",
    )
    .bind(book_id)
    .fetch_optional(&mut **tx)
    .await?;
    Ok(row
        .map(
            |(chapter_index, page_index, percent, revision, content_version, cfi, encoding)| {
                ProgressBody {
                    chapter_index,
                    page_index,
                    percent,
                    revision: Some(revision),
                    content_version: content_version.or(Some(version.clone())),
                    cfi,
                    encoding: stored_progress_encoding(format, encoding),
                }
            },
        )
        .unwrap_or(ProgressBody {
            chapter_index: 0,
            page_index: 0,
            percent: 0.0,
            revision: Some(0),
            content_version: Some(version),
            cfi: None,
            encoding: stored_progress_encoding(format, None),
        }))
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
            parse_range("bytes=-1", 0),
            RangeParse::Unsatisfiable
        ));
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
