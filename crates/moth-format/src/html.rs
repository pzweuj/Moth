//! Sanitizing and URL rewriting for EPUB chapter XHTML. Chapters are stored
//! server-side with internal resource URLs rewritten to served endpoints, and
//! active content (scripts, embedded objects) removed.

use std::collections::HashMap;
use std::sync::OnceLock;

use regex::Regex;

use crate::resolve_reference;

fn element_regex(name: &str) -> &'static Regex {
    static CACHE: OnceLock<HashMap<&'static str, Regex>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| {
        ["script", "iframe", "object", "embed", "form"]
            .into_iter()
            .map(|name| {
                let pattern = format!(r"(?is)<{name}\b[^>]*>.*?</{name}\s*>");
                (name, Regex::new(&pattern).expect("element regex"))
            })
            .collect()
    });
    cache.get(name).expect("cached element regex")
}

fn strip_elements(html: &str, names: &[&str]) -> String {
    let mut out = html.to_owned();
    for name in names {
        out = element_regex(name).replace_all(&out, "").into_owned();
    }
    // Malformed chapters sometimes omit a closing tag. Remove any remaining
    // active-element tags as well; leaving their text is preferable to
    // allowing a browser to reinterpret the rest of the chapter as markup.
    static ACTIVE_TAGS: OnceLock<Regex> = OnceLock::new();
    out = ACTIVE_TAGS
        .get_or_init(|| {
            Regex::new(r"(?is)</?(?:script|iframe|object|embed|form)\b[^>]*>")
                .expect("active element tag regex")
        })
        .replace_all(&out, "")
        .into_owned();
    // `meta` and `base` are normally void elements, so the paired expression
    // above cannot match them. Neither is needed inside a reader chapter.
    static VOID_ELEMENTS: OnceLock<Regex> = OnceLock::new();
    VOID_ELEMENTS
        .get_or_init(|| Regex::new(r"(?is)<(?:meta|base)\b[^>]*?/?>").expect("void element regex"))
        .replace_all(&out, "")
        .into_owned()
}

fn strip_event_handlers(html: &str) -> String {
    static HANDLERS: OnceLock<Regex> = OnceLock::new();
    let re = HANDLERS.get_or_init(|| {
        Regex::new(r#"(?i)\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)"#)
            .expect("event handler regex")
    });
    re.replace_all(html, "").into_owned()
}

/// Remove active content and rewrite internal `src`/`href` references to the
/// resource endpoint prefix. References that are not in `resources` are left
/// unchanged; absolute and scheme URLs are never rewritten.
pub fn sanitize_and_rewrite(
    html: &str,
    base_dir: &str,
    resources: &HashMap<String, usize>,
    prefix: &str,
) -> String {
    let stripped = strip_elements(html, &["script", "iframe", "object", "embed", "form"]);
    let stripped = strip_event_handlers(&stripped);

    static URL_ATTRIBUTE: OnceLock<Regex> = OnceLock::new();
    let re = URL_ATTRIBUTE.get_or_init(|| {
        Regex::new(r#"(?i)(src|href|xlink:href|action|formaction|poster|data|srcset)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))"#).expect("url attribute regex")
    });
    re.replace_all(&stripped, |caps: &regex::Captures<'_>| {
        let attribute = &caps[1];
        let value = caps
            .get(3)
            .map(|m| m.as_str())
            .or_else(|| caps.get(4).map(|m| m.as_str()))
            .or_else(|| caps.get(5).map(|m| m.as_str()))
            .unwrap_or_default();
        let trimmed = value.trim();
        let normalized = trimmed
            .chars()
            .filter(|character| !character.is_whitespace() && !character.is_control())
            .collect::<String>()
            .to_ascii_lowercase();
        if normalized.starts_with("javascript:")
            || normalized.starts_with("vbscript:")
            || normalized.starts_with("data:text/html")
            || normalized.starts_with("data:application/xhtml+xml")
            || normalized.starts_with("file:")
            || normalized.starts_with("filesystem:")
        {
            return format!("{attribute}=\"#\"");
        }
        if attribute.eq_ignore_ascii_case("srcset")
            && value.split(',').any(|candidate| {
                let candidate = candidate.split_whitespace().next().unwrap_or_default();
                let normalized = candidate
                    .chars()
                    .filter(|character| !character.is_whitespace() && !character.is_control())
                    .collect::<String>()
                    .to_ascii_lowercase();
                normalized.starts_with("javascript:")
                    || normalized.starts_with("vbscript:")
                    || normalized.starts_with("data:text/html")
                    || normalized.starts_with("data:application/xhtml+xml")
                    || normalized.starts_with("file:")
                    || normalized.starts_with("filesystem:")
            })
        {
            return format!("{attribute}=\"#\"");
        }
        if trimmed.is_empty()
            || trimmed.starts_with('#')
            || trimmed.starts_with("http://")
            || trimmed.starts_with("https://")
            || trimmed.starts_with("data:")
            || trimmed.starts_with("mailto:")
        {
            return caps[0].to_owned();
        }
        let resolved = resolve_reference(base_dir, trimmed);
        if let Some(index) = resources.get(&resolved) {
            format!(r#"{attribute}="{prefix}/{index}""#)
        } else {
            caps[0].to_owned()
        }
    })
    .into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map() -> HashMap<String, usize> {
        let mut map = HashMap::new();
        map.insert("OEBPS/Images/x.jpg".to_owned(), 0);
        map.insert("OEBPS/css/main.css".to_owned(), 1);
        map
    }

    #[test]
    fn rewrites_relative_resources() {
        let html = r#"<html><body><img src="../Images/x.jpg"/><link rel="stylesheet" href="../css/main.css"/></body></html>"#;
        let out = sanitize_and_rewrite(
            html,
            "OEBPS/text",
            &map(),
            "/api/v1/publications/1/resource",
        );
        assert!(out.contains(r#"src="/api/v1/publications/1/resource/0""#));
        assert!(out.contains(r#"href="/api/v1/publications/1/resource/1""#));
    }

    #[test]
    fn leaves_external_and_fragment_urls() {
        let html = r##"<a href="#note">n</a><img src="https://x/y.png"/><img src="data:image/png;base64,aa"/>"##;
        let out = sanitize_and_rewrite(html, "OEBPS/text", &map(), "/resource");
        assert!(out.contains(r##"href="#note""##));
        assert!(out.contains(r#"src="https://x/y.png""#));
        assert!(out.contains(r#"src="data:image/png;base64,aa""#));
    }

    #[test]
    fn strips_active_content() {
        let html = r#"<p onclick="evil()">x</p><script>alert(1)</script><iframe src="https://evil"></iframe>"#;
        let out = sanitize_and_rewrite(html, "", &HashMap::new(), "/resource");
        assert!(!out.contains("<script"));
        assert!(!out.contains("<iframe"));
        assert!(!out.contains("onclick"));
        assert!(out.contains("<p>x</p>"));
    }

    #[test]
    fn neutralizes_dangerous_urls() {
        let html = "<a href=\"java\nscript:alert(1)\">x</a><img src=\"data:text/html,<script>x</script>\"><a href=\"file:///etc/passwd\">f</a>";
        let out = sanitize_and_rewrite(html, "", &HashMap::new(), "/resource");
        assert!(!out.to_ascii_lowercase().contains("javascript:"));
        assert!(!out.to_ascii_lowercase().contains("data:text/html"));
        assert!(!out.to_ascii_lowercase().contains("file:"));
        assert_eq!(out.matches("href=\"#\"").count(), 2);
    }

    #[test]
    fn strips_forms_metadata_and_dangerous_srcsets() {
        let html = r#"<meta http-equiv="refresh" content="0;url=https://evil"><base href="https://evil/"><form action="https://evil"><input></form><img srcset="filesystem:secret 1x, ../ok.png 2x"><img src=javascript:alert(1)><svg><use xlink:href="javascript:alert(1)"/></svg>"#;
        let out = sanitize_and_rewrite(html, "OEBPS/text", &map(), "/resource");
        assert!(!out.to_ascii_lowercase().contains("<meta"));
        assert!(!out.to_ascii_lowercase().contains("<base"));
        assert!(!out.to_ascii_lowercase().contains("<form"));
        assert!(!out.to_ascii_lowercase().contains("filesystem:"));
        assert!(!out.to_ascii_lowercase().contains("javascript:"));
    }
}
