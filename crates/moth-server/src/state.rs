use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex as StdMutex},
};

use serde::Serialize;
use sqlx::SqlitePool;
use tokio::sync::{Mutex, Semaphore};
use zip::{ZipArchive, read::ZipArchiveMetadata};

use crate::config::Config;

const CBZ_ARCHIVE_CACHE_CAPACITY: usize = 2;

#[derive(Clone, Debug, PartialEq, Eq)]
struct CbzArchiveKey {
    path: PathBuf,
    file_size: u64,
    mtime_ns: i64,
}

/// Tiny bounded cache of parsed CBZ ZIP Central Directory metadata.
///
/// Holds no open file descriptors and at most two recently read archives so
/// sequential page turns and thumbnail drawer bursts do not re-parse the ZIP
/// central directory on every request.
#[derive(Default)]
pub struct CbzArchiveCache {
    entries: StdMutex<Vec<(CbzArchiveKey, Arc<ZipArchiveMetadata>)>>,
}

impl CbzArchiveCache {
    pub fn open(&self, source: &Path) -> std::io::Result<ZipArchive<std::fs::File>> {
        let file = std::fs::File::open(source)?;
        let metadata = file.metadata()?;
        let file_size = metadata.len();
        let mtime_ns = metadata
            .modified()
            .ok()
            .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|value| value.as_nanos() as i64)
            .unwrap_or(0);
        let key = CbzArchiveKey {
            path: source.to_path_buf(),
            file_size,
            mtime_ns,
        };
        if let Some(cached) = self.get(&key) {
            // SAFETY: `file` was just opened at `source` and verified to have
            // the same size and mtime as when `cached` was parsed from this
            // read-only archive.
            return Ok(unsafe { ZipArchive::unsafe_new_with_metadata(file, cached) });
        }
        let archive = ZipArchive::new(file).map_err(std::io::Error::other)?;
        self.insert(key, archive.metadata());
        Ok(archive)
    }

    fn get(&self, key: &CbzArchiveKey) -> Option<Arc<ZipArchiveMetadata>> {
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        let pos = entries.iter().position(|(existing, _)| existing == key)?;
        let item = entries.remove(pos);
        let metadata = Arc::clone(&item.1);
        entries.push(item);
        Some(metadata)
    }

    fn insert(&self, key: CbzArchiveKey, metadata: Arc<ZipArchiveMetadata>) {
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(pos) = entries.iter().position(|(existing, _)| existing == &key) {
            entries.remove(pos);
        }
        entries.push((key, metadata));
        while entries.len() > CBZ_ARCHIVE_CACHE_CAPACITY {
            entries.remove(0);
        }
    }

    pub fn clear(&self) {
        self.entries
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
    }
}

/// Publish complete, rebuildable cache files without exposing partial writes.
pub(crate) fn write_cache(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temp = path.with_extension(format!("{:016x}.tmp", rand::random::<u64>()));
    let result = (|| {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        file.write_all(bytes)?;
        drop(file);
        std::fs::rename(&temp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

/// Progress of the single-root scan, surfaced through `GET /api/v1/scan/status`.
#[derive(Debug, Clone, Default, Serialize)]
pub struct ScanStatus {
    pub scanning: bool,
    pub discovery_complete: bool,
    pub processed: u64,
    pub total: u64,
    pub errors: u64,
    pub message: String,
}

#[derive(Clone)]
pub struct AppState {
    pub login_throttle: Arc<Mutex<crate::auth::LoginThrottle>>,
    pub login_verifications: Arc<Semaphore>,
    pub config: Config,
    pub db: SqlitePool,
    pub read_db: SqlitePool,
    pub scan_status: Arc<Mutex<ScanStatus>>,
    pub(crate) hidden_shelves: Arc<Mutex<Option<Arc<Vec<String>>>>>,
    /// Conversion jobs are keyed by content version rather than publication
    /// id so duplicate files share one generated EPUB and one in-flight task.
    pub conversion_jobs: Arc<Mutex<HashMap<String, ConversionState>>>,
    /// Limit concurrent MOBI conversion tasks to bound CPU and memory usage.
    pub conversion_tasks: Arc<Semaphore>,
    /// Bounds concurrent image decoding and encoding across cover and CBZ
    /// thumbnail requests. One permit covers source reads through cache writes.
    pub image_tasks: Arc<Semaphore>,
    /// Serialize dimension cache rebuilds, including duplicate requests.
    pub dimension_tasks: Arc<Semaphore>,
    /// Serialize on-demand TXT encoding cache builds so concurrent requests
    /// share one decode and chapter-index update.
    pub txt_tasks: Arc<Semaphore>,
    /// Limit active ZIP decompression streams so several readers cannot keep
    /// one blocking worker and a large compressed page alive indefinitely.
    pub page_streams: Arc<Semaphore>,
    /// Bounded cache of parsed CBZ ZIP Central Directory metadata.
    pub cbz_archives: Arc<CbzArchiveCache>,
}

impl AppState {
    pub fn new(config: Config, db: SqlitePool) -> Self {
        Self::with_pools(
            config,
            crate::db::DbPools {
                read: db.clone(),
                write: db,
            },
        )
    }

    pub fn with_pools(config: Config, pools: crate::db::DbPools) -> Self {
        Self {
            login_throttle: Arc::new(Mutex::new(crate::auth::LoginThrottle::default())),
            login_verifications: Arc::new(Semaphore::new(1)),
            config,
            db: pools.write,
            read_db: pools.read,
            scan_status: Arc::new(Mutex::new(ScanStatus::default())),
            hidden_shelves: Arc::new(Mutex::new(None)),
            conversion_jobs: Arc::new(Mutex::new(HashMap::new())),
            conversion_tasks: Arc::new(Semaphore::new(1)),
            image_tasks: Arc::new(Semaphore::new(1)),
            dimension_tasks: Arc::new(Semaphore::new(1)),
            txt_tasks: Arc::new(Semaphore::new(1)),
            page_streams: Arc::new(Semaphore::new(2)),
            cbz_archives: Arc::new(CbzArchiveCache::default()),
        }
    }

    /// Directory holding generated cover thumbnails.
    pub fn covers_dir(&self) -> std::path::PathBuf {
        self.config.data_dir.join("covers")
    }

    pub fn cover_path(&self, version: &str) -> std::path::PathBuf {
        self.covers_dir().join(format!("{version}.jpg"))
    }

    /// Directory holding generated CBZ page thumbnails.
    pub fn thumbnails_dir(&self, version: &str) -> std::path::PathBuf {
        self.config.data_dir.join("thumbnails").join(version)
    }

    pub fn thumbnail_path(&self, version: &str, page: i64) -> std::path::PathBuf {
        self.thumbnails_dir(version).join(format!("{page}.jpg"))
    }

    pub fn page_dimensions_path(&self, version: &str) -> std::path::PathBuf {
        self.config
            .data_dir
            .join("page-dimensions")
            .join(format!("{version}-v1.json"))
    }

    pub fn txt_dir(&self, version: &str, encoding: &str) -> std::path::PathBuf {
        self.config
            .data_dir
            .join("txt")
            .join(version)
            .join(encoding)
    }

    pub fn mobi_dir(&self, version: &str) -> std::path::PathBuf {
        self.config
            .data_dir
            .join("mobi")
            .join(version)
            .join("mobi-epub-v2")
    }
}

#[derive(Debug, Clone)]
pub enum ConversionState {
    Preparing,
    Ready,
    Failed(String),
}
