use std::{env, net::SocketAddr, path::PathBuf};

use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

use crate::error::AppError;

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
        let books_dir = path_value(&lookup, "MOTH_BOOKS_DIR", "/books");
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
        let filter =
            tracing_subscriber::EnvFilter::try_new(&self.log_directive).map_err(|error| {
                AppError::Config(format!("MOTH_LOG is not a valid log filter: {error}"))
            })?;
        tracing_subscriber::registry()
            .with(filter)
            .with(tracing_subscriber::fmt::layer())
            .try_init()
            .map_err(|error| AppError::Config(format!("could not initialize logging: {error}")))
    }
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
    let value = lookup(key).unwrap_or_else(|| default.to_owned());
    parser(&value)
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
        assert!(!config.cookie_secure);
        assert_eq!(config.session_ttl_days, 30);
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
}
