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
}
