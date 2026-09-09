use argon2::{
    Argon2,
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
};
use axum::{
    extract::{FromRequestParts, Json, State, rejection::JsonRejection},
    http::{StatusCode, header, request::Parts},
    response::IntoResponse,
};
use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use rand::{RngCore, rngs::OsRng};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::Row;
use std::time::{Duration, Instant};
use time::{Duration as CookieDuration, OffsetDateTime};

use crate::{error::AppError, state::AppState};

pub const SESSION_COOKIE: &str = "moth_session";
const MIN_PASSWORD_CHARS: usize = 10;
const MAX_USERNAME_CHARS: usize = 64;
/// Minimum gap between `last_used_at` refreshes for one session.
const LAST_USED_REFRESH_SECS: i64 = 60;

/// Global to this single-user server: changing usernames or proxy headers
/// must not create a fresh guessing budget. Rejected requests do not extend it.
#[derive(Default)]
pub struct LoginThrottle {
    attempts: u32,
    last_attempt: Option<Instant>,
    next_attempt: Option<Instant>,
}

impl LoginThrottle {
    fn admit(&mut self, now: Instant) -> Result<(), AppError> {
        if let Some(next) = self.next_attempt
            && next > now
        {
            return Err(AppError::LoginThrottled(
                next.duration_since(now).as_secs() + 1,
            ));
        }
        if self
            .last_attempt
            .is_some_and(|last| now.duration_since(last) >= Duration::from_secs(900))
        {
            self.attempts = 0;
        }
        self.attempts = self.attempts.saturating_add(1);
        let delay = if self.attempts < 5 {
            1
        } else {
            (2_u64.pow((self.attempts - 4).min(6))).min(60)
        };
        self.last_attempt = Some(now);
        self.next_attempt = Some(now + Duration::from_secs(delay));
        Ok(())
    }

    fn success(&mut self) {
        self.attempts = 0;
        // Keep the minimum interval, even for repeated successful logins.
    }
}

#[derive(Debug, Deserialize, Clone)]
pub struct Credentials {
    pub username: String,
    pub password: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct SessionResponse {
    pub authenticated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct SetupStatusResponse {
    pub initialized: bool,
}

#[derive(Debug)]
pub struct Authenticated {
    pub username: String,
}

pub async fn setup_status(
    State(state): State<AppState>,
) -> Result<Json<SetupStatusResponse>, AppError> {
    Ok(Json(SetupStatusResponse {
        initialized: user_exists(&state).await?,
    }))
}

pub async fn setup(
    State(state): State<AppState>,
    payload: Result<Json<Credentials>, JsonRejection>,
) -> Result<impl IntoResponse, AppError> {
    let Json(credentials) =
        payload.map_err(|_| AppError::Validation("Request body must be valid JSON".to_owned()))?;
    let credentials = validate_credentials(credentials)?;
    create_user(&state, &credentials).await?;
    Ok((
        StatusCode::CREATED,
        Json(SetupStatusResponse { initialized: true }),
    ))
}

pub async fn login(
    State(state): State<AppState>,
    jar: CookieJar,
    payload: Result<Json<Credentials>, JsonRejection>,
) -> Result<impl IntoResponse, AppError> {
    state.login_throttle.lock().await.admit(Instant::now())?;
    let Json(credentials) =
        payload.map_err(|_| AppError::Validation("Request body must be valid JSON".to_owned()))?;
    let credentials = validate_credentials(credentials)?;
    if !verify_user(&state, &credentials).await? {
        return Err(AppError::Unauthorized);
    }

    state.login_throttle.lock().await.success();

    let token = create_session(&state).await?;
    let cookie = session_cookie(&state, &token);
    Ok((jar.add(cookie), StatusCode::NO_CONTENT))
}

pub async fn current_session(
    State(state): State<AppState>,
    jar: CookieJar,
) -> Result<Json<SessionResponse>, AppError> {
    let Some(token) = cookie_token(&jar) else {
        return Ok(Json(SessionResponse {
            authenticated: false,
            username: None,
        }));
    };

    let username = resolve_session(&state, &token).await?;
    let authenticated = username.is_some();
    Ok(Json(SessionResponse {
        authenticated,
        username,
    }))
}

pub async fn logout(
    State(state): State<AppState>,
    jar: CookieJar,
) -> Result<impl IntoResponse, AppError> {
    if let Some(token) = cookie_token(&jar) {
        delete_session(&state, &token).await?;
    }

    Ok((clear_session_cookie(&state, jar), StatusCode::NO_CONTENT))
}

pub fn validate_credentials(credentials: Credentials) -> Result<Credentials, AppError> {
    let username = credentials.username.trim().to_owned();
    let username_chars = username.chars().count();
    if !(1..=MAX_USERNAME_CHARS).contains(&username_chars) {
        return Err(AppError::Validation(
            "Username must contain 1–64 characters".to_owned(),
        ));
    }

    if credentials.password.chars().count() < MIN_PASSWORD_CHARS {
        return Err(AppError::Validation(
            "Password must contain at least 10 characters".to_owned(),
        ));
    }

    Ok(Credentials {
        username,
        password: credentials.password,
    })
}

async fn user_exists(state: &AppState) -> Result<bool, AppError> {
    Ok(
        sqlx::query_scalar::<_, i64>("SELECT EXISTS(SELECT 1 FROM user_account WHERE id = 1)")
            .fetch_one(&state.db)
            .await?
            != 0,
    )
}

async fn create_user(state: &AppState, credentials: &Credentials) -> Result<(), AppError> {
    // Argon2 is deliberately slow; hash off the async runtime.
    let password = credentials.password.clone();
    let password_hash = tokio::task::spawn_blocking(move || hash_password(&password))
        .await
        .map_err(|error| AppError::Io(std::io::Error::other(error)))??;
    let timestamp = now_unix();
    let mut transaction = state.db.begin().await?;

    let result = sqlx::query(
        "INSERT INTO user_account (id, username, password_hash, created_at, updated_at) VALUES (1, ?, ?, ?, ?)",
    )
    .bind(&credentials.username)
    .bind(password_hash)
    .bind(timestamp)
    .bind(timestamp)
    .execute(&mut *transaction)
    .await;

    match result {
        Ok(_) => transaction.commit().await.map_err(AppError::Database),
        Err(error) if is_unique_violation(&error) => Err(AppError::Conflict {
            code: "setup_completed",
            message: "Moth has already been initialized",
        }),
        Err(error) => Err(AppError::Database(error)),
    }
}

async fn verify_user(state: &AppState, credentials: &Credentials) -> Result<bool, AppError> {
    let permit = state
        .login_verifications
        .clone()
        .try_acquire_owned()
        .map_err(|_| AppError::LoginThrottled(1))?;
    let row = sqlx::query("SELECT username, password_hash FROM user_account WHERE id = 1")
        .fetch_optional(&state.db)
        .await?;
    let Some(row) = row else {
        return Ok(false);
    };

    let username: String = row.try_get("username")?;
    let password_hash: String = row.try_get("password_hash")?;
    let username_matches = username == credentials.username;

    // Password verification runs off the async runtime; it is deliberately slow.
    let password = credentials.password.clone();
    let verified = tokio::task::spawn_blocking(move || {
        // Own the permit inside the blocking task so a disconnected client
        // cannot free capacity while Argon2 is still running.
        let _permit = permit;
        match PasswordHash::new(&password_hash) {
            Ok(parsed_hash) => Argon2::default()
                .verify_password(password.as_bytes(), &parsed_hash)
                .is_ok(),
            Err(_) => false,
        }
    })
    .await
    .map_err(|error| AppError::Io(std::io::Error::other(error)))?;
    Ok(verified && username_matches)
}

fn hash_password(password: &str) -> Result<String, AppError> {
    let salt = SaltString::generate(&mut OsRng);
    Ok(Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map_err(|_| AppError::PasswordHash)?
        .to_string())
}

async fn create_session(state: &AppState) -> Result<String, AppError> {
    let mut bytes = [0_u8; 32];
    OsRng.fill_bytes(&mut bytes);
    let token = URL_SAFE_NO_PAD.encode(bytes);
    let token_hash = hash_token(&token);
    let created_at = now_unix();
    let expires_at = created_at
        .saturating_add((state.config.session_ttl_days as i64).saturating_mul(24 * 60 * 60));

    sqlx::query(
        "INSERT INTO sessions (token_hash, created_at, expires_at, last_used_at) VALUES (?, ?, ?, ?)",
    )
    .bind(token_hash)
    .bind(created_at)
    .bind(expires_at)
    .bind(created_at)
    .execute(&state.db)
    .await?;

    Ok(token)
}

async fn resolve_session(state: &AppState, token: &str) -> Result<Option<String>, AppError> {
    let token_hash = hash_token(token);
    let row = sqlx::query(
        "SELECT a.username, s.expires_at, s.last_used_at FROM sessions s JOIN user_account a ON a.id = 1 WHERE s.token_hash = ?",
    )
    .bind(&token_hash)
    .fetch_optional(&state.db)
    .await?;
    let Some(row) = row else {
        return Ok(None);
    };

    let expires_at: i64 = row.try_get("expires_at")?;
    if expires_at <= now_unix() {
        delete_session(state, token).await?;
        return Ok(None);
    }

    let username: String = row.try_get("username")?;
    let last_used_at: i64 = row.try_get("last_used_at")?;
    // Refresh the marker at most once per throttle window so an authenticated
    // request does not turn into a write on every call.
    if now_unix().saturating_sub(last_used_at) >= LAST_USED_REFRESH_SECS {
        sqlx::query("UPDATE sessions SET last_used_at = ? WHERE token_hash = ?")
            .bind(now_unix())
            .bind(token_hash)
            .execute(&state.db)
            .await?;
    }
    Ok(Some(username))
}

async fn delete_session(state: &AppState, token: &str) -> Result<(), AppError> {
    sqlx::query("DELETE FROM sessions WHERE token_hash = ?")
        .bind(hash_token(token))
        .execute(&state.db)
        .await?;
    Ok(())
}

pub async fn purge_expired_sessions(state: &AppState) -> Result<u64, AppError> {
    let result = sqlx::query("DELETE FROM sessions WHERE expires_at <= ?")
        .bind(now_unix())
        .execute(&state.db)
        .await?;
    Ok(result.rows_affected())
}

fn session_cookie(state: &AppState, token: &str) -> Cookie<'static> {
    Cookie::build((SESSION_COOKIE, token.to_owned()))
        .http_only(true)
        .same_site(SameSite::Lax)
        .secure(state.config.cookie_secure)
        .path("/")
        .max_age(CookieDuration::days(state.config.session_ttl_days as i64))
        .build()
}

fn clear_session_cookie(state: &AppState, jar: CookieJar) -> CookieJar {
    let cookie = Cookie::build((SESSION_COOKIE, ""))
        .http_only(true)
        .same_site(SameSite::Lax)
        .secure(state.config.cookie_secure)
        .path("/")
        .max_age(CookieDuration::ZERO)
        .build();
    jar.add(cookie)
}

fn cookie_token(jar: &CookieJar) -> Option<String> {
    jar.get(SESSION_COOKIE)
        .map(|cookie| cookie.value().to_owned())
}

fn hash_token(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

fn now_unix() -> i64 {
    OffsetDateTime::now_utc().unix_timestamp()
}

fn is_unique_violation(error: &sqlx::Error) -> bool {
    error
        .as_database_error()
        .is_some_and(sqlx::error::DatabaseError::is_unique_violation)
}

fn token_from_headers(headers: &axum::http::HeaderMap) -> Option<String> {
    let raw = headers.get(header::COOKIE)?.to_str().ok()?;
    raw.split(';').find_map(|part| {
        let (name, value) = part.trim().split_once('=')?;
        (name == SESSION_COOKIE).then(|| value.to_owned())
    })
}

impl FromRequestParts<AppState> for Authenticated {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let token = token_from_headers(&parts.headers).ok_or(AppError::Unauthorized)?;
        let username = resolve_session(state, &token)
            .await?
            .ok_or(AppError::Unauthorized)?;
        Ok(Self { username })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{config::Config, db::connect, state::AppState};
    use axum::http::HeaderMap;

    async fn test_state() -> (tempfile::TempDir, AppState) {
        let temp = tempfile::tempdir().expect("temporary directory");
        let config = Config::for_test(temp.path().to_path_buf());
        let db = connect(&config).await.expect("database");
        let state = AppState::new(config, db);
        (temp, state)
    }

    #[test]
    fn throttle_backs_off_without_extending_rejected_requests() {
        let mut throttle = LoginThrottle::default();
        let mut now = Instant::now();
        for delay in [1, 1, 1, 1, 2, 4, 8, 16, 32, 60, 60] {
            throttle.admit(now).expect("admitted after cooldown");
            let next = throttle.next_attempt;
            assert!(matches!(
                throttle.admit(now),
                Err(AppError::LoginThrottled(_))
            ));
            assert_eq!(throttle.next_attempt, next);
            assert_eq!(next, Some(now + Duration::from_secs(delay)));
            now += Duration::from_secs(delay);
        }
        throttle.success();
        throttle.admit(now).expect("success resets backoff");
        assert_eq!(throttle.next_attempt, Some(now + Duration::from_secs(1)));
        throttle.attempts = 20;
        now += Duration::from_secs(900);
        throttle.admit(now).expect("idle resets backoff");
        assert_eq!(throttle.attempts, 1);
    }

    #[tokio::test]
    async fn login_throttle_is_shared_and_returns_retry_after() {
        let (_temp, state) = test_state().await;
        let cloned = state.clone();
        state
            .login_throttle
            .lock()
            .await
            .admit(Instant::now())
            .unwrap();
        let result = login(
            State(cloned),
            CookieJar::new(),
            Ok(Json(Credentials {
                username: "another-user".to_owned(),
                password: "another password".to_owned(),
            })),
        )
        .await;
        let error = match result {
            Err(error) => error,
            Ok(_) => panic!("must throttle"),
        };
        let response = error.into_response();
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        assert!(response.headers().contains_key(header::RETRY_AFTER));
    }

    #[tokio::test]
    async fn verification_rejects_wrong_username_and_bounds_concurrency() {
        let (_temp, state) = test_state().await;
        let credentials = Credentials {
            username: "moth".to_owned(),
            password: "a secure password".to_owned(),
        };
        create_user(&state, &credentials).await.unwrap();
        let wrong_user = Credentials {
            username: "unknown".to_owned(),
            ..credentials.clone()
        };
        assert!(!verify_user(&state, &wrong_user).await.unwrap());
        let permit = state
            .login_verifications
            .clone()
            .acquire_owned()
            .await
            .unwrap();
        assert!(matches!(
            verify_user(&state, &credentials).await,
            Err(AppError::LoginThrottled(1))
        ));
        drop(permit);
        assert!(verify_user(&state, &credentials).await.unwrap());
        let response = login(
            State(state.clone()),
            CookieJar::new(),
            Ok(Json(credentials)),
        )
        .await
        .unwrap()
        .into_response();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        assert!(response.headers().contains_key(header::SET_COOKIE));
        assert_eq!(state.login_throttle.lock().await.attempts, 0);
    }

    #[test]
    fn validates_credentials_without_trimming_password() {
        let credentials = validate_credentials(Credentials {
            username: "  moth  ".to_owned(),
            password: "          ".to_owned(),
        })
        .expect("valid credentials");
        assert_eq!(credentials.username, "moth");
        assert_eq!(credentials.password, "          ");
    }

    #[test]
    fn rejects_short_credentials() {
        assert!(matches!(
            validate_credentials(Credentials {
                username: String::new(),
                password: "short".to_owned(),
            }),
            Err(AppError::Validation(_))
        ));
    }

    #[tokio::test]
    async fn setup_is_singleton_and_password_is_verifiable() {
        let (_temp, state) = test_state().await;
        let credentials = Credentials {
            username: "moth".to_owned(),
            password: "a secure password".to_owned(),
        };
        create_user(&state, &credentials).await.expect("setup");
        assert!(verify_user(&state, &credentials).await.expect("verify"));

        let second = create_user(&state, &credentials).await;
        assert!(matches!(
            second,
            Err(AppError::Conflict {
                code: "setup_completed",
                ..
            })
        ));
    }

    #[tokio::test]
    async fn expired_session_is_deleted_when_resolved() {
        let (_temp, state) = test_state().await;
        let credentials = Credentials {
            username: "moth".to_owned(),
            password: "a secure password".to_owned(),
        };
        create_user(&state, &credentials).await.expect("setup");
        let token = "expired-token";
        sqlx::query(
            "INSERT INTO sessions (token_hash, created_at, expires_at, last_used_at) VALUES (?, ?, ?, ?)",
        )
        .bind(hash_token(token))
        .bind(0_i64)
        .bind(0_i64)
        .bind(0_i64)
        .execute(&state.db)
        .await
        .expect("expired session");

        assert_eq!(resolve_session(&state, token).await.expect("resolve"), None);
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sessions")
            .fetch_one(&state.db)
            .await
            .expect("count");
        assert_eq!(count, 0);
    }

    #[tokio::test]
    async fn last_used_at_refresh_is_throttled() {
        let (_temp, state) = test_state().await;
        let credentials = Credentials {
            username: "moth".to_owned(),
            password: "a secure password".to_owned(),
        };
        create_user(&state, &credentials).await.expect("setup");
        let token = create_session(&state).await.expect("session");

        // A fresh session was just touched: resolving again must not move it.
        let before: i64 = sqlx::query_scalar("SELECT last_used_at FROM sessions")
            .fetch_one(&state.db)
            .await
            .expect("timestamp");
        assert_eq!(
            resolve_session(&state, &token)
                .await
                .expect("resolve")
                .as_deref(),
            Some("moth")
        );
        let after: i64 = sqlx::query_scalar("SELECT last_used_at FROM sessions")
            .fetch_one(&state.db)
            .await
            .expect("timestamp");
        assert_eq!(before, after);

        // Once the throttle window has passed, the marker is refreshed again.
        let stale = now_unix() - LAST_USED_REFRESH_SECS - 1;
        sqlx::query("UPDATE sessions SET last_used_at = ?")
            .bind(stale)
            .execute(&state.db)
            .await
            .expect("backdate");
        assert_eq!(
            resolve_session(&state, &token)
                .await
                .expect("resolve")
                .as_deref(),
            Some("moth")
        );
        let refreshed: i64 = sqlx::query_scalar("SELECT last_used_at FROM sessions")
            .fetch_one(&state.db)
            .await
            .expect("timestamp");
        assert!(refreshed >= stale);
    }

    #[tokio::test]
    async fn purge_expired_sessions_removes_only_expired_rows() {
        let (_temp, state) = test_state().await;
        sqlx::query(
            "INSERT INTO sessions (token_hash, created_at, expires_at, last_used_at) VALUES (?, 0, 0, 0)",
        )
        .bind(hash_token("expired"))
        .execute(&state.db)
        .await
        .expect("expired row");
        sqlx::query(
            "INSERT INTO sessions (token_hash, created_at, expires_at, last_used_at) VALUES (?, ?, ?, ?)",
        )
        .bind(hash_token("live"))
        .bind(now_unix())
        .bind(now_unix() + 3600)
        .bind(now_unix())
        .execute(&state.db)
        .await
        .expect("live row");

        let purged = purge_expired_sessions(&state).await.expect("purge");
        assert_eq!(purged, 1);
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sessions")
            .fetch_one(&state.db)
            .await
            .expect("count");
        assert_eq!(count, 1);
    }

    #[test]
    fn extracts_token_from_cookie_header() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            "other=value; moth_session=abc123".parse().expect("cookie"),
        );
        assert_eq!(token_from_headers(&headers).as_deref(), Some("abc123"));
    }
}
