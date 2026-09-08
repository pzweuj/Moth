//! Filesystem-first library configuration, directory indexing and scanning.

use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use axum::{
    Json,
    extract::{Path as AxumPath, Query, State},
};
use image::codecs::jpeg::JpegEncoder;
use moth_format::{BookFormat, ParsedBook};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{Row, SqlitePool};

use crate::{
    auth::Authenticated,
    error::AppError,
    state::{AppState, ScanStatus},
};

const COVER_MAX_EDGE: u32 = 640;

#[derive(Debug, Serialize)]
pub struct LibrarySummary {
    pub key: String,
    pub name: String,
    pub publication_count: i64,
    pub directory_count: i64,
}

#[derive(Debug, Serialize)]
pub struct DirectorySummary {
    pub name: String,
    pub path: String,
    pub publication_count: i64,
}

#[derive(Debug, Serialize)]
pub struct BrowseResponse {
    pub library: LibrarySummary,
    pub path: String,
    pub breadcrumbs: Vec<Breadcrumb>,
    pub directories: Vec<DirectorySummary>,
    pub publications: Vec<crate::books::PublicationSummary>,
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

pub async fn list_libraries(
    State(state): State<AppState>,
    _user: Authenticated,
) -> Result<Json<Vec<LibrarySummary>>, AppError> {
    let rows = sqlx::query(
        "SELECT l.config_key, l.name, COUNT(DISTINCT p.id) AS publication_count, COUNT(DISTINCT d.id) AS directory_count
         FROM libraries l LEFT JOIN directories d ON d.library_id = l.id LEFT JOIN publications p ON p.library_id = l.id
         GROUP BY l.id ORDER BY l.name COLLATE NOCASE",
    ).fetch_all(&state.db).await?;
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        out.push(LibrarySummary {
            key: row.try_get("config_key")?,
            name: row.try_get("name")?,
            publication_count: row.try_get("publication_count")?,
            directory_count: row.try_get("directory_count")?,
        });
    }
    Ok(Json(out))
}

pub async fn browse_library(
    State(state): State<AppState>,
    _user: Authenticated,
    AxumPath(key): AxumPath<String>,
    Query(query): Query<BrowseQuery>,
) -> Result<Json<BrowseResponse>, AppError> {
    let library = library_row(&state.db, &key).await?;
    let path = normalize_relative(query.path.as_deref().unwrap_or(""))?;
    let directory_id: i64 =
        sqlx::query_scalar("SELECT id FROM directories WHERE library_id = ? AND relative_path = ?")
            .bind(library.0)
            .bind(&path)
            .fetch_optional(&state.db)
            .await?
            .ok_or(AppError::NotFound)?;
    let summary = library_summary(&state.db, library.0, &library.1).await?;
    let directories = sqlx::query(
        "SELECT d.name, d.relative_path AS path, COUNT(p.id) AS publication_count
         FROM directories d LEFT JOIN publications p ON p.directory_id = d.id
         WHERE d.library_id = ? AND d.parent_id = ? GROUP BY d.id ORDER BY d.name COLLATE NOCASE",
    )
    .bind(library.0)
    .bind(directory_id)
    .fetch_all(&state.db)
    .await?;
    let dirs = directories
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
        crate::books::fetch_publications(&state.db, Some(library.0), Some(directory_id), None)
            .await?;
    Ok(Json(BrowseResponse {
        library: summary,
        path: path.clone(),
        breadcrumbs: breadcrumbs(&path),
        directories: dirs,
        publications,
    }))
}

pub async fn start_library_scan(
    State(state): State<AppState>,
    _user: Authenticated,
    AxumPath(key): AxumPath<String>,
) -> Result<(), AppError> {
    let _ = library_row(&state.db, &key).await?;
    start_scan_on(&state, Some(key)).await
}

pub async fn scan_status(
    State(state): State<AppState>,
    _user: Authenticated,
    AxumPath(key): AxumPath<String>,
) -> Result<Json<ScanStatus>, AppError> {
    let _ = library_row(&state.db, &key).await?;
    let status = state.scan_status.lock().await.clone();
    Ok(Json(status))
}

pub async fn start_scan_on(state: &AppState, only: Option<String>) -> Result<(), AppError> {
    {
        let mut status = state.scan_status.lock().await;
        if status.scanning {
            return Err(AppError::Conflict {
                code: "scan_in_progress",
                message: "A library scan is already running",
            });
        }
        *status = ScanStatus {
            scanning: true,
            ..ScanStatus::default()
        };
    }
    let cloned = state.clone();
    tokio::spawn(async move {
        let result = run_scan(&cloned, only.as_deref()).await;
        let mut status = cloned.scan_status.lock().await;
        status.scanning = false;
        if let Err(error) = result {
            status.message = error.to_string();
        }
    });
    Ok(())
}

pub async fn start_initial_scan(state: &AppState) -> Result<(), AppError> {
    sync_configured_libraries(state).await?;
    start_scan_on(state, None).await
}

async fn run_scan(state: &AppState, only: Option<&str>) -> Result<(), AppError> {
    let configured: Vec<_> = state
        .config
        .libraries
        .iter()
        .filter(|library| only.is_none_or(|key| key == library.key))
        .cloned()
        .collect();
    let mut all_files = Vec::new();
    let mut all_directories = Vec::new();
    let mut directory_paths: HashMap<String, HashSet<String>> = HashMap::new();
    let mut complete = true;
    let mut scanned_keys = Vec::with_capacity(configured.len());
    for library in configured {
        let root = library.path.clone();
        let key = library.key.clone();
        scanned_keys.push(key.clone());
        let scan_root = root.clone();
        let collected = tokio::task::spawn_blocking(move || collect_files(&root))
            .await
            .map_err(|error| AppError::Io(std::io::Error::other(error)))?;
        if !collected.complete {
            complete = false;
            state.scan_status.lock().await.message = format!("Library scan was incomplete: {key}");
        }
        for directory in collected.directories {
            match directory.strip_prefix(&scan_root) {
                Ok(relative) => {
                    let relative = relative.to_string_lossy().replace('\\', "/");
                    directory_paths
                        .entry(key.clone())
                        .or_default()
                        .insert(relative);
                    all_directories.push((key.clone(), directory));
                }
                Err(_) => {
                    complete = false;
                    state.scan_status.lock().await.message =
                        format!("Library scan encountered a path outside its root: {key}");
                }
            }
        }
        all_files.extend(collected.files.into_iter().map(|file| (key.clone(), file)));
    }
    state.scan_status.lock().await.total = all_files.len() as u64;
    // Create the directory tree before indexing files so empty directories are
    // visible and the database remains a faithful projection of the source
    // filesystem.  A directory disappearing between collection and indexing
    // makes the scan incomplete; in that case pruning is deliberately skipped.
    for (key, directory) in all_directories {
        if !directory.is_dir() {
            complete = false;
            state.scan_status.lock().await.message = format!(
                "Library scan was incomplete while reading directory: {}",
                directory.display()
            );
            continue;
        }
        let (library_id, _name, root) = library_row(&state.db, &key).await?;
        let relative = directory.strip_prefix(&root).map_err(|_| {
            AppError::Validation("directory is outside configured library".to_owned())
        })?;
        ensure_directory(&state.db, library_id, relative).await?;
    }
    for (key, file) in all_files {
        if let Err(error) = index_file(state, &key, &file).await {
            tracing::warn!(library = %key, path = %file.display(), %error, "publication indexing failed");
            complete = false;
            let mut status = state.scan_status.lock().await;
            status.errors += 1;
            status.message = error.to_string();
        }
        state.scan_status.lock().await.processed += 1;
    }
    if complete {
        prune_removed(state, &scanned_keys, &directory_paths).await?;
    }
    Ok(())
}

struct Collected {
    files: Vec<PathBuf>,
    directories: Vec<PathBuf>,
    complete: bool,
}

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

async fn index_file(state: &AppState, key: &str, path: &Path) -> Result<(), AppError> {
    let (library_id, _name, root) = library_row(&state.db, key).await?;
    let relative = path
        .strip_prefix(&root)
        .map_err(|_| AppError::Validation("file is outside configured library".to_owned()))?
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
    let existing = sqlx::query("SELECT id, sha256, file_size, mtime_ns, format FROM publications WHERE library_id = ? AND relative_path = ?").bind(library_id).bind(&relative).fetch_optional(&state.db).await?;
    if let Some(row) = existing {
        let id: i64 = row.try_get("id")?;
        if row.try_get::<i64, _>("file_size")? == size
            && row.try_get::<i64, _>("mtime_ns")? == mtime
            && row.try_get::<String, _>("format")? == format.as_str()
        {
            return Ok(());
        }
        let hash = hash_file(path)?;
        let directory = ensure_directory(
            &state.db,
            library_id,
            Path::new(&relative).parent().unwrap_or(Path::new("")),
        )
        .await?;
        return store_publication(
            state, id, library_id, directory, &relative, path, format, hash, size, mtime,
        )
        .await;
    }
    let hash = hash_file(path)?;
    // A unique hash match is treated as a move/rename within one Library.
    let candidates = sqlx::query("SELECT id,relative_path FROM publications WHERE library_id = ? AND sha256 = ? AND file_size = ? AND format = ? AND relative_path <> ?")
        .bind(library_id).bind(&hash).bind(size).bind(format.as_str()).bind(&relative).fetch_all(&state.db).await?;
    let id = if candidates.len() == 1 {
        let candidate_path: String = candidates[0].try_get("relative_path")?;
        let candidate_file = root.join(&candidate_path);
        let candidate_exists = candidate_file.is_file()
            && BookFormat::from_path(&candidate_file)
                .is_some_and(|candidate_format| candidate_format.as_str() == format.as_str());
        if candidate_exists {
            0
        } else {
            candidates[0].try_get("id")?
        }
    } else {
        // Multiple equal hashes are intentionally kept as independent rows;
        // only one unambiguously missing path may be adopted as a move.
        0
    };
    let directory = ensure_directory(
        &state.db,
        library_id,
        Path::new(&relative).parent().unwrap_or(Path::new("")),
    )
    .await?;
    if id != 0 {
        return store_publication(
            state, id, library_id, directory, &relative, path, format, hash, size, mtime,
        )
        .await;
    }
    store_publication(
        state, 0, library_id, directory, &relative, path, format, hash, size, mtime,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn store_publication(
    state: &AppState,
    id: i64,
    library_id: i64,
    directory_id: i64,
    relative: &str,
    path: &Path,
    format: BookFormat,
    hash: String,
    size: i64,
    mtime: i64,
) -> Result<(), AppError> {
    let parsed = tokio::task::spawn_blocking({
        let path = path.to_owned();
        move || match format {
            BookFormat::Epub => moth_format::epub::parse_metadata(&path),
            BookFormat::Mobi => moth_format::mobi::parse_metadata(&path),
            _ => ParsedBook::parse_as(&path, format),
        }
    })
    .await
    .map_err(|error| AppError::Io(std::io::Error::other(error)))?;
    let now = now_unix();
    let (title, author, cover, pages, parse_error) = match parsed {
        Ok(book) => (book.title, book.author, book.cover, book.pages, None),
        Err(error) => (
            path.file_stem()
                .map(|value| value.to_string_lossy().into_owned())
                .unwrap_or_else(|| "未命名".to_owned()),
            None,
            None,
            Vec::new(),
            Some(error.to_string()),
        ),
    };
    let status = if parse_error.is_some() { "error" } else { "ok" };
    let publication_id = if id == 0 {
        sqlx::query_scalar::<_, i64>("INSERT INTO publications (library_id,directory_id,relative_path,filename,format,title,author,file_size,mtime_ns,sha256,has_cover,parse_status,parse_error,added_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id")
            .bind(library_id).bind(directory_id).bind(relative).bind(path.file_name().map(|v| v.to_string_lossy().into_owned()).unwrap_or_default()).bind(format.as_str()).bind(&title).bind(&author).bind(size).bind(mtime).bind(&hash).bind(cover.is_some()).bind(status).bind(&parse_error).bind(now).bind(now).fetch_one(&state.db).await?
    } else {
        sqlx::query("UPDATE publications SET directory_id=?,relative_path=?,filename=?,format=?,title=?,author=?,file_size=?,mtime_ns=?,sha256=?,has_cover=?,parse_status=?,parse_error=?,updated_at=? WHERE id=?")
            .bind(directory_id).bind(relative).bind(path.file_name().map(|v| v.to_string_lossy().into_owned()).unwrap_or_default()).bind(format.as_str()).bind(&title).bind(&author).bind(size).bind(mtime).bind(&hash).bind(cover.is_some()).bind(status).bind(&parse_error).bind(now).bind(id).execute(&state.db).await?;
        sqlx::query("DELETE FROM text_chapters WHERE publication_id = ?")
            .bind(id)
            .execute(&state.db)
            .await?;
        sqlx::query("DELETE FROM cbz_pages WHERE publication_id = ?")
            .bind(id)
            .execute(&state.db)
            .await?;
        id
    };
    let cache_version = crate::books::content_version(&hash, format.as_str(), None);
    if let Some(cover) = cover {
        write_cover(state, &cache_version, &cover.data).await?;
    }
    if format == BookFormat::Cbz {
        for (idx, page) in pages.iter().enumerate() {
            sqlx::query("INSERT INTO cbz_pages (publication_id,idx,path,mime) VALUES (?,?,?,?)")
                .bind(publication_id)
                .bind(idx as i64)
                .bind(&page.path)
                .bind(&page.mime)
                .execute(&state.db)
                .await?;
        }
    }
    if format == BookFormat::Txt && parse_error.is_none() {
        let text_version = crate::books::content_version(&hash, "txt", Some("auto"));
        write_text_cache(state, publication_id, &text_version, path, "auto").await?;
    }
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
    let chapters = tokio::task::spawn_blocking(move || {
        moth_format::txt::normalized_chapters(&path, requested.as_deref())
    })
    .await
    .map_err(|error| AppError::Io(std::io::Error::other(error)))?
    .map_err(|error| AppError::Validation(error.to_string()))?;
    let dir = state.txt_dir(content_version, encoding);
    tokio::fs::create_dir_all(&dir).await?;
    let mut bytes = Vec::new();
    let mut ranges = Vec::with_capacity(chapters.len());
    for (idx, (title, body)) in chapters.iter().enumerate() {
        let start = bytes.len() as i64;
        bytes.extend_from_slice(body.as_bytes());
        bytes.extend_from_slice(b"\n");
        let end = bytes.len() as i64;
        ranges.push((idx as i64, title.clone(), start, end));
    }
    let target = dir.join("book.utf8");
    let temp = dir.join("book.utf8.tmp");
    tokio::fs::write(&temp, bytes).await?;
    tokio::fs::rename(&temp, &target).await?;
    for (idx, title, start, end) in ranges {
        sqlx::query("INSERT INTO text_chapters (publication_id,encoding,idx,title,byte_start,byte_end) VALUES (?,?,?,?,?,?) ON CONFLICT(publication_id,encoding,idx) DO UPDATE SET title=excluded.title,byte_start=excluded.byte_start,byte_end=excluded.byte_end")
            .bind(id)
            .bind(encoding)
            .bind(idx)
            .bind(title)
            .bind(start)
            .bind(end)
            .execute(&state.db)
            .await?;
    }
    Ok(())
}

async fn write_cover(
    state: &AppState,
    content_version: &str,
    bytes: &[u8],
) -> Result<(), AppError> {
    let dir = state.covers_dir();
    tokio::fs::create_dir_all(&dir).await?;
    let target = state.cover_path(content_version);
    if target.exists() {
        return Ok(());
    }
    let raw = bytes.to_vec();
    let encoded = tokio::task::spawn_blocking(move || {
        let image = image::load_from_memory(&raw)
            .map_err(|error| AppError::Validation(format!("invalid cover: {error}")))?;
        let image = image.thumbnail(COVER_MAX_EDGE, COVER_MAX_EDGE);
        let mut output = Vec::new();
        JpegEncoder::new_with_quality(&mut output, 84)
            .encode_image(&image)
            .map_err(|error| AppError::Validation(format!("could not encode cover: {error}")))?;
        Ok::<_, AppError>(output)
    })
    .await
    .map_err(|error| AppError::Io(std::io::Error::other(error)))??;
    let temp = target.with_extension("tmp");
    tokio::fs::write(&temp, encoded).await?;
    tokio::fs::rename(temp, target).await?;
    Ok(())
}

async fn ensure_directory(
    db: &SqlitePool,
    library_id: i64,
    relative: &Path,
) -> Result<i64, AppError> {
    // Every non-root directory must be attached to the synthetic library-root
    // row.  The old implementation started with `parent_id = NULL`, which
    // left first-level directories orphaned from browse queries that select
    // `parent_id = root.id`.
    sqlx::query("INSERT INTO directories (library_id,parent_id,name,relative_path,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(library_id,relative_path) DO NOTHING")
        .bind(library_id)
        .bind(None::<i64>)
        .bind("书库")
        .bind("")
        .bind(now_unix())
        .execute(db)
        .await?;
    let root_id: i64 = sqlx::query_scalar(
        "SELECT id FROM directories WHERE library_id = ? AND relative_path = ''",
    )
    .bind(library_id)
    .fetch_one(db)
    .await?;
    if relative.as_os_str().is_empty() {
        return Ok(root_id);
    }

    let mut parent_id = Some(root_id);
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
        sqlx::query("INSERT INTO directories (library_id,parent_id,name,relative_path,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(library_id,relative_path) DO UPDATE SET name=excluded.name, parent_id=excluded.parent_id, updated_at=excluded.updated_at")
            .bind(library_id).bind(parent_id).bind(&name).bind(&current).bind(now_unix()).execute(db).await?;
        parent_id = sqlx::query_scalar(
            "SELECT id FROM directories WHERE library_id = ? AND relative_path = ?",
        )
        .bind(library_id)
        .bind(&current)
        .fetch_one(db)
        .await?;
    }
    parent_id.ok_or_else(|| AppError::Validation("directory path is empty".to_owned()))
}

async fn prune_removed(
    state: &AppState,
    keys: &[String],
    directory_paths: &HashMap<String, HashSet<String>>,
) -> Result<(), AppError> {
    for library in state
        .config
        .libraries
        .iter()
        .filter(|library| keys.iter().any(|key| key == &library.key))
    {
        let (id, _name, root) = library_row(&state.db, &library.key).await?;
        let rows = sqlx::query("SELECT id,relative_path FROM publications WHERE library_id = ?")
            .bind(id)
            .fetch_all(&state.db)
            .await?;
        for row in rows {
            let publication_id: i64 = row.try_get("id")?;
            let relative: String = row.try_get("relative_path")?;
            let source = root.join(&relative);
            match std::fs::metadata(&source) {
                Ok(metadata) if metadata.is_file() && BookFormat::from_path(&source).is_some() => {}
                Ok(_) => {
                    sqlx::query("DELETE FROM publications WHERE id = ?")
                        .bind(publication_id)
                        .execute(&state.db)
                        .await?;
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    sqlx::query("DELETE FROM publications WHERE id = ?")
                        .bind(publication_id)
                        .execute(&state.db)
                        .await?;
                }
                Err(error) => {
                    tracing::warn!(library = %library.key, path = %relative, %error, "could not verify indexed publication during prune");
                }
            }
        }
        // Directories are also derived from the filesystem, including empty
        // ones. Delete only rows absent from this complete scan, deepest first
        // so a stale parent cannot cascade a still-present child row.
        let present = directory_paths.get(&library.key);
        let rows = sqlx::query(
            "SELECT id,relative_path FROM directories WHERE library_id=? AND relative_path<>''",
        )
        .bind(id)
        .fetch_all(&state.db)
        .await?;
        let mut stale = rows
            .into_iter()
            .filter_map(|row| {
                let relative: String = row.try_get("relative_path").ok()?;
                let id: i64 = row.try_get("id").ok()?;
                if present.is_none_or(|paths| !paths.contains(&relative)) {
                    Some((relative, id))
                } else {
                    None
                }
            })
            .collect::<Vec<_>>();
        stale.sort_by(|(left, _), (right, _)| {
            right.split('/').count().cmp(&left.split('/').count())
        });
        for (_relative, directory_id) in stale {
            sqlx::query("DELETE FROM directories WHERE id=?")
                .bind(directory_id)
                .execute(&state.db)
                .await?;
        }
    }
    Ok(())
}

async fn sync_configured_libraries(state: &AppState) -> Result<(), AppError> {
    let now = now_unix();
    for library in &state.config.libraries {
        sqlx::query("INSERT INTO libraries (config_key,name,root_path,created_at,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(config_key) DO UPDATE SET name=excluded.name, root_path=excluded.root_path, updated_at=excluded.updated_at").bind(&library.key).bind(&library.name).bind(library.path.to_string_lossy().as_ref()).bind(now).bind(now).execute(&state.db).await?;
    }
    let keys: HashSet<_> = state
        .config
        .libraries
        .iter()
        .map(|library| library.key.as_str())
        .collect();
    let rows = sqlx::query("SELECT id,config_key FROM libraries")
        .fetch_all(&state.db)
        .await?;
    for row in rows {
        let id: i64 = row.try_get("id")?;
        let key: String = row.try_get("config_key")?;
        if !keys.contains(key.as_str()) {
            sqlx::query("DELETE FROM libraries WHERE id=?")
                .bind(id)
                .execute(&state.db)
                .await?;
        }
    }
    for library in &state.config.libraries {
        let id: i64 = sqlx::query_scalar("SELECT id FROM libraries WHERE config_key=?")
            .bind(&library.key)
            .fetch_one(&state.db)
            .await?;
        ensure_directory(&state.db, id, Path::new("")).await?;
    }
    Ok(())
}

async fn library_summary(db: &SqlitePool, id: i64, name: &str) -> Result<LibrarySummary, AppError> {
    let publication_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM publications WHERE library_id=?")
            .bind(id)
            .fetch_one(db)
            .await?;
    let directory_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM directories WHERE library_id=?")
            .bind(id)
            .fetch_one(db)
            .await?;
    let key: String = sqlx::query_scalar("SELECT config_key FROM libraries WHERE id=?")
        .bind(id)
        .fetch_one(db)
        .await?;
    Ok(LibrarySummary {
        key,
        name: name.to_owned(),
        publication_count,
        directory_count,
    })
}

pub(crate) async fn library_row(
    db: &SqlitePool,
    key: &str,
) -> Result<(i64, String, PathBuf), AppError> {
    let row = sqlx::query("SELECT id,name,root_path FROM libraries WHERE config_key=?")
        .bind(key)
        .fetch_optional(db)
        .await?
        .ok_or(AppError::NotFound)?;
    Ok((
        row.try_get("id")?,
        row.try_get("name")?,
        PathBuf::from(row.try_get::<String, _>("root_path")?),
    ))
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
                    "path must stay inside the library".to_owned(),
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

#[cfg(test)]
mod tests {
    use super::*;

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
        assert!(collected.directories.contains(&temp.path().to_path_buf()));
        assert!(collected.directories.contains(&nested));
    }

    #[tokio::test]
    async fn scan_preserves_unique_moves_and_keeps_duplicate_files_separate() {
        let temp = tempfile::tempdir().expect("temporary directory");
        let root = temp.path().join("books");
        std::fs::create_dir_all(&root).expect("book root");
        std::fs::write(root.join("novel.txt"), "第一章\n内容").expect("text fixture");

        let mut config = crate::config::Config::for_test(temp.path().join("data"));
        config.libraries[0].path = root.clone();
        let db = crate::db::connect(&config).await.expect("database");
        let state = crate::state::AppState::new(config, db);
        sync_configured_libraries(&state)
            .await
            .expect("configured library");
        run_scan(&state, None).await.expect("initial scan");

        let first_id: i64 = sqlx::query_scalar("SELECT id FROM publications")
            .fetch_one(&state.db)
            .await
            .expect("first publication");
        std::fs::create_dir_all(root.join("nested")).expect("nested directory");
        std::fs::rename(root.join("novel.txt"), root.join("nested/renamed.txt"))
            .expect("move fixture");
        run_scan(&state, None).await.expect("move scan");
        let moved: (i64, String) = sqlx::query_as("SELECT id,relative_path FROM publications")
            .fetch_one(&state.db)
            .await
            .expect("moved publication");
        assert_eq!(moved.0, first_id);
        assert_eq!(moved.1, "nested/renamed.txt");

        std::fs::copy(root.join("nested/renamed.txt"), root.join("duplicate.txt"))
            .expect("duplicate fixture");
        run_scan(&state, None).await.expect("duplicate scan");
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM publications")
            .fetch_one(&state.db)
            .await
            .expect("publication count");
        assert_eq!(count, 2);

        std::fs::remove_file(root.join("duplicate.txt")).expect("remove duplicate");
        run_scan(&state, None).await.expect("delete scan");
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM publications")
            .fetch_one(&state.db)
            .await
            .expect("publication count after delete");
        assert_eq!(count, 1);

        std::fs::rename(
            root.join("nested/renamed.txt"),
            root.join("nested/renamed.pdf"),
        )
        .expect("unsupported rename");
        run_scan(&state, None).await.expect("unsupported scan");
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM publications")
            .fetch_one(&state.db)
            .await
            .expect("publication count after extension change");
        assert_eq!(count, 0);
        let directories: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM directories WHERE relative_path='nested'")
                .fetch_one(&state.db)
                .await
                .expect("nested directory count");
        assert_eq!(directories, 1);
        let parent_id: Option<i64> =
            sqlx::query_scalar("SELECT parent_id FROM directories WHERE relative_path='nested'")
                .fetch_one(&state.db)
                .await
                .expect("nested directory parent");
        let root_id: i64 = sqlx::query_scalar("SELECT id FROM directories WHERE relative_path=''")
            .fetch_one(&state.db)
            .await
            .expect("library root");
        assert_eq!(parent_id, Some(root_id));
    }

    #[test]
    fn rejects_parent_paths() {
        assert!(normalize_relative("../secret").is_err());
        assert_eq!(normalize_relative("a\\b").unwrap(), "a/b");
    }
}
