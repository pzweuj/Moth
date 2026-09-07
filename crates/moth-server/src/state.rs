use std::{collections::HashMap, sync::Arc};

use sqlx::SqlitePool;
use tokio::sync::Mutex;

use crate::config::Config;

/// Progress of a library scan, surfaced through
/// `GET /api/v1/library/scan/status`.
#[derive(Debug, Clone, Default)]
pub struct ScanStatus {
    pub scanning: bool,
    pub processed: u64,
    pub total: u64,
    pub errors: u64,
    pub message: String,
}

#[derive(Clone)]
pub struct AppState {
    pub config: Config,
    pub db: SqlitePool,
    pub scan_status: Arc<Mutex<ScanStatus>>,
    pub txt_cache: Arc<Mutex<HashMap<TxtCacheKey, Arc<Vec<moth_format::Chapter>>>>>,
}

/// Cache key for an explicitly decoded TXT publication. The content hash
/// prevents a rescan from serving chapters generated from an older file.
#[derive(Debug, Clone, Hash, PartialEq, Eq)]
pub struct TxtCacheKey {
    pub book_id: i64,
    pub content_version: String,
    pub encoding: String,
    pub parser_version: &'static str,
}

impl AppState {
    pub fn new(config: Config, db: SqlitePool) -> Self {
        Self {
            config,
            db,
            scan_status: Arc::new(Mutex::new(ScanStatus::default())),
            txt_cache: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Directory holding generated cover thumbnails.
    pub fn covers_dir(&self) -> std::path::PathBuf {
        self.config.data_dir.join("covers")
    }

    /// Directory holding extracted EPUB resources.
    pub fn resources_dir(&self) -> std::path::PathBuf {
        self.config.data_dir.join("resources")
    }

    /// Verified immutable copies of source files used by range readers.
    pub fn snapshots_dir(&self) -> std::path::PathBuf {
        self.config.data_dir.join("snapshots")
    }

    /// Versioned cover thumbnails. A scan can install a new version without
    /// replacing bytes that an existing reader is still using.
    pub fn cover_path(&self, book_id: i64, version: &str) -> std::path::PathBuf {
        self.covers_dir()
            .join(book_id.to_string())
            .join(format!("{version}.jpg"))
    }

    /// Versioned extracted resources for one book.
    pub fn resource_path(&self, book_id: i64, version: &str, index: i64) -> std::path::PathBuf {
        self.resources_dir()
            .join(book_id.to_string())
            .join(version)
            .join(index.to_string())
    }

    /// All generated files for one book, including obsolete content versions.
    pub fn book_covers_dir(&self, book_id: i64) -> std::path::PathBuf {
        self.covers_dir().join(book_id.to_string())
    }

    pub fn book_resources_dir(&self, book_id: i64) -> std::path::PathBuf {
        self.resources_dir().join(book_id.to_string())
    }
}
