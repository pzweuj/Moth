//! Publication API and format-specific reader endpoints.

use std::{
    collections::HashMap,
    io::{Cursor, Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, OnceLock},
};

use axum::{
    Json,
    body::Body,
    extract::{Path as AxumPath, Query, State},
    http::{HeaderMap, StatusCode, header},
    response::Response,
};
use quick_xml::{Reader as XmlReader, events::Event};
use regex::Regex;
use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio_stream::wrappers::ReceiverStream;
use tokio_util::io::ReaderStream;
use zip::{ZipArchive, ZipWriter, write::SimpleFileOptions};

use crate::{
    auth::Authenticated,
    error::AppError,
    library::{is_hidden_shelf, now_unix},
    state::{AppState, ConversionState},
};

const CONTENT_ADAPTER_VERSION: &str = "core-v2";
const IMAGE_MAX_BYTES: usize = 16 * 1024 * 1024;
const IMAGE_MAX_ALLOC: u64 = 64 * 1024 * 1024;
const IMAGE_MAX_DIMENSION: u32 = 8192;
const IMAGE_MAX_PIXELS: u64 = 16_000_000;
const DIMENSION_HEADER_MAX_BYTES: u64 = 1024 * 1024;

#[cfg(test)]
mod stream_tests;

#[derive(Debug, Clone, Serialize)]
pub struct PublicationSummary {
    pub id: i64,
    pub title: String,
    pub author: Option<String>,
    pub source_format: String,
    pub reader_format: String,
    pub cover_url: Option<String>,
    pub progress: f64,
    pub content_version: String,
    pub file_size: i64,
    pub filename: String,
    pub directory_path: String,
    pub parse_status: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ChapterInfo {
    pub idx: i64,
    pub title: String,
    pub character_count: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct PageInfo {
    pub idx: i64,
    pub path: String,
    pub mime: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
pub struct BookDetail {
    #[serde(flatten)]
    pub summary: PublicationSummary,
    pub chapters: Vec<ChapterInfo>,
    pub pages: Vec<PageInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ReadingPosition {
    #[serde(rename = "epub")]
    Epub {
        href: String,
        cfi: String,
        progress: f64,
    },
    #[serde(rename = "txt")]
    Txt {
        chapter_index: i64,
        character_offset: i64,
        encoding: String,
        progress: f64,
    },
    #[serde(rename = "cbz")]
    Cbz {
        page_index: i64,
        page_progress: f64,
        progress: f64,
    },
}

impl ReadingPosition {
    fn progress_raw(&self) -> f64 {
        match self {
            Self::Epub { progress, .. }
            | Self::Txt { progress, .. }
            | Self::Cbz { progress, .. } => *progress,
        }
    }
    fn progress(&self) -> f64 {
        self.progress_raw().clamp(0.0, 1.0)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProgressBody {
    pub content_version: String,
    pub position: ReadingPosition,
}

#[derive(Debug, Serialize)]
pub struct HomeResponse {
    pub continue_reading: Vec<PublicationSummary>,
    pub directories: Vec<HomeDirectoryPreview>,
    pub hidden_directories: Vec<HiddenDirectorySummary>,
}

#[derive(Debug, Serialize)]
pub struct HiddenDirectorySummary {
    pub name: String,
    pub path: String,
}

#[derive(Debug, Serialize)]
pub struct HomeDirectoryPreview {
    pub name: String,
    pub path: String,
    pub series: Vec<HomeSeriesPreview>,
}

#[derive(Debug, Serialize)]
pub struct HomeSeriesPreview {
    pub name: String,
    pub path: String,
    pub publication_count: i64,
    pub representative: Option<PublicationSummary>,
}

#[derive(Debug, Serialize)]
pub struct ConversionResponse {
    pub status: String,
    pub file_url: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ChapterQuery {
    pub encoding: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
pub struct BookQuery {
    pub encoding: Option<String>,
}

#[derive(Debug, Serialize)]
struct ChapterResponse {
    idx: i64,
    title: String,
    content: String,
    text: String,
    encoding: String,
    content_version: String,
    character_count: i64,
}

pub async fn home(
    State(state): State<AppState>,
    _user: Authenticated,
) -> Result<Json<HomeResponse>, AppError> {
    let (directories, hidden_directories) =
        fetch_home_directories(&state.db, &state.config.books_dir).await?;
    let hidden_paths = hidden_directories
        .iter()
        .map(|directory| directory.path.as_str())
        .collect::<Vec<_>>();
    let continue_reading = fetch_continue_reading(&state.db, &hidden_paths).await?;
    Ok(Json(HomeResponse {
        continue_reading,
        directories,
        hidden_directories,
    }))
}

struct SeriesCandidate {
    preview: HomeSeriesPreview,
    active_at: Option<i64>,
}

async fn fetch_home_directories(
    db: &SqlitePool,
    books_root: &std::path::Path,
) -> Result<(Vec<HomeDirectoryPreview>, Vec<HiddenDirectorySummary>), AppError> {
    let Some(root_id) =
        sqlx::query_scalar::<_, i64>("SELECT id FROM directories WHERE relative_path=''")
            .fetch_optional(db)
            .await?
    else {
        return Ok((Vec::new(), Vec::new()));
    };
    let categories = sqlx::query(
        "SELECT id,name,relative_path FROM directories WHERE parent_id=? ORDER BY name COLLATE NOCASE",
    )
    .bind(root_id)
    .fetch_all(db)
    .await?;
    let mut output = Vec::with_capacity(categories.len());
    let mut hidden = Vec::new();
    for category in categories {
        let category_id: i64 = category.try_get("id")?;
        let category_path: String = category.try_get("relative_path")?;
        let category_name: String = category.try_get("name")?;
        if is_hidden_shelf(books_root, &category_path) {
            hidden.push(HiddenDirectorySummary {
                name: category_name,
                path: category_path,
            });
            continue;
        }
        // Rank series in SQL so a large shelf never loads every series (or
        // every book in every series) just to discard all but the four cards
        // shown on the home page. `active_at` is NULL for series without an
        // in-progress book; SQLite sorts those after real timestamps when
        // ordering descending.
        let series_rows = sqlx::query(
            "SELECT d.id,d.name,d.relative_path,COUNT(p.id) AS publication_count,
                    MAX(CASE WHEN r.progress>0 AND r.progress<1 THEN r.updated_at END) AS active_at
             FROM directories d
             LEFT JOIN publications p ON p.directory_id=d.id
             LEFT JOIN reading_progress r ON r.publication_id=p.id
             WHERE d.parent_id=?
             GROUP BY d.id
             ORDER BY active_at DESC, d.name COLLATE NOCASE
             LIMIT 4",
        )
        .bind(category_id)
        .fetch_all(db)
        .await?;
        let mut candidates = Vec::with_capacity(series_rows.len());
        for series in series_rows {
            let series_id: i64 = series.try_get("id")?;
            let publication_count: i64 = series.try_get("publication_count")?;
            let representative = fetch_series_representative(db, series_id).await?;
            let active_at: Option<i64> = series.try_get("active_at")?;
            candidates.push(SeriesCandidate {
                preview: HomeSeriesPreview {
                    name: series.try_get("name")?,
                    path: series.try_get("relative_path")?,
                    publication_count,
                    representative,
                },
                active_at,
            });
        }
        order_home_series(&mut candidates);
        output.push(HomeDirectoryPreview {
            name: category_name,
            path: category_path,
            series: candidates
                .into_iter()
                .map(|candidate| candidate.preview)
                .collect(),
        });
    }
    Ok((output, hidden))
}

async fn fetch_continue_reading(
    db: &SqlitePool,
    hidden_paths: &[&str],
) -> Result<Vec<PublicationSummary>, AppError> {
    let mut sql = String::from(
        "SELECT p.id,p.title,p.author,p.format,p.sha256,p.file_size,p.filename,p.parse_status,p.has_cover,d.relative_path,COALESCE(r.progress,0.0) AS progress FROM publications p JOIN directories d ON d.id=p.directory_id JOIN reading_progress r ON r.publication_id=p.id WHERE r.progress>0 AND r.progress<1",
    );
    for _ in hidden_paths {
        // Match path segments exactly. Using `LIKE` here would make SQLite's
        // default ASCII case folding hide a sibling such as `Books` when the
        // marker is on `books`, and would require escaping user directory
        // names as patterns.
        sql.push_str(
            " AND NOT (d.relative_path=? OR substr(d.relative_path,1,length(?) + 1)=? || '/')",
        );
    }
    sql.push_str(" ORDER BY r.updated_at DESC, p.title COLLATE NOCASE LIMIT 12");
    let mut query = sqlx::query(&sql);
    for hidden in hidden_paths {
        query = query.bind(*hidden).bind(*hidden).bind(*hidden);
    }
    let rows = query.fetch_all(db).await?;
    rows.iter()
        .map(summary_from_row)
        .collect::<Result<Vec<_>, sqlx::Error>>()
        .map_err(AppError::from)
}

async fn fetch_series_representative(
    db: &SqlitePool,
    series_id: i64,
) -> Result<Option<PublicationSummary>, AppError> {
    let row = sqlx::query(
        "SELECT p.id,p.title,p.author,p.format,p.sha256,p.file_size,p.filename,p.parse_status,p.has_cover,d.relative_path,COALESCE(r.progress,0.0) AS progress FROM publications p JOIN directories d ON d.id=p.directory_id LEFT JOIN reading_progress r ON r.publication_id=p.id WHERE p.directory_id=? ORDER BY CASE WHEN p.parse_status='ok' THEN 0 ELSE 1 END, p.filename COLLATE NOCASE, p.title COLLATE NOCASE LIMIT 1",
    )
    .bind(series_id)
    .fetch_optional(db)
    .await?;
    row.map(|value| summary_from_row(&value))
        .transpose()
        .map_err(AppError::from)
}

#[cfg(test)]
fn is_hidden_directory_path(path: &str, hidden_paths: &[&str]) -> bool {
    hidden_paths.iter().any(|hidden| {
        path == *hidden
            || path
                .strip_prefix(hidden)
                .is_some_and(|suffix| suffix.starts_with('/'))
    })
}

fn order_home_series(candidates: &mut Vec<SeriesCandidate>) {
    candidates.sort_by(|left, right| match (left.active_at, right.active_at) {
        (Some(left_at), Some(right_at)) => right_at.cmp(&left_at).then_with(|| {
            left.preview
                .name
                .to_lowercase()
                .cmp(&right.preview.name.to_lowercase())
        }),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => left
            .preview
            .name
            .to_lowercase()
            .cmp(&right.preview.name.to_lowercase()),
    });
    candidates.truncate(4);
}

pub(crate) async fn fetch_publications(
    db: &SqlitePool,
    directory_id: Option<i64>,
    sort: Option<&str>,
) -> Result<Vec<PublicationSummary>, AppError> {
    let filename_sort = sort == Some("filename");
    let order = match sort {
        Some("added") => "p.added_at DESC, p.title COLLATE NOCASE",
        Some("progress") => "COALESCE(r.updated_at, 0) DESC, p.title COLLATE NOCASE",
        Some("filename") => "p.filename COLLATE NOCASE, p.title COLLATE NOCASE, p.id",
        _ => "p.title COLLATE NOCASE",
    };
    let query = format!(
        "SELECT p.id,p.title,p.author,p.format,p.sha256,p.file_size,p.filename,p.parse_status,p.has_cover,d.relative_path,COALESCE(r.progress,0.0) AS progress FROM publications p JOIN directories d ON d.id=p.directory_id LEFT JOIN reading_progress r ON r.publication_id=p.id WHERE (? IS NULL OR p.directory_id=?) ORDER BY {order}"
    );
    let rows = sqlx::query(&query)
        .bind(directory_id)
        .bind(directory_id)
        .fetch_all(db)
        .await?;
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        out.push(summary_from_row(&row)?);
    }
    if filename_sort {
        out.sort_by(|left, right| {
            natural_filename_compare(&left.filename, &right.filename)
                .then_with(|| {
                    left.filename
                        .to_lowercase()
                        .cmp(&right.filename.to_lowercase())
                })
                .then_with(|| left.id.cmp(&right.id))
        });
    }
    Ok(out)
}

fn natural_filename_compare(left: &str, right: &str) -> std::cmp::Ordering {
    let left_chars: Vec<char> = left.chars().collect();
    let right_chars: Vec<char> = right.chars().collect();
    let (mut i, mut j) = (0, 0);
    while i < left_chars.len() && j < right_chars.len() {
        let left_char = left_chars[i];
        let right_char = right_chars[j];
        if left_char.is_ascii_digit() && right_char.is_ascii_digit() {
            let (mut left_end, mut right_end) = (i, j);
            while left_end < left_chars.len() && left_chars[left_end].is_ascii_digit() {
                left_end += 1;
            }
            while right_end < right_chars.len() && right_chars[right_end].is_ascii_digit() {
                right_end += 1;
            }
            let left_digits = left_chars[i..left_end].iter().collect::<String>();
            let right_digits = right_chars[j..right_end].iter().collect::<String>();
            let left_normalized = left_digits.trim_start_matches('0');
            let right_normalized = right_digits.trim_start_matches('0');
            let left_normalized = if left_normalized.is_empty() {
                "0"
            } else {
                left_normalized
            };
            let right_normalized = if right_normalized.is_empty() {
                "0"
            } else {
                right_normalized
            };
            match left_normalized
                .len()
                .cmp(&right_normalized.len())
                .then_with(|| left_normalized.cmp(right_normalized))
            {
                std::cmp::Ordering::Equal => {
                    i = left_end;
                    j = right_end;
                }
                other => return other,
            }
        } else {
            match left_char
                .to_ascii_lowercase()
                .cmp(&right_char.to_ascii_lowercase())
            {
                std::cmp::Ordering::Equal => {
                    i += 1;
                    j += 1;
                }
                other => return other,
            }
        }
    }
    (left_chars.len() - i).cmp(&(right_chars.len() - j))
}

async fn fetch_publication(db: &SqlitePool, id: i64) -> Result<PublicationSummary, AppError> {
    let row = sqlx::query(
        "SELECT p.id,p.title,p.author,p.format,p.sha256,p.file_size,p.filename,p.parse_status,p.has_cover,d.relative_path,COALESCE(r.progress,0.0) AS progress
         FROM publications p
         JOIN directories d ON d.id=p.directory_id
         LEFT JOIN reading_progress r ON r.publication_id=p.id
         WHERE p.id=?",
    )
    .bind(id)
    .fetch_optional(db)
    .await?
    .ok_or(AppError::NotFound)?;
    Ok(summary_from_row(&row)?)
}

pub(crate) fn summary_from_row(
    row: &sqlx::sqlite::SqliteRow,
) -> Result<PublicationSummary, sqlx::Error> {
    let source: String = row.try_get("format")?;
    let hash: String = row.try_get("sha256")?;
    let has_cover: bool = row.try_get("has_cover")?;
    Ok(PublicationSummary {
        id: row.try_get("id")?,
        title: row.try_get("title")?,
        author: row.try_get("author")?,
        source_format: source.clone(),
        reader_format: if source == "mobi" {
            "epub".to_owned()
        } else {
            source
        },
        cover_url: has_cover.then(|| {
            format!(
                "/api/v1/publications/{}/cover?v={hash}",
                row.try_get::<i64, _>("id").unwrap_or_default()
            )
        }),
        progress: row.try_get::<f64, _>("progress")?.clamp(0.0, 1.0),
        content_version: content_version(&hash, row.try_get::<String, _>("format")?.as_str(), None),
        file_size: row.try_get("file_size")?,
        filename: row.try_get("filename")?,
        directory_path: row.try_get("relative_path")?,
        parse_status: row.try_get("parse_status")?,
    })
}

pub async fn get_book(
    State(state): State<AppState>,
    _user: Authenticated,
    AxumPath(id): AxumPath<i64>,
    Query(query): Query<BookQuery>,
) -> Result<Json<BookDetail>, AppError> {
    let row = publication_row(&state.db, &state.config.books_dir, id).await?;
    ensure_source_current(&row).await?;
    let encoding = query
        .encoding
        .as_deref()
        .unwrap_or("auto")
        .to_ascii_lowercase();
    if row.format == "txt" {
        ensure_txt_encoding(&state, &row, &encoding).await?;
    }
    let summary = fetch_publication(&state.db, id).await?;
    let mut summary = summary;
    if row.format == "txt" {
        summary.content_version = current_content_version(&row, Some(&encoding));
    }
    let chapters = sqlx::query(
        "SELECT idx,title,character_count FROM text_chapters WHERE publication_id=? AND encoding=? ORDER BY idx",
    )
    .bind(id)
    .bind(if row.format == "txt" {
        encoding.as_str()
    } else {
        "auto"
    })
    .fetch_all(&state.db)
    .await?
    .into_iter()
    .map(|row| {
        Ok(ChapterInfo {
            idx: row.try_get("idx")?,
            title: row.try_get("title")?,
            character_count: row.try_get("character_count")?,
        })
    })
    .collect::<Result<Vec<_>, sqlx::Error>>()?;
    let mut pages =
        sqlx::query("SELECT idx,path,mime FROM cbz_pages WHERE publication_id=? ORDER BY idx")
            .bind(id)
            .fetch_all(&state.db)
            .await?
            .into_iter()
            .map(|row| {
                Ok(PageInfo {
                    idx: row.try_get("idx")?,
                    path: row.try_get("path")?,
                    mime: row.try_get("mime")?,
                    width: None,
                    height: None,
                })
            })
            .collect::<Result<Vec<_>, sqlx::Error>>()?;
    if row.format == "cbz" {
        let source = ensure_source_current(&row).await?;
        let version = current_content_version(&row, None);
        let dimensions = page_dimensions(&state, &version, source, &pages).await?;
        for (page, dimensions) in pages.iter_mut().zip(dimensions) {
            if let Some((width, height)) = dimensions {
                page.width = Some(width);
                page.height = Some(height);
            }
        }
    }
    Ok(Json(BookDetail {
        summary,
        chapters,
        pages,
    }))
}

pub async fn get_cover(
    State(state): State<AppState>,
    _user: Authenticated,
    AxumPath(id): AxumPath<i64>,
) -> Result<Response, AppError> {
    let row = publication_row(&state.db, &state.config.books_dir, id).await?;
    ensure_source_current(&row).await?;
    if !row.has_cover {
        return Err(AppError::NotFound);
    }
    let path = state.cover_path(&current_content_version(&row, None));
    let bytes = tokio::fs::read(path).await.map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            AppError::NotFound
        } else {
            AppError::Io(error)
        }
    })?;
    let etag = format!("\"{}\"", current_content_version(&row, None));
    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "image/jpeg")
        .header(header::ETAG, etag)
        .header(header::CACHE_CONTROL, "public, max-age=31536000, immutable")
        .header(header::CONTENT_LENGTH, bytes.len())
        .body(Body::from(bytes))
        .expect("cover response"))
}

async fn ensure_txt_encoding(
    state: &AppState,
    row: &PublicationRow,
    encoding: &str,
) -> Result<(), AppError> {
    if !supported_encoding(encoding) {
        return Err(AppError::Validation("unsupported TXT encoding".to_owned()));
    }
    if encoding == "auto" {
        return Ok(());
    }
    let chapter_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM text_chapters WHERE publication_id=? AND encoding=?",
    )
    .bind(row.id)
    .bind(encoding)
    .fetch_one(&state.db)
    .await?;
    if chapter_count == 0 {
        let path = ensure_source_current(row).await?;
        let version = current_content_version(row, Some(encoding));
        crate::library::write_text_cache(state, row.id, &version, &path, encoding).await?;
    }
    Ok(())
}

async fn page_dimensions(
    state: &AppState,
    version: &str,
    source: PathBuf,
    pages: &[PageInfo],
) -> Result<Vec<Option<(u32, u32)>>, AppError> {
    let cache = state.page_dimensions_path(version);
    let entries = pages
        .iter()
        .map(|page| page.path.clone())
        .collect::<Vec<_>>();
    let permit = state
        .dimension_tasks
        .clone()
        .acquire_owned()
        .await
        .map_err(|error| AppError::Io(std::io::Error::other(error)))?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        // Recheck after acquiring the permit: simultaneous opens share a rebuild.
        // Bound cache reads too, since corrupt caches are simply rebuildable.
        if let Ok(file) = std::fs::File::open(&cache) {
            let limit = (entries.len() as u64).saturating_mul(32).saturating_add(64);
            if let Ok(value) =
                serde_json::from_reader::<_, Vec<Option<(u32, u32)>>>(file.take(limit))
                && value.len() == entries.len()
                && value
                    .iter()
                    .flatten()
                    .all(|&(width, height)| width > 0 && height > 0)
            {
                return Ok(value);
            }
        }
        let file = std::fs::File::open(source)?;
        let mut archive = ZipArchive::new(file).map_err(std::io::Error::other)?;
        let mut dimensions = Vec::with_capacity(entries.len());
        for entry in entries {
            let value = archive.by_name(&entry).ok().and_then(|item| {
                let mut bytes =
                    Vec::with_capacity(item.size().min(DIMENSION_HEADER_MAX_BYTES) as usize);
                item.take(DIMENSION_HEADER_MAX_BYTES)
                    .read_to_end(&mut bytes)
                    .ok()?;
                image::ImageReader::new(Cursor::new(bytes))
                    .with_guessed_format()
                    .ok()?
                    .into_dimensions()
                    .ok()
                    .filter(|&(width, height)| width > 0 && height > 0)
            });
            dimensions.push(value);
        }
        if let Err(error) = serde_json::to_vec(&dimensions)
            .map_err(std::io::Error::other)
            .and_then(|bytes| crate::state::write_cache(&cache, &bytes))
        {
            tracing::debug!(%error, "could not persist page dimensions");
        }
        Ok::<_, std::io::Error>(dimensions)
    })
    .await
    .map_err(|error| AppError::Io(std::io::Error::other(error)))?
    .map_err(AppError::Io)
}

pub async fn get_file(
    State(state): State<AppState>,
    _user: Authenticated,
    AxumPath(id): AxumPath<i64>,
    headers: HeaderMap,
) -> Result<Response, AppError> {
    let row = publication_row(&state.db, &state.config.books_dir, id).await?;
    let source = ensure_source_current(&row).await?;
    let path = if row.format == "mobi" {
        let target = state
            .mobi_dir(&current_content_version(&row, None))
            .join("book.epub");
        if !target.exists() {
            return Err(AppError::Conflict {
                code: "conversion_required",
                message: "请先转换此 MOBI，或将其转换为 EPUB",
            });
        }
        target
    } else {
        source
    };
    let etag = format!("\"{}\"", current_content_version(&row, None));
    if let Some(value) = headers
        .get(header::IF_MATCH)
        .and_then(|value| value.to_str().ok())
    {
        let matches = value
            .split(',')
            .map(str::trim)
            .any(|candidate| candidate == "*" || candidate == etag);
        if !matches {
            return Ok(Response::builder()
                .status(StatusCode::PRECONDITION_FAILED)
                .header(header::ETAG, etag)
                .body(Body::empty())
                .expect("precondition response"));
        }
    }
    range_response(
        &path,
        &headers,
        if row.format == "mobi" {
            "application/epub+zip"
        } else {
            mime_for_format(&row.format)
        },
        &etag,
    )
    .await
}

pub async fn get_chapter(
    State(state): State<AppState>,
    _user: Authenticated,
    AxumPath((id, idx)): AxumPath<(i64, i64)>,
    Query(query): Query<ChapterQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let row = publication_row(&state.db, &state.config.books_dir, id).await?;
    if row.format != "txt" {
        return Err(AppError::Validation(
            "chapters are available only for TXT publications".to_owned(),
        ));
    }
    ensure_source_current(&row).await?;
    let encoding = query
        .encoding
        .as_deref()
        .unwrap_or("auto")
        .to_ascii_lowercase();
    ensure_txt_encoding(&state, &row, &encoding).await?;
    let chapter = sqlx::query(
        "SELECT title,byte_start,byte_end,character_count FROM text_chapters WHERE publication_id=? AND encoding=? AND idx=?",
    )
    .bind(id)
    .bind(&encoding)
    .bind(idx)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;
    let start: u64 = chapter
        .try_get::<i64, _>("byte_start")?
        .try_into()
        .map_err(|_| AppError::Validation("invalid chapter offset".to_owned()))?;
    let end: u64 = chapter
        .try_get::<i64, _>("byte_end")?
        .try_into()
        .map_err(|_| AppError::Validation("invalid chapter offset".to_owned()))?;
    let cache_path = state
        .txt_dir(&current_content_version(&row, Some(&encoding)), &encoding)
        .join("book.utf8");
    let text = read_cached_range(&cache_path, start, end).await?;
    let title: String = chapter.try_get("title")?;
    let character_count: i64 = chapter.try_get("character_count")?;
    let content = render_txt_html(&text);
    Ok(Json(serde_json::json!(ChapterResponse {
        idx,
        title,
        content,
        text,
        encoding: encoding.clone(),
        content_version: current_content_version(&row, Some(&encoding)),
        character_count
    })))
}

pub async fn get_page(
    State(state): State<AppState>,
    _user: Authenticated,
    AxumPath((id, idx)): AxumPath<(i64, i64)>,
) -> Result<Response, AppError> {
    let row = publication_row(&state.db, &state.config.books_dir, id).await?;
    if row.format != "cbz" {
        return Err(AppError::Validation(
            "pages are available only for CBZ publications".to_owned(),
        ));
    }
    ensure_source_current(&row).await?;
    let page = sqlx::query("SELECT path,mime FROM cbz_pages WHERE publication_id=? AND idx=?")
        .bind(id)
        .bind(idx)
        .fetch_optional(&state.db)
        .await?
        .ok_or(AppError::NotFound)?;
    let entry: String = page.try_get("path")?;
    let mime: String = page.try_get("mime")?;
    let source = row.root.join(&row.relative_path);
    let (size, stream) = cbz_page_stream(source, entry, Arc::clone(&state.page_streams)).await?;
    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime)
        .header(
            header::ETAG,
            format!("\"{}-page-{idx}\"", current_content_version(&row, None)),
        )
        .header(header::CACHE_CONTROL, "no-cache")
        .header(header::CONTENT_LENGTH, size)
        .body(Body::from_stream(stream))
        .expect("page response"))
}

const PAGE_STREAM_CHUNK: usize = 64 * 1024;
const PAGE_STREAM_BUFFER: usize = 2;

async fn cbz_page_stream(
    source: PathBuf,
    entry: String,
    page_streams: Arc<tokio::sync::Semaphore>,
) -> Result<(u64, ReceiverStream<Result<bytes::Bytes, std::io::Error>>), AppError> {
    // Acquire before opening the ZIP central directory, and open it only once.
    let permit = page_streams
        .acquire_owned()
        .await
        .map_err(|error| AppError::Io(std::io::Error::other(error)))?;
    let (ready, metadata) = tokio::sync::oneshot::channel();
    let (sender, receiver) = tokio::sync::mpsc::channel(PAGE_STREAM_BUFFER);
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let mut ready = Some(ready);
        let result = (|| -> Result<(), std::io::Error> {
            if sender.is_closed() {
                return Ok(());
            }
            let file = std::fs::File::open(source)?;
            let mut archive = ZipArchive::new(file).map_err(std::io::Error::other)?;
            let mut item = archive.by_name(&entry).map_err(std::io::Error::other)?;
            if ready
                .take()
                .expect("metadata sender")
                .send(Ok(item.size()))
                .is_err()
            {
                return Ok(());
            }
            let mut buffer = [0_u8; PAGE_STREAM_CHUNK];
            while !sender.is_closed() {
                let read = item.read(&mut buffer)?;
                if read == 0 {
                    break;
                }
                if sender
                    .blocking_send(Ok(bytes::Bytes::copy_from_slice(&buffer[..read])))
                    .is_err()
                {
                    break;
                }
            }
            Ok(())
        })();
        if let Err(error) = result {
            if let Some(ready) = ready {
                let _ = ready.send(Err(error));
            } else {
                let _ = sender.blocking_send(Err(error));
            }
        }
    });
    let size = metadata
        .await
        .map_err(|error| AppError::Io(std::io::Error::other(error)))??;
    Ok((size, ReceiverStream::new(receiver)))
}

pub async fn get_page_thumbnail(
    State(state): State<AppState>,
    _user: Authenticated,
    AxumPath((id, idx)): AxumPath<(i64, i64)>,
) -> Result<Response, AppError> {
    let row = publication_row(&state.db, &state.config.books_dir, id).await?;
    if row.format != "cbz" {
        return Err(AppError::Validation(
            "page thumbnails are available only for CBZ publications".to_owned(),
        ));
    }
    let source = ensure_source_current(&row).await?;
    let page: Option<(String,)> =
        sqlx::query_as("SELECT path FROM cbz_pages WHERE publication_id=? AND idx=?")
            .bind(id)
            .bind(idx)
            .fetch_optional(&state.db)
            .await?;
    let (entry,) = page.ok_or(AppError::NotFound)?;
    let version = current_content_version(&row, None);
    let target = state.thumbnail_path(&version, idx);
    ensure_page_thumbnail(state.image_tasks.clone(), source, entry, target.clone()).await?;
    let bytes = tokio::fs::read(&target).await?;
    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "image/jpeg")
        .header(header::ETAG, format!("\"{version}-page-{idx}-thumbnail\""))
        .header(header::CACHE_CONTROL, "public, max-age=31536000, immutable")
        .header(header::CONTENT_LENGTH, bytes.len())
        .body(Body::from(bytes))
        .expect("thumbnail response"))
}

async fn ensure_page_thumbnail(
    image_tasks: Arc<tokio::sync::Semaphore>,
    source: PathBuf,
    entry: String,
    target: PathBuf,
) -> Result<(), AppError> {
    if target.is_file() {
        return Ok(());
    }
    let permit = image_tasks
        .acquire_owned()
        .await
        .map_err(|error| AppError::Io(std::io::Error::other(error)))?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        if target.is_file() {
            return Ok(());
        }
        let encoded = (|| {
            let file = std::fs::File::open(source)?;
            let mut zip = ZipArchive::new(file).map_err(std::io::Error::other)?;
            let item = zip.by_name(&entry).map_err(std::io::Error::other)?;
            if item.size() > IMAGE_MAX_BYTES as u64 {
                return Err(AppError::Validation(
                    "CBZ page exceeds the 16 MiB thumbnail limit".to_owned(),
                ));
            }
            let mut raw = Vec::with_capacity(item.size() as usize);
            item.take(IMAGE_MAX_BYTES as u64 + 1)
                .read_to_end(&mut raw)?;
            encode_page_thumbnail(&raw)
        })()
        .or_else(|error| {
            tracing::debug!(%error, "using placeholder for unavailable CBZ thumbnail");
            placeholder_thumbnail()
        })?;
        crate::state::write_cache(&target, &encoded)?;
        Ok::<_, AppError>(())
    })
    .await
    .map_err(|error| AppError::Io(std::io::Error::other(error)))?
}

fn encode_page_thumbnail(raw: &[u8]) -> Result<Vec<u8>, AppError> {
    if raw.len() > IMAGE_MAX_BYTES {
        return Err(AppError::Validation(
            "CBZ page exceeds the 16 MiB thumbnail limit".to_owned(),
        ));
    }
    let header_reader = image::ImageReader::new(Cursor::new(raw))
        .with_guessed_format()
        .map_err(|error| AppError::Validation(format!("invalid CBZ page: {error}")))?;
    let (width, height) = header_reader
        .into_dimensions()
        .map_err(|error| AppError::Validation(format!("invalid CBZ page dimensions: {error}")))?;
    if width > IMAGE_MAX_DIMENSION
        || height > IMAGE_MAX_DIMENSION
        || u64::from(width).saturating_mul(u64::from(height)) > IMAGE_MAX_PIXELS
    {
        return Err(AppError::Validation(
            "CBZ page dimensions exceed the thumbnail limit".to_owned(),
        ));
    }
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(IMAGE_MAX_DIMENSION);
    limits.max_image_height = Some(IMAGE_MAX_DIMENSION);
    limits.max_alloc = Some(IMAGE_MAX_ALLOC);
    let mut reader = image::ImageReader::new(Cursor::new(raw))
        .with_guessed_format()
        .map_err(|error| AppError::Validation(format!("invalid CBZ page: {error}")))?;
    reader.limits(limits);
    let image = reader
        .decode()
        .map_err(|error| AppError::Validation(format!("invalid CBZ page: {error}")))?
        .thumbnail(240, 240)
        .to_rgb8();
    let mut output = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut output, 78)
        .encode_image(&image)
        .map_err(|error| AppError::Validation(format!("could not encode thumbnail: {error}")))?;
    Ok(output)
}

fn placeholder_thumbnail() -> Result<Vec<u8>, AppError> {
    let image = image::RgbImage::from_pixel(2, 2, image::Rgb([214, 220, 211]));
    let mut output = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut output, 78)
        .encode_image(&image)
        .map_err(|error| {
            AppError::Validation(format!("could not encode thumbnail placeholder: {error}"))
        })?;
    Ok(output)
}

pub async fn get_progress(
    State(state): State<AppState>,
    _user: Authenticated,
    AxumPath(id): AxumPath<i64>,
) -> Result<Json<Option<ProgressBody>>, AppError> {
    let publication = publication_row(&state.db, &state.config.books_dir, id).await?;
    ensure_source_current(&publication).await?;
    let row = sqlx::query(
        "SELECT content_version,locator_json,progress FROM reading_progress WHERE publication_id=?",
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await?;
    let value = match row {
        Some(row) => {
            let stored_progress: f64 = row.try_get("progress")?;
            let stored_version: String = row.try_get("content_version")?;
            let locator: String = row.try_get("locator_json")?;
            let position = serde_json::from_str::<ReadingPosition>(&locator).ok();
            let expected_version = position
                .as_ref()
                .map(|position| content_version_for_position(&publication, position))
                .unwrap_or_else(|| current_content_version(&publication, None));
            if let Some(position) = position.filter(|_| stored_version == expected_version) {
                Some(ProgressBody {
                    content_version: expected_version,
                    position,
                })
            } else {
                // Keep the useful coarse progress but deliberately discard a
                // locator tied to an older file/parser version.
                let position = fallback_position(&state.db, &publication, stored_progress).await?;
                Some(ProgressBody {
                    content_version: content_version_for_position(&publication, &position),
                    position,
                })
            }
        }
        None => None,
    };
    Ok(Json(value))
}

pub async fn put_progress(
    State(state): State<AppState>,
    _user: Authenticated,
    AxumPath(id): AxumPath<i64>,
    payload: Result<Json<ProgressBody>, axum::extract::rejection::JsonRejection>,
) -> Result<Json<ProgressBody>, AppError> {
    let Json(body) = payload
        .map_err(|_| AppError::Validation("Request body must be valid progress JSON".to_owned()))?;
    let publication = publication_row(&state.db, &state.config.books_dir, id).await?;
    ensure_source_current(&publication).await?;
    let current_version = content_version_for_position(&publication, &body.position);
    if body.content_version != current_version {
        return Err(AppError::Conflict {
            code: "content_version_mismatch",
            message: "书籍内容已变化，请重新打开后再保存进度",
        });
    }
    validate_progress(&state.db, &publication, &body).await?;
    let now = now_unix();
    let json = serde_json::to_string(&body.position)
        .map_err(|error| AppError::Validation(error.to_string()))?;
    sqlx::query("INSERT INTO reading_progress (publication_id,content_version,locator_json,progress,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(publication_id) DO UPDATE SET content_version=excluded.content_version,locator_json=excluded.locator_json,progress=excluded.progress,updated_at=excluded.updated_at").bind(id).bind(&body.content_version).bind(json).bind(body.position.progress()).bind(now).execute(&state.db).await?;
    Ok(Json(body))
}

async fn validate_progress(
    db: &SqlitePool,
    publication: &PublicationRow,
    body: &ProgressBody,
) -> Result<(), AppError> {
    if body.content_version.trim().is_empty() {
        return Err(AppError::Validation(
            "content_version is required".to_owned(),
        ));
    }
    let progress = body.position.progress_raw();
    if !progress.is_finite() || !(0.0..=1.0).contains(&progress) {
        return Err(AppError::Validation(
            "progress must be between 0 and 1".to_owned(),
        ));
    }
    match (publication.format.as_str(), &body.position) {
        ("epub" | "mobi", ReadingPosition::Epub { href, cfi, .. })
            if !href.trim().is_empty()
                && cfi.trim().starts_with("epubcfi(")
                && cfi.trim().ends_with(')') =>
        {
            Ok(())
        }
        (
            "txt",
            ReadingPosition::Txt {
                chapter_index,
                character_offset,
                encoding,
                ..
            },
        ) if *chapter_index >= 0 && *character_offset >= 0 && supported_encoding(encoding) => {
            let encoding = encoding.to_ascii_lowercase();
            let chapter_count: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM text_chapters WHERE publication_id=? AND encoding=?",
            )
            .bind(publication.id)
            .bind(&encoding)
            .fetch_one(db)
            .await?;
            if chapter_count == 0 || *chapter_index >= chapter_count {
                return Err(AppError::Validation(
                    "chapter_index is outside the TXT chapter list".to_owned(),
                ));
            }
            let character_count = sqlx::query_scalar::<_, i64>(
                "SELECT character_count FROM text_chapters WHERE publication_id=? AND encoding=? AND idx=?",
            )
            .bind(publication.id)
            .bind(&encoding)
            .bind(*chapter_index)
            .fetch_optional(db)
            .await?
            .ok_or_else(|| AppError::Validation("chapter_index is outside the TXT chapter list".to_owned()))?;
            if *character_offset > character_count.max(0) {
                return Err(AppError::Validation(
                    "character_offset is outside the TXT chapter".to_owned(),
                ));
            }
            Ok(())
        }
        (
            "cbz",
            ReadingPosition::Cbz {
                page_index,
                page_progress,
                ..
            },
        ) if *page_index >= 0
            && page_progress.is_finite()
            && (0.0..=1.0).contains(page_progress) =>
        {
            let page_count: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM cbz_pages WHERE publication_id=?")
                    .bind(publication.id)
                    .fetch_one(db)
                    .await?;
            if page_count == 0 || *page_index >= page_count {
                return Err(AppError::Validation(
                    "page_index is outside the CBZ page list".to_owned(),
                ));
            }
            Ok(())
        }
        (_, _) => Err(AppError::Validation(
            "阅读位置与书籍格式不匹配或包含无效定位".to_owned(),
        )),
    }
}

fn supported_encoding(value: &str) -> bool {
    matches!(
        value.to_ascii_lowercase().as_str(),
        "auto" | "utf-8" | "utf-16le" | "utf-16be" | "gbk" | "gb18030" | "big5"
    )
}

async fn fallback_position(
    db: &SqlitePool,
    row: &PublicationRow,
    progress: f64,
) -> Result<ReadingPosition, AppError> {
    let progress = progress.clamp(0.0, 1.0);
    Ok(match row.format.as_str() {
        "txt" => {
            let count: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM text_chapters WHERE publication_id=? AND encoding='auto'",
            )
            .bind(row.id)
            .fetch_one(db)
            .await?;
            let last = (count - 1).max(0) as f64;
            ReadingPosition::Txt {
                chapter_index: (progress * last).round() as i64,
                character_offset: 0,
                encoding: "auto".to_owned(),
                progress,
            }
        }
        "cbz" => {
            let count: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM cbz_pages WHERE publication_id=?")
                    .bind(row.id)
                    .fetch_one(db)
                    .await?;
            let last = (count - 1).max(0) as f64;
            ReadingPosition::Cbz {
                page_index: (progress * last).round() as i64,
                page_progress: 0.0,
                progress,
            }
        }
        _ => ReadingPosition::Epub {
            href: String::new(),
            cfi: String::new(),
            progress,
        },
    })
}

async fn read_cached_range(path: &Path, start: u64, end: u64) -> Result<String, AppError> {
    let length = tokio::fs::metadata(path).await?.len();
    let start = start.min(length);
    let end = end.min(length);
    if end < start {
        return Ok(String::new());
    }
    let mut file = tokio::fs::File::open(path).await?;
    tokio::io::AsyncSeekExt::seek(&mut file, std::io::SeekFrom::Start(start)).await?;
    let mut bytes = vec![
        0_u8;
        usize::try_from(end - start)
            .map_err(|_| AppError::Validation("chapter is too large".to_owned()))?
    ];
    tokio::io::AsyncReadExt::read_exact(&mut file, &mut bytes).await?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn render_txt_html(text: &str) -> String {
    moth_format::txt::render_plain_html(text)
}

pub async fn conversion_status(
    State(state): State<AppState>,
    _user: Authenticated,
    AxumPath(id): AxumPath<i64>,
) -> Result<Json<ConversionResponse>, AppError> {
    let row = publication_row(&state.db, &state.config.books_dir, id).await?;
    if row.format != "mobi" {
        return Ok(Json(ConversionResponse {
            status: "not_required".to_owned(),
            file_url: Some(format!("/api/v1/publications/{id}/file")),
            error: None,
        }));
    }
    ensure_source_current(&row).await?;
    let version = current_content_version(&row, None);
    let target = state.mobi_dir(&version).join("book.epub");
    if target.exists() {
        return Ok(Json(ConversionResponse {
            status: "ready".to_owned(),
            file_url: Some(format!("/api/v1/publications/{id}/file")),
            error: None,
        }));
    }
    let jobs = state.conversion_jobs.lock().await;
    let response = match jobs.get(&version) {
        Some(ConversionState::Preparing) => ConversionResponse {
            status: "preparing".to_owned(),
            file_url: None,
            error: None,
        },
        Some(ConversionState::Failed(error)) => ConversionResponse {
            status: "failed".to_owned(),
            file_url: None,
            error: Some(error.clone()),
        },
        _ => ConversionResponse {
            status: "pending".to_owned(),
            file_url: None,
            error: None,
        },
    };
    Ok(Json(response))
}

pub async fn start_conversion(
    State(state): State<AppState>,
    _user: Authenticated,
    AxumPath(id): AxumPath<i64>,
) -> Result<Json<ConversionResponse>, AppError> {
    let row = publication_row(&state.db, &state.config.books_dir, id).await?;
    if row.format != "mobi" {
        return Ok(Json(ConversionResponse {
            status: "not_required".to_owned(),
            file_url: Some(format!("/api/v1/publications/{id}/file")),
            error: None,
        }));
    }
    ensure_source_current(&row).await?;
    let version = current_content_version(&row, None);
    let target = state.mobi_dir(&version).join("book.epub");
    if target.exists() {
        return Ok(Json(ConversionResponse {
            status: "ready".to_owned(),
            file_url: Some(format!("/api/v1/publications/{id}/file")),
            error: None,
        }));
    }
    {
        let mut jobs = state.conversion_jobs.lock().await;
        if jobs
            .get(&version)
            .is_some_and(|value| matches!(value, ConversionState::Preparing))
        {
            return Ok(Json(ConversionResponse {
                status: "preparing".to_owned(),
                file_url: None,
                error: None,
            }));
        }
        jobs.insert(version.clone(), ConversionState::Preparing);
    }
    let jobs = Arc::clone(&state.conversion_jobs);
    let source = row.root.join(&row.relative_path);
    let dir = state.mobi_dir(&version);
    tokio::spawn(async move {
        let result = tokio::task::spawn_blocking(move || convert_mobi(&source, &dir))
            .await
            .map_err(|error| error.to_string())
            .and_then(|value| value.map_err(|error| error.to_string()));
        let mut jobs = jobs.lock().await;
        *jobs.entry(version).or_insert(ConversionState::Preparing) = match result {
            Ok(()) => ConversionState::Ready,
            Err(error) => ConversionState::Failed(error),
        };
    });
    Ok(Json(ConversionResponse {
        status: "preparing".to_owned(),
        file_url: None,
        error: None,
    }))
}

async fn publication_row(
    db: &SqlitePool,
    root: &Path,
    id: i64,
) -> Result<PublicationRow, AppError> {
    let row = sqlx::query("SELECT id,relative_path,format,sha256,file_size,mtime_ns,has_cover FROM publications WHERE id=?").bind(id).fetch_optional(db).await?.ok_or(AppError::NotFound)?;
    Ok(PublicationRow {
        id: row.try_get("id")?,
        relative_path: row.try_get("relative_path")?,
        format: row.try_get("format")?,
        sha256: row.try_get("sha256")?,
        file_size: row.try_get("file_size")?,
        mtime_ns: row.try_get("mtime_ns")?,
        has_cover: row.try_get("has_cover")?,
        root: root.to_owned(),
    })
}

struct PublicationRow {
    id: i64,
    relative_path: String,
    format: String,
    sha256: String,
    file_size: i64,
    mtime_ns: i64,
    has_cover: bool,
    root: PathBuf,
}

pub(crate) fn content_version(hash: &str, format: &str, encoding: Option<&str>) -> String {
    let encoding = encoding.unwrap_or("auto").to_ascii_lowercase();
    format!("{CONTENT_ADAPTER_VERSION}-{format}-{encoding}-{hash}")
}
fn current_content_version(row: &PublicationRow, encoding: Option<&str>) -> String {
    content_version(&row.sha256, &row.format, encoding)
}
fn content_version_for_position(row: &PublicationRow, position: &ReadingPosition) -> String {
    let encoding = match position {
        ReadingPosition::Txt { encoding, .. } => Some(encoding.as_str()),
        _ => None,
    };
    current_content_version(row, encoding)
}
fn mime_for_format(format: &str) -> &'static str {
    match format {
        "epub" => "application/epub+zip",
        "cbz" => "application/vnd.comicbook+zip",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

async fn ensure_source_current(row: &PublicationRow) -> Result<PathBuf, AppError> {
    let path = row.root.join(&row.relative_path);
    let metadata = tokio::fs::metadata(&path).await.map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            AppError::NotFound
        } else {
            AppError::Io(error)
        }
    })?;
    let size = i64::try_from(metadata.len()).unwrap_or(i64::MAX);
    let mtime = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|value| value.as_nanos() as i64)
        .unwrap_or(0);
    if size != row.file_size || mtime != row.mtime_ns {
        return Err(AppError::Conflict {
            code: "source_changed",
            message: "源文件已变化，请先重新扫描书库",
        });
    }
    Ok(path)
}

async fn range_response(
    path: &Path,
    headers: &HeaderMap,
    mime: &'static str,
    etag: &str,
) -> Result<Response, AppError> {
    let metadata = tokio::fs::metadata(path).await?;
    let total = metadata.len();
    let common = |builder: axum::http::response::Builder| {
        builder
            .header(header::CONTENT_TYPE, mime)
            .header(header::ACCEPT_RANGES, "bytes")
            .header(header::ETAG, etag)
            .header(header::CACHE_CONTROL, "no-cache")
    };
    let Some(value) = headers
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
    else {
        let file = tokio::fs::File::open(path).await?;
        return Ok(common(Response::builder())
            .status(StatusCode::OK)
            .header(header::CONTENT_LENGTH, total)
            .body(Body::from_stream(ReaderStream::new(file)))
            .expect("file response"));
    };
    let Some((start, end)) = parse_range(value, total) else {
        return Ok(common(Response::builder())
            .status(StatusCode::RANGE_NOT_SATISFIABLE)
            .header(header::CONTENT_RANGE, format!("bytes */{total}"))
            .body(Body::empty())
            .expect("range response"));
    };
    let length = end - start + 1;
    let mut file = tokio::fs::File::open(path).await?;
    file.seek(std::io::SeekFrom::Start(start)).await?;
    let stream = ReaderStream::new(file.take(length));
    Ok(common(Response::builder())
        .status(StatusCode::PARTIAL_CONTENT)
        .header(
            header::CONTENT_RANGE,
            format!("bytes {start}-{end}/{total}"),
        )
        .header(header::CONTENT_LENGTH, length)
        .body(Body::from_stream(stream))
        .expect("range response"))
}

fn parse_range(value: &str, total: u64) -> Option<(u64, u64)> {
    if total == 0 {
        return None;
    }
    let range = value.strip_prefix("bytes=")?.split(',').next()?.trim();
    let (start, end) = range.split_once('-')?;
    if start.is_empty() {
        let suffix = end.parse::<u64>().ok()?;
        if suffix == 0 {
            return None;
        }
        let length = suffix.min(total);
        return Some((total - length, total - 1));
    }
    let start = start.parse::<u64>().ok()?;
    if start >= total {
        return None;
    }
    let end = if end.is_empty() {
        total - 1
    } else {
        end.parse::<u64>().ok()?.min(total - 1)
    };
    (start <= end).then_some((start, end))
}

fn convert_mobi(source: &Path, directory: &Path) -> Result<(), AppError> {
    let book = mobi::Mobi::from_path(source).map_err(mobi_conversion_error)?;
    let text = match book.content_as_string() {
        Ok(text) => text,
        Err(_) => book.content_as_string_lossy(),
    };
    if text.trim().is_empty() {
        return Err(mobi_conversion_error("没有可读取的正文"));
    }
    let raw_title = book.title();
    let title = if raw_title.trim().is_empty() {
        "未命名 MOBI".to_owned()
    } else {
        raw_title
    };
    let author = book.author().unwrap_or_default();
    let mut image_items = Vec::new();
    let mut image_paths = HashMap::new();
    for (ordinal, record) in book.image_records().into_iter().enumerate() {
        let Some((extension, mime)) = mobi_image_type(record.content) else {
            continue;
        };
        let path = format!("images/record-{}.{}", record.record.id, extension);
        image_paths
            .entry(record.record.id)
            .or_insert_with(|| path.clone());
        image_paths
            .entry(u32::try_from(ordinal).unwrap_or(u32::MAX))
            .or_insert_with(|| path.clone());
        image_paths
            .entry(u32::try_from(ordinal + 1).unwrap_or(u32::MAX))
            .or_insert_with(|| path.clone());
        image_items.push((path, mime, record.content.to_vec()));
    }

    let mut chapters = mobi_chapters(&text, &image_paths);
    if chapters.is_empty() {
        return Err(mobi_conversion_error("没有可读取的正文"));
    }
    rewrite_mobi_links(&mut chapters);
    let bytes = build_mobi_epub(&title, &author, &chapters, &image_items)?;
    let image_paths = image_items
        .iter()
        .map(|(path, _, _)| path.as_str())
        .collect::<Vec<_>>();
    validate_generated_epub(&bytes, chapters.len(), &image_paths)?;

    let target = directory.join("book.epub");
    std::fs::create_dir_all(directory)?;
    let temp = directory.join("book.epub.tmp");
    std::fs::write(&temp, bytes)?;
    match std::fs::rename(&temp, &target) {
        Ok(()) => Ok(()),
        Err(_error) if target.exists() => {
            let _ = std::fs::remove_file(&temp);
            Ok(())
        }
        Err(error) => Err(AppError::Io(error)),
    }
}

const MOBI_CHAPTER_CHAR_LIMIT: usize = 80_000;

#[derive(Debug, Clone)]
struct MobiChapter {
    title: Option<String>,
    body: String,
}

fn mobi_chapters(text: &str, image_paths: &HashMap<u32, String>) -> Vec<MobiChapter> {
    let body = normalize_mobi_markup(&extract_mobi_body(text));
    let html_like = Regex::new(
        r"(?is)<(?:p|div|h[1-6]|br|img|a|ul|ol|li|table|blockquote|pre|section|article)\b",
    )
    .expect("MOBI HTML detector");
    if html_like.is_match(&body) {
        let body = rewrite_mobi_images(&body, image_paths);
        let mut chapters = Vec::new();
        for piece in body.split("<!--MOTH-PAGEBREAK-->") {
            let piece = repair_mobi_fragment(piece);
            for fragment in split_long_markup(&piece) {
                let fragment = repair_mobi_fragment(&fragment);
                if !mobi_fragment_has_content(&fragment) {
                    continue;
                }
                chapters.push(MobiChapter {
                    title: mobi_heading_title(&fragment),
                    body: fragment,
                });
            }
        }
        return chapters;
    }

    // Some classic MOBI producers store plain text in PalmDOC records. Use
    // paragraph and heading rules for that input without pretending generated
    // chunks are an original publisher TOC.
    plain_mobi_chapters(&body.replace("<!--MOTH-PAGEBREAK-->", "\n\n"))
}

fn extract_mobi_body(text: &str) -> String {
    let body_re = Regex::new(r"(?is)<body\b[^>]*>(.*?)</body\s*>").expect("MOBI body extractor");
    if let Some(captures) = body_re.captures(text) {
        return captures
            .get(1)
            .map(|value| value.as_str().to_owned())
            .unwrap_or_default();
    }

    let mut body = text.to_owned();
    for pattern in [
        r"(?is)<head\b[^>]*>.*?</head\s*>",
        r"(?is)<!doctype[^>]*>",
        r"(?is)<\?xml[^>]*\?>",
        r"(?is)</?html\b[^>]*>",
        r"(?is)</?body\b[^>]*>",
    ] {
        body = Regex::new(pattern)
            .expect("MOBI wrapper pattern")
            .replace_all(&body, "")
            .into_owned();
    }
    body
}

fn normalize_mobi_markup(value: &str) -> String {
    let mut body = value
        .chars()
        .filter(|character| {
            matches!(character, '\t' | '\n' | '\r' | '\u{20}'..='\u{d7ff}' | '\u{e000}'..='\u{fffd}')
        })
        .collect::<String>();
    body = Regex::new(r"(?is)<\s*mbp:pagebreak\b[^>]*>|<\s*pagebreak\b[^>]*>")
        .expect("MOBI page break pattern")
        .replace_all(&body, "<!--MOTH-PAGEBREAK-->")
        .into_owned();
    body = Regex::new(r"(?is)</?\s*mbp:[^>]*>")
        .expect("MOBI namespace pattern")
        .replace_all(&body, "")
        .into_owned();
    body = moth_format::html::sanitize_html(&body);
    body = escape_stray_markup(&body);
    body = normalize_named_entities(&body);
    normalize_void_elements(&body)
}

fn escape_stray_markup(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut index = 0;
    while index < value.len() {
        let rest = &value[index..];
        if rest.starts_with('<') {
            let next = rest.as_bytes().get(1).copied();
            let valid = next.is_some_and(|byte| byte.is_ascii_alphabetic())
                || rest.starts_with("<!--")
                || rest.starts_with("</")
                || rest.starts_with("<!");
            if !valid {
                output.push_str("&lt;");
                index += '<'.len_utf8();
                continue;
            }
        }
        let character = rest.chars().next().unwrap_or_default();
        output.push(character);
        index += character.len_utf8();
    }
    output
}

fn normalize_named_entities(value: &str) -> String {
    let entity = Regex::new(r"&([A-Za-z][A-Za-z0-9]+);").expect("HTML entity pattern");
    let normalized = entity
        .replace_all(value, |captures: &regex::Captures<'_>| {
            let name = captures
                .get(1)
                .map(|value| value.as_str())
                .unwrap_or_default();
            match name.to_ascii_lowercase().as_str() {
                "amp" => "&amp;".to_owned(),
                "lt" => "&lt;".to_owned(),
                "gt" => "&gt;".to_owned(),
                "quot" => "&quot;".to_owned(),
                "apos" => "&apos;".to_owned(),
                "nbsp" => "&#160;".to_owned(),
                "copy" => "&#169;".to_owned(),
                "reg" => "&#174;".to_owned(),
                "trade" => "&#8482;".to_owned(),
                "mdash" => "&#8212;".to_owned(),
                "ndash" => "&#8211;".to_owned(),
                "hellip" => "&#8230;".to_owned(),
                "ldquo" => "&#8220;".to_owned(),
                "rdquo" => "&#8221;".to_owned(),
                "lsquo" => "&#8216;".to_owned(),
                "rsquo" => "&#8217;".to_owned(),
                "bull" => "&#8226;".to_owned(),
                "middot" => "&#183;".to_owned(),
                _ => format!("&amp;{name};"),
            }
        })
        .into_owned();
    escape_bare_ampersands(&normalized)
}

fn escape_bare_ampersands(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(index) = rest.find('&') {
        output.push_str(&rest[..index]);
        let tail = &rest[index..];
        if let Some(length) = xml_entity_length(tail) {
            output.push_str(&tail[..length]);
            rest = &tail[length..];
        } else {
            output.push_str("&amp;");
            rest = &tail[1..];
        }
    }
    output.push_str(rest);
    output
}

fn xml_entity_length(value: &str) -> Option<usize> {
    for entity in ["&amp;", "&lt;", "&gt;", "&quot;", "&apos;"] {
        if value.starts_with(entity) {
            return Some(entity.len());
        }
    }
    let bytes = value.as_bytes();
    if !bytes.starts_with(b"&#") {
        return None;
    }
    let mut index = 2;
    if matches!(bytes.get(index), Some(b'x' | b'X')) {
        index += 1;
        let start = index;
        while matches!(bytes.get(index), Some(byte) if byte.is_ascii_hexdigit()) {
            index += 1;
        }
        if index == start || bytes.get(index) != Some(&b';') {
            return None;
        }
    } else {
        let start = index;
        while matches!(bytes.get(index), Some(byte) if byte.is_ascii_digit()) {
            index += 1;
        }
        if index == start || bytes.get(index) != Some(&b';') {
            return None;
        }
    }
    Some(index + 1)
}

fn normalize_void_elements(value: &str) -> String {
    let void = Regex::new(
        r"(?is)<(area|base|br|embed|hr|img|input|link|meta|param|source|track|wbr)\b([^>]*?)(?:\s*/)?\s*>",
    )
    .expect("MOBI XHTML void pattern");
    let normalized = void
        .replace_all(value, |captures: &regex::Captures<'_>| {
            format!(
                "<{}{} />",
                captures[1].to_ascii_lowercase(),
                captures
                    .get(2)
                    .map(|value| value.as_str())
                    .unwrap_or_default()
            )
        })
        .into_owned();
    Regex::new(r"(?is)</(?:area|base|br|embed|hr|img|input|link|meta|param|source|track|wbr)\s*>")
        .expect("MOBI XHTML closing pattern")
        .replace_all(&normalized, "")
        .into_owned()
}

fn repair_mobi_fragment(value: &str) -> String {
    let token =
        Regex::new(r"(?is)<!--.*?-->|<\s*/?\s*[A-Za-z][^>]*>").expect("MOBI tag token pattern");
    let tag = Regex::new(r"(?is)^<\s*(/?)\s*([A-Za-z][A-Za-z0-9:._-]*)\b([^>]*)>$")
        .expect("MOBI tag parser pattern");
    let mut output = String::with_capacity(value.len() + 32);
    let mut stack: Vec<String> = Vec::new();
    let mut cursor = 0;
    for match_ in token.find_iter(value) {
        output.push_str(&escape_unterminated_markup(&value[cursor..match_.start()]));
        let raw = match_.as_str();
        if raw.starts_with("<!--") {
            output.push_str(raw);
            cursor = match_.end();
            continue;
        }
        let Some(captures) = tag.captures(raw) else {
            cursor = match_.end();
            continue;
        };
        let name = captures[2].to_ascii_lowercase();
        if !is_mobi_tag(&name) {
            output.push_str(&raw.replace('<', "&lt;").replace('>', "&gt;"));
            cursor = match_.end();
            continue;
        }
        let closing = !captures[1].is_empty();
        let attributes = normalize_mobi_attributes(
            captures
                .get(3)
                .map(|value| value.as_str())
                .unwrap_or_default(),
        );
        let void = matches!(
            name.as_str(),
            "area"
                | "base"
                | "br"
                | "embed"
                | "hr"
                | "img"
                | "input"
                | "link"
                | "meta"
                | "param"
                | "source"
                | "track"
                | "wbr"
        ) || attributes.trim_end().ends_with('/');
        if closing {
            if let Some(index) = stack.iter().rposition(|value| value == &name) {
                while stack.len() > index + 1 {
                    if let Some(open) = stack.pop() {
                        output.push_str("</");
                        output.push_str(&open);
                        output.push('>');
                    }
                }
                stack.pop();
                output.push_str("</");
                output.push_str(&name);
                output.push('>');
            }
        } else if void {
            output.push('<');
            output.push_str(&name);
            output.push_str(attributes.trim_end_matches('/').trim_end());
            output.push_str(" />");
        } else {
            output.push('<');
            output.push_str(&name);
            output.push_str(&attributes);
            output.push('>');
            stack.push(name);
        }
        cursor = match_.end();
    }
    output.push_str(&escape_unterminated_markup(&value[cursor..]));
    while let Some(open) = stack.pop() {
        output.push_str("</");
        output.push_str(&open);
        output.push('>');
    }
    output
}

fn escape_unterminated_markup(value: &str) -> String {
    value.replace('<', "&lt;")
}

fn normalize_mobi_attributes(value: &str) -> String {
    let attribute = Regex::new(
        r#"(?is)([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>]+))"#,
    )
    .expect("MOBI attribute pattern");
    let mut seen = std::collections::HashSet::new();
    let mut output = String::new();
    for captures in attribute.captures_iter(value) {
        let name = captures[1].to_ascii_lowercase();
        if name.contains(':') || name.starts_with("on") || !seen.insert(name.clone()) {
            continue;
        }
        let value = captures
            .get(2)
            .or_else(|| captures.get(3))
            .or_else(|| captures.get(4))
            .map(|value| value.as_str())
            .unwrap_or_default();
        if value
            .chars()
            .any(|character| character == '<' || character == '>' || character == '\0')
        {
            continue;
        }
        output.push(' ');
        output.push_str(&name);
        output.push_str("=\"");
        output.push_str(&escape_mobi_attribute(value));
        output.push('"');
    }
    output
}

fn escape_mobi_attribute(value: &str) -> String {
    let value = normalize_named_entities(value);
    let mut output = String::with_capacity(value.len());
    let mut rest = value.as_str();
    while let Some(index) = rest.find('&') {
        output.push_str(&rest[..index]);
        let tail = &rest[index..];
        if tail.starts_with("&amp;")
            || tail.starts_with("&lt;")
            || tail.starts_with("&gt;")
            || tail.starts_with("&quot;")
            || tail.starts_with("&apos;")
            || tail.starts_with("&#")
        {
            output.push('&');
            rest = &tail[1..];
        } else {
            output.push_str("&amp;");
            rest = &tail[1..];
        }
    }
    output.push_str(rest);
    output
}

fn is_mobi_tag(name: &str) -> bool {
    matches!(
        name,
        "a" | "abbr"
            | "b"
            | "big"
            | "blockquote"
            | "body"
            | "br"
            | "caption"
            | "center"
            | "cite"
            | "code"
            | "col"
            | "dd"
            | "del"
            | "div"
            | "dl"
            | "dt"
            | "em"
            | "font"
            | "h1"
            | "h2"
            | "h3"
            | "h4"
            | "h5"
            | "h6"
            | "head"
            | "html"
            | "i"
            | "img"
            | "li"
            | "ol"
            | "p"
            | "pre"
            | "q"
            | "s"
            | "small"
            | "span"
            | "strike"
            | "strong"
            | "sub"
            | "sup"
            | "table"
            | "tbody"
            | "td"
            | "tfoot"
            | "th"
            | "thead"
            | "title"
            | "tr"
            | "tt"
            | "u"
            | "ul"
            | "var"
    )
}

fn rewrite_mobi_images(value: &str, image_paths: &HashMap<u32, String>) -> String {
    let image = Regex::new(r"(?is)<img\b([^>]*?)>").expect("MOBI image pattern");
    let recindex =
        Regex::new(r#"(?i)\brecindex\s*=\s*["']?(\d+)["']?"#).expect("MOBI recindex pattern");
    let embed = Regex::new(r"(?i)kindle:(?:embed|image):(\d+)").expect("MOBI embed pattern");
    let src = Regex::new(r#"(?i)\s+src\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)"#)
        .expect("MOBI image src pattern");
    image
        .replace_all(value, |captures: &regex::Captures<'_>| {
            let attrs = captures
                .get(1)
                .map(|value| value.as_str())
                .unwrap_or_default();
            let record = recindex
                .captures(attrs)
                .and_then(|value| value.get(1))
                .and_then(|value| value.as_str().parse::<u32>().ok())
                .or_else(|| {
                    embed
                        .captures(attrs)
                        .and_then(|value| value.get(1))
                        .and_then(|value| value.as_str().parse::<u32>().ok())
                });
            let Some(path) = record.and_then(|value| image_paths.get(&value)) else {
                return captures[0].to_owned();
            };
            let attrs = recindex.replace_all(attrs, "").into_owned();
            let attrs = embed.replace_all(&attrs, "").into_owned();
            let attrs = src.replace_all(&attrs, "").into_owned();
            format!("<img{attrs} src=\"{path}\" />")
        })
        .into_owned()
}

fn split_long_markup(value: &str) -> Vec<String> {
    let value = value.trim();
    if value.chars().count() <= MOBI_CHAPTER_CHAR_LIMIT {
        return if value.is_empty() {
            Vec::new()
        } else {
            vec![value.to_owned()]
        };
    }

    let mut output = Vec::new();
    let mut start = 0;
    while start < value.len() {
        let remaining = &value[start..];
        if remaining.chars().count() <= MOBI_CHAPTER_CHAR_LIMIT {
            if !remaining.trim().is_empty() {
                output.push(remaining.trim().to_owned());
            }
            break;
        }

        let target = byte_index_after_chars(remaining, MOBI_CHAPTER_CHAR_LIMIT);
        let max_boundary = byte_index_after_chars(remaining, MOBI_CHAPTER_CHAR_LIMIT * 2);
        let boundaries = mobi_paragraph_boundaries(remaining);
        let end = boundaries
            .iter()
            .copied()
            .take_while(|end| *end <= target)
            .last()
            .or_else(|| boundaries.iter().copied().find(|end| *end <= max_boundary))
            .unwrap_or(target);
        let end = safe_markup_boundary(remaining, end);
        let end = if end == 0 { target.max(1) } else { end };
        let fragment = remaining[..end].trim();
        if !fragment.is_empty() {
            output.push(fragment.to_owned());
        }
        start += end;
    }
    output
}

fn safe_markup_boundary(value: &str, target: usize) -> usize {
    let target = target.min(value.len());
    let before = &value[..target];
    let last_lt = before.rfind('<');
    let last_gt = before.rfind('>');
    if last_lt.is_some_and(|index| Some(index) > last_gt) {
        return value[target..]
            .find('>')
            .map(|index| target + index + 1)
            .unwrap_or(target);
    }
    let last_amp = before.rfind('&');
    let last_semicolon = before.rfind(';');
    if last_amp.is_some_and(|index| Some(index) > last_semicolon) {
        return value[target..]
            .find(';')
            .map(|index| target + index + 1)
            .unwrap_or(target);
    }
    target
}

fn mobi_paragraph_boundaries(value: &str) -> Vec<usize> {
    let bytes = value.as_bytes();
    let mut boundaries = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'<' {
            index += 1;
            continue;
        }
        let start = index;
        index += 1;
        let mut quote = None;
        while index < bytes.len() {
            let byte = bytes[index];
            if let Some(mark) = quote {
                if byte == mark {
                    quote = None;
                }
            } else if byte == b'\'' || byte == b'"' {
                quote = Some(byte);
            } else if byte == b'>' {
                let raw = &value[start..=index];
                if mobi_is_paragraph_boundary(raw) {
                    boundaries.push(index + 1);
                }
                index += 1;
                break;
            }
            index += 1;
        }
        if index >= bytes.len() && quote.is_some() {
            break;
        }
    }
    boundaries
}

fn mobi_is_paragraph_boundary(raw: &str) -> bool {
    let mut tag = raw.strip_prefix('<').unwrap_or(raw).trim_start_matches('/');
    tag = tag.trim_start();
    let name = tag
        .chars()
        .take_while(|character| character.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_lowercase();
    if raw
        .strip_prefix('<')
        .is_some_and(|value| value.trim_start().starts_with('/'))
    {
        matches!(
            name.as_str(),
            "p" | "li" | "blockquote" | "pre" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6"
        )
    } else {
        name == "br"
    }
}

fn byte_index_after_chars(value: &str, count: usize) -> usize {
    value
        .char_indices()
        .nth(count)
        .map(|(index, _)| index)
        .unwrap_or(value.len())
}

fn mobi_fragment_has_content(value: &str) -> bool {
    let text = mobi_markup_text(value);
    !text.trim().is_empty()
        || Regex::new(r"(?is)<img\b")
            .expect("MOBI image content pattern")
            .is_match(value)
}

fn mobi_heading_title(value: &str) -> Option<String> {
    let heading =
        Regex::new(r"(?is)<h[1-6]\b[^>]*>(.*?)</h[1-6]\s*>").expect("MOBI heading pattern");
    heading
        .captures(value)
        .and_then(|captures| captures.get(1))
        .map(|value| mobi_markup_text(value.as_str()))
        .filter(|value| !value.is_empty())
}

fn mobi_markup_text(value: &str) -> String {
    let value = Regex::new(r"(?is)<br\s*/?>")
        .expect("MOBI line break pattern")
        .replace_all(value, "\n")
        .into_owned();
    let value = Regex::new(r"(?is)<[^>]+>")
        .expect("MOBI tag pattern")
        .replace_all(&value, "")
        .into_owned();
    value
        .replace("&#160;", " ")
        .replace("&#xa0;", " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn plain_mobi_chapters(text: &str) -> Vec<MobiChapter> {
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut logical = Vec::new();
    let mut title = None;
    let mut lines = Vec::new();
    for line in normalized.lines() {
        if let Some(next_title) = plain_mobi_heading(line) {
            push_plain_logical(&mut logical, title.take(), &lines);
            lines.clear();
            title = Some(next_title);
        } else {
            lines.push(line.to_owned());
        }
    }
    push_plain_logical(&mut logical, title, &lines);

    let mut chapters = Vec::new();
    for (title, body) in logical {
        let chunks = split_plain_body(&body);
        for (index, chunk) in chunks.into_iter().enumerate() {
            chapters.push(MobiChapter {
                title: (index == 0).then(|| title.clone()).flatten(),
                body: render_plain_mobi_fragment(
                    (index == 0).then_some(title.as_deref()).flatten(),
                    &chunk,
                ),
            });
        }
    }
    chapters
}

fn plain_mobi_heading(line: &str) -> Option<String> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    static HEADING: OnceLock<Regex> = OnceLock::new();
    let pattern = HEADING.get_or_init(|| {
        Regex::new(
            r"(?i)^(?:chapter|part|volume|book|section)\s+[0-9ivxlcdm]+(?:\s*[:.\-].*|\s+.*)?$|^第\s*\d+\s*[章节回卷部篇].*$|^(?:序章|楔子|终章|尾声|番外(?:篇)?).*$",
        )
        .expect("MOBI plain heading pattern")
    });
    pattern.is_match(line).then(|| line.to_owned())
}

fn push_plain_logical(
    output: &mut Vec<(Option<String>, String)>,
    title: Option<String>,
    lines: &[String],
) {
    let body = lines.join("\n").trim().to_owned();
    if !body.is_empty() || title.is_some() {
        output.push((title, body));
    }
}

fn split_plain_body(value: &str) -> Vec<String> {
    if value.trim().is_empty() {
        return vec![String::new()];
    }
    let paragraphs = value
        .split("\n\n")
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    let units = if paragraphs.len() == 1 && paragraphs[0].chars().count() > MOBI_CHAPTER_CHAR_LIMIT
    {
        value
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .collect::<Vec<_>>()
    } else {
        paragraphs
    };
    let mut output = Vec::new();
    let mut current = String::new();
    for unit in units {
        let separator = if current.is_empty() { "" } else { "\n\n" };
        if !current.is_empty()
            && current.chars().count() + separator.chars().count() + unit.chars().count()
                > MOBI_CHAPTER_CHAR_LIMIT
        {
            output.push(std::mem::take(&mut current));
        }
        if !current.is_empty() {
            current.push_str("\n\n");
        }
        current.push_str(unit);
    }
    if !current.is_empty() {
        output.push(current);
    }
    if output.is_empty() {
        vec![String::new()]
    } else {
        output
    }
}

fn render_plain_mobi_fragment(title: Option<&str>, body: &str) -> String {
    let mut html = String::new();
    if let Some(title) = title.filter(|value| !value.trim().is_empty()) {
        html.push_str("<h1>");
        html.push_str(&xml_escape(title));
        html.push_str("</h1>");
    }
    for paragraph in body
        .split("\n\n")
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        html.push_str("<p>");
        html.push_str(&xml_escape(paragraph).replace('\n', "<br />"));
        html.push_str("</p>");
    }
    html
}

fn rewrite_mobi_links(chapters: &mut [MobiChapter]) {
    let anchor =
        Regex::new(r#"(?i)\b(?:id|name)\s*=\s*["']([^"']+)["']"#).expect("MOBI anchor pattern");
    let href = Regex::new(r#"(?i)(href\s*=\s*)(["'])([^"']*)(["'])"#).expect("MOBI href pattern");
    let mut owners = HashMap::new();
    for (index, chapter) in chapters.iter().enumerate() {
        for captures in anchor.captures_iter(&chapter.body) {
            if let Some(value) = captures.get(1) {
                owners.entry(value.as_str().to_owned()).or_insert(index);
            }
        }
    }
    for (index, chapter) in chapters.iter_mut().enumerate() {
        chapter.body = href
            .replace_all(&chapter.body, |captures: &regex::Captures<'_>| {
                let target = &captures[3];
                let Some((path, fragment)) = target.split_once('#') else {
                    return captures[0].to_owned();
                };
                if path.contains(':') || fragment.is_empty() {
                    return captures[0].to_owned();
                }
                let Some(owner) = owners.get(fragment).copied() else {
                    return captures[0].to_owned();
                };
                if owner == index && path.is_empty() {
                    return captures[0].to_owned();
                }
                format!(
                    "{}{}chapter-{}.xhtml#{}{}",
                    &captures[1],
                    &captures[2],
                    owner + 1,
                    fragment,
                    &captures[4]
                )
            })
            .into_owned();
    }
}

fn build_mobi_epub(
    title: &str,
    author: &str,
    chapters: &[MobiChapter],
    image_items: &[(String, &'static str, Vec<u8>)],
) -> Result<Vec<u8>, AppError> {
    let title = xml_escape(title);
    let author = xml_escape(author);
    let author_element = if author.trim().is_empty() {
        String::new()
    } else {
        format!("<dc:creator>{author}</dc:creator>")
    };
    let chapter_manifest = chapters
        .iter()
        .enumerate()
        .map(|(index, _)| {
            format!(
                "<item id=\"chapter-{}\" href=\"chapter-{}.xhtml\" media-type=\"application/xhtml+xml\"/>",
                index + 1,
                index + 1
            )
        })
        .collect::<String>();
    let spine = chapters
        .iter()
        .enumerate()
        .map(|(index, _)| format!("<itemref idref=\"chapter-{}\"/>", index + 1))
        .collect::<String>();
    let image_manifest = image_items
        .iter()
        .enumerate()
        .map(|(index, (path, mime, _))| {
            format!("<item id=\"image-{index}\" href=\"{path}\" media-type=\"{mime}\"/>")
        })
        .collect::<String>();
    let nav_items = chapters
        .iter()
        .enumerate()
        .map(|(index, chapter)| {
            let label = chapter
                .title
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .map(str::to_owned)
                .unwrap_or_else(|| format!("内容分段 {}", index + 1));
            format!(
                "<li><a href=\"chapter-{}.xhtml\">{}</a></li>",
                index + 1,
                xml_escape(&label)
            )
        })
        .collect::<String>();

    let mut writer = ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let stored = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    let deflated = SimpleFileOptions::default();
    writer
        .start_file("mimetype", stored)
        .map_err(|error| AppError::Archive(error.to_string()))?;
    writer.write_all(b"application/epub+zip")?;
    writer
        .start_file("META-INF/container.xml", deflated)
        .map_err(|error| AppError::Archive(error.to_string()))?;
    writer.write_all(br#"<?xml version="1.0" encoding="UTF-8"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>"#)?;
    writer
        .start_file("OEBPS/content.opf", deflated)
        .map_err(|error| AppError::Archive(error.to_string()))?;
    writer.write_all(
        format!(
            r#"<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="bookid">moth-{}</dc:identifier><dc:title>{title}</dc:title>{author_element}<dc:language>und</dc:language></metadata><manifest>{chapter_manifest}<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>{image_manifest}</manifest><spine>{spine}</spine></package>"#,
            uuidish(title.as_str())
        )
        .as_bytes(),
    )?;
    for (index, chapter) in chapters.iter().enumerate() {
        writer
            .start_file(format!("OEBPS/chapter-{}.xhtml", index + 1), deflated)
            .map_err(|error| AppError::Archive(error.to_string()))?;
        writer.write_all(
            format!(
                r#"<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>{title}</title></head><body>{}</body></html>"#,
                chapter.body
            )
            .as_bytes(),
        )?;
    }
    writer
        .start_file("OEBPS/nav.xhtml", deflated)
        .map_err(|error| AppError::Archive(error.to_string()))?;
    writer.write_all(
        format!(
            r#"<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>{title}</title></head><body><nav epub:type="toc" id="toc"><h2>{title}</h2><ol>{nav_items}</ol></nav></body></html>"#
        )
        .as_bytes(),
    )?;
    for (path, _mime, bytes) in image_items {
        writer
            .start_file(format!("OEBPS/{path}"), deflated)
            .map_err(|error| AppError::Archive(error.to_string()))?;
        writer.write_all(bytes)?;
    }
    writer
        .finish()
        .map_err(|error| AppError::Archive(error.to_string()))
        .map(|cursor| cursor.into_inner())
}

fn validate_generated_epub(
    bytes: &[u8],
    chapter_count: usize,
    image_paths: &[&str],
) -> Result<(), AppError> {
    if chapter_count == 0 {
        return Err(AppError::Validation("MOBI 转换没有生成任何章节".to_owned()));
    }
    let mut archive = ZipArchive::new(Cursor::new(bytes))
        .map_err(|error| AppError::Validation(format!("生成的 EPUB 不是有效 ZIP：{error}")))?;
    if archive.is_empty() {
        return Err(AppError::Validation("生成的 EPUB 为空".to_owned()));
    }
    let (name, compression, content) = {
        let mut entry = archive
            .by_index(0)
            .map_err(|error| AppError::Validation(format!("生成的 EPUB 缺少 mimetype：{error}")))?;
        let name = entry.name().to_owned();
        let compression = entry.compression();
        let mut content = Vec::new();
        entry.read_to_end(&mut content)?;
        (name, compression, content)
    };
    if name != "mimetype"
        || compression != zip::CompressionMethod::Stored
        || content != b"application/epub+zip"
    {
        return Err(AppError::Validation(
            "生成的 EPUB 的 mimetype 不符合规范".to_owned(),
        ));
    }

    let names = (0..archive.len())
        .map(|index| {
            archive
                .by_index(index)
                .map(|entry| entry.name().to_owned())
                .map_err(|error| AppError::Validation(format!("读取 EPUB 目录失败：{error}")))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let names = names.into_iter().collect::<std::collections::HashSet<_>>();
    for required in [
        "META-INF/container.xml",
        "OEBPS/content.opf",
        "OEBPS/nav.xhtml",
    ] {
        if !names.contains(required) {
            return Err(AppError::Validation(format!("生成的 EPUB 缺少 {required}")));
        }
    }
    for index in 1..=chapter_count {
        let name = format!("OEBPS/chapter-{index}.xhtml");
        if !names.contains(&name) {
            return Err(AppError::Validation(format!("生成的 EPUB 缺少 {name}")));
        }
    }
    for path in image_paths {
        let name = format!("OEBPS/{path}");
        if !names.contains(&name) {
            return Err(AppError::Validation(format!(
                "生成的 EPUB 缺少图片资源 {name}"
            )));
        }
    }

    let xml_names = names
        .iter()
        .filter(|name| name.ends_with(".xml") || name.ends_with(".opf") || name.ends_with(".xhtml"))
        .cloned()
        .collect::<Vec<_>>();
    for name in &xml_names {
        let content = archive_entry_bytes(&mut archive, name)?;
        validate_xml_document(&content, name)?;
    }

    let reference =
        Regex::new(r#"(?i)\b(?:href|src)\s*=\s*["']([^"']+)["']"#).expect("EPUB reference pattern");
    for name in xml_names {
        let content = archive_entry_bytes(&mut archive, &name)?;
        let text = String::from_utf8_lossy(&content);
        let base = name.rsplit_once('/').map(|(base, _)| base).unwrap_or("");
        for captures in reference.captures_iter(&text) {
            let value = captures.get(1).map(|value| value.as_str()).unwrap_or("");
            let local = value.split('#').next().unwrap_or("");
            if local.is_empty() || local.contains(':') {
                continue;
            }
            let resolved = moth_format::resolve_reference(base, local);
            if !names.contains(&resolved) {
                return Err(AppError::Validation(format!(
                    "生成的 EPUB 引用了不存在的资源 {resolved}"
                )));
            }
        }
    }
    Ok(())
}

fn archive_entry_bytes<R: Read + std::io::Seek>(
    archive: &mut ZipArchive<R>,
    name: &str,
) -> Result<Vec<u8>, AppError> {
    let mut entry = archive
        .by_name(name)
        .map_err(|error| AppError::Validation(format!("读取生成的 EPUB {name} 失败：{error}")))?;
    let mut content = Vec::new();
    entry.read_to_end(&mut content)?;
    Ok(content)
}

fn validate_xml_document(bytes: &[u8], name: &str) -> Result<(), AppError> {
    let mut reader = XmlReader::from_reader(bytes);
    loop {
        match reader.read_event() {
            Ok(Event::Eof) => return Ok(()),
            Ok(_) => {}
            Err(error) => {
                return Err(AppError::Validation(format!(
                    "生成的 EPUB 文档 {name} 不是合法 XML：{error}"
                )));
            }
        }
    }
}

fn mobi_conversion_error(error: impl std::fmt::Display) -> AppError {
    AppError::Validation(format!(
        "MOBI 不支持、包含 DRM 或已损坏，请转换为 EPUB：{error}"
    ))
}

fn mobi_image_type(bytes: &[u8]) -> Option<(&'static str, &'static str)> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some(("png", "image/png"))
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some(("gif", "image/gif"))
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some(("webp", "image/webp"))
    } else if bytes.starts_with(b"BM") {
        Some(("bmp", "image/bmp"))
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some(("jpg", "image/jpeg"))
    } else {
        None
    }
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}
fn uuidish(value: &str) -> String {
    format!("{:x}", md5_like(value.as_bytes()))
}
fn md5_like(bytes: &[u8]) -> u64 {
    let mut value = 0xcbf29ce484222325u64;
    for byte in bytes {
        value ^= u64::from(*byte);
        value = value.wrapping_mul(0x100000001b3);
    }
    value
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_single_and_suffix_ranges() {
        assert_eq!(parse_range("bytes=0-9", 20), Some((0, 9)));
        assert_eq!(parse_range("bytes=10-", 20), Some((10, 19)));
        assert_eq!(parse_range("bytes=-4", 20), Some((16, 19)));
        assert_eq!(parse_range("bytes=20-", 20), None);
        assert_eq!(parse_range("bytes=0-1,4-5", 20), Some((0, 1)));
    }

    #[tokio::test]
    async fn range_response_streams_full_and_partial_files() {
        let temp = tempfile::tempdir().expect("temporary directory");
        let path = temp.path().join("book.epub");
        let source = (0_u8..=255).collect::<Vec<_>>();
        tokio::fs::write(&path, &source).await.expect("fixture");

        let response = range_response(&path, &HeaderMap::new(), "application/epub+zip", "\"v1\"")
            .await
            .expect("full response");
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), 1024)
            .await
            .expect("full body");
        assert_eq!(body.as_ref(), source.as_slice());

        let mut headers = HeaderMap::new();
        headers.insert(header::RANGE, "bytes=10-19".parse().expect("range header"));
        let response = range_response(&path, &headers, "application/epub+zip", "\"v1\"")
            .await
            .expect("partial response");
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        let body = axum::body::to_bytes(response.into_body(), 1024)
            .await
            .expect("partial body");
        assert_eq!(body.as_ref(), &source[10..20]);
    }

    #[test]
    fn home_series_prioritizes_active_reading_and_limits_to_four() {
        let mut candidates = [
            ("z-active", Some(20)),
            ("delta", None),
            ("alpha", None),
            ("echo", None),
            ("bravo", None),
            ("charlie", None),
        ]
        .into_iter()
        .map(|(name, active_at)| SeriesCandidate {
            preview: HomeSeriesPreview {
                name: name.to_owned(),
                path: name.to_owned(),
                publication_count: 1,
                representative: None,
            },
            active_at,
        })
        .collect::<Vec<_>>();

        order_home_series(&mut candidates);

        assert_eq!(
            candidates
                .iter()
                .map(|candidate| candidate.preview.name.as_str())
                .collect::<Vec<_>>(),
            vec!["z-active", "alpha", "bravo", "charlie"]
        );
    }

    #[test]
    fn natural_filename_order_handles_volume_numbers() {
        let mut names = vec!["卷10.epub", "卷2.epub", "卷1.epub"];
        names.sort_by(|left, right| {
            natural_filename_compare(left, right)
                .then_with(|| left.to_lowercase().cmp(&right.to_lowercase()))
        });
        assert_eq!(names, vec!["卷1.epub", "卷2.epub", "卷10.epub"]);
    }

    #[test]
    fn hidden_directory_matching_is_segment_aware() {
        let hidden = ["私人"].as_slice();
        assert!(is_hidden_directory_path("私人", hidden));
        assert!(is_hidden_directory_path("私人/系列", hidden));
        assert!(!is_hidden_directory_path("私人备份/系列", hidden));
        assert!(!is_hidden_directory_path("公开/私人", hidden));
    }

    #[tokio::test]
    async fn continue_reading_filters_hidden_shelves_before_limit() {
        let db = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("sqlite");
        sqlx::query(
            "CREATE TABLE directories (id INTEGER PRIMARY KEY, relative_path TEXT NOT NULL)",
        )
        .execute(&db)
        .await
        .expect("directories");
        sqlx::query("CREATE TABLE publications (id INTEGER PRIMARY KEY, directory_id INTEGER NOT NULL, title TEXT NOT NULL, author TEXT, format TEXT NOT NULL, sha256 TEXT NOT NULL, file_size INTEGER NOT NULL, filename TEXT NOT NULL, parse_status TEXT NOT NULL, has_cover INTEGER NOT NULL)")
            .execute(&db)
            .await
            .expect("publications");
        sqlx::query("CREATE TABLE reading_progress (publication_id INTEGER PRIMARY KEY, progress REAL NOT NULL, updated_at INTEGER NOT NULL)")
            .execute(&db)
            .await
            .expect("progress");
        sqlx::query("INSERT INTO directories (id,relative_path) VALUES (1,'隐藏'),(2,'隐藏备份'),(3,'公开')")
            .execute(&db)
            .await
            .expect("directory rows");
        for (id, directory_id, title, updated_at) in [
            (1_i64, 1_i64, "hidden", 30_i64),
            (2, 2, "similar", 20),
            (3, 3, "visible", 10),
        ] {
            sqlx::query("INSERT INTO publications (id,directory_id,title,author,format,sha256,file_size,filename,parse_status,has_cover) VALUES (?,?,?,?,?,?,?,?,?,?)")
                .bind(id)
                .bind(directory_id)
                .bind(title)
                .bind(None::<String>)
                .bind("txt")
                .bind(format!("hash-{id}"))
                .bind(1_i64)
                .bind(format!("{title}.txt"))
                .bind("ok")
                .bind(false)
                .execute(&db)
                .await
                .expect("publication row");
            sqlx::query(
                "INSERT INTO reading_progress (publication_id,progress,updated_at) VALUES (?,?,?)",
            )
            .bind(id)
            .bind(0.5_f64)
            .bind(updated_at)
            .execute(&db)
            .await
            .expect("progress row");
        }
        let books = fetch_continue_reading(&db, &["隐藏"])
            .await
            .expect("home query");
        assert_eq!(
            books
                .iter()
                .map(|book| book.title.as_str())
                .collect::<Vec<_>>(),
            ["similar", "visible"]
        );
    }

    #[tokio::test]
    async fn home_directories_move_marked_shelves_to_hidden_entries() {
        let temp = tempfile::tempdir().expect("temporary directory");
        let books_root = temp.path().join("books");
        let data_root = temp.path().join("data");
        std::fs::create_dir_all(books_root.join("隐藏")).expect("hidden shelf");
        std::fs::create_dir_all(books_root.join("公开").join("系列")).expect("visible shelf");
        let marker = books_root.join("隐藏").join("hide");
        std::fs::File::create(&marker).expect("hide marker");
        let mut config = crate::config::Config::for_test(data_root);
        config.books_dir = books_root.clone();
        let db = crate::db::connect(&config).await.expect("database");
        sqlx::query(
            "INSERT INTO directories (parent_id,name,relative_path,updated_at) VALUES (NULL,?,?,0)",
        )
        .bind("书库")
        .bind("")
        .execute(&db)
        .await
        .expect("root directory");
        let root_id: i64 = sqlx::query_scalar("SELECT id FROM directories WHERE relative_path=''")
            .fetch_one(&db)
            .await
            .expect("root id");
        for (name, path) in [("隐藏", "隐藏"), ("公开", "公开")] {
            sqlx::query("INSERT INTO directories (parent_id,name,relative_path,updated_at) VALUES (?,?,?,0)")
                .bind(root_id)
                .bind(name)
                .bind(path)
                .execute(&db)
                .await
                .expect("category");
        }
        let visible_id: i64 =
            sqlx::query_scalar("SELECT id FROM directories WHERE relative_path='公开'")
                .fetch_one(&db)
                .await
                .expect("visible id");
        sqlx::query(
            "INSERT INTO directories (parent_id,name,relative_path,updated_at) VALUES (?,?,?,0)",
        )
        .bind(visible_id)
        .bind("系列")
        .bind("公开/系列")
        .execute(&db)
        .await
        .expect("series");

        let (visible, hidden) = fetch_home_directories(&db, &books_root)
            .await
            .expect("home directories");
        assert_eq!(
            hidden
                .iter()
                .map(|entry| entry.name.as_str())
                .collect::<Vec<_>>(),
            ["隐藏"]
        );
        assert_eq!(
            visible
                .iter()
                .map(|entry| entry.name.as_str())
                .collect::<Vec<_>>(),
            ["公开"]
        );
        assert_eq!(visible[0].series[0].name, "系列");

        // The marker is filesystem state, so removing it takes effect on the
        // next home request without a scan or a database update.
        std::fs::remove_file(marker).expect("remove hide marker");
        let (visible, hidden) = fetch_home_directories(&db, &books_root)
            .await
            .expect("home directories after marker removal");
        assert!(hidden.is_empty());
        assert!(visible.iter().any(|entry| entry.name == "隐藏"));
    }

    #[test]
    fn page_thumbnail_is_jpeg_with_maximum_edge() {
        let source = image::RgbImage::from_pixel(480, 300, image::Rgb([20, 80, 140]));
        let mut raw = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(source)
            .write_to(&mut raw, image::ImageFormat::Png)
            .expect("encode source image");
        let thumbnail = encode_page_thumbnail(raw.get_ref()).expect("encode thumbnail");
        let decoded = image::load_from_memory(&thumbnail).expect("decode thumbnail");
        assert_eq!(decoded.width(), 240);
        assert_eq!(decoded.height(), 150);
    }

    #[test]
    fn repairs_malformed_mobi_markup_and_xml_entities() {
        let normalized = normalize_mobi_markup(
            r#"<p>Tom & Jerry</p><p>宽度 <3pt" width="1em"</p><img recindex="7">"#,
        );
        let repaired = repair_mobi_fragment(&normalized);
        assert!(repaired.contains("&amp;"));
        assert!(repaired.contains("&lt;3pt"));
        validate_xml_document(
            format!(r#"<html xmlns="http://www.w3.org/1999/xhtml"><body>{repaired}</body></html>"#)
                .as_bytes(),
            "malformed-test.xhtml",
        )
        .expect("repaired MOBI fragment should be XML");
    }

    #[test]
    fn builds_mobi_epub_with_chapters_images_and_cross_chapter_links() {
        let mut chapters = vec![
            MobiChapter {
                title: Some("第一章".to_owned()),
                body: r#"<h1 id="start">第一章</h1><p><a href="source.xhtml#ending">继续</a></p>"#
                    .to_owned(),
            },
            MobiChapter {
                title: Some("第二章".to_owned()),
                body: r#"<h1 id="ending">第二章</h1><p>结束</p>"#.to_owned(),
            },
        ];
        rewrite_mobi_links(&mut chapters);
        assert!(chapters[0].body.contains("chapter-2.xhtml#ending"));

        let image = vec![0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n'];
        let image_items = vec![("images/record-7.png".to_owned(), "image/png", image)];
        let bytes = build_mobi_epub("Alice", "Author", &chapters, &image_items)
            .expect("build converted EPUB");
        validate_generated_epub(&bytes, chapters.len(), &["images/record-7.png"])
            .expect("converted EPUB should validate");

        let mut archive = ZipArchive::new(Cursor::new(bytes)).expect("valid EPUB zip");
        let mut nav = String::new();
        archive
            .by_name("OEBPS/nav.xhtml")
            .expect("nav document")
            .read_to_string(&mut nav)
            .expect("read nav document");
        assert_eq!(nav.matches("<a href=").count(), 2);
    }

    #[test]
    fn converts_fixture_to_minimal_epub3() {
        let source =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../moth-format/tests/fixtures/alice.mobi");
        let temp = tempfile::tempdir().expect("temporary directory");
        convert_mobi(&source, temp.path()).expect("classic MOBI conversion");
        let file = std::fs::File::open(temp.path().join("book.epub")).expect("converted EPUB");
        let mut archive = ZipArchive::new(file).expect("valid EPUB zip");
        assert_eq!(
            archive.by_name("mimetype").expect("mimetype").size(),
            "application/epub+zip".len() as u64
        );
        assert!(archive.by_name("OEBPS/content.opf").is_ok());
        assert!(archive.by_name("OEBPS/nav.xhtml").is_ok());
        assert!(archive.by_name("OEBPS/chapter-1.xhtml").is_ok());
    }
}
