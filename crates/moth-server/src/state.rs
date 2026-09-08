use std::{collections::HashMap, sync::Arc};

use serde::Serialize;
use sqlx::SqlitePool;
use tokio::sync::Mutex;

use crate::config::Config;

/// Progress of the single-root scan, surfaced through `GET /api/v1/scan/status`.
#[derive(Debug, Clone, Default, Serialize)]
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
    /// Conversion jobs are keyed by content version rather than publication
    /// id so duplicate files share one generated EPUB and one in-flight task.
    pub conversion_jobs: Arc<Mutex<HashMap<String, ConversionState>>>,
}

impl AppState {
    pub fn new(config: Config, db: SqlitePool) -> Self {
        Self {
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
            .join("mobi-epub-v1")
    }
}

#[derive(Debug, Clone)]
pub enum ConversionState {
    Preparing,
    Ready,
    Failed(String),
}
