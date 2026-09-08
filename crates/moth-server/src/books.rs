//! Publication API and format-specific reader endpoints.

use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Arc,
};

use axum::{
    Json,
    body::Body,
    extract::{Path as AxumPath, Query, State},
    http::{HeaderMap, StatusCode, header},
    response::Response,
};
use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};
use zip::{ZipArchive, ZipWriter, write::SimpleFileOptions};

use crate::{
    auth::Authenticated,
    error::AppError,
    library::now_unix,
    state::{AppState, ConversionState},
};

const CONTENT_ADAPTER_VERSION: &str = "core-v1";

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
    let mut continue_reading = fetch_publications(&state.db, None, Some("progress")).await?;
    continue_reading.retain(|book| book.progress > 0.0 && book.progress < 1.0);
    continue_reading.truncate(12);
    let directories = fetch_home_directories(&state.db).await?;
    Ok(Json(HomeResponse {
        continue_reading,
        directories,
    }))
}

struct SeriesCandidate {
    preview: HomeSeriesPreview,
    active_at: Option<i64>,
}

async fn fetch_home_directories(db: &SqlitePool) -> Result<Vec<HomeDirectoryPreview>, AppError> {
    let Some(root_id) =
        sqlx::query_scalar::<_, i64>("SELECT id FROM directories WHERE relative_path=''")
            .fetch_optional(db)
            .await?
    else {
        return Ok(Vec::new());
    };
    let categories = sqlx::query(
        "SELECT id,name,relative_path FROM directories WHERE parent_id=? ORDER BY name COLLATE NOCASE",
    )
    .bind(root_id)
    .fetch_all(db)
    .await?;
    let mut output = Vec::with_capacity(categories.len());
    for category in categories {
        let category_id: i64 = category.try_get("id")?;
        let series_rows = sqlx::query(
            "SELECT id,name,relative_path FROM directories WHERE parent_id=? ORDER BY name COLLATE NOCASE",
        )
        .bind(category_id)
        .fetch_all(db)
        .await?;
        let mut candidates = Vec::with_capacity(series_rows.len());
        for series in series_rows {
            let series_id: i64 = series.try_get("id")?;
            let publications = fetch_publications(db, Some(series_id), Some("filename")).await?;
            let active_at: Option<i64> = sqlx::query_scalar(
                "SELECT MAX(r.updated_at) FROM publications p JOIN reading_progress r ON r.publication_id=p.id WHERE p.directory_id=? AND r.progress>0 AND r.progress<1",
            )
            .bind(series_id)
            .fetch_one(db)
            .await?;
            candidates.push(SeriesCandidate {
                preview: HomeSeriesPreview {
                    name: series.try_get("name")?,
                    path: series.try_get("relative_path")?,
                    publication_count: publications.len() as i64,
                    representative: publications
                        .iter()
                        .find(|publication| publication.parse_status == "ok")
                        .cloned()
                        .or_else(|| publications.first().cloned()),
                },
                active_at,
            });
        }
        order_home_series(&mut candidates);
        output.push(HomeDirectoryPreview {
            name: category.try_get("name")?,
            path: category.try_get("relative_path")?,
            series: candidates
                .into_iter()
                .map(|candidate| candidate.preview)
                .collect(),
        });
    }
    Ok(output)
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
    let order = match sort {
        Some("added") => "p.added_at DESC, p.title COLLATE NOCASE",
        Some("progress") => "COALESCE(r.updated_at, 0) DESC, p.title COLLATE NOCASE",
        Some("filename") => "p.filename COLLATE NOCASE, p.title COLLATE NOCASE",
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
    Ok(out)
}

fn summary_from_row(row: &sqlx::sqlite::SqliteRow) -> Result<PublicationSummary, sqlx::Error> {
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
) -> Result<Json<BookDetail>, AppError> {
    let row = publication_row(&state.db, &state.config.books_dir, id).await?;
    let summary = fetch_publications(&state.db, Some(row.directory_id), Some("title"))
        .await?
        .into_iter()
        .find(|value| value.id == id)
        .ok_or(AppError::NotFound)?;
    let chapters = sqlx::query("SELECT idx,title,character_count FROM text_chapters WHERE publication_id=? AND encoding='auto' ORDER BY idx").bind(id).fetch_all(&state.db).await?.into_iter().map(|row| Ok(ChapterInfo { idx: row.try_get("idx")?, title: row.try_get("title")?, character_count: row.try_get("character_count")? })).collect::<Result<Vec<_>, sqlx::Error>>()?;
    let pages =
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
                })
            })
            .collect::<Result<Vec<_>, sqlx::Error>>()?;
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
    if !supported_encoding(&encoding) {
        return Err(AppError::Validation("unsupported TXT encoding".to_owned()));
    }
    let chapter_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM text_chapters WHERE publication_id=? AND encoding=?",
    )
    .bind(id)
    .bind(&encoding)
    .fetch_one(&state.db)
    .await?;
    if chapter_count == 0 && encoding != "auto" {
        let path = row.root.join(&row.relative_path);
        let version = current_content_version(&row, Some(&encoding));
        crate::library::write_text_cache(&state, id, &version, &path, &encoding).await?;
    }
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
    let bytes = tokio::task::spawn_blocking(move || {
        let file = std::fs::File::open(source)?;
        let mut zip = ZipArchive::new(file).map_err(std::io::Error::other)?;
        let mut item = zip.by_name(&entry).map_err(std::io::Error::other)?;
        let mut bytes = Vec::new();
        item.read_to_end(&mut bytes)?;
        Ok::<_, std::io::Error>(bytes)
    })
    .await
    .map_err(|error| AppError::Io(std::io::Error::other(error)))??;
    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime)
        .header(
            header::ETAG,
            format!("\"{}-page-{idx}\"", current_content_version(&row, None)),
        )
        .header(header::CACHE_CONTROL, "no-cache")
        .header(header::CONTENT_LENGTH, bytes.len())
        .body(Body::from(bytes))
        .expect("page response"))
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
    if !target.exists() {
        let target_dir = state.thumbnails_dir(&version);
        tokio::fs::create_dir_all(&target_dir).await?;
        let raw = tokio::task::spawn_blocking(move || {
            let file = std::fs::File::open(source)?;
            let mut zip = ZipArchive::new(file).map_err(std::io::Error::other)?;
            let mut item = zip.by_name(&entry).map_err(std::io::Error::other)?;
            let mut bytes = Vec::new();
            item.read_to_end(&mut bytes)?;
            Ok::<_, std::io::Error>(bytes)
        })
        .await
        .map_err(|error| AppError::Io(std::io::Error::other(error)))??;
        let encoded = tokio::task::spawn_blocking(move || encode_page_thumbnail(&raw))
            .await
            .map_err(|error| AppError::Io(std::io::Error::other(error)))??;
        let temp = target.with_extension("tmp");
        tokio::fs::write(&temp, encoded).await?;
        tokio::fs::rename(&temp, &target).await?;
    }
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

fn encode_page_thumbnail(raw: &[u8]) -> Result<Vec<u8>, AppError> {
    let image = image::load_from_memory(raw)
        .map_err(|error| AppError::Validation(format!("invalid CBZ page: {error}")))?
        .thumbnail(240, 240);
    let mut output = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut output, 78)
        .encode_image(&image)
        .map_err(|error| AppError::Validation(format!("could not encode thumbnail: {error}")))?;
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
    let row = sqlx::query("SELECT id,directory_id,relative_path,format,sha256,file_size,mtime_ns,has_cover FROM publications WHERE id=?").bind(id).fetch_optional(db).await?.ok_or(AppError::NotFound)?;
    Ok(PublicationRow {
        id: row.try_get("id")?,
        directory_id: row.try_get("directory_id")?,
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
    directory_id: i64,
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
        let bytes = tokio::fs::read(path).await?;
        return Ok(common(Response::builder())
            .status(StatusCode::OK)
            .header(header::CONTENT_LENGTH, bytes.len())
            .body(Body::from(bytes))
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
    tokio::io::AsyncSeekExt::seek(&mut file, std::io::SeekFrom::Start(start)).await?;
    let mut body = vec![
        0_u8;
        usize::try_from(length).map_err(|_| AppError::Validation(
            "requested range is too large".to_owned()
        ))?
    ];
    tokio::io::AsyncReadExt::read_exact(&mut file, &mut body).await?;
    Ok(common(Response::builder())
        .status(StatusCode::PARTIAL_CONTENT)
        .header(
            header::CONTENT_RANGE,
            format!("bytes {start}-{end}/{total}"),
        )
        .header(header::CONTENT_LENGTH, body.len())
        .body(Body::from(body))
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
    std::fs::create_dir_all(directory)?;
    let target = directory.join("book.epub");
    let book = mobi::Mobi::from_path(source).map_err(mobi_conversion_error)?;
    let text = match book.content_as_string() {
        Ok(text) => text,
        Err(_) => book.content_as_string_lossy(),
    };
    if text.trim().is_empty() {
        return Err(mobi_conversion_error("没有可读取的正文"));
    }
    let title = xml_escape(&book.title());
    let author = xml_escape(&book.author().unwrap_or_default());
    let mut image_items = Vec::new();
    let mut image_paths = std::collections::HashMap::new();
    for record in book.image_records() {
        let Some((extension, mime)) = mobi_image_type(record.content) else {
            continue;
        };
        let path = format!("images/record-{}.{}", record.record.id, extension);
        image_paths.insert(record.record.id, path.clone());
        image_items.push((path, mime, record.content.to_vec()));
    }
    let mut html = if text.to_ascii_lowercase().contains("<html") {
        moth_format::html::sanitize_html(&text)
    } else {
        format!("<p>{}</p>", xml_escape(&text).replace('\n', "</p><p>"))
    };
    // Classic MOBI embeds image references as `recindex` attributes. Repoint
    // those references at the image entries written into the generated EPUB.
    for (record_id, path) in &image_paths {
        for quote in [
            format!("recindex=\"{record_id}\""),
            format!("recindex='{record_id}'"),
        ] {
            html = html.replace(&quote, &format!("src=\"{path}\""));
        }
    }
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
    writer.write_all(br#"<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>"#)?;
    writer
        .start_file("OEBPS/content.opf", deflated)
        .map_err(|error| AppError::Archive(error.to_string()))?;
    let image_manifest = image_items
        .iter()
        .enumerate()
        .map(|(index, (path, mime, _))| {
            format!("<item id=\"image-{index}\" href=\"{path}\" media-type=\"{mime}\"/>")
        })
        .collect::<String>();
    writer.write_all(format!(r#"<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="bookid">moth-{}</dc:identifier><dc:title>{title}</dc:title><dc:creator>{author}</dc:creator></metadata><manifest><item id="chapter-1" href="chapter-1.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>{image_manifest}</manifest><spine><itemref idref="chapter-1"/></spine></package>"#, uuidish(&title)).as_bytes())?;
    writer
        .start_file("OEBPS/chapter-1.xhtml", deflated)
        .map_err(|error| AppError::Archive(error.to_string()))?;
    writer.write_all(format!(r#"<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>{title}</title></head><body>{html}</body></html>"#).as_bytes())?;
    writer
        .start_file("OEBPS/nav.xhtml", deflated)
        .map_err(|error| AppError::Archive(error.to_string()))?;
    writer.write_all(format!(r#"<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>{title}</title></head><body><nav epub:type="toc" id="toc"><h2>{title}</h2><ol><li><a href="chapter-1.xhtml">{title}</a></li></ol></nav></body></html>"#).as_bytes())?;
    for (path, _mime, bytes) in image_items {
        writer
            .start_file(format!("OEBPS/{path}"), deflated)
            .map_err(|error| AppError::Archive(error.to_string()))?;
        writer.write_all(&bytes)?;
    }
    let bytes = writer
        .finish()
        .map_err(|error| AppError::Archive(error.to_string()))?
        .into_inner();
    let temp = target.with_extension("tmp");
    std::fs::write(&temp, bytes)?;
    std::fs::rename(temp, target)?;
    Ok(())
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
