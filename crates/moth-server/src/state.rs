use std::{collections::HashMap, sync::Arc};

use serde::Serialize;
use sqlx::SqlitePool;
use tokio::sync::{Mutex, Semaphore};

use crate::config::Config;

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
    pub scan_status: Arc<Mutex<ScanStatus>>,
    /// Conversion jobs are keyed by content version rather than publication
    /// id so duplicate files share one generated EPUB and one in-flight task.
    pub conversion_jobs: Arc<Mutex<HashMap<String, ConversionState>>>,
}

impl AppState {
    pub fn new(config: Config, db: SqlitePool) -> Self {
        Self {
            login_throttle: Arc::new(Mutex::new(crate::auth::LoginThrottle::default())),
            login_verifications: Arc::new(Semaphore::new(1)),
            config,
            db,
            scan_status: Arc::new(Mutex::new(ScanStatus::default())),
            conversion_jobs: Arc::new(Mutex::new(HashMap::new())),
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
