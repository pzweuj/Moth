//! User-managed organization for the library shelf.
//!
//! A book has one direct owner: either a section or a series.  Series inherit
//! their section, which makes moving a whole series a single transactional
//! update and prevents contradictory book/series classifications.

use axum::{
    Json,
    extract::{Path as AxumPath, State},
};
use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};

use crate::{
    auth::Authenticated,
    books::{BookListItem, fetch_book_items},
    error::AppError,
    state::AppState,
};

#[derive(Debug, Serialize, Clone)]
pub struct SeriesSummary {
    pub id: i64,
    pub name: String,
    pub section_id: i64,
    pub sort_order: i64,
    pub book_count: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cover_url: Option<String>,
    pub books: Vec<BookListItem>,
}

#[derive(Debug, Serialize, Clone)]
pub struct SectionSummary {
    pub id: i64,
    pub name: String,
    pub sort_order: i64,
    pub is_system: bool,
    pub book_count: i64,
    pub series: Vec<SeriesSummary>,
    /// Books that belong directly to this section (series members are nested
    /// under their series).
    pub books: Vec<BookListItem>,
}

#[derive(Debug, Deserialize)]
pub struct NameBody {
    pub name: String,
}

#[derive(Debug, Deserialize)]
pub struct SectionPatch {
    pub name: Option<String>,
    pub sort_order: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct SeriesCreate {
    pub name: String,
    pub section_id: i64,
}

#[derive(Debug, Deserialize)]
pub struct SeriesPatch {
    pub name: Option<String>,
    pub section_id: Option<i64>,
    pub sort_order: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct BookOrganization {
    pub book_ids: Vec<i64>,
    pub section_id: Option<i64>,
    pub series_id: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct IdOrder {
    pub ids: Vec<i64>,
}

fn clean_name(name: &str) -> Result<String, AppError> {
    let value = name.trim();
    if value.is_empty() {
        return Err(AppError::Validation("Name cannot be empty".to_owned()));
    }
    if value.chars().count() > 200 {
        return Err(AppError::Validation("Name is too long".to_owned()));
    }
    Ok(value.to_owned())
}

fn unique_ids(ids: &[i64]) -> Result<Vec<i64>, AppError> {
    if ids.is_empty() {
        return Err(AppError::Validation(
            "At least one book is required".to_owned(),
        ));
    }
    let mut result = Vec::with_capacity(ids.len());
    for id in ids {
        if *id <= 0 {
            return Err(AppError::Validation("Book IDs must be positive".to_owned()));
        }
        if !result.contains(id) {
            result.push(*id);
        }
    }
    Ok(result)
}

async fn unclassified_id(db: &SqlitePool) -> Result<i64, AppError> {
    sqlx::query_scalar("SELECT id FROM sections WHERE is_system = 1 LIMIT 1")
        .fetch_optional(db)
        .await?
        .ok_or_else(|| {
            AppError::Database(sqlx::Error::Protocol("missing system section".to_owned()))
        })
}

async fn ensure_section(db: &SqlitePool, id: i64) -> Result<bool, AppError> {
    Ok(
        sqlx::query_scalar::<_, i64>("SELECT 1 FROM sections WHERE id = ?")
            .bind(id)
            .fetch_optional(db)
            .await?
            .is_some(),
    )
}

async fn ensure_series(db: &SqlitePool, id: i64) -> Result<Option<i64>, AppError> {
    sqlx::query_scalar("SELECT section_id FROM series WHERE id = ?")
        .bind(id)
        .fetch_optional(db)
        .await
        .map_err(AppError::from)
}

async fn name_conflict_section(
    db: &SqlitePool,
    name: &str,
    except: Option<i64>,
) -> Result<bool, AppError> {
    Ok(sqlx::query_scalar::<_, i64>(
        "SELECT 1 FROM sections WHERE name = ? COLLATE NOCASE AND (? IS NULL OR id <> ?) LIMIT 1",
    )
    .bind(name)
    .bind(except)
    .bind(except)
    .fetch_optional(db)
    .await?
    .is_some())
}

async fn name_conflict_series(
    db: &SqlitePool,
    section_id: i64,
    name: &str,
    except: Option<i64>,
) -> Result<bool, AppError> {
    Ok(sqlx::query_scalar::<_, i64>(
        "SELECT 1 FROM series WHERE section_id = ? AND name = ? COLLATE NOCASE AND (? IS NULL OR id <> ?) LIMIT 1",
    )
    .bind(section_id)
    .bind(name)
    .bind(except)
    .bind(except)
    .fetch_optional(db)
    .await?
    .is_some())
}

pub async fn list_sections(
    State(state): State<AppState>,
    _user: Authenticated,
) -> Result<Json<Vec<SectionSummary>>, AppError> {
    let sections = sqlx::query(
        "SELECT id, name, sort_order, is_system FROM sections ORDER BY sort_order, name COLLATE NOCASE",
    )
    .fetch_all(&state.db)
    .await?;
    let all_books = fetch_book_items(&state.db, None, None).await?;
    let series_rows = sqlx::query(
        "SELECT id, name, section_id, sort_order FROM series ORDER BY sort_order, name COLLATE NOCASE",
    )
    .fetch_all(&state.db)
    .await?;

    let mut result = Vec::with_capacity(sections.len());
    for row in sections {
        let id: i64 = row.try_get("id")?;
        let mut section_series = Vec::new();
        for series_row in &series_rows {
            let series_id: i64 = series_row.try_get("id")?;
            let section_id: i64 = series_row.try_get("section_id")?;
            if section_id != id {
                continue;
            }
            let mut books: Vec<BookListItem> = all_books
                .iter()
                .filter(|book| book.series_id == Some(series_id))
                .cloned()
                .collect();
            books.sort_by_key(|book| book.series_order.unwrap_or(i64::MAX));
            section_series.push(SeriesSummary {
                id: series_id,
                name: series_row.try_get("name")?,
                section_id,
                sort_order: series_row.try_get("sort_order")?,
                book_count: books.len() as i64,
                cover_url: books.iter().find_map(|book| book.cover_url.clone()),
                books,
            });
        }
        let books: Vec<BookListItem> = all_books
            .iter()
            .filter(|book| book.series_id.is_none() && book.section_id == Some(id))
            .cloned()
            .collect();
        let book_count = all_books
            .iter()
            .filter(|book| book.section_id == Some(id))
            .count() as i64;
        result.push(SectionSummary {
            id,
            name: row.try_get("name")?,
            sort_order: row.try_get("sort_order")?,
            is_system: row.try_get("is_system")?,
            book_count,
            series: section_series,
            books,
        });
    }
    Ok(Json(result))
}

pub async fn get_section(
    State(state): State<AppState>,
    user: Authenticated,
    AxumPath(id): AxumPath<i64>,
) -> Result<Json<SectionSummary>, AppError> {
    let sections = list_sections(State(state), user).await?.0;
    sections
        .into_iter()
        .find(|section| section.id == id)
        .map(Json)
        .ok_or(AppError::NotFound)
}

pub async fn list_series(
    State(state): State<AppState>,
    user: Authenticated,
) -> Result<Json<Vec<SeriesSummary>>, AppError> {
    let sections = list_sections(State(state), user).await?.0;
    Ok(Json(
        sections
            .into_iter()
            .flat_map(|section| section.series)
            .collect(),
    ))
}

pub async fn get_series(
    State(state): State<AppState>,
    _user: Authenticated,
    AxumPath(id): AxumPath<i64>,
) -> Result<Json<SeriesSummary>, AppError> {
    let row = sqlx::query("SELECT id, name, section_id, sort_order FROM series WHERE id = ?")
        .bind(id)
        .fetch_optional(&state.db)
        .await?
        .ok_or(AppError::NotFound)?;
    let mut books = fetch_book_items(&state.db, None, Some(id)).await?;
    books.sort_by_key(|book| book.series_order.unwrap_or(i64::MAX));
    Ok(Json(SeriesSummary {
        id: row.try_get("id")?,
        name: row.try_get("name")?,
        section_id: row.try_get("section_id")?,
        sort_order: row.try_get("sort_order")?,
        book_count: books.len() as i64,
        cover_url: books.iter().find_map(|book| book.cover_url.clone()),
        books,
    }))
}

pub async fn create_section(
    State(state): State<AppState>,
    _user: Authenticated,
    Json(body): Json<NameBody>,
) -> Result<Json<SectionSummary>, AppError> {
    let name = clean_name(&body.name)?;
    if name_conflict_section(&state.db, &name, None).await? {
        return Err(AppError::Conflict {
            code: "section_name_taken",
            message: "A section with that name already exists",
        });
    }
    let now = crate::library::now_unix_for_api();
    let sort_order: i64 =
        sqlx::query_scalar("SELECT COALESCE(MAX(sort_order), -1) + 1 FROM sections")
            .fetch_one(&state.db)
            .await?;
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO sections (name, sort_order, is_system, created_at, updated_at) VALUES (?, ?, 0, ?, ?) RETURNING id",
    )
    .bind(&name)
    .bind(sort_order)
    .bind(now)
    .bind(now)
    .fetch_one(&state.db)
    .await?;
    Ok(Json(SectionSummary {
        id,
        name,
        sort_order,
        is_system: false,
        book_count: 0,
        series: Vec::new(),
        books: Vec::new(),
    }))
}

pub async fn update_section(
    State(state): State<AppState>,
    _user: Authenticated,
    AxumPath(id): AxumPath<i64>,
    Json(body): Json<SectionPatch>,
) -> Result<Json<SectionSummary>, AppError> {
    let existing = sqlx::query("SELECT name, sort_order, is_system FROM sections WHERE id = ?")
        .bind(id)
        .fetch_optional(&state.db)
        .await?
        .ok_or(AppError::NotFound)?;
    let is_system: bool = existing.try_get("is_system")?;
    let name = match body.name {
        Some(value) => {
            if is_system {
                return Err(AppError::Conflict {
                    code: "system_section",
                    message: "The system section cannot be renamed",
                });
            }
            let value = clean_name(&value)?;
            if name_conflict_section(&state.db, &value, Some(id)).await? {
                return Err(AppError::Conflict {
                    code: "section_name_taken",
                    message: "A section with that name already exists",
                });
            }
            value
        }
        None => existing.try_get("name")?,
    };
    let sort_order = body
        .sort_order
        .unwrap_or(existing.try_get("sort_order")?)
        .max(if is_system { 0 } else { 1 });
    let now = crate::library::now_unix_for_api();
    sqlx::query("UPDATE sections SET name = ?, sort_order = ?, updated_at = ? WHERE id = ?")
        .bind(&name)
        .bind(sort_order)
        .bind(now)
        .bind(id)
        .execute(&state.db)
        .await?;
    Ok(Json(SectionSummary {
        id,
        name,
        sort_order,
        is_system,
        book_count: 0,
        series: Vec::new(),
        books: Vec::new(),
    }))
}

pub async fn delete_section(
    State(state): State<AppState>,
    _user: Authenticated,
    AxumPath(id): AxumPath<i64>,
) -> Result<(), AppError> {
    let existing = sqlx::query("SELECT is_system FROM sections WHERE id = ?")
        .bind(id)
        .fetch_optional(&state.db)
        .await?
        .ok_or(AppError::NotFound)?;
    if existing.try_get::<bool, _>("is_system")? {
        return Err(AppError::Conflict {
            code: "system_section",
            message: "The system section cannot be deleted",
        });
    }
    let fallback = unclassified_id(&state.db).await?;
    if fallback == id {
        return Err(AppError::Conflict {
            code: "system_section",
            message: "The system section cannot be deleted",
        });
    }
    // Moving series into the fallback section can collide with a same-named
    // series there; fail before making any changes so deletion is atomic.
    let names: Vec<(i64, String)> =
        sqlx::query_as("SELECT id, name FROM series WHERE section_id = ? ORDER BY sort_order, id")
            .bind(id)
            .fetch_all(&state.db)
            .await?;
    for (_, name) in &names {
        if name_conflict_series(&state.db, fallback, name, None).await? {
            return Err(AppError::Conflict {
                code: "series_name_taken",
                message: "The destination section already has a series with that name",
            });
        }
    }
    let mut tx = state.db.begin().await?;
    sqlx::query("UPDATE books SET section_id = ? WHERE section_id = ? AND series_id IS NULL")
        .bind(fallback)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    let next_series_order: i64 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM series WHERE section_id = ?",
    )
    .bind(fallback)
    .fetch_one(&mut *tx)
    .await?;
    for (offset, (series_id, _)) in names.iter().enumerate() {
        sqlx::query("UPDATE series SET section_id = ?, sort_order = ? WHERE id = ?")
            .bind(fallback)
            .bind(next_series_order + offset as i64)
            .bind(series_id)
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query("DELETE FROM sections WHERE id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

pub async fn reorder_sections(
    State(state): State<AppState>,
    _user: Authenticated,
    Json(body): Json<IdOrder>,
) -> Result<(), AppError> {
    let ids = unique_ids(&body.ids)?;
    let mut tx = state.db.begin().await?;
    for (index, id) in ids.iter().enumerate() {
        let changed =
            sqlx::query("UPDATE sections SET sort_order = ? WHERE id = ? AND is_system = 0")
                .bind(index as i64 + 1)
                .bind(id)
                .execute(&mut *tx)
                .await?;
        if changed.rows_affected() == 0 {
            return Err(AppError::NotFound);
        }
    }
    tx.commit().await?;
    Ok(())
}

pub async fn create_series(
    State(state): State<AppState>,
    _user: Authenticated,
    Json(body): Json<SeriesCreate>,
) -> Result<Json<SeriesSummary>, AppError> {
    let name = clean_name(&body.name)?;
    if !ensure_section(&state.db, body.section_id).await? {
        return Err(AppError::NotFound);
    }
    if name_conflict_series(&state.db, body.section_id, &name, None).await? {
        return Err(AppError::Conflict {
            code: "series_name_taken",
            message: "A series with that name already exists in this section",
        });
    }
    let now = crate::library::now_unix_for_api();
    let sort_order: i64 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM series WHERE section_id = ?",
    )
    .bind(body.section_id)
    .fetch_one(&state.db)
    .await?;
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO series (section_id, name, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?) RETURNING id",
    )
    .bind(body.section_id)
    .bind(&name)
    .bind(sort_order)
    .bind(now)
    .bind(now)
    .fetch_one(&state.db)
    .await?;
    Ok(Json(SeriesSummary {
        id,
        name,
        section_id: body.section_id,
        sort_order,
        book_count: 0,
        cover_url: None,
        books: Vec::new(),
    }))
}

pub async fn update_series(
    State(state): State<AppState>,
    _user: Authenticated,
    AxumPath(id): AxumPath<i64>,
    Json(body): Json<SeriesPatch>,
) -> Result<Json<SeriesSummary>, AppError> {
    let existing = sqlx::query("SELECT name, section_id, sort_order FROM series WHERE id = ?")
        .bind(id)
        .fetch_optional(&state.db)
        .await?
        .ok_or(AppError::NotFound)?;
    let old_section: i64 = existing.try_get("section_id")?;
    let section_id = body.section_id.unwrap_or(old_section);
    if !ensure_section(&state.db, section_id).await? {
        return Err(AppError::NotFound);
    }
    let name = match body.name {
        Some(value) => clean_name(&value)?,
        None => existing.try_get("name")?,
    };
    if name_conflict_series(&state.db, section_id, &name, Some(id)).await? {
        return Err(AppError::Conflict {
            code: "series_name_taken",
            message: "A series with that name already exists in this section",
        });
    }
    let sort_order = body
        .sort_order
        .unwrap_or(existing.try_get("sort_order")?)
        .max(0);
    let now = crate::library::now_unix_for_api();
    sqlx::query(
        "UPDATE series SET name = ?, section_id = ?, sort_order = ?, updated_at = ? WHERE id = ?",
    )
    .bind(&name)
    .bind(section_id)
    .bind(sort_order)
    .bind(now)
    .bind(id)
    .execute(&state.db)
    .await?;
    let books = fetch_book_items(&state.db, None, Some(id)).await?;
    Ok(Json(SeriesSummary {
        id,
        name,
        section_id,
        sort_order,
        book_count: books.len() as i64,
        cover_url: books.iter().find_map(|book| book.cover_url.clone()),
        books,
    }))
}

pub async fn delete_series(
    State(state): State<AppState>,
    _user: Authenticated,
    AxumPath(id): AxumPath<i64>,
) -> Result<(), AppError> {
    let section_id = ensure_series(&state.db, id)
        .await?
        .ok_or(AppError::NotFound)?;
    let mut tx = state.db.begin().await?;
    sqlx::query(
        "UPDATE books SET section_id = ?, series_id = NULL, series_order = 0 WHERE series_id = ?",
    )
    .bind(section_id)
    .bind(id)
    .execute(&mut *tx)
    .await?;
    sqlx::query("DELETE FROM series WHERE id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

pub async fn organize_books(
    State(state): State<AppState>,
    _user: Authenticated,
    Json(body): Json<BookOrganization>,
) -> Result<(), AppError> {
    let ids = unique_ids(&body.book_ids)?;
    if body.section_id.is_some() == body.series_id.is_some() {
        return Err(AppError::Validation(
            "Choose exactly one destination".to_owned(),
        ));
    }
    if let Some(series_id) = body.series_id {
        ensure_series(&state.db, series_id)
            .await?
            .ok_or(AppError::NotFound)?;
    }
    if let Some(section_id) = body.section_id
        && !ensure_section(&state.db, section_id).await?
    {
        return Err(AppError::NotFound);
    }
    let mut tx = state.db.begin().await?;
    for id in &ids {
        let exists: Option<i64> = sqlx::query_scalar("SELECT id FROM books WHERE id = ?")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?;
        if exists.is_none() {
            return Err(AppError::NotFound);
        }
    }
    if let Some(series_id) = body.series_id {
        let next: i64 = sqlx::query_scalar(
            "SELECT COALESCE(MAX(series_order), -1) + 1 FROM books WHERE series_id = ?",
        )
        .bind(series_id)
        .fetch_one(&mut *tx)
        .await?;
        for (offset, id) in ids.iter().enumerate() {
            sqlx::query(
                "UPDATE books SET section_id = NULL, series_id = ?, series_order = ? WHERE id = ?",
            )
            .bind(series_id)
            .bind(next + offset as i64)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        }
    } else if let Some(section_id) = body.section_id {
        for id in &ids {
            sqlx::query(
                "UPDATE books SET section_id = ?, series_id = NULL, series_order = 0 WHERE id = ?",
            )
            .bind(section_id)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        }
    }
    tx.commit().await?;
    Ok(())
}

pub async fn reorder_series_books(
    State(state): State<AppState>,
    _user: Authenticated,
    AxumPath(series_id): AxumPath<i64>,
    Json(body): Json<IdOrder>,
) -> Result<(), AppError> {
    let ids = unique_ids(&body.ids)?;
    if ensure_series(&state.db, series_id).await?.is_none() {
        return Err(AppError::NotFound);
    }
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM books WHERE series_id = ?")
        .bind(series_id)
        .fetch_one(&state.db)
        .await?;
    if count != ids.len() as i64 {
        return Err(AppError::Validation(
            "The order must include every book in the series".to_owned(),
        ));
    }
    let mut tx = state.db.begin().await?;
    for (index, id) in ids.iter().enumerate() {
        let changed =
            sqlx::query("UPDATE books SET series_order = ? WHERE id = ? AND series_id = ?")
                .bind(index as i64)
                .bind(id)
                .bind(series_id)
                .execute(&mut *tx)
                .await?;
        if changed.rows_affected() == 0 {
            return Err(AppError::Validation(
                "The order contains a book from another series".to_owned(),
            ));
        }
    }
    tx.commit().await?;
    Ok(())
}

/// Only missing source records can be removed from the index. The original
/// read-only library is never touched by this endpoint.
pub async fn delete_missing_book(
    State(state): State<AppState>,
    _user: Authenticated,
    AxumPath(id): AxumPath<i64>,
) -> Result<(), AppError> {
    let missing: Option<bool> = sqlx::query_scalar("SELECT missing FROM books WHERE id = ?")
        .bind(id)
        .fetch_optional(&state.db)
        .await?;
    match missing {
        None => Err(AppError::NotFound),
        Some(false) => Err(AppError::Conflict {
            code: "book_present",
            message: "Only a missing book record can be removed",
        }),
        Some(true) => {
            sqlx::query("DELETE FROM books WHERE id = ?")
                .bind(id)
                .execute(&state.db)
                .await?;
            let _ = tokio::fs::remove_dir_all(state.book_covers_dir(id)).await;
            let _ = tokio::fs::remove_dir_all(state.book_resources_dir(id)).await;
            Ok(())
        }
    }
}

// Keep timestamp generation in the scanner module, while exposing a narrow
// crate-visible helper for organization mutations.
// (The scanner already owns the same UTC seconds convention.)
