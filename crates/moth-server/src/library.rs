//! Library scanning and persistence. Books are discovered under the read-only
//! library directory, parsed by `moth-format`, and indexed in SQLite with
//! derived content (chapters, resources, cover thumbnails) in the writable
//! data directory.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

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
    state.txt_cache.lock().await.clear();
    let configured_books_dir = state.config.books_dir.clone();
    let books_dir = match tokio::fs::canonicalize(&configured_books_dir).await {
        Ok(path) if path.is_dir() => path,
        Ok(path) => {
            state.scan_status.lock().await.message =
                format!("books directory is not a directory: {}", path.display());
            return Ok(());
        }
        Err(error) => {
            state.scan_status.lock().await.message = format!(
                "books directory not found: {} ({error})",
                configured_books_dir.display()
            );
            return Ok(());
        }
    };

    let books_dir_for_scan = books_dir.clone();
    let collected = tokio::task::spawn_blocking(move || collect_books(&books_dir_for_scan))
        .await
        .map_err(|error| AppError::Io(std::io::Error::other(error)))?;

    let CollectedBooks {
        files,
        mut complete,
    } = collected;
    if !complete {
        state.scan_status.lock().await.message =
            "Library scan was incomplete; existing books were kept".to_owned();
    }

    state.scan_status.lock().await.total = files.len() as u64;

    let mut seen: Vec<String> = Vec::with_capacity(files.len());
    let collected_relatives: HashSet<String> = files
        .iter()
        .filter_map(|path| {
            path.strip_prefix(&books_dir)
                .ok()
                .map(|rel| rel.to_string_lossy().replace('\\', "/"))
        })
        .collect();
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
                // A file can disappear or become unreadable after directory
                // enumeration. Treat that as an incomplete scan and keep the
                // previous indexed content and progress; turning it into a
                // parse error would destroy the only usable representation.
                complete = false;
                mark_incomplete(state).await;
                tracing::warn!(%relative, %error, "book could not be read during scan");
                state.scan_status.lock().await.errors += 1;
                bump_processed(state).await;
                continue;
            }
        };

        // A unique content match whose old path is absent from this complete
        // enumeration is treated as a move/rename. The existing row (and its
        // manually managed classification and progress) is retained. Multiple
        // candidates are deliberately left alone so duplicate files are never
        // silently merged.
        adopt_moved_book(state, &relative, &hash, size, format, &collected_relatives).await?;

        if is_unchanged(&state.db, &relative, &hash, size).await? {
            bump_processed(state).await;
            continue;
        }

        let parse_path = path.clone();
        let parsed = tokio::task::spawn_blocking(move || {
            moth_format::ParsedBook::parse_as(&parse_path, format)
        })
        .await
        .map_err(|error| AppError::Io(std::io::Error::other(error)))?;

        // Some format libraries wrap an open/read failure in a format error
        // instead of preserving the underlying IO variant. Re-check the file
        // before replacing an existing row so a file disappearing during the
        // parse cannot erase its last good chapters or progress.
        if parsed.is_err() {
            let readable_path = path.clone();
            let readable = tokio::task::spawn_blocking(move || hash_file(&readable_path).is_ok())
                .await
                .map_err(|error| AppError::Io(std::io::Error::other(error)))?;
            if !readable {
                complete = false;
                mark_incomplete(state).await;
                tracing::warn!(%relative, "book disappeared or became unreadable during parse");
                state.scan_status.lock().await.errors += 1;
                bump_processed(state).await;
                continue;
            }
        }

        match parsed {
            Ok(mut book) => store_book(state, &relative, format, hash, size, &mut book).await?,
            Err(error) if matches!(error, moth_format::ParseError::Io(_)) => {
                // Parsing may lose a race with a file replacement/removal.
                // Preserve the previous row and skip pruning for this scan.
                complete = false;
                mark_incomplete(state).await;
                tracing::warn!(%relative, %error, "book disappeared while parsing");
                state.scan_status.lock().await.errors += 1;
            }
            Err(error) => {
                store_parse_error(state, &relative, format, hash, size, &error.to_string()).await?
            }
        }
        bump_processed(state).await;
    }

    if complete {
        prune_missing(state, &seen).await?;
    }
    Ok(())
}

async fn bump_processed(state: &AppState) {
    let mut status = state.scan_status.lock().await;
    status.processed += 1;
}

async fn mark_incomplete(state: &AppState) {
    state.scan_status.lock().await.message =
        "Library scan was incomplete; existing books were kept".to_owned();
}

struct CollectedBooks {
    files: Vec<PathBuf>,
    complete: bool,
}

fn collect_books(dir: &Path) -> CollectedBooks {
    let mut out = Vec::new();
    let mut complete = true;
    let mut stack = vec![dir.to_path_buf()];
    let mut visited_dirs = HashSet::new();
    while let Some(current) = stack.pop() {
        // Canonical paths make directory junctions safe: a junction back to
        // an ancestor is visited once, and a junction outside the library is
        // rejected before it can be traversed.
        let current = match std::fs::canonicalize(&current) {
            Ok(path) if path.starts_with(dir) => path,
            Ok(path) => {
                tracing::warn!(path = %path.display(), root = %dir.display(), "skipping directory outside library");
                continue;
            }
            Err(error) => {
                tracing::warn!(path = %current.display(), %error, "could not canonicalize library directory");
                complete = false;
                continue;
            }
        };
        if !visited_dirs.insert(current.clone()) {
            continue;
        }
        let entries = match std::fs::read_dir(&current) {
            Ok(entries) => entries,
            Err(error) => {
                tracing::warn!(path = %current.display(), %error, "could not read library directory");
                complete = false;
                continue;
            }
        };
        let mut dirs = Vec::new();
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => {
                    tracing::warn!(path = %current.display(), %error, "could not inspect library entry");
                    complete = false;
                    continue;
                }
            };
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            let file_type = match entry.file_type() {
                Ok(file_type) => file_type,
                Err(error) => {
                    tracing::warn!(path = %path.display(), %error, "could not inspect library entry type");
                    complete = false;
                    continue;
                }
            };
            // Never follow symlinks or directory junctions from a read-only
            // library. They can create loops or expose files outside /books.
            if file_type.is_symlink() {
                // A skipped link means the directory contents were not fully
                // observed. Keep existing rows until a later complete scan so
                // a link disappearing during a rescan cannot prune a book or
                // its progress by accident.
                complete = false;
                tracing::warn!(path = %path.display(), "skipping symlink in library");
                continue;
            }
            let canonical = match std::fs::canonicalize(&path) {
                Ok(path) if path.starts_with(dir) => path,
                Ok(path) => {
                    complete = false;
                    tracing::warn!(path = %path.display(), root = %dir.display(), "skipping entry outside library");
                    continue;
                }
                Err(error) => {
                    tracing::warn!(path = %path.display(), %error, "could not canonicalize library entry");
                    complete = false;
                    continue;
                }
            };
            if file_type.is_dir() {
                dirs.push(canonical);
            } else if file_type.is_file() && BookFormat::from_path(&canonical).is_some() {
                out.push(canonical);
            }
        }
        dirs.reverse();
        stack.extend(dirs);
    }
    out.sort();
    CollectedBooks {
        files: out,
        complete,
    }
}

pub(crate) fn hash_file(path: &Path) -> std::io::Result<(String, u64)> {
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
    let row = sqlx::query(
        "SELECT sha256, file_size, parse_status, missing FROM books WHERE relative_path = ?",
    )
    .bind(relative)
    .fetch_optional(db)
    .await?;
    Ok(match row {
        Some(row) => {
            let existing_hash: String = row.try_get("sha256")?;
            let existing_size: i64 = row.try_get("file_size")?;
            let status: String = row.try_get("parse_status")?;
            let missing: bool = row.try_get("missing")?;
            existing_hash == hash && existing_size == size as i64 && status == "ok" && !missing
        }
        None => false,
    })
}

fn now_unix() -> i64 {
    OffsetDateTime::now_utc().unix_timestamp()
}

async fn adopt_moved_book(
    state: &AppState,
    relative: &str,
    hash: &str,
    size: u64,
    format: BookFormat,
    present_paths: &HashSet<String>,
) -> Result<(), AppError> {
    // A row already using this path wins; the caller will update it normally.
    let path_exists: Option<i64> =
        sqlx::query_scalar("SELECT id FROM books WHERE relative_path = ?")
            .bind(relative)
            .fetch_optional(&state.db)
            .await?;
    if path_exists.is_some() {
        return Ok(());
    }
    let candidates: Vec<(i64, String)> = sqlx::query_as(
        "SELECT id, relative_path FROM books WHERE sha256 = ? AND file_size = ? AND format = ?",
    )
    .bind(hash)
    .bind(size as i64)
    .bind(format.as_str())
    .fetch_all(&state.db)
    .await?;
    let candidates: Vec<(i64, String)> = candidates
        .into_iter()
        .filter(|(_, old_path)| !present_paths.contains(old_path))
        .collect();
    if candidates.len() != 1 {
        return Ok(());
    }
    let (id, old_path) = &candidates[0];
    sqlx::query("UPDATE books SET relative_path = ?, missing = 0, updated_at = ? WHERE id = ?")
        .bind(relative)
        .bind(now_unix())
        .bind(id)
        .execute(&state.db)
        .await?;
    tracing::info!(book_id = id, old_path = %old_path, new_path = %relative, "adopted moved book");
    Ok(())
}

/// Timestamp helper shared by user-managed metadata mutations.
pub(crate) fn now_unix_for_api() -> i64 {
    now_unix()
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
                 parse_error = NULL, missing = 0, updated_at = ? WHERE id = ?",
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
                 sha256, has_cover, page_count, parse_status, section_id, added_at, updated_at) \
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ok', (SELECT id FROM sections WHERE is_system = 1 LIMIT 1), ?, ?) RETURNING id",
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
    if let Some(jpeg) = cover_jpeg
        && let Err(error) = write_derived_file(&state.cover_path(book_id, &hash), &jpeg).await
    {
        tracing::warn!(%error, book_id, "could not write cover");
    }
    let resource_dir = state.resources_dir().join(book_id.to_string()).join(&hash);
    for (idx, resource) in book.resources.iter().enumerate() {
        if let Err(error) =
            write_derived_file(&resource_dir.join(idx.to_string()), &resource.data).await
        {
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
    let book_id = match existing {
        Some(id) => {
            sqlx::query(
                "UPDATE books SET title = ?, format = ?, file_size = ?, sha256 = ?, \
                 has_cover = 0, page_count = 0, parse_status = 'error', \
                 parse_error = ?, missing = 0, updated_at = ? WHERE id = ?",
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
            id
        }
        None => {
            let id: i64 = sqlx::query_scalar(
                "INSERT INTO books (title, author, format, relative_path, file_size, \
                 sha256, has_cover, page_count, parse_status, parse_error, section_id, added_at, \
                 updated_at) VALUES (?, NULL, ?, ?, ?, ?, 0, 0, 'error', ?, (SELECT id FROM sections WHERE is_system = 1 LIMIT 1), ?, ?) RETURNING id",
            )
            .bind(relative.rsplit('/').next().unwrap_or(relative))
            .bind(format.as_str())
            .bind(relative)
            .bind(size as i64)
            .bind(&hash)
            .bind(message)
            .bind(now)
            .bind(now)
            .fetch_one(&mut *tx)
            .await?;
            id
        }
    };
    tx.commit().await?;
    // A failed replacement must not leave the old cover or resource files
    // addressable after the database row has been marked unreadable.
    let _ = tokio::fs::remove_dir_all(state.book_covers_dir(book_id)).await;
    let _ = tokio::fs::remove_dir_all(state.book_resources_dir(book_id)).await;
    state.scan_status.lock().await.errors += 1;
    Ok(())
}

/// Mark books whose files disappeared from a complete library scan. Keeping
/// the row preserves manual organization and reading progress while the
/// source is temporarily unavailable; the owner can explicitly remove a
/// missing record through the management API.
async fn prune_missing(state: &AppState, seen: &[String]) -> Result<(), AppError> {
    let rows: Vec<(i64, String, bool)> =
        sqlx::query_as("SELECT id, relative_path, missing FROM books")
            .fetch_all(&state.db)
            .await?;
    for (id, relative, already_missing) in rows {
        if !seen.iter().any(|seen| seen == &relative) {
            sqlx::query("UPDATE books SET missing = 1, updated_at = ? WHERE id = ?")
                .bind(now_unix())
                .bind(id)
                .execute(&state.db)
                .await?;
            if !already_missing {
                tracing::info!(book_id = id, %relative, "marked missing book");
            }
        }
    }
    Ok(())
}

/// Install generated data by rename so a reader can never observe a partially
/// written cover or resource. Versioned destinations also let an active reader
/// finish using the previous scan while the new scan is being committed.
async fn write_derived_file(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| std::io::Error::other("derived path has no parent"))?;
    tokio::fs::create_dir_all(parent).await?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("file");
    let temporary = parent.join(format!(".{file_name}.{stamp}.tmp"));
    if let Err(error) = tokio::fs::write(&temporary, bytes).await {
        let _ = tokio::fs::remove_file(&temporary).await;
        return Err(error);
    }
    if let Err(error) = tokio::fs::rename(&temporary, path).await {
        let _ = tokio::fs::remove_file(&temporary).await;
        return Err(error);
    }
    Ok(())
}
