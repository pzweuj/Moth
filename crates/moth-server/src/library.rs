//! Library scanning and persistence. Books are discovered under the read-only
//! library directory, parsed by `moth-format`, and indexed in SQLite with
//! derived content (chapters, resources, cover thumbnails) in the writable
//! data directory.

use std::path::{Path, PathBuf};

use axum::extract::State;
use image::codecs::jpeg::JpegEncoder;
use moth_format::BookFormat;
use sha2::{Digest, Sha256};
use sqlx::{Row, SqlitePool};
use time::OffsetDateTime;

use crate::auth::Authenticated;
use crate::error::AppError;
use crate::state::AppState;

/// HTTP handler: kick off a background scan.
pub async fn start_scan(
    State(state): State<AppState>,
    _user: Authenticated,
) -> Result<(), AppError> {
    start_scan_on(&state).await
}

/// Kick off a background scan. Returns a conflict while one is already
/// running; otherwise spawns the scan task and returns immediately.
pub async fn start_scan_on(state: &AppState) -> Result<(), AppError> {
    {
        let mut status = state.scan_status.lock().await;
        if status.scanning {
            return Err(AppError::Conflict {
                code: "scan_in_progress",
                message: "A library scan is already running",
            });
        }
        status.scanning = true;
        status.processed = 0;
        status.total = 0;
        status.errors = 0;
        status.message = String::new();
    }

    let state = state.clone();
    tokio::spawn(async move {
        if let Err(error) = run_scan(&state).await {
            tracing::error!(%error, "library scan failed");
            state.scan_status.lock().await.message = error.to_string();
        }
        state.scan_status.lock().await.scanning = false;
    });
    Ok(())
}

async fn run_scan(state: &AppState) -> Result<(), AppError> {
    let books_dir = state.config.books_dir.clone();
    if !books_dir.is_dir() {
        state.scan_status.lock().await.message =
            format!("books directory not found: {}", books_dir.display());
        return Ok(());
    }

    let books_dir_for_scan = books_dir.clone();
    let files: Vec<PathBuf> =
        tokio::task::spawn_blocking(move || collect_books(&books_dir_for_scan))
            .await
            .map_err(|error| AppError::Io(std::io::Error::other(error)))?;

    state.scan_status.lock().await.total = files.len() as u64;

    let mut seen: Vec<String> = Vec::with_capacity(files.len());
    for path in files {
        let relative = path
            .strip_prefix(&books_dir)
            .map(|rel| rel.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|_| path.to_string_lossy().into_owned());
        seen.push(relative.clone());

        let (format, hashed) = {
            let path = path.clone();
            tokio::task::spawn_blocking(move || {
                let format = BookFormat::from_path(&path);
                let hashed = hash_file(&path).map_err(AppError::from);
                (format, hashed)
            })
            .await
            .map_err(|error| AppError::Io(std::io::Error::other(error)))?
        };
        let Some(format) = format else {
            // Unreachable in practice: collect_books only returns files whose
            // extension named a supported format.
            continue;
        };
        let (hash, size) = match hashed {
            Ok(values) => values,
            Err(error) => {
                // The file could not be read (removed mid-scan, permission
                // changes, ...). Record it so the shelf shows the failure
                // instead of silently dropping it.
                store_parse_error(
                    state,
                    &relative,
                    format,
                    String::new(),
                    0,
                    &error.to_string(),
                )
                .await?;
                bump_processed(state).await;
                continue;
            }
        };

        if is_unchanged(&state.db, &relative, &hash, size).await? {
            bump_processed(state).await;
            continue;
        }

        let parsed =
            tokio::task::spawn_blocking(move || moth_format::ParsedBook::parse_as(&path, format))
                .await
                .map_err(|error| AppError::Io(std::io::Error::other(error)))?;

        match parsed {
            Ok(mut book) => store_book(state, &relative, format, hash, size, &mut book).await?,
            Err(error) => {
                store_parse_error(state, &relative, format, hash, size, &error.to_string()).await?
            }
        }
        bump_processed(state).await;
    }

    prune_missing(state, &seen).await?;
    Ok(())
}

async fn bump_processed(state: &AppState) {
    let mut status = state.scan_status.lock().await;
    status.processed += 1;
}

fn collect_books(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(current) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&current) else {
            continue;
        };
        let mut dirs = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            if path.is_dir() {
                dirs.push(path);
            } else if BookFormat::from_path(&path).is_some() {
                out.push(path);
            }
        }
        dirs.reverse();
        stack.extend(dirs);
    }
    out.sort();
    out
}

fn hash_file(path: &Path) -> std::io::Result<(String, u64)> {
    use std::io::Read;

    let mut file = std::fs::File::open(path)?;
    let size = file.metadata()?.len();
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok((hex::encode(hasher.finalize()), size))
}

async fn is_unchanged(
    db: &SqlitePool,
    relative: &str,
    hash: &str,
    size: u64,
) -> Result<bool, AppError> {
    let row =
        sqlx::query("SELECT sha256, file_size, parse_status FROM books WHERE relative_path = ?")
            .bind(relative)
            .fetch_optional(db)
            .await?;
    Ok(match row {
        Some(row) => {
            let existing_hash: String = row.try_get("sha256")?;
            let existing_size: i64 = row.try_get("file_size")?;
            let status: String = row.try_get("parse_status")?;
            existing_hash == hash && existing_size == size as i64 && status == "ok"
        }
        None => false,
    })
}

fn now_unix() -> i64 {
    OffsetDateTime::now_utc().unix_timestamp()
}

/// Build a JPEG cover thumbnail fitting within 400x600, or `None` when the
/// image cannot be decoded. Run off the async runtime.
fn cover_thumbnail(data: &[u8], mime: &str) -> Option<Vec<u8>> {
    let format = image::ImageFormat::from_mime_type(mime)
        .or_else(|| image::ImageFormat::from_extension(mime.rsplit('/').next()?));
    let mut reader = image::ImageReader::new(std::io::Cursor::new(data));
    if let Some(format) = format {
        reader.set_format(format);
    }
    let image = match reader.decode() {
        Ok(image) => image,
        Err(_) => return None,
    };
    let image = image.thumbnail(400, 600);
    let mut output = Vec::new();
    let mut encoder = JpegEncoder::new_with_quality(&mut output, 80);
    if encoder.encode_image(&image).is_err() {
        return None;
    }
    Some(output)
}

/// Insert or update a successfully parsed book and its derived content.
async fn store_book(
    state: &AppState,
    relative: &str,
    format: BookFormat,
    hash: String,
    size: u64,
    book: &mut moth_format::ParsedBook,
) -> Result<(), AppError> {
    // Generate the cover thumbnail before touching the database so the
    // has_cover flag is correct on insert.
    let cover_jpeg = match &book.cover {
        Some(cover) => tokio::task::spawn_blocking({
            let data = cover.data.clone();
            let mime = cover.mime.clone();
            move || cover_thumbnail(&data, &mime)
        })
        .await
        .map_err(|error| AppError::Io(std::io::Error::other(error)))?,
        None => None,
    };

    let now = now_unix();
    let mut tx = state.db.begin().await?;
    let existing: Option<i64> = sqlx::query_scalar("SELECT id FROM books WHERE relative_path = ?")
        .bind(relative)
        .fetch_optional(&mut *tx)
        .await?;

    let book_id = match existing {
        Some(id) => {
            sqlx::query(
                "UPDATE books SET title = ?, author = ?, format = ?, file_size = ?, \
                 sha256 = ?, has_cover = ?, page_count = ?, parse_status = 'ok', \
                 parse_error = NULL, updated_at = ? WHERE id = ?",
            )
            .bind(&book.title)
            .bind(&book.author)
            .bind(format.as_str())
            .bind(size as i64)
            .bind(&hash)
            .bind(cover_jpeg.is_some())
            .bind(book.pages.len() as i64)
            .bind(now)
            .bind(id)
            .execute(&mut *tx)
            .await?;
            sqlx::query("DELETE FROM chapters WHERE book_id = ?")
                .bind(id)
                .execute(&mut *tx)
                .await?;
            sqlx::query("DELETE FROM resources WHERE book_id = ?")
                .bind(id)
                .execute(&mut *tx)
                .await?;
            sqlx::query("DELETE FROM pages WHERE book_id = ?")
                .bind(id)
                .execute(&mut *tx)
                .await?;
            id
        }
        None => {
            let id: i64 = sqlx::query_scalar(
                "INSERT INTO books (title, author, format, relative_path, file_size, \
                 sha256, has_cover, page_count, parse_status, added_at, updated_at) \
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ok', ?, ?) RETURNING id",
            )
            .bind(&book.title)
            .bind(&book.author)
            .bind(format.as_str())
            .bind(relative)
            .bind(size as i64)
            .bind(&hash)
            .bind(cover_jpeg.is_some())
            .bind(book.pages.len() as i64)
            .bind(now)
            .bind(now)
            .fetch_one(&mut *tx)
            .await?;
            id
        }
    };

    // Rewrite EPUB resource URLs now that the book id is part of the path.
    let prefix = format!("/api/v1/books/{book_id}/resource");
    book.rewrite_resource_urls(&prefix);

    for (idx, chapter) in book.chapters.iter().enumerate() {
        sqlx::query("INSERT INTO chapters (book_id, idx, title, content) VALUES (?, ?, ?, ?)")
            .bind(book_id)
            .bind(idx as i64)
            .bind(&chapter.title)
            .bind(&chapter.content)
            .execute(&mut *tx)
            .await?;
    }
    for (idx, resource) in book.resources.iter().enumerate() {
        sqlx::query("INSERT INTO resources (book_id, idx, path, mime) VALUES (?, ?, ?, ?)")
            .bind(book_id)
            .bind(idx as i64)
            .bind(&resource.path)
            .bind(&resource.mime)
            .execute(&mut *tx)
            .await?;
    }
    for (idx, page) in book.pages.iter().enumerate() {
        sqlx::query("INSERT INTO pages (book_id, idx, path, mime) VALUES (?, ?, ?, ?)")
            .bind(book_id)
            .bind(idx as i64)
            .bind(&page.path)
            .bind(&page.mime)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;

    // Derived files are a cache; failures here do not fail the book.
    if let Some(jpeg) = cover_jpeg {
        let dir = state.covers_dir();
        if let Err(error) = tokio::fs::create_dir_all(&dir).await {
            tracing::warn!(%error, "could not create covers directory");
        } else if let Err(error) = tokio::fs::write(dir.join(format!("{book_id}.jpg")), jpeg).await
        {
            tracing::warn!(%error, book_id, "could not write cover");
        }
    }
    for (idx, resource) in book.resources.iter().enumerate() {
        let dir = state.resources_dir().join(book_id.to_string());
        if let Err(error) = tokio::fs::create_dir_all(&dir).await {
            tracing::warn!(%error, "could not create resources directory");
            break;
        }
        if let Err(error) = tokio::fs::write(dir.join(idx.to_string()), &resource.data).await {
            tracing::warn!(%error, book_id, idx, "could not write resource");
        }
    }

    Ok(())
}

/// Record a book that could not be parsed so the shelf can show the error
/// instead of silently dropping it.
async fn store_parse_error(
    state: &AppState,
    relative: &str,
    format: BookFormat,
    hash: String,
    size: u64,
    message: &str,
) -> Result<(), AppError> {
    let now = now_unix();
    let mut tx = state.db.begin().await?;
    let existing: Option<i64> = sqlx::query_scalar("SELECT id FROM books WHERE relative_path = ?")
        .bind(relative)
        .fetch_optional(&mut *tx)
        .await?;
    match existing {
        Some(id) => {
            sqlx::query(
                "UPDATE books SET title = ?, format = ?, file_size = ?, sha256 = ?, \
                 parse_status = 'error', parse_error = ?, updated_at = ? WHERE id = ?",
            )
            .bind(relative.rsplit('/').next().unwrap_or(relative))
            .bind(format.as_str())
            .bind(size as i64)
            .bind(&hash)
            .bind(message)
            .bind(now)
            .bind(id)
            .execute(&mut *tx)
            .await?;
            sqlx::query("DELETE FROM chapters WHERE book_id = ?")
                .bind(id)
                .execute(&mut *tx)
                .await?;
            sqlx::query("DELETE FROM resources WHERE book_id = ?")
                .bind(id)
                .execute(&mut *tx)
                .await?;
            sqlx::query("DELETE FROM pages WHERE book_id = ?")
                .bind(id)
                .execute(&mut *tx)
                .await?;
        }
        None => {
            sqlx::query(
                "INSERT INTO books (title, author, format, relative_path, file_size, \
                 sha256, has_cover, page_count, parse_status, parse_error, added_at, \
                 updated_at) VALUES (?, NULL, ?, ?, ?, ?, 0, 0, 'error', ?, ?, ?)",
            )
            .bind(relative.rsplit('/').next().unwrap_or(relative))
            .bind(format.as_str())
            .bind(relative)
            .bind(size as i64)
            .bind(&hash)
            .bind(message)
            .bind(now)
            .bind(now)
            .execute(&mut *tx)
            .await?;
        }
    }
    tx.commit().await?;
    state.scan_status.lock().await.errors += 1;
    Ok(())
}

/// Delete books whose files disappeared from the library, along with their
/// derived content (cascades) and cache files.
async fn prune_missing(state: &AppState, seen: &[String]) -> Result<(), AppError> {
    let rows: Vec<(i64, String)> = sqlx::query_as("SELECT id, relative_path FROM books")
        .fetch_all(&state.db)
        .await?;
    for (id, relative) in rows {
        if !seen.iter().any(|seen| seen == &relative) {
            sqlx::query("DELETE FROM books WHERE id = ?")
                .bind(id)
                .execute(&state.db)
                .await?;
            let cover = state.covers_dir().join(format!("{id}.jpg"));
            let _ = tokio::fs::remove_file(cover).await;
            let resources = state.resources_dir().join(id.to_string());
            let _ = tokio::fs::remove_dir_all(resources).await;
            tracing::info!(book_id = id, %relative, "removed missing book");
        }
    }
    Ok(())
}
