use std::{
    env,
    net::SocketAddr,
    path::{Path, PathBuf},
};

use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

use crate::error::AppError;

#[derive(Clone, Debug)]
pub struct Config {
    pub bind_addr: SocketAddr,
    pub data_dir: PathBuf,
    pub libraries: Vec<LibraryConfig>,
    pub config_file: Option<PathBuf>,
    pub web_dir: PathBuf,
    pub cookie_secure: bool,
    pub session_ttl_days: u64,
    pub log_directive: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LibraryConfig {
    pub key: String,
    pub name: String,
    pub path: PathBuf,
}

impl Config {
    pub fn from_env() -> Result<Self, AppError> {
        Self::from_lookup(|key| env::var(key).ok())
    }

    pub fn for_test(data_dir: PathBuf) -> Self {
        Self {
            bind_addr: "127.0.0.1:0".parse().expect("test address"),
            data_dir,
            libraries: vec![LibraryConfig {
                key: "default".to_owned(),
                name: "书库".to_owned(),
                path: PathBuf::from("books"),
            }],
            config_file: None,
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
        let legacy_books_dir = path_value(&lookup, "MOTH_BOOKS_DIR", "/books");
        let web_dir = path_value(&lookup, "MOTH_WEB_DIR", "web/dist");

        let config_file = lookup("MOTH_CONFIG_FILE")
            .map(|value| PathBuf::from(value.trim()))
            .filter(|path| !path.as_os_str().is_empty());
        let libraries = if let Some(path) = config_file.as_deref() {
            if !path.is_file() {
                return Err(AppError::Config(format!(
                    "MOTH_CONFIG_FILE does not exist or is not a regular file: {}",
                    path.display()
                )));
            }
            load_libraries(path)?
        } else {
            validate_libraries(vec![LibraryConfig {
                key: "default".to_owned(),
                name: "书库".to_owned(),
                path: legacy_books_dir,
            }])?
        };

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
            libraries,
            config_file,
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

fn load_libraries(path: &Path) -> Result<Vec<LibraryConfig>, AppError> {
    let content = std::fs::read_to_string(path).map_err(|error| {
        AppError::Config(format!(
            "could not read MOTH_CONFIG_FILE {}: {error}",
            path.display()
        ))
    })?;
    // Deliberately small TOML subset: one `[[libraries]]` table with string
    // key/name/path fields. Keeping this parser local avoids adding a runtime
    // dependency just for three deployment settings.
    let mut libraries = Vec::new();
    let mut current: Option<LibraryConfig> = None;
    let mut fields = std::collections::HashSet::new();
    for (line_no, raw) in content.lines().enumerate() {
        let line = strip_comment(raw).trim();
        if line.is_empty() {
            continue;
        }
        if line == "[[libraries]]" {
            if let Some(value) = current.take() {
                libraries.push(value);
            }
            fields.clear();
            current = Some(LibraryConfig {
                key: String::new(),
                name: String::new(),
                path: PathBuf::new(),
            });
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            return Err(AppError::Config(format!(
                "invalid MOTH_CONFIG_FILE line {}",
                line_no + 1
            )));
        };
        let Some(current) = current.as_mut() else {
            return Err(AppError::Config(format!(
                "library field before [[libraries]] on line {}",
                line_no + 1
            )));
        };
        let key = key.trim();
        if !fields.insert(key.to_owned()) {
            return Err(AppError::Config(format!(
                "duplicate library field {key} on line {}",
                line_no + 1
            )));
        }
        let value = parse_quoted_string(value.trim())
            .map_err(|message| AppError::Config(format!("{message} on line {}", line_no + 1)))?;
        match key {
            "key" => current.key = value,
            "name" => current.name = value,
            "path" => current.path = PathBuf::from(value),
            other => {
                return Err(AppError::Config(format!(
                    "unknown library field {other} on line {}",
                    line_no + 1
                )));
            }
        }
    }
    if let Some(value) = current {
        libraries.push(value);
    }
    validate_libraries(libraries)
}

fn strip_comment(value: &str) -> &str {
    let mut quoted = false;
    let mut escaped = false;
    for (index, character) in value.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if quoted && character == '\\' {
            escaped = true;
            continue;
        }
        if character == '"' {
            quoted = !quoted;
        } else if character == '#' && !quoted {
            return &value[..index];
        }
    }
    value
}

fn parse_quoted_string(value: &str) -> Result<String, String> {
    if !value.starts_with('"') {
        return Err("library values must be quoted strings".to_owned());
    }
    let mut output = String::new();
    let mut escaped = false;
    let mut closed_at = None;
    for (index, character) in value[1..].char_indices() {
        if escaped {
            output.push(match character {
                '"' => '"',
                '\\' => '\\',
                'n' => '\n',
                'r' => '\r',
                't' => '\t',
                other => return Err(format!("unsupported TOML escape \\{other}")),
            });
            escaped = false;
        } else if character == '\\' {
            escaped = true;
        } else if character == '"' {
            closed_at = Some(index + 1 + character.len_utf8());
            break;
        } else {
            output.push(character);
        }
    }
    let Some(end) = closed_at else {
        return Err("unterminated quoted library value".to_owned());
    };
    if !value[end..].trim().is_empty() {
        return Err("unexpected characters after quoted library value".to_owned());
    }
    Ok(output)
}

fn validate_libraries(libraries: Vec<LibraryConfig>) -> Result<Vec<LibraryConfig>, AppError> {
    if libraries.is_empty() {
        return Err(AppError::Config(
            "at least one library is required".to_owned(),
        ));
    }
    let mut keys = std::collections::HashSet::new();
    let mut names = std::collections::HashSet::new();
    let mut paths = std::collections::HashSet::new();
    let mut normalized_libraries = Vec::with_capacity(libraries.len());
    for library in libraries {
        let key = library.key.trim();
        let name = library.name.trim();
        if key.is_empty()
            || name.is_empty()
            || library.path.as_os_str().is_empty()
            || library.path.to_string_lossy().trim().is_empty()
        {
            return Err(AppError::Config(
                "library key, name and path must not be empty".to_owned(),
            ));
        }
        if key.contains(['/', '\\']) || key == "." || key == ".." {
            return Err(AppError::Config(format!(
                "invalid library key: {}",
                library.key
            )));
        }
        let normalized = normalize_library_path(&library.path)?;
        if normalized.exists() && !normalized.is_dir() {
            return Err(AppError::Config(format!(
                "library path is not a directory: {}",
                normalized.display()
            )));
        }
        if !keys.insert(key.to_owned()) {
            return Err(AppError::Config(format!(
                "duplicate library key: {}",
                library.key
            )));
        }
        if !names.insert(name.to_owned()) {
            return Err(AppError::Config(format!(
                "duplicate library name: {}",
                library.name
            )));
        }
        let path_key = std::fs::canonicalize(&normalized)
            .unwrap_or(normalized.clone())
            .to_string_lossy()
            .to_ascii_lowercase();
        if !paths.insert(path_key) {
            return Err(AppError::Config(format!(
                "duplicate library path: {}",
                normalized.display()
            )));
        }
        normalized_libraries.push(LibraryConfig {
            key: key.to_owned(),
            name: name.to_owned(),
            path: normalized,
        });
    }
    Ok(normalized_libraries)
}

/// Return an absolute, lexically normalized path without requiring a NAS mount
/// to be present during configuration parsing. Existing paths are checked for
/// directory-ness above and canonicalized only for duplicate detection.
fn normalize_library_path(path: &Path) -> Result<PathBuf, AppError> {
    if path.as_os_str().to_string_lossy().trim().is_empty() {
        return Err(AppError::Config(format!(
            "invalid library path: {}",
            path.display()
        )));
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
                        "library path escapes its root: {}",
                        path.display()
                    )));
                }
            }
            std::path::Component::Normal(value) => normalized.push(value),
        }
    }
    if normalized.as_os_str().is_empty() {
        return Err(AppError::Config(format!(
            "invalid library path: {}",
            path.display()
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
        assert_eq!(config.libraries[0].key, "default");
        assert_eq!(config.libraries[0].name, "书库");
        assert!(config.libraries[0].path.is_absolute());
    }

    #[test]
    fn rejects_empty_legacy_books_dir() {
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
    fn rejects_missing_explicit_config_file() {
        let result = Config::from_lookup(lookup(vec![("MOTH_CONFIG_FILE", "does-not-exist.toml")]));
        assert!(
            matches!(result, Err(AppError::Config(message)) if message.contains("MOTH_CONFIG_FILE"))
        );
    }

    #[test]
    fn rejects_duplicate_library_keys_and_paths() {
        let temp = tempfile::tempdir().expect("temporary directory");
        let config = temp.path().join("libraries.toml");
        let path = temp.path().to_string_lossy().replace('\\', "/");
        std::fs::write(
            &config,
            format!(
                "[[libraries]]\nkey=\"same\"\nname=\"一\"\npath=\"{}\"\n\n[[libraries]]\nkey=\"same\"\nname=\"二\"\npath=\"{}\"\n",
                path, path
            ),
        )
        .expect("config file");
        let result = Config::from_lookup(lookup(vec![(
            "MOTH_CONFIG_FILE",
            config.to_string_lossy().as_ref(),
        )]));
        assert!(
            matches!(result, Err(AppError::Config(message)) if message.contains("duplicate library key"))
        );

        std::fs::write(
            &config,
            format!(
                "[[libraries]]\nkey=\"one\"\nname=\"相同名称\"\npath=\"{}\"\n\n[[libraries]]\nkey=\"two\"\nname=\"相同名称\"\npath=\"{}-other\"\n",
                path, path
            ),
        )
        .expect("config file");
        let result = Config::from_lookup(lookup(vec![(
            "MOTH_CONFIG_FILE",
            config.to_string_lossy().as_ref(),
        )]));
        assert!(
            matches!(result, Err(AppError::Config(message)) if message.contains("duplicate library name"))
        );
    }

    #[test]
    fn parses_quoted_comments_and_rejects_duplicate_fields() {
        let temp = tempfile::tempdir().expect("temporary directory");
        let config = temp.path().join("libraries.toml");
        let path = temp.path().to_string_lossy().replace('\\', "/");
        std::fs::write(
            &config,
            format!(
                "[[libraries]]\nkey=\"中文\" # key\nname=\"带 # 号\"\npath=\"{}\"\n",
                path
            ),
        )
        .expect("config file");
        let parsed = Config::from_lookup(lookup(vec![(
            "MOTH_CONFIG_FILE",
            config.to_string_lossy().as_ref(),
        )]))
        .expect("quoted TOML");
        assert_eq!(parsed.libraries[0].key, "中文");
        assert_eq!(parsed.libraries[0].name, "带 # 号");

        std::fs::write(
            &config,
            format!(
                "[[libraries]]\nkey=\"one\"\nkey=\"two\"\nname=\"书库\"\npath=\"{}\"\n",
                path
            ),
        )
        .expect("config file");
        let result = Config::from_lookup(lookup(vec![(
            "MOTH_CONFIG_FILE",
            config.to_string_lossy().as_ref(),
        )]));
        assert!(
            matches!(result, Err(AppError::Config(message)) if message.contains("duplicate library field"))
        );
    }
}
