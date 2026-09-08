use std::{
    env,
    net::SocketAddr,
    path::{Path, PathBuf},
};

use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

use crate::error::AppError;

/// Runtime configuration for the single-user, single-root server.
#[derive(Clone, Debug)]
pub struct Config {
    pub bind_addr: SocketAddr,
    pub data_dir: PathBuf,
    pub books_dir: PathBuf,
    pub web_dir: PathBuf,
    pub cookie_secure: bool,
    pub session_ttl_days: u64,
    pub log_directive: String,
}

impl Config {
    pub fn from_env() -> Result<Self, AppError> {
        Self::from_lookup(|key| env::var(key).ok())
    }

    pub fn for_test(data_dir: PathBuf) -> Self {
        Self {
            bind_addr: "127.0.0.1:0".parse().expect("test address"),
            data_dir,
            books_dir: PathBuf::from("books"),
            web_dir: PathBuf::from("web/dist"),
            cookie_secure: false,
            session_ttl_days: 30,
            log_directive: "info".to_owned(),
        }
    }

    fn from_lookup<F>(lookup: F) -> Result<Self, AppError>
    where
        F: Fn(&str) -> Option<String>,
    {
        let bind_addr = parse_value(&lookup, "MOTH_BIND_ADDR", "0.0.0.0:8080", |value| {
            value.parse::<SocketAddr>().map_err(|_| {
                AppError::Config(format!(
                    "MOTH_BIND_ADDR is not a valid socket address: {value}"
                ))
            })
        })?;
        let data_dir = path_value(&lookup, "MOTH_DATA_DIR", "/data");
        let books_dir = normalize_books_path(&path_value(&lookup, "MOTH_BOOKS_DIR", "/books"))?;
        let web_dir = path_value(&lookup, "MOTH_WEB_DIR", "web/dist");
        let cookie_secure = parse_value(&lookup, "MOTH_COOKIE_SECURE", "false", |value| {
            value.parse::<bool>().map_err(|_| {
                AppError::Config(format!(
                    "MOTH_COOKIE_SECURE must be true or false, got: {value}"
                ))
            })
        })?;
        let session_ttl_days = parse_value(&lookup, "MOTH_SESSION_TTL_DAYS", "30", |value| {
            let parsed = value.parse::<u64>().map_err(|_| {
                AppError::Config(format!(
                    "MOTH_SESSION_TTL_DAYS must be a positive integer, got: {value}"
                ))
            })?;
            if parsed == 0 {
                return Err(AppError::Config(
                    "MOTH_SESSION_TTL_DAYS must be greater than zero".to_owned(),
                ));
            }
            Ok(parsed)
        })?;
        let log_directive = lookup("MOTH_LOG").unwrap_or_else(|| "info".to_owned());
        tracing_subscriber::EnvFilter::try_new(&log_directive).map_err(|error| {
            AppError::Config(format!("MOTH_LOG is not a valid log filter: {error}"))
        })?;
        Ok(Self {
            bind_addr,
            data_dir,
            books_dir,
            web_dir,
            cookie_secure,
            session_ttl_days,
            log_directive,
        })
    }

    pub fn init_tracing(&self) -> Result<(), AppError> {
        let filter = tracing_subscriber::EnvFilter::try_new(&self.log_directive)
            .map_err(|error| AppError::Config(format!("invalid log filter: {error}")))?;
        tracing_subscriber::registry()
            .with(filter)
            .with(tracing_subscriber::fmt::layer())
            .try_init()
            .map_err(|error| AppError::Config(format!("could not initialize logging: {error}")))
    }
}

/// Resolve a root path without requiring a NAS mount to exist at startup.
fn normalize_books_path(path: &Path) -> Result<PathBuf, AppError> {
    if path.as_os_str().to_string_lossy().trim().is_empty() {
        return Err(AppError::Config(
            "MOTH_BOOKS_DIR must not be empty".to_owned(),
        ));
    }
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        env::current_dir()
            .map_err(|error| {
                AppError::Config(format!("could not resolve current directory: {error}"))
            })?
            .join(path)
    };
    let mut normalized = PathBuf::new();
    for component in absolute.components() {
        match component {
            std::path::Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            std::path::Component::RootDir => normalized.push(std::path::MAIN_SEPARATOR.to_string()),
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                if !normalized.pop() {
                    return Err(AppError::Config(format!(
                        "MOTH_BOOKS_DIR escapes its root: {}",
                        path.display()
                    )));
                }
            }
            std::path::Component::Normal(value) => normalized.push(value),
        }
    }
    if normalized.as_os_str().is_empty() {
        return Err(AppError::Config(
            "MOTH_BOOKS_DIR must not be empty".to_owned(),
        ));
    }
    if normalized.exists() && !normalized.is_dir() {
        return Err(AppError::Config(format!(
            "MOTH_BOOKS_DIR is not a directory: {}",
            normalized.display()
        )));
    }
    Ok(normalized)
}

fn path_value<F>(lookup: &F, key: &str, default: &str) -> PathBuf
where
    F: Fn(&str) -> Option<String>,
{
    PathBuf::from(lookup(key).unwrap_or_else(|| default.to_owned()))
}

fn parse_value<F, T, P>(lookup: &F, key: &str, default: &str, parser: P) -> Result<T, AppError>
where
    F: Fn(&str) -> Option<String>,
    P: FnOnce(&str) -> Result<T, AppError>,
{
    parser(&lookup(key).unwrap_or_else(|| default.to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lookup(values: Vec<(&str, &str)>) -> impl Fn(&str) -> Option<String> {
        move |key| {
            values
                .iter()
                .find(|(name, _)| *name == key)
                .map(|(_, value)| (*value).to_owned())
        }
    }

    #[test]
    fn uses_safe_defaults() {
        let config = Config::from_lookup(lookup(vec![])).expect("defaults");
        assert_eq!(config.bind_addr, "0.0.0.0:8080".parse().expect("address"));
        assert_eq!(config.data_dir, PathBuf::from("/data"));
        assert!(config.books_dir.ends_with("books"));
        assert!(!config.cookie_secure);
        assert_eq!(config.session_ttl_days, 30);
    }

    #[test]
    fn rejects_empty_books_dir() {
        let result = Config::from_lookup(lookup(vec![("MOTH_BOOKS_DIR", " ")]));
        assert!(
            matches!(result, Err(AppError::Config(message)) if message.contains("must not be empty"))
        );
    }

    #[test]
    fn rejects_invalid_values() {
        let result = Config::from_lookup(lookup(vec![("MOTH_COOKIE_SECURE", "yes")]));
        assert!(
            matches!(result, Err(AppError::Config(message)) if message.contains("MOTH_COOKIE_SECURE"))
        );
        let result = Config::from_lookup(lookup(vec![("MOTH_SESSION_TTL_DAYS", "0")]));
        assert!(
            matches!(result, Err(AppError::Config(message)) if message.contains("greater than zero"))
        );
        let result = Config::from_lookup(lookup(vec![("MOTH_LOG", "[")]));
        assert!(matches!(result, Err(AppError::Config(message)) if message.contains("MOTH_LOG")));
    }

    #[test]
    fn normalizes_relative_books_dir() {
        let config = Config::from_lookup(lookup(vec![("MOTH_BOOKS_DIR", "books/../library")]));
        assert!(config.expect("path").books_dir.ends_with("library"));
    }
}
