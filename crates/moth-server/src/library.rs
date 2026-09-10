//! Filesystem-first indexing for one read-only book root.

use std::{
    io::Cursor,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use axum::{
    Json,
    extract::{Query, State},
};
use image::{ImageReader, Limits, codecs::jpeg::JpegEncoder};
use moth_format::{BookFormat, Cover, Page, ParseError};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{Row, SqlitePool};
use tokio::sync::mpsc;

use crate::{
    auth::Authenticated,
    error::AppError,
    state::{AppState, ScanStatus},
};

const COVER_MAX_EDGE: u32 = 640;
const COVER_MAX_BYTES: usize = 16 * 1024 * 1024;
const COVER_MAX_ALLOC: u64 = 64 * 1024 * 1024;
const COVER_MAX_DIMENSION: u32 = 8192;
const COVER_MAX_PIXELS: u64 = 16_000_000;

struct IndexedPublication {
    title: String,
    author: Option<String>,
    cover: Option<Cover>,
    cover_error: Option<String>,
    pages: Vec<Page>,
    text_index: Option<moth_format::txt::TextIndex>,
}

fn parse_index(
    path: &Path,
    format: BookFormat,
    txt_cache_target: Option<&Path>,
) -> Result<IndexedPublication, ParseError> {
    let fallback_title = || {
        path.file_stem()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_else(|| "未命名".to_owned())
    };
    match format {
        BookFormat::Epub => {
            let metadata = moth_format::epub::parse_metadata(path)?;
            Ok(IndexedPublication {
                title: if metadata.title.trim().is_empty() {
                    fallback_title()
                } else {
                    metadata.title
                },
                author: metadata.author,
                cover: metadata.cover,
                cover_error: metadata.cover_error,
                pages: Vec::new(),
                text_index: None,
            })
        }
        BookFormat::Mobi => {
            let metadata = moth_format::mobi::parse_metadata(path)?;
            Ok(IndexedPublication {
                title: if metadata.title.trim().is_empty() {
                    fallback_title()
                } else {
                    metadata.title
                },
                author: metadata.author,
                cover: metadata.cover,
                cover_error: metadata.cover_error,
                pages: Vec::new(),
                text_index: None,
            })
        }
        BookFormat::Txt => {
            let target = txt_cache_target.ok_or_else(|| {
                ParseError::Io(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "TXT cache target is required",
                ))
            })?;
            let index = moth_format::txt::write_indexed_cache(path, None, target)?;
            let title = index.title.clone().unwrap_or_else(fallback_title);
            Ok(IndexedPublication {
                title,
                author: None,
                cover: None,
                cover_error: None,
                pages: Vec::new(),
                text_index: Some(index),
            })
        }
        BookFormat::Cbz => {
            let index = moth_format::cbz::parse(path)?;
            Ok(IndexedPublication {
                title: fallback_title(),
                author: None,
                cover: index.cover,
                cover_error: index.cover_error,
                pages: index.pages,
                text_index: None,
            })
        }
    }
}

#[derive(Debug, Serialize)]
pub struct DirectorySummary {
    pub name: String,
    pub path: String,
    pub publication_count: i64,
}

#[derive(Debug, Serialize)]
pub struct BrowseResponse {
    pub path: String,
    pub breadcrumbs: Vec<Breadcrumb>,
    pub directories: Vec<DirectorySummary>,
    pub publications: Vec<crate::books::PublicationSummary>,
    pub publication_count: i64,
    pub directory_count: i64,
}

#[derive(Debug, Serialize)]
pub struct Breadcrumb {
    pub name: String,
    pub path: String,
}

#[derive(Debug, Deserialize)]
pub struct BrowseQuery {
    pub path: Option<String>,
}

pub async fn browse(
    State(state): State<AppState>,
    _user: Authenticated,
    Query(query): Query<BrowseQuery>,
) -> Result<Json<BrowseResponse>, AppError> {
    ensure_directory(&state.db, Path::new("")).await?;
    let path = normalize_relative(query.path.as_deref().unwrap_or(""))?;
    let directory_id: i64 =
        sqlx::query_scalar("SELECT id FROM directories WHERE relative_path = ?")
            .bind(&path)
            .fetch_optional(&state.db)
            .await?
            .ok_or(AppError::NotFound)?;
    let directories = sqlx::query(
        "SELECT d.name, d.relative_path AS path, COUNT(p.id) AS publication_count
         FROM directories d LEFT JOIN publications p ON p.directory_id = d.id
         WHERE d.parent_id = ? GROUP BY d.id ORDER BY d.name COLLATE NOCASE",
    )
    .bind(directory_id)
    .fetch_all(&state.db)
    .await?
    .into_iter()
    .map(|row| {
        Ok(DirectorySummary {
            name: row.try_get("name")?,
            path: row.try_get("path")?,
            publication_count: row.try_get("publication_count")?,
        })
    })
    .collect::<Result<Vec<_>, sqlx::Error>>()?;
    let publications =
        crate::books::fetch_publications(&state.db, Some(directory_id), None).await?;
    let publication_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM publications")
        .fetch_one(&state.db)
        .await?;
    let directory_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM directories WHERE relative_path <> ''")
            .fetch_one(&state.db)
            .await?;
    Ok(Json(BrowseResponse {
        path: path.clone(),
        breadcrumbs: breadcrumbs(&path),
        directories,
        publications,
        publication_count,
        directory_count,
    }))
}

pub async fn start_scan(
    State(state): State<AppState>,
    _user: Authenticated,
) -> Result<(), AppError> {
    start_scan_on(&state).await
}

pub async fn scan_status(
    State(state): State<AppState>,
    _user: Authenticated,
) -> Result<Json<ScanStatus>, AppError> {
    Ok(Json(state.scan_status.lock().await.clone()))
}

pub async fn start_scan_on(state: &AppState) -> Result<(), AppError> {
    {
        let mut status = state.scan_status.lock().await;
        if status.scanning {
            return Err(AppError::Conflict {
                code: "scan_in_progress",
                message: "书库扫描正在进行",
            });
        }
        *status = ScanStatus {
            scanning: true,
            ..ScanStatus::default()
        };
    }
    let cloned = state.clone();
    tokio::spawn(async move {
        let result = run_scan(&cloned).await;
        let mut status = cloned.scan_status.lock().await;
        status.scanning = false;
        if let Err(error) = result {
            status.message = error.to_string();
        }
    });
    Ok(())
}

pub async fn start_initial_scan(state: &AppState) -> Result<(), AppError> {
    ensure_directory(&state.db, Path::new("")).await?;
    start_scan_on(state).await
}

async fn run_scan(state: &AppState) -> Result<(), AppError> {
    let root = state.config.books_dir.clone();
    let (sender, mut receiver) = mpsc::channel(32);
    let discovery = tokio::task::spawn_blocking(move || discover_files(&root, sender));
    let mut complete = true;
    let mut processed = 0_u64;
    while let Some(item) = receiver.recv().await {
        match item {
            Discovered::Directory(directory) => {
                let root = &state.config.books_dir;
                if !directory.is_dir() {
                    complete = false;
                    state.scan_status.lock().await.message =
                        format!("扫描期间目录消失：{}", directory.display());
                    continue;
                }
                let relative = directory.strip_prefix(root).map_err(|_| {
                    AppError::Validation("directory is outside book root".to_owned())
                })?;
                if let Err(error) = ensure_directory(&state.db, relative).await {
                    complete = false;
                    state.scan_status.lock().await.message = error.to_string();
                }
            }
            Discovered::File(file) => {
                if let Err(error) = index_file(state, &file).await {
                    tracing::warn!(path = %file.display(), %error, "publication indexing failed");
                    complete = false;
                    let mut status = state.scan_status.lock().await;
                    status.errors += 1;
                    status.message = error.to_string();
                }
                processed += 1;
                let mut status = state.scan_status.lock().await;
                status.processed = processed;
                status.total = processed;
            }
        }
    }
    let discovery_complete = discovery
        .await
        .map_err(|error| AppError::Io(std::io::Error::other(error)))?;
    complete &= discovery_complete;
    {
        let mut status = state.scan_status.lock().await;
        status.total = processed;
        status.discovery_complete = discovery_complete;
        if !discovery_complete {
            status.message = "扫描未完整完成，已保留现有索引".to_owned();
        }
    }
    // The root may disappear after discovery has sent its last entry but
    // before the database cleanup starts. Treat that race as an incomplete
    // scan so a transient NAS outage can never prune the existing index.
    if complete && !state.config.books_dir.is_dir() {
        complete = false;
        state.scan_status.lock().await.message =
            "扫描期间书库目录不可用，已保留现有索引".to_owned();
    }
    if complete {
        prune_removed(state).await?;
    }
    Ok(())
}

#[cfg(test)]
struct Collected {
    files: Vec<PathBuf>,
    directories: Vec<PathBuf>,
    complete: bool,
}

#[cfg(test)]
fn collect_files(root: &Path) -> Collected {
    let mut files = Vec::new();
    let mut directories = Vec::new();
    let mut complete = true;
    if !root.is_dir() {
        return Collected {
            files,
            directories,
            complete: false,
        };
    }
    directories.push(root.to_path_buf());
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(_) => {
                complete = false;
                continue;
            }
        };
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => {
                    complete = false;
                    continue;
                }
            };
            let path = entry.path();
            match entry.file_type() {
                Ok(file_type) if file_type.is_dir() => {
                    directories.push(path.clone());
                    stack.push(path);
                }
                Ok(file_type) if file_type.is_file() && BookFormat::from_path(&path).is_some() => {
                    files.push(path)
                }
                Ok(_) => {}
                Err(_) => complete = false,
            }
        }
    }
    files.sort();
    directories.sort();
    Collected {
        files,
        directories,
        complete,
    }
}

async fn index_file(state: &AppState, path: &Path) -> Result<(), AppError> {
    let root = &state.config.books_dir;
    let relative = path
        .strip_prefix(root)
        .map_err(|_| AppError::Validation("file is outside book root".to_owned()))?
        .to_string_lossy()
        .replace('\\', "/");
    let metadata = std::fs::metadata(path)?;
    let size = i64::try_from(metadata.len()).unwrap_or(i64::MAX);
    let mtime = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_nanos() as i64)
        .unwrap_or(0);
    let format = BookFormat::from_path(path)
        .ok_or_else(|| AppError::Validation("unsupported publication".to_owned()))?;
    let existing = sqlx::query(
        "SELECT id,sha256,file_size,mtime_ns,format FROM publications WHERE relative_path=?",
    )
    .bind(&relative)
    .fetch_optional(&state.db)
    .await?;
    if let Some(row) = existing {
        let id: i64 = row.try_get("id")?;
        if row.try_get::<i64, _>("file_size")? == size
            && row.try_get::<i64, _>("mtime_ns")? == mtime
            && row.try_get::<String, _>("format")? == format.as_str()
        {
            return Ok(());
        }
        let hash = hash_file_async(path).await?;
        let directory = ensure_directory(
            &state.db,
            Path::new(&relative).parent().unwrap_or(Path::new("")),
        )
        .await?;
        if row.try_get::<String, _>("sha256")? == hash {
            sqlx::query(
                "UPDATE publications SET directory_id=?,filename=?,file_size=?,mtime_ns=?,updated_at=? WHERE id=?",
            )
            .bind(directory)
            .bind(
                path.file_name()
                    .map(|value| value.to_string_lossy().into_owned())
                    .unwrap_or_default(),
            )
            .bind(size)
            .bind(mtime)
            .bind(now_unix())
            .bind(id)
            .execute(&state.db)
            .await?;
            return Ok(());
        }
        return store_publication(
            state, id, directory, &relative, path, format, hash, size, mtime,
        )
        .await;
    }
    let hash = hash_file_async(path).await?;
    let candidates = sqlx::query("SELECT id,relative_path FROM publications WHERE sha256=? AND file_size=? AND format=? AND relative_path<>?")
        .bind(&hash).bind(size).bind(format.as_str()).bind(&relative)
        .fetch_all(&state.db).await?;
    // A moved file leaves its old row behind until the scan completes. Reuse
    // that row only when exactly one matching candidate is currently absent;
    // live candidates represent real duplicate files and must keep separate
    // publication IDs.
    let missing_candidates = candidates
        .iter()
        .filter(|candidate| {
            candidate
                .try_get::<String, _>("relative_path")
                .ok()
                .is_some_and(|candidate_path| !root.join(candidate_path).is_file())
        })
        .collect::<Vec<_>>();
    let id = if missing_candidates.len() == 1 {
        missing_candidates[0].try_get("id")?
    } else {
        0
    };
    let directory = ensure_directory(
        &state.db,
        Path::new(&relative).parent().unwrap_or(Path::new("")),
    )
    .await?;
    store_publication(
        state, id, directory, &relative, path, format, hash, size, mtime,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn store_publication(
    state: &AppState,
    id: i64,
    directory_id: i64,
    relative: &str,
    path: &Path,
    format: BookFormat,
    hash: String,
    size: i64,
    mtime: i64,
) -> Result<(), AppError> {
    let cache_version = crate::books::content_version(&hash, format.as_str(), None);
    let txt_cache_target = (format == BookFormat::Txt)
        .then(|| state.txt_dir(&cache_version, "auto").join("book.utf8"));
    let parsed = tokio::task::spawn_blocking({
        let path = path.to_owned();
        move || parse_index(&path, format, txt_cache_target.as_deref())
    })
    .await
    .map_err(|error| AppError::Io(std::io::Error::other(error)))?;
    let now = now_unix();
    let (title, author, cover, pages, mut parse_error, text_index, parsed_ok) = match parsed {
        Ok(book) => (
            book.title,
            book.author,
            book.cover,
            book.pages,
            book.cover_error,
            book.text_index,
            true,
        ),
        Err(error) => (
            path.file_stem()
                .map(|value| value.to_string_lossy().into_owned())
                .unwrap_or_else(|| "未命名".to_owned()),
            None,
            None,
            Vec::new(),
            Some(error.to_string()),
            None,
            false,
        ),
    };
    let mut has_cover = false;
    if let Some(cover) = cover {
        let result = write_cover(state, &cache_version, cover.data).await?;
        has_cover = result.written;
        if let Some(error) = result.error {
            parse_error = Some(append_error(parse_error, error));
        }
    }
    let status = if parsed_ok { "ok" } else { "error" };
    // Keep the publication row and its derived indexes in one SQLite
    // transaction. This avoids exposing a half-written chapter/page list to
    // readers and turns hundreds of individual commits into one bounded
    // batch per publication.
    let mut tx = state.db.begin().await?;
    let publication_id = if id == 0 {
        sqlx::query_scalar::<_, i64>("INSERT INTO publications (directory_id,relative_path,filename,format,title,author,file_size,mtime_ns,sha256,has_cover,parse_status,parse_error,added_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id")
            .bind(directory_id).bind(relative).bind(path.file_name().map(|v| v.to_string_lossy().into_owned()).unwrap_or_default()).bind(format.as_str()).bind(&title).bind(&author).bind(size).bind(mtime).bind(&hash).bind(has_cover).bind(status).bind(&parse_error).bind(now).bind(now).fetch_one(&mut *tx).await?
    } else {
        sqlx::query("UPDATE publications SET directory_id=?,relative_path=?,filename=?,format=?,title=?,author=?,file_size=?,mtime_ns=?,sha256=?,has_cover=?,parse_status=?,parse_error=?,updated_at=? WHERE id=?")
            .bind(directory_id).bind(relative).bind(path.file_name().map(|v| v.to_string_lossy().into_owned()).unwrap_or_default()).bind(format.as_str()).bind(&title).bind(&author).bind(size).bind(mtime).bind(&hash).bind(has_cover).bind(status).bind(&parse_error).bind(now).bind(id).execute(&mut *tx).await?;
        sqlx::query("DELETE FROM text_chapters WHERE publication_id=?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM cbz_pages WHERE publication_id=?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        id
    };
    if format == BookFormat::Cbz {
        for (idx, page) in pages.iter().enumerate() {
            sqlx::query("INSERT INTO cbz_pages (publication_id,idx,path,mime) VALUES (?,?,?,?)")
                .bind(publication_id)
                .bind(idx as i64)
                .bind(&page.path)
                .bind(&page.mime)
                .execute(&mut *tx)
                .await?;
        }
    }
    if format == BookFormat::Txt
        && let Some(index) = text_index
    {
        insert_text_index(&mut tx, publication_id, "auto", index).await?;
    }
    tx.commit().await?;
    Ok(())
}

pub(crate) async fn write_text_cache(
    state: &AppState,
    id: i64,
    content_version: &str,
    path: &Path,
    encoding: &str,
) -> Result<(), AppError> {
    let path = path.to_owned();
    let requested = (encoding != "auto").then(|| encoding.to_owned());
    let target = state.txt_dir(content_version, encoding).join("book.utf8");
    let index = tokio::task::spawn_blocking(move || {
        moth_format::txt::write_indexed_cache(&path, requested.as_deref(), &target)
    })
    .await
    .map_err(|error| AppError::Io(std::io::Error::other(error)))?
    .map_err(|error| AppError::Validation(error.to_string()))?;
    let mut tx = state.db.begin().await?;
    sqlx::query("DELETE FROM text_chapters WHERE publication_id=? AND encoding=?")
        .bind(id)
        .bind(encoding)
        .execute(&mut *tx)
        .await?;
    insert_text_index(&mut tx, id, encoding, index).await?;
    tx.commit().await?;
    Ok(())
}

enum Discovered {
    Directory(PathBuf),
    File(PathBuf),
}

fn discover_files(root: &Path, sender: mpsc::Sender<Discovered>) -> bool {
    if !root.is_dir() {
        return false;
    }
    if sender
        .blocking_send(Discovered::Directory(root.to_path_buf()))
        .is_err()
    {
        return false;
    }
    let mut complete = true;
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(_) => {
                complete = false;
                continue;
            }
        };
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => {
                    complete = false;
                    continue;
                }
            };
            let path = entry.path();
            match entry.file_type() {
                Ok(file_type) if file_type.is_dir() => {
                    if sender
                        .blocking_send(Discovered::Directory(path.clone()))
                        .is_err()
                    {
                        return false;
                    }
                    stack.push(path);
                }
                Ok(file_type) if file_type.is_file() && BookFormat::from_path(&path).is_some() => {
                    if sender.blocking_send(Discovered::File(path)).is_err() {
                        return false;
                    }
                }
                Ok(_) => {}
                Err(_) => complete = false,
            }
        }
    }
    complete
}

async fn insert_text_index(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    id: i64,
    encoding: &str,
    index: moth_format::txt::TextIndex,
) -> Result<(), AppError> {
    for (idx, chapter) in index.chapters.into_iter().enumerate() {
        sqlx::query("INSERT INTO text_chapters (publication_id,encoding,idx,title,byte_start,byte_end,character_count) VALUES (?,?,?,?,?,?,?) ON CONFLICT(publication_id,encoding,idx) DO UPDATE SET title=excluded.title,byte_start=excluded.byte_start,byte_end=excluded.byte_end,character_count=excluded.character_count")
            .bind(id)
            .bind(encoding)
            .bind(idx as i64)
            .bind(chapter.title)
            .bind(chapter.byte_start)
            .bind(chapter.byte_end)
            .bind(chapter.character_count)
            .execute(&mut **tx)
            .await?;
    }
    Ok(())
}

struct CoverWriteResult {
    written: bool,
    error: Option<String>,
}

fn append_error(previous: Option<String>, next: String) -> String {
    previous.map_or(next.clone(), |value| format!("{value}; {next}"))
}

async fn write_cover(
    state: &AppState,
    content_version: &str,
    bytes: Vec<u8>,
) -> Result<CoverWriteResult, AppError> {
    if bytes.len() > COVER_MAX_BYTES {
        return Ok(CoverWriteResult {
            written: false,
            error: Some("cover exceeds the 16 MiB scan limit".to_owned()),
        });
    }
    let dir = state.covers_dir();
    if let Err(error) = tokio::fs::create_dir_all(&dir).await {
        return Ok(CoverWriteResult {
            written: false,
            error: Some(format!("could not create cover cache: {error}")),
        });
    }
    let target = state.cover_path(content_version);
    if target.exists() {
        return Ok(CoverWriteResult {
            written: true,
            error: None,
        });
    }
    let encoded = tokio::task::spawn_blocking(move || {
        // Read only the image header first. This lets us reject pathological
        // dimensions and pixel counts before the decoder allocates a frame.
        let header_reader = ImageReader::new(Cursor::new(bytes.as_slice()))
            .with_guessed_format()
            .map_err(|error| format!("invalid cover: {error}"))?;
        let (width, height) = header_reader
            .into_dimensions()
            .map_err(|error| format!("invalid cover dimensions: {error}"))?;
        if width > COVER_MAX_DIMENSION
            || height > COVER_MAX_DIMENSION
            || u64::from(width).saturating_mul(u64::from(height)) > COVER_MAX_PIXELS
        {
            return Err("cover dimensions exceed the scan limit".to_owned());
        }

        let mut limits = Limits::default();
        limits.max_image_width = Some(COVER_MAX_DIMENSION);
        limits.max_image_height = Some(COVER_MAX_DIMENSION);
        limits.max_alloc = Some(COVER_MAX_ALLOC);
        let mut reader = ImageReader::new(Cursor::new(bytes))
            .with_guessed_format()
            .map_err(|error| format!("invalid cover: {error}"))?;
        reader.limits(limits);
        let image = reader
            .decode()
            .map_err(|error| format!("invalid cover: {error}"))?;
        let image = image.thumbnail(COVER_MAX_EDGE, COVER_MAX_EDGE);
        let mut output = Vec::new();
        JpegEncoder::new_with_quality(&mut output, 84)
            .encode_image(&image)
            .map_err(|error| format!("could not encode cover: {error}"))?;
        Ok::<_, String>(output)
    })
    .await
    .map_err(|error| AppError::Io(std::io::Error::other(error)))?;
    let encoded = match encoded {
        Ok(encoded) => encoded,
        Err(error) => {
            return Ok(CoverWriteResult {
                written: false,
                error: Some(error),
            });
        }
    };
    let temp = target.with_extension("tmp");
    if let Err(error) = tokio::fs::write(&temp, encoded).await {
        let _ = tokio::fs::remove_file(&temp).await;
        return Ok(CoverWriteResult {
            written: false,
            error: Some(format!("could not write cover cache: {error}")),
        });
    }
    if let Err(error) = tokio::fs::rename(&temp, &target).await {
        let _ = tokio::fs::remove_file(&temp).await;
        return Ok(CoverWriteResult {
            written: false,
            error: Some(format!("could not finalize cover cache: {error}")),
        });
    }
    Ok(CoverWriteResult {
        written: true,
        error: None,
    })
}

async fn ensure_directory(db: &SqlitePool, relative: &Path) -> Result<i64, AppError> {
    sqlx::query("INSERT INTO directories (parent_id,name,relative_path,updated_at) VALUES (?,?,?,?) ON CONFLICT(relative_path) DO NOTHING")
        .bind(None::<i64>).bind("书库").bind("").bind(now_unix()).execute(db).await?;
    let root_id: i64 = sqlx::query_scalar("SELECT id FROM directories WHERE relative_path=''")
        .fetch_one(db)
        .await?;
    if relative.as_os_str().is_empty() {
        return Ok(root_id);
    }
    let mut parent_id = root_id;
    let mut current = String::new();
    for component in relative.components() {
        let name = component.as_os_str().to_string_lossy().to_string();
        if name.is_empty() {
            continue;
        }
        current = if current.is_empty() {
            name.clone()
        } else {
            format!("{current}/{name}")
        };
        sqlx::query("INSERT INTO directories (parent_id,name,relative_path,updated_at) VALUES (?,?,?,?) ON CONFLICT(relative_path) DO UPDATE SET name=excluded.name,parent_id=excluded.parent_id,updated_at=excluded.updated_at")
            .bind(parent_id).bind(&name).bind(&current).bind(now_unix()).execute(db).await?;
        parent_id = sqlx::query_scalar("SELECT id FROM directories WHERE relative_path=?")
            .bind(&current)
            .fetch_one(db)
            .await?;
    }
    Ok(parent_id)
}

async fn prune_removed(state: &AppState) -> Result<(), AppError> {
    let root = &state.config.books_dir;
    let mut last_id = 0_i64;
    loop {
        let rows = sqlx::query(
            "SELECT id,relative_path FROM publications WHERE id>? ORDER BY id LIMIT 256",
        )
        .bind(last_id)
        .fetch_all(&state.db)
        .await?;
        if rows.is_empty() {
            break;
        }
        for row in rows {
            let id: i64 = row.try_get("id")?;
            last_id = id;
            let relative: String = row.try_get("relative_path")?;
            let source = root.join(&relative);
            match std::fs::metadata(&source) {
                Ok(metadata) if metadata.is_file() && BookFormat::from_path(&source).is_some() => {}
                Ok(_) => {
                    sqlx::query("DELETE FROM publications WHERE id=?")
                        .bind(id)
                        .execute(&state.db)
                        .await?;
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    sqlx::query("DELETE FROM publications WHERE id=?")
                        .bind(id)
                        .execute(&state.db)
                        .await?;
                }
                Err(error) => {
                    tracing::warn!(path = %relative, %error, "could not verify publication during prune")
                }
            }
        }
    }
    let mut last_id = 0_i64;
    loop {
        let rows = sqlx::query(
            "SELECT id,relative_path FROM directories WHERE relative_path<>'' AND id>? ORDER BY id LIMIT 256",
        )
        .bind(last_id)
        .fetch_all(&state.db)
        .await?;
        if rows.is_empty() {
            break;
        }
        for row in rows {
            let id: i64 = row.try_get("id")?;
            last_id = id;
            let relative: String = row.try_get("relative_path")?;
            if !root.join(&relative).is_dir() {
                sqlx::query("DELETE FROM directories WHERE id=?")
                    .bind(id)
                    .execute(&state.db)
                    .await?;
            }
        }
    }
    Ok(())
}

pub(crate) fn normalize_relative(path: &str) -> Result<String, AppError> {
    let path = path.replace('\\', "/");
    let mut parts = Vec::new();
    for component in Path::new(&path).components() {
        match component {
            std::path::Component::Normal(value) => parts.push(value.to_string_lossy().to_string()),
            std::path::Component::CurDir => {}
            _ => {
                return Err(AppError::Validation(
                    "path must stay inside the book root".to_owned(),
                ));
            }
        }
    }
    Ok(parts.join("/"))
}

fn breadcrumbs(path: &str) -> Vec<Breadcrumb> {
    let mut out = vec![Breadcrumb {
        name: "目录".to_owned(),
        path: String::new(),
    }];
    let mut current = String::new();
    for part in path.split('/').filter(|part| !part.is_empty()) {
        current = if current.is_empty() {
            part.to_owned()
        } else {
            format!("{current}/{part}")
        };
        out.push(Breadcrumb {
            name: part.to_owned(),
            path: current.clone(),
        });
    }
    out
}

pub(crate) fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs() as i64)
        .unwrap_or(0)
}

pub(crate) fn hash_file(path: &Path) -> Result<String, AppError> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher)?;
    Ok(hex::encode(hasher.finalize()))
}

async fn hash_file_async(path: &Path) -> Result<String, AppError> {
    let path = path.to_owned();
    tokio::task::spawn_blocking(move || hash_file(&path))
        .await
        .map_err(|error| AppError::Io(std::io::Error::other(error)))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{config::Config, db, state::AppState};
    use std::io::Write;

    async fn test_state() -> (tempfile::TempDir, AppState) {
        let temp = tempfile::tempdir().expect("temporary directory");
        let books = temp.path().join("books");
        let data = temp.path().join("data");
        std::fs::create_dir_all(&books).expect("book root");
        let mut config = Config::for_test(data);
        config.books_dir = books;
        let pool = db::connect(&config).await.expect("database");
        (temp, AppState::new(config, pool))
    }

    async fn publication_rows(state: &AppState) -> Vec<(i64, String, String)> {
        sqlx::query_as("SELECT id,relative_path,sha256 FROM publications ORDER BY relative_path")
            .fetch_all(&state.db)
            .await
            .expect("publication rows")
    }

    async fn scan(state: &AppState) {
        run_scan(state).await.expect("scan");
    }

    #[test]
    fn collects_empty_and_nested_directories_without_indexing_unsupported_files() {
        let temp = tempfile::tempdir().expect("temporary directory");
        let nested = temp.path().join("小说").join("空目录");
        std::fs::create_dir_all(&nested).expect("nested directories");
        std::fs::write(temp.path().join("novel.txt"), "第一章\n内容").expect("text fixture");
        std::fs::write(temp.path().join("ignored.pdf"), b"not indexed")
            .expect("unsupported fixture");
        let collected = collect_files(temp.path());
        assert!(collected.complete);
        assert_eq!(collected.files.len(), 1);
        assert!(collected.directories.contains(&nested));
    }

    #[test]
    fn rejects_parent_paths() {
        assert!(normalize_relative("../secret").is_err());
        assert_eq!(normalize_relative("a\\b").unwrap(), "a/b");
    }

    #[tokio::test]
    async fn scan_indexes_nested_books_and_prunes_deleted_files() {
        let (_temp, state) = test_state().await;
        let nested = state.config.books_dir.join("中文").join("子目录");
        std::fs::create_dir_all(&nested).expect("nested directory");
        std::fs::write(nested.join("story.txt"), "第一章\n正文").expect("TXT");
        std::fs::write(state.config.books_dir.join("ignore.pdf"), b"not supported")
            .expect("unsupported file");

        scan(&state).await;
        let rows = publication_rows(&state).await;
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].1, "中文/子目录/story.txt");
        let directory_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM directories WHERE relative_path <> ''")
                .fetch_one(&state.db)
                .await
                .expect("directory count");
        assert_eq!(directory_count, 2);

        std::fs::remove_file(nested.join("story.txt")).expect("delete TXT");
        scan(&state).await;
        assert!(publication_rows(&state).await.is_empty());
    }

    #[tokio::test]
    async fn damaged_cover_keeps_publication_with_format_placeholder() {
        let (_temp, state) = test_state().await;
        let path = state.config.books_dir.join("damaged.cbz");
        let mut archive = zip::ZipWriter::new(std::fs::File::create(&path).expect("CBZ"));
        archive
            .start_file("001.jpg", zip::write::SimpleFileOptions::default())
            .expect("page entry");
        archive.write_all(b"not an image").expect("page bytes");
        archive.finish().expect("CBZ archive");

        scan(&state).await;
        let row = sqlx::query(
            "SELECT has_cover,parse_status,parse_error FROM publications WHERE relative_path='damaged.cbz'",
        )
        .fetch_one(&state.db)
        .await
        .expect("publication row");
        assert!(!row.try_get::<bool, _>("has_cover").expect("cover flag"));
        assert_eq!(
            row.try_get::<String, _>("parse_status").expect("status"),
            "ok"
        );
        assert!(
            row.try_get::<Option<String>, _>("parse_error")
                .expect("parse error")
                .is_some()
        );
    }

    #[tokio::test]
    async fn oversized_cover_is_rejected_before_decode() {
        let (_temp, state) = test_state().await;
        let mut png = Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(COVER_MAX_DIMENSION + 1, 1)
            .write_to(&mut png, image::ImageFormat::Png)
            .expect("PNG fixture");

        let result = write_cover(&state, "oversized", png.into_inner())
            .await
            .expect("cover result");
        assert!(!result.written);
        assert!(
            result
                .error
                .as_deref()
                .is_some_and(|message| message.contains("dimensions"))
        );
        assert!(!state.cover_path("oversized").exists());
    }

    #[tokio::test]
    async fn scan_skips_unchanged_files_and_reindexes_modified_content() {
        let (_temp, state) = test_state().await;
        let path = state.config.books_dir.join("story.txt");
        std::fs::write(&path, "第一章\n旧内容").expect("TXT");
        scan(&state).await;
        let first = publication_rows(&state).await;
        assert_eq!(first.len(), 1);

        scan(&state).await;
        let unchanged = publication_rows(&state).await;
        assert_eq!(unchanged, first);

        std::fs::write(&path, "第一章\n新内容\n更多内容").expect("modified TXT");
        scan(&state).await;
        let modified = publication_rows(&state).await;
        assert_eq!(modified.len(), 1);
        assert_eq!(modified[0].0, first[0].0);
        assert_ne!(modified[0].2, first[0].2);
    }

    #[tokio::test]
    async fn scan_preserves_id_on_unique_move_but_not_for_duplicates() {
        let (_temp, state) = test_state().await;
        let original = state.config.books_dir.join("original.txt");
        std::fs::write(&original, "第一章\n同一份内容").expect("TXT");
        scan(&state).await;
        let first_id = publication_rows(&state).await[0].0;

        let moved = state.config.books_dir.join("nested").join("moved.txt");
        std::fs::create_dir_all(moved.parent().expect("parent")).expect("directory");
        std::fs::rename(&original, &moved).expect("move");
        scan(&state).await;
        let moved_row = publication_rows(&state).await;
        assert_eq!(moved_row.len(), 1);
        assert_eq!(moved_row[0].0, first_id);
        assert_eq!(moved_row[0].1, "nested/moved.txt");

        std::fs::copy(&moved, state.config.books_dir.join("duplicate.txt")).expect("duplicate");
        scan(&state).await;
        let duplicate_rows = publication_rows(&state).await;
        assert_eq!(duplicate_rows.len(), 2);
        assert_ne!(duplicate_rows[0].0, duplicate_rows[1].0);

        // If one of two duplicate files moves, the missing candidate is
        // unambiguous and should retain its own ID while the live duplicate
        // remains untouched.
        let duplicate_id = duplicate_rows
            .iter()
            .find(|row| row.1 == "duplicate.txt")
            .expect("duplicate row")
            .0;
        let duplicate_moved = state
            .config
            .books_dir
            .join("nested")
            .join("duplicate-moved.txt");
        std::fs::rename(
            state.config.books_dir.join("duplicate.txt"),
            &duplicate_moved,
        )
        .expect("move duplicate");
        scan(&state).await;
        let moved_duplicates = publication_rows(&state).await;
        assert!(
            moved_duplicates
                .iter()
                .any(|row| row.0 == duplicate_id && row.1 == "nested/duplicate-moved.txt")
        );
    }

    #[tokio::test]
    async fn incomplete_scan_does_not_prune_existing_index() {
        let (_temp, state) = test_state().await;
        let path = state.config.books_dir.join("story.txt");
        std::fs::write(&path, "第一章\n正文").expect("TXT");
        scan(&state).await;
        assert_eq!(publication_rows(&state).await.len(), 1);

        std::fs::remove_dir_all(&state.config.books_dir).expect("temporarily unavailable root");
        scan(&state).await;
        assert_eq!(publication_rows(&state).await.len(), 1);
    }
}
