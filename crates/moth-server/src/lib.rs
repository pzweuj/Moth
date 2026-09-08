pub mod auth;
pub mod books;
pub mod config;
pub mod db;
pub mod error;
pub mod library;
pub mod state;

use axum::{
    Router,
    extract::State,
    http::{HeaderValue, Method, Request, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Json, Response},
    routing::{any, get},
};
use serde::Serialize;
use tower_http::services::ServeDir;

use crate::{error::AppError, state::AppState};

#[derive(Debug, Serialize)]
pub struct HealthResponse {
    pub status: &'static str,
    pub version: &'static str,
    pub database: &'static str,
}

pub fn router(state: AppState) -> Router {
    let api = Router::new()
        .route("/health", get(health))
        .route("/setup/status", get(auth::setup_status))
        .route("/setup", axum::routing::post(auth::setup))
        .route(
            "/session",
            get(auth::current_session)
                .post(auth::login)
                .delete(auth::logout),
        )
        .route("/home", get(books::home))
        .route("/browse", get(library::browse))
        .route("/scan", axum::routing::post(library::start_scan))
        .route("/scan/status", get(library::scan_status))
        .route("/publications/{id}", get(books::get_book))
        .route("/publications/{id}/cover", get(books::get_cover))
        .route("/publications/{id}/file", get(books::get_file))
        .route("/publications/{id}/chapters/{idx}", get(books::get_chapter))
        .route("/publications/{id}/pages/{idx}", get(books::get_page))
        .route(
            "/publications/{id}/progress",
            get(books::get_progress).put(books::put_progress),
        )
        .route(
            "/publications/{id}/conversion",
            get(books::conversion_status).post(books::start_conversion),
        )
        .fallback(api_not_found);

    let web_dir = state.config.web_dir.clone();
    Router::new()
        .nest("/api/v1", api)
        .route("/api", any(api_not_found))
        .route("/api/{*path}", any(api_not_found))
        .route(
            "/sw.js",
            get({
                let path = web_dir.join("sw.js");
                move || static_file(path.clone(), "application/javascript; charset=utf-8")
            }),
        )
        .route(
            "/manifest.webmanifest",
            get({
                let path = web_dir.join("manifest.webmanifest");
                move || static_file(path.clone(), "application/manifest+json")
            }),
        )
        .route(
            "/favicon.svg",
            get({
                let path = web_dir.join("favicon.svg");
                move || static_file(path.clone(), "image/svg+xml")
            }),
        )
        .nest_service("/assets", ServeDir::new(web_dir.join("assets")))
        .fallback(spa_fallback)
        .layer(middleware::from_fn(add_security_headers))
        .layer(middleware::from_fn(add_cache_headers))
        .with_state(state)
}

async fn health(State(state): State<AppState>) -> Result<Json<HealthResponse>, AppError> {
    sqlx::query("SELECT 1").execute(&state.db).await?;
    Ok(Json(HealthResponse {
        status: "ok",
        version: env!("CARGO_PKG_VERSION"),
        database: "ok",
    }))
}

async fn api_not_found() -> (StatusCode, Json<serde_json::Value>) {
    (
        StatusCode::NOT_FOUND,
        Json(
            serde_json::json!({"error":{"code":"not_found","message":"The requested resource was not found"}}),
        ),
    )
}

async fn add_cache_headers(request: Request<axum::body::Body>, next: Next) -> Response {
    let path = request.uri().path().to_owned();
    let mut response = next.run(request).await;
    if !path.starts_with("/api/") {
        let value = if path.starts_with("/assets/") {
            "public, max-age=31536000, immutable"
        } else {
            "no-cache"
        };
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static(value));
    }
    response
}

async fn add_security_headers(request: Request<axum::body::Body>, next: Next) -> Response {
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("strict-origin-when-cross-origin"),
    );
    headers.insert(
        header::X_FRAME_OPTIONS,
        HeaderValue::from_static("SAMEORIGIN"),
    );
    headers.insert(
        header::HeaderName::from_static("permissions-policy"),
        HeaderValue::from_static("camera=(), microphone=(), geolocation=()"),
    );
    headers.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' blob: data:; img-src 'self' data: blob:; font-src 'self' blob:; connect-src 'self' blob:; worker-src 'self' blob:; frame-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'"));
    response
}

async fn static_file(path: std::path::PathBuf, content_type: &'static str) -> Response {
    match tokio::fs::read(path).await {
        Ok(body) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, content_type)
            .header(header::CACHE_CONTROL, "no-cache")
            .body(axum::body::Body::from(body))
            .expect("static response builder"),
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn spa_fallback(
    State(state): State<AppState>,
    request: Request<axum::body::Body>,
) -> Response {
    if request.method() != Method::GET && request.method() != Method::HEAD {
        return StatusCode::NOT_FOUND.into_response();
    }
    match tokio::fs::read(state.config.web_dir.join("index.html")).await {
        Ok(body) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
            .body(axum::body::Body::from(body))
            .expect("spa response builder"),
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}
