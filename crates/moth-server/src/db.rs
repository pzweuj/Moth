use std::{path::Path, time::Duration};

use sqlx::sqlite::SqlitePoolOptions;
use sqlx::{
    SqlitePool,
    sqlite::{SqliteConnectOptions, SqliteJournalMode},
};

use crate::{config::Config, error::AppError};

pub async fn connect(config: &Config) -> Result<SqlitePool, AppError> {
    tokio::fs::create_dir_all(&config.data_dir).await?;
    let database_path = config.data_dir.join("moth.db");
    let options = connect_options(&database_path);
    let pool = SqlitePoolOptions::new()
        // SQLite permits concurrent readers, but only one writer.  Moth is a
        // single-user application and the scanner performs multi-statement
        // write transactions while the UI may issue setup/progress requests
        // at the same time. A single pooled connection queues
        // those operations at the connection boundary, avoiding transient
        // `database is locked` errors during the initial scan.
        .max_connections(1)
        .connect_with(options)
        .await?;

    reject_legacy_schema(&pool).await?;
    sqlx::migrate!("../../migrations").run(&pool).await?;
    Ok(pool)
}

/// Moth deliberately does not migrate the pre-core database.  A migration
/// history from the old product can otherwise fail with a checksum error (or,
/// worse, leave a partially upgraded database), so detect it before sqlx gets
/// a chance to apply the new clean migration.
async fn reject_legacy_schema(pool: &SqlitePool) -> Result<(), AppError> {
    let legacy_tables: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master
         WHERE type = 'table' AND name IN
           ('libraries','admin_credentials','books','chapters','resources','pages','sections',
            'series','progress_operations','server_metadata')",
    )
    .fetch_one(pool)
    .await?;
    let has_migrations: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = '_sqlx_migrations'",
    )
    .fetch_one(pool)
    .await?;
    let has_core: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('directories','publications','reading_progress')",
    )
    .fetch_one(pool)
    .await?;
    if legacy_tables > 0 || (has_migrations > 0 && has_core == 0) {
        return Err(AppError::Config(
            "旧版 Moth 数据库不兼容当前个人核心 schema；请先备份并删除 data/moth.db（及 moth.db-wal/moth.db-shm），然后重新扫描书库".to_owned(),
        ));
    }
    Ok(())
}

fn connect_options(path: &Path) -> SqliteConnectOptions {
    SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .foreign_keys(true)
        .busy_timeout(Duration::from_secs(5))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;

    #[tokio::test]
    async fn creates_database_and_runs_migrations() {
        let temp = tempfile::tempdir().expect("temporary directory");
        let config = Config::for_test(temp.path().to_path_buf());
        let pool = connect(&config).await.expect("database connection");

        let tables: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('user_account', 'sessions')",
        )
        .fetch_one(&pool)
        .await
        .expect("table query");
        assert_eq!(tables, 2);

        let journal_mode: String = sqlx::query_scalar("PRAGMA journal_mode")
            .fetch_one(&pool)
            .await
            .expect("journal mode");
        assert_eq!(journal_mode.to_ascii_lowercase(), "wal");
    }

    #[tokio::test]
    async fn rejects_pre_core_database_with_actionable_error() {
        let temp = tempfile::tempdir().expect("temporary directory");
        let config = Config::for_test(temp.path().to_path_buf());
        tokio::fs::create_dir_all(&config.data_dir)
            .await
            .expect("data directory");
        let database_path = config.data_dir.join("moth.db");
        let options = connect_options(&database_path);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("legacy connection");
        sqlx::query("CREATE TABLE books (id INTEGER PRIMARY KEY)")
            .execute(&pool)
            .await
            .expect("legacy table");
        pool.close().await;

        let error = connect(&config).await.expect_err("legacy schema must fail");
        assert!(
            matches!(error, AppError::Config(message) if message.contains("旧版 Moth") && message.contains("moth.db"))
        );
    }

    #[tokio::test]
    async fn rejects_old_multi_library_schema() {
        let temp = tempfile::tempdir().expect("temporary directory");
        let config = Config::for_test(temp.path().to_path_buf());
        tokio::fs::create_dir_all(&config.data_dir)
            .await
            .expect("data directory");
        let database_path = config.data_dir.join("moth.db");
        let options = connect_options(&database_path);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("legacy connection");
        sqlx::query("CREATE TABLE libraries (id INTEGER PRIMARY KEY, root_path TEXT NOT NULL)")
            .execute(&pool)
            .await
            .expect("legacy libraries table");
        pool.close().await;

        let error = connect(&config).await.expect_err("legacy schema must fail");
        assert!(matches!(error, AppError::Config(message) if message.contains("旧版 Moth")));
    }
}
