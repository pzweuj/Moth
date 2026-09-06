use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("configuration error: {0}")]
    Config(String),
    #[error("validation error: {0}")]
    Validation(String),
    #[error("invalid credentials")]
    Unauthorized,
    #[error("not found")]
    NotFound,
    #[error("archive error: {0}")]
    Archive(String),
    #[error("conflict: {code}")]
    Conflict {
        code: &'static str,
        message: &'static str,
    },
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Database(#[from] sqlx::Error),
    #[error(transparent)]
    Migration(#[from] sqlx::migrate::MigrateError),
    #[error("password hashing failed")]
    PasswordHash,
}

#[derive(Debug, Serialize)]
struct ErrorBody {
    error: ErrorDetail,
}

#[derive(Debug, Serialize)]
struct ErrorDetail {
    code: String,
    message: String,
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, code, message) = match &self {
            Self::Validation(message) => (
                StatusCode::BAD_REQUEST,
                "validation_error".to_owned(),
                message.clone(),
            ),
            Self::Unauthorized => (
                StatusCode::UNAUTHORIZED,
                "invalid_credentials".to_owned(),
                "Invalid username or password".to_owned(),
            ),
            Self::NotFound => (
                StatusCode::NOT_FOUND,
                "not_found".to_owned(),
                "The requested resource was not found".to_owned(),
            ),
            Self::Archive(message) => {
                tracing::error!(message, "archive read failed");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal_error".to_owned(),
                    "An internal server error occurred".to_owned(),
                )
            }
            Self::Conflict { code, message } => (
                StatusCode::CONFLICT,
                (*code).to_owned(),
                (*message).to_owned(),
            ),
            error => {
                tracing::error!(error = %error, "request failed");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal_error".to_owned(),
                    "An internal server error occurred".to_owned(),
                )
            }
        };
        (
            status,
            axum::Json(ErrorBody {
                error: ErrorDetail { code, message },
            }),
        )
            .into_response()
    }
}
