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
        .route("/books", get(books::list_books))
        .route("/books/{id}", get(books::get_book))
        .route("/books/{id}/cover", get(books::get_cover))
        .route("/books/{id}/chapter/{idx}", get(books::get_chapter))
        .route("/books/{id}/page/{idx}", get(books::get_page))
        .route("/books/{id}/resource/{idx}", get(books::get_resource))
        .route(
            "/books/{id}/progress",
            get(books::get_progress).put(books::put_progress),
        )
        .route("/library/scan", axum::routing::post(library::start_scan))
        .route("/library/scan/status", get(books::scan_status))
        .fallback(api_not_found);
    let web_dir = state.config.web_dir.clone();
    Router::new()
        .nest("/api/v1", api)
        .route("/api", any(api_not_found))
        .route("/api/{*path}", any(api_not_found))
        .nest_service("/assets", ServeDir::new(web_dir.join("assets")))
        .fallback(spa_fallback)
        .layer(middleware::from_fn(add_cache_headers))
        .with_state(state)
}

async fn health(State(state): State<AppState>) -> Result<Json<HealthResponse>, AppError> {
    sqlx::query("SELECT 1")
        .execute(&state.db)
        .await
        .map_err(AppError::Database)?;

    Ok(Json(HealthResponse {
        status: "ok",
        version: env!("CARGO_PKG_VERSION"),
        database: "ok",
    }))
}

async fn api_not_found() -> (StatusCode, Json<serde_json::Value>) {
    (
        StatusCode::NOT_FOUND,
        Json(serde_json::json!({
            "error": {
                "code": "not_found",
                "message": "The requested resource was not found"
            }
        })),
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

async fn spa_fallback(
    State(state): State<AppState>,
    request: Request<axum::body::Body>,
) -> Response {
    if request.method() != Method::GET && request.method() != Method::HEAD {
        return StatusCode::NOT_FOUND.into_response();
    }

    let index_file = state.config.web_dir.join("index.html");
    match tokio::fs::read(index_file).await {
        Ok(body) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
            .body(axum::body::Body::from(body))
            .expect("static response builder"),
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{config::Config, db::connect, state::AppState};
    use axum::body::Body;
    use axum::http::{Method, Request, StatusCode, header};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    async fn test_app() -> (tempfile::TempDir, Router) {
        let temp = tempfile::tempdir().expect("temporary directory");
        let config = Config::for_test(temp.path().to_path_buf());
        let pool = connect(&config).await.expect("database connection");
        (temp, router(AppState::new(config, pool)))
    }

    fn json_request(method: Method, uri: &str, body: &str) -> Request<Body> {
        Request::builder()
            .method(method)
            .uri(uri)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_owned()))
            .expect("request")
    }

    async fn response_json(response: axum::http::Response<Body>) -> serde_json::Value {
        let body = response
            .into_body()
            .collect()
            .await
            .expect("body")
            .to_bytes();
        serde_json::from_slice(&body).expect("json")
    }

    #[tokio::test]
    async fn health_reports_database_status() {
        let temp = tempfile::tempdir().expect("temporary directory");
        let config = Config::for_test(temp.path().to_path_buf());
        let pool = connect(&config).await.expect("database connection");
        let app = router(AppState::new(config, pool));

        let response = app
            .oneshot(
                axum::http::Request::builder()
                    .uri("/api/v1/health")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");

        assert_eq!(response.status(), StatusCode::OK);
        let body = response
            .into_body()
            .collect()
            .await
            .expect("body")
            .to_bytes();
        let value: serde_json::Value = serde_json::from_slice(&body).expect("json");
        assert_eq!(value["status"], "ok");
        assert_eq!(value["database"], "ok");
    }

    #[tokio::test]
    async fn setup_login_session_and_logout_follow_api_contract() {
        let (_temp, app) = test_app().await;

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/v1/setup/status")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response_json(response).await["initialized"], false);

        let setup_body = r#"{"username":"moth","password":"a secure password"}"#;
        let response = app
            .clone()
            .oneshot(json_request(Method::POST, "/api/v1/setup", setup_body))
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::CREATED);

        let response = app
            .clone()
            .oneshot(json_request(Method::POST, "/api/v1/setup", setup_body))
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::CONFLICT);
        assert_eq!(
            response_json(response).await["error"]["code"],
            "setup_completed"
        );

        let wrong_body = r#"{"username":"moth","password":"wrong password"}"#;
        let response = app
            .clone()
            .oneshot(json_request(Method::POST, "/api/v1/session", wrong_body))
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(
            response_json(response).await["error"]["code"],
            "invalid_credentials"
        );

        let response = app
            .clone()
            .oneshot(json_request(Method::POST, "/api/v1/session", setup_body))
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        let set_cookie = response
            .headers()
            .get(header::SET_COOKIE)
            .expect("session cookie")
            .to_str()
            .expect("cookie value")
            .to_owned();
        assert!(set_cookie.contains("HttpOnly"));
        assert!(set_cookie.contains("SameSite=Lax"));
        assert!(set_cookie.contains("Path=/"));
        let cookie = set_cookie
            .split(';')
            .next()
            .expect("cookie pair")
            .to_owned();

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/v1/session")
                    .header(header::COOKIE, &cookie)
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::OK);
        let session = response_json(response).await;
        assert_eq!(session["authenticated"], true);
        assert_eq!(session["username"], "moth");

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::DELETE)
                    .uri("/api/v1/session")
                    .header(header::COOKIE, &cookie)
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        assert!(
            response
                .headers()
                .get(header::SET_COOKIE)
                .expect("clear cookie")
                .to_str()
                .expect("cookie value")
                .contains("Max-Age=0")
        );

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/v1/session")
                    .header(header::COOKIE, cookie)
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response_json(response).await["authenticated"], false);
    }

    #[tokio::test]
    async fn concurrent_setup_allows_only_one_user() {
        let (_temp, app) = test_app().await;
        let body = r#"{"username":"moth","password":"a secure password"}"#;
        let first = app
            .clone()
            .oneshot(json_request(Method::POST, "/api/v1/setup", body));
        let second = app.oneshot(json_request(Method::POST, "/api/v1/setup", body));
        let (first, second) = tokio::join!(first, second);
        let statuses = [
            first.expect("first response").status(),
            second.expect("second response").status(),
        ];
        assert!(statuses.contains(&StatusCode::CREATED));
        assert!(statuses.contains(&StatusCode::CONFLICT));
    }

    #[tokio::test]
    async fn malformed_credentials_use_the_unified_error_shape() {
        let (_temp, app) = test_app().await;
        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/v1/setup")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from("not-json"))
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            response_json(response).await["error"]["code"],
            "validation_error"
        );
    }

    #[tokio::test]
    async fn unknown_api_paths_are_json_not_spa_documents() {
        let (_temp, app) = test_app().await;
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/v1/does-not-exist")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(response.headers()[header::CONTENT_TYPE], "application/json");
        assert_eq!(response_json(response).await["error"]["code"], "not_found");
    }

    #[tokio::test]
    async fn api_remains_available_without_a_web_build() {
        let temp = tempfile::tempdir().expect("temporary directory");
        let mut config = Config::for_test(temp.path().join("data"));
        config.web_dir = temp.path().join("missing-web");
        let pool = connect(&config).await.expect("database connection");
        let app = router(AppState::new(config, pool));

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/v1/health")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::OK);

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/reader/book-1")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn static_service_serves_spa_fallback_and_cache_headers() {
        let temp = tempfile::tempdir().expect("temporary directory");
        let web_dir = temp.path().join("web");
        let assets_dir = web_dir.join("assets");
        tokio::fs::create_dir_all(&assets_dir)
            .await
            .expect("assets directory");
        tokio::fs::write(
            web_dir.join("index.html"),
            "<!doctype html><main>Moth shell</main>",
        )
        .await
        .expect("index");
        tokio::fs::write(assets_dir.join("app.js"), "console.log('moth')")
            .await
            .expect("asset");

        let data_dir = temp.path().join("data");
        let mut config = Config::for_test(data_dir);
        config.web_dir = web_dir;
        let pool = connect(&config).await.expect("database connection");
        let app = router(AppState::new(config, pool));

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/reader/book-1")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-cache");
        let body = response
            .into_body()
            .collect()
            .await
            .expect("body")
            .to_bytes();
        assert!(String::from_utf8_lossy(&body).contains("Moth shell"));

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/assets/app.js")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()[header::CACHE_CONTROL],
            "public, max-age=31536000, immutable"
        );
        assert_eq!(response.headers()[header::CONTENT_TYPE], "text/javascript");
    }
}
