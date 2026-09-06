//! Book API handlers: the library shelf, reading content, and progress.

use std::io::Read;
use std::path::Path;

use axum::{
    Json,
    extract::{Path as AxumPath, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use sqlx::Row;
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
        sqlx::query_as::<_, (i64, String)>(
            "SELECT idx, title FROM chapters WHERE book_id = ? ORDER BY idx",
        )
        .bind(id)
        .fetch_all(&state.db)
        .await?
        .into_iter()
        .map(|(idx, title)| ChapterInfo { idx, title })
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

pub async fn get_chapter(
    State(state): State<AppState>,
    _user: Authenticated,
    AxumPath((book_id, idx)): AxumPath<(i64, i64)>,
) -> Result<Json<ChapterContent>, AppError> {
    let row = sqlx::query("SELECT title, content FROM chapters WHERE book_id = ? AND idx = ?")
        .bind(book_id)
        .bind(idx)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| AppError::NotFound)?;
    Ok(Json(ChapterContent {
        idx,
        title: row.try_get("title")?,
        content: row.try_get("content")?,
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
