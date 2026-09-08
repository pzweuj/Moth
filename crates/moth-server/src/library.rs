//! Filesystem-first indexing for one read-only book root.

use std::{
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use axum::{
    Json,
    extract::{Query, State},
};
use image::codecs::jpeg::JpegEncoder;
use moth_format::{BookFormat, Cover, Page, ParseError};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{Row, SqlitePool};

use crate::{
    auth::Authenticated,
    error::AppError,
    state::{AppState, ScanStatus},
};

const COVER_MAX_EDGE: u32 = 640;

struct IndexedPublication {
    title: String,
    author: Option<String>,
    cover: Option<Cover>,
    pages: Vec<Page>,
}

fn parse_index(path: &Path, format: BookFormat) -> Result<IndexedPublication, ParseError> {
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
                pages: Vec::new(),
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
                pages: Vec::new(),
            })
        }
        BookFormat::Txt => {
            let chapters = moth_format::txt::normalized_chapters(path, None)?;
            let title = chapters
                .iter()
                .find_map(|(title, _)| (!title.trim().is_empty()).then(|| title.clone()))
                .unwrap_or_else(fallback_title);
            Ok(IndexedPublication {
                title,
                author: None,
                cover: None,
                pages: Vec::new(),
            })
        }
        BookFormat::Cbz => {
            let index = moth_format::cbz::parse(path)?;
            Ok(IndexedPublication {
                title: fallback_title(),
                author: None,
                cover: index.cover,
                pages: index.pages,
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
    let collected = tokio::task::spawn_blocking(move || collect_files(&root))
        .await
        .map_err(|error| AppError::Io(std::io::Error::other(error)))?;
    let mut complete = collected.complete;
    let root = state.config.books_dir.clone();
    {
        let mut status = state.scan_status.lock().await;
        status.total = collected.files.len() as u64;
        if !collected.complete {
            status.message = "扫描未完整完成，已保留现有索引".to_owned();
        }
    }
    for directory in collected.directories {
        if !directory.is_dir() {
            complete = false;
            state.scan_status.lock().await.message =
                format!("扫描期间目录消失：{}", directory.display());
            continue;
        }
        let relative = directory
            .strip_prefix(&root)
            .map_err(|_| AppError::Validation("directory is outside book root".to_owned()))?;
        if let Err(error) = ensure_directory(&state.db, relative).await {
            complete = false;
            state.scan_status.lock().await.message = error.to_string();
        }
    }
    for file in collected.files {
        if let Err(error) = index_file(state, &file).await {
            tracing::warn!(path = %file.display(), %error, "publication indexing failed");
            complete = false;
            let mut status = state.scan_status.lock().await;
            status.errors += 1;
            status.message = error.to_string();
        }
        state.scan_status.lock().await.processed += 1;
    }
    if complete {
        prune_removed(state).await?;
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
        let hash = hash_file(path)?;
        let directory = ensure_directory(
            &state.db,
            Path::new(&relative).parent().unwrap_or(Path::new("")),
        )
        .await?;
        return store_publication(
            state, id, directory, &relative, path, format, hash, size, mtime,
        )
        .await;
    }
    let hash = hash_file(path)?;
    let candidates = sqlx::query("SELECT id,relative_path FROM publications WHERE sha256=? AND file_size=? AND format=? AND relative_path<>?")
        .bind(&hash).bind(size).bind(format.as_str()).bind(&relative)
        .fetch_all(&state.db).await?;
    let id = if candidates.len() == 1 {
        let candidate_path: String = candidates[0].try_get("relative_path")?;
        if !root.join(&candidate_path).is_file() {
            candidates[0].try_get("id")?
        } else {
            0
        }
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
    let parsed = tokio::task::spawn_blocking({
        let path = path.to_owned();
        move || parse_index(&path, format)
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
        sqlx::query_scalar::<_, i64>("INSERT INTO publications (directory_id,relative_path,filename,format,title,author,file_size,mtime_ns,sha256,has_cover,parse_status,parse_error,added_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id")
            .bind(directory_id).bind(relative).bind(path.file_name().map(|v| v.to_string_lossy().into_owned()).unwrap_or_default()).bind(format.as_str()).bind(&title).bind(&author).bind(size).bind(mtime).bind(&hash).bind(cover.is_some()).bind(status).bind(&parse_error).bind(now).bind(now).fetch_one(&state.db).await?
    } else {
        sqlx::query("UPDATE publications SET directory_id=?,relative_path=?,filename=?,format=?,title=?,author=?,file_size=?,mtime_ns=?,sha256=?,has_cover=?,parse_status=?,parse_error=?,updated_at=? WHERE id=?")
            .bind(directory_id).bind(relative).bind(path.file_name().map(|v| v.to_string_lossy().into_owned()).unwrap_or_default()).bind(format.as_str()).bind(&title).bind(&author).bind(size).bind(mtime).bind(&hash).bind(cover.is_some()).bind(status).bind(&parse_error).bind(now).bind(id).execute(&state.db).await?;
        sqlx::query("DELETE FROM text_chapters WHERE publication_id=?")
            .bind(id)
            .execute(&state.db)
            .await?;
        sqlx::query("DELETE FROM cbz_pages WHERE publication_id=?")
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
        // Keep the separator outside each chapter's range. It is useful in
        // the concatenated cache, but it is not part of the normalized text
        // returned to the reader or counted by the TXT locator.
        if idx > 0 {
            bytes.extend_from_slice(b"\n");
        }
        let start = bytes.len() as i64;
        bytes.extend_from_slice(body.as_bytes());
        let end = bytes.len() as i64;
        // The virtual TXT section renders its chapter title as an h1, then a
        // single newline, before the normalized body. The locator covers
        // exactly those visible UTF-16 code units.
        let character_count =
            (title.encode_utf16().count() + 1 + body.encode_utf16().count()) as i64;
        ranges.push((idx as i64, title.clone(), start, end, character_count));
    }
    let target = dir.join("book.utf8");
    let temp = dir.join("book.utf8.tmp");
    tokio::fs::write(&temp, bytes).await?;
    tokio::fs::rename(&temp, &target).await?;
    for (idx, title, start, end, character_count) in ranges {
        sqlx::query("INSERT INTO text_chapters (publication_id,encoding,idx,title,byte_start,byte_end,character_count) VALUES (?,?,?,?,?,?,?) ON CONFLICT(publication_id,encoding,idx) DO UPDATE SET title=excluded.title,byte_start=excluded.byte_start,byte_end=excluded.byte_end,character_count=excluded.character_count")
            .bind(id).bind(encoding).bind(idx).bind(title).bind(start).bind(end).bind(character_count).execute(&state.db).await?;
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
    let rows = sqlx::query("SELECT id,relative_path FROM publications")
        .fetch_all(&state.db)
        .await?;
    for row in rows {
        let id: i64 = row.try_get("id")?;
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
    let rows = sqlx::query("SELECT id,relative_path FROM directories WHERE relative_path<>''")
        .fetch_all(&state.db)
        .await?;
    let mut stale = rows
        .into_iter()
        .filter_map(|row| {
            let id: i64 = row.try_get("id").ok()?;
            let relative: String = row.try_get("relative_path").ok()?;
            if root.join(&relative).is_dir() {
                None
            } else {
                Some((relative, id))
            }
        })
        .collect::<Vec<_>>();
    stale.sort_by_key(|(path, _)| std::cmp::Reverse(path.split('/').count()));
    for (_, id) in stale {
        sqlx::query("DELETE FROM directories WHERE id=?")
            .bind(id)
            .execute(&state.db)
            .await?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{config::Config, db, state::AppState};

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
