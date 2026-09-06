//! Library scan + book API integration tests. Fixture books (TXT, CBZ, EPUB,
//! and a corrupt MOBI) are generated in a temporary directory so the whole
//! pipeline is exercised end to end without external assets.

use std::io::Write;
use std::path::Path;

use axum::body::Body;
use axum::http::{Method, Request, StatusCode, header};
use http_body_util::BodyExt;
use moth_server::{config::Config, db, router};
use tempfile::TempDir;
use tower::ServiceExt;

fn png_bytes(r: u8, g: u8, b: u8) -> Vec<u8> {
    let image = image::RgbImage::from_pixel(60, 90, image::Rgb([r, g, b]));
    let mut bytes = Vec::new();
    image
        .write_to(
            &mut std::io::Cursor::new(&mut bytes),
            image::ImageFormat::Png,
        )
        .expect("encode png");
    bytes
}

fn write_txt(dir: &Path) {
    let content = "第一章 启程\n\n天亮了,我们出发。\n\n第二章 路上\n\n他们继续走,一路无言。\n";
    std::fs::write(dir.join("novel.txt"), content).expect("write txt");
}

fn write_cbz(path: &Path) {
    let file = std::fs::File::create(path).expect("create cbz");
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default();
    for (name, color) in [
        ("page_1.png", (200, 30, 30)),
        ("page_2.png", (30, 200, 30)),
        ("page_10.png", (30, 30, 200)),
    ] {
        zip.start_file(name, options).expect("cbz entry");
        zip.write_all(&png_bytes(color.0, color.1, color.2))
            .expect("cbz page");
    }
    zip.finish().expect("finish cbz");
}

fn write_epub(path: &Path) {
    let file = std::fs::File::create(path).expect("create epub");
    let mut zip = zip::ZipWriter::new(file);
    let stored =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    let deflated = zip::write::SimpleFileOptions::default();

    zip.start_file("mimetype", stored).expect("mimetype");
    zip.write_all(b"application/epub+zip").expect("mimetype");
    zip.start_file("META-INF/container.xml", deflated)
        .expect("container");
    zip.write_all(
        br#"<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>"#,
    )
    .expect("container");
    zip.start_file("OEBPS/content.opf", deflated).expect("opf");
    zip.write_all(
        br#"<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>The Fixture Novel</dc:title>
    <dc:creator>Moth Author</dc:creator>
    <meta name="cover" content="cover-img"/>
  </metadata>
  <manifest>
    <item id="cover-img" href="Images/cover.png" media-type="image/png"/>
    <item id="css" href="css/main.css" media-type="text/css"/>
    <item id="ch1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
  </spine>
</package>"#,
    )
    .expect("opf");
    zip.start_file("OEBPS/text/ch1.xhtml", deflated)
        .expect("ch1");
    zip.write_all(
        br#"<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Chapter One</title><link rel="stylesheet" href="../css/main.css"/></head>
<body><h1>Chapter One</h1><p>The adventure begins.</p><img src="../Images/cover.png" alt="cover"/></body>
</html>"#,
    )
    .expect("ch1");
    zip.start_file("OEBPS/text/ch2.xhtml", deflated)
        .expect("ch2");
    zip.write_all(
        br#"<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Chapter Two</title></head>
<body><h1>Chapter Two</h1><p>And then it continued.</p></body>
</html>"#,
    )
    .expect("ch2");
    zip.start_file("OEBPS/nav.xhtml", deflated).expect("nav");
    zip.write_all(
        br#"<html xmlns="http://www.w3.org/1999/xhtml"><body><nav><a href="text/ch1.xhtml">1</a></nav></body></html>"#,
    )
    .expect("nav");
    zip.start_file("OEBPS/Images/cover.png", deflated)
        .expect("cover img");
    zip.write_all(&png_bytes(40, 40, 180)).expect("cover img");
    zip.start_file("OEBPS/css/main.css", deflated).expect("css");
    zip.write_all(b"body { font-family: serif; }").expect("css");
    zip.finish().expect("finish epub");
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

fn json_request(method: Method, uri: &str, body: &str) -> Request<Body> {
    Request::builder()
        .method(method)
        .uri(uri)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_owned()))
        .expect("request")
}

fn authed_request(method: Method, uri: &str, cookie: &str, body: &str) -> Request<Body> {
    Request::builder()
        .method(method)
        .uri(uri)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::COOKIE, cookie)
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

async fn build_app() -> (TempDir, axum::Router) {
    let temp = tempfile::tempdir().expect("temp dir");
    let books = temp.path().join("books");
    std::fs::create_dir_all(&books).expect("books dir");
    write_txt(&books);
    write_cbz(&books.join("comic.cbz"));
    write_epub(&books.join("fixture.epub"));
    std::fs::write(books.join("broken.mobi"), vec![0_u8; 64]).expect("broken mobi");

    let mut config = Config::for_test(temp.path().join("data"));
    config.books_dir = books;
    let pool = db::connect(&config).await.expect("database");
    (
        temp,
        router(moth_server::state::AppState::new(config, pool)),
    )
}

async fn setup_and_login(app: &axum::Router) -> String {
    let body = r#"{"username":"moth","password":"a secure password"}"#;
    let response = app
        .clone()
        .oneshot(json_request(Method::POST, "/api/v1/setup", body))
        .await
        .expect("setup");
    assert_eq!(response.status(), StatusCode::CREATED);

    let response = app
        .clone()
        .oneshot(json_request(Method::POST, "/api/v1/session", body))
        .await
        .expect("login");
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    let set_cookie = response
        .headers()
        .get(header::SET_COOKIE)
        .expect("session cookie")
        .to_str()
        .expect("cookie")
        .to_owned();
    set_cookie
        .split(';')
        .next()
        .expect("cookie pair")
        .to_owned()
}

async fn run_scan(app: &axum::Router, cookie: &str) {
    let response = app
        .clone()
        .oneshot(authed_request(
            Method::POST,
            "/api/v1/library/scan",
            cookie,
            "",
        ))
        .await
        .expect("scan");
    assert_eq!(response.status(), StatusCode::OK);

    for _ in 0..500 {
        let response = app
            .clone()
            .oneshot(authed_request(
                Method::GET,
                "/api/v1/library/scan/status",
                cookie,
                "",
            ))
            .await
            .expect("status");
        let json = response_json(response).await;
        if json["scanning"] == false {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    panic!("library scan did not finish");
}

async fn list_books(app: &axum::Router, cookie: &str) -> serde_json::Value {
    let response = app
        .clone()
        .oneshot(authed_request(Method::GET, "/api/v1/books", cookie, ""))
        .await
        .expect("list books");
    assert_eq!(response.status(), StatusCode::OK);
    response_json(response).await
}

fn find_book<'a>(books: &'a serde_json::Value, format: &str) -> &'a serde_json::Value {
    books
        .as_array()
        .expect("array")
        .iter()
        .find(|book| book["format"] == format)
        .unwrap_or_else(|| panic!("no {format} book in {books}"))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn scan_indexes_all_four_formats() {
    let (_temp, app) = build_app().await;
    let cookie = setup_and_login(&app).await;
    run_scan(&app, &cookie).await;

    let books = list_books(&app, &cookie).await;
    assert_eq!(books.as_array().expect("array").len(), 4);

    let txt = find_book(&books, "txt");
    assert_eq!(txt["title"], "第一章 启程");
    assert_eq!(txt["parse_status"], "ok");

    let cbz = find_book(&books, "cbz");
    assert_eq!(cbz["title"], "comic");
    assert_eq!(cbz["page_count"], 3);
    assert_eq!(cbz["has_cover"], true);

    let epub = find_book(&books, "epub");
    assert_eq!(epub["title"], "The Fixture Novel");
    assert_eq!(epub["author"], "Moth Author");
    assert_eq!(epub["has_cover"], true);

    let mobi = find_book(&books, "mobi");
    assert_eq!(mobi["parse_status"], "error");
}

#[tokio::test]
async fn book_api_requires_login() {
    let (_temp, app) = build_app().await;
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/books")
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn txt_chapters_and_progress_roundtrip() {
    let (_temp, app) = build_app().await;
    let cookie = setup_and_login(&app).await;
    run_scan(&app, &cookie).await;

    let books = list_books(&app, &cookie).await;
    let txt = find_book(&books, "txt");
    let id = txt["id"].as_i64().expect("id");

    let detail = app
        .clone()
        .oneshot(authed_request(
            Method::GET,
            &format!("/api/v1/books/{id}"),
            &cookie,
            "",
        ))
        .await
        .expect("detail");
    let detail = response_json(detail).await;
    let chapters = detail["chapters"].as_array().expect("chapters");
    assert_eq!(chapters.len(), 2);
    assert_eq!(chapters[0]["title"], "第一章 启程");

    let chapter = app
        .clone()
        .oneshot(authed_request(
            Method::GET,
            &format!("/api/v1/books/{id}/chapter/0"),
            &cookie,
            "",
        ))
        .await
        .expect("chapter");
    let chapter = response_json(chapter).await;
    assert!(
        chapter["content"]
            .as_str()
            .expect("content")
            .contains("天亮了")
    );
    assert!(
        chapter["content"]
            .as_str()
            .expect("content")
            .contains("<h2>")
    );

    let progress = r#"{"chapter_index":1,"page_index":3,"percent":42.5}"#;
    let response = app
        .clone()
        .oneshot(authed_request(
            Method::PUT,
            &format!("/api/v1/books/{id}/progress"),
            &cookie,
            progress,
        ))
        .await
        .expect("put progress");
    assert_eq!(response.status(), StatusCode::NO_CONTENT);

    let response = app
        .clone()
        .oneshot(authed_request(
            Method::GET,
            &format!("/api/v1/books/{id}/progress"),
            &cookie,
            "",
        ))
        .await
        .expect("get progress");
    let saved = response_json(response).await;
    assert_eq!(saved["chapter_index"], 1);
    assert_eq!(saved["page_index"], 3);
    assert_eq!(saved["percent"], 42.5);

    // The shelf reflects the progress.
    let books = list_books(&app, &cookie).await;
    assert_eq!(find_book(&books, "txt")["percent"], 42.5);
}

#[tokio::test]
async fn epub_chapters_rewrite_resources_and_serve_cover() {
    let (_temp, app) = build_app().await;
    let cookie = setup_and_login(&app).await;
    run_scan(&app, &cookie).await;

    let books = list_books(&app, &cookie).await;
    let epub = find_book(&books, "epub");
    let id = epub["id"].as_i64().expect("id");

    let chapter = app
        .clone()
        .oneshot(authed_request(
            Method::GET,
            &format!("/api/v1/books/{id}/chapter/0"),
            &cookie,
            "",
        ))
        .await
        .expect("chapter");
    let chapter = response_json(chapter).await;
    let content = chapter["content"].as_str().expect("content");
    assert!(content.contains(&format!("/api/v1/books/{id}/resource/0")));
    assert!(content.contains(&format!("/api/v1/books/{id}/resource/1")));
    assert!(!content.contains("<script"));

    let cover = app
        .clone()
        .oneshot(authed_request(
            Method::GET,
            &format!("/api/v1/books/{id}/cover"),
            &cookie,
            "",
        ))
        .await
        .expect("cover");
    assert_eq!(cover.status(), StatusCode::OK);
    assert_eq!(cover.headers()[header::CONTENT_TYPE], "image/jpeg");

    let resource = app
        .clone()
        .oneshot(authed_request(
            Method::GET,
            &format!("/api/v1/books/{id}/resource/0"),
            &cookie,
            "",
        ))
        .await
        .expect("resource");
    assert_eq!(resource.status(), StatusCode::OK);
    assert_eq!(resource.headers()[header::CONTENT_TYPE], "image/png");
}

#[tokio::test]
async fn cbz_pages_are_served_from_the_archive() {
    let (_temp, app) = build_app().await;
    let cookie = setup_and_login(&app).await;
    run_scan(&app, &cookie).await;

    let books = list_books(&app, &cookie).await;
    let cbz = find_book(&books, "cbz");
    let id = cbz["id"].as_i64().expect("id");

    for idx in 0..3 {
        let page = app
            .clone()
            .oneshot(authed_request(
                Method::GET,
                &format!("/api/v1/books/{id}/page/{idx}"),
                &cookie,
                "",
            ))
            .await
            .expect("page");
        assert_eq!(page.status(), StatusCode::OK, "page {idx}");
        assert_eq!(page.headers()[header::CONTENT_TYPE], "image/png");
        let bytes = page.into_body().collect().await.expect("body").to_bytes();
        assert!(!bytes.is_empty());
    }
}
