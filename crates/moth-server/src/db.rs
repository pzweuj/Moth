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
        .max_connections(5)
        .connect_with(options)
        .await?;

    sqlx::migrate!("../../migrations").run(&pool).await?;
    Ok(pool)
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
}
