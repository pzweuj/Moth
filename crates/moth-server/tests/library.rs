//! Library scan + book API integration tests. Fixture books (TXT, CBZ, EPUB,
//! and a corrupt MOBI) are generated in a temporary directory so the whole
//! pipeline is exercised end to end without external assets.

use std::io::Write;
use std::path::Path;

use axum::body::Body;
use axum::http::{Method, Request, StatusCode, header};
use http_body_util::BodyExt;
use moth_server::{config::Config, db, router};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
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

fn write_gbk_txt(path: &Path) {
    // "第一章 出发\n\n编码测试\n\n第二章 路上\n\n正确解码。\n" GBK-encoded.
    let bytes = [
        0xB5, 0xDA, 0xD2, 0xBB, 0xD5, 0xC2, 0x20, 0xB3, 0xF6, 0xB7, 0xA2, 0x0A, 0x0A, 0xB1, 0xE0,
        0xC2, 0xEB, 0xB2, 0xE2, 0xCA, 0xD4, 0x0A, 0x0A, 0xB5, 0xDA, 0xB6, 0xFE, 0xD5, 0xC2, 0x20,
        0xC2, 0xB7, 0xC9, 0xCF, 0x0A, 0x0A, 0xD5, 0xFD, 0xC8, 0xB7, 0xBD, 0xE2, 0xC2, 0xEB, 0xA1,
        0xA3, 0x0A,
    ];
    std::fs::write(path, bytes).expect("write gbk txt");
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
async fn library_scan_requires_login() {
    let (_temp, app) = build_app().await;
    let response = app
        .clone()
        .oneshot(json_request(Method::POST, "/api/v1/library/scan", ""))
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn txt_chapter_supports_manual_encoding_override() {
    let temp = tempfile::tempdir().expect("temp dir");
    let books = temp.path().join("books");
    std::fs::create_dir_all(&books).expect("books dir");
    write_gbk_txt(&books.join("legacy.txt"));

    let mut config = Config::for_test(temp.path().join("data"));
    config.books_dir = books;
    let pool = db::connect(&config).await.expect("database");
    let app = router(moth_server::state::AppState::new(config, pool));
    let cookie = setup_and_login(&app).await;
    run_scan(&app, &cookie).await;

    let books = list_books(&app, &cookie).await;
    let txt = find_book(&books, "txt");
    let id = txt["id"].as_i64().expect("id");

    // Without an override the auto-detected chapters are served as stored.
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
    assert_eq!(chapter.status(), StatusCode::OK);

    // With ?encoding=gb18030 the chapter is re-decoded from the original file.
    let chapter = app
        .clone()
        .oneshot(authed_request(
            Method::GET,
            &format!("/api/v1/books/{id}/chapter/0?encoding=gb18030"),
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
            .contains("编码测试")
    );

    // The detail endpoint uses the same decoder, so its TOC stays aligned
    // with the manually decoded chapter responses.
    let detail = app
        .clone()
        .oneshot(authed_request(
            Method::GET,
            &format!("/api/v1/books/{id}?encoding=gb18030"),
            &cookie,
            "",
        ))
        .await
        .expect("detail");
    let detail = response_json(detail).await;
    assert_eq!(detail["chapters"][0]["title"], "第一章 出发");

    let manifest = app
        .clone()
        .oneshot(authed_request(
            Method::GET,
            &format!("/api/v1/books/{id}/offline-manifest?encoding=gb18030"),
            &cookie,
            "",
        ))
        .await
        .expect("encoded offline manifest");
    let manifest = response_json(manifest).await;
    assert_eq!(manifest["encoding"], "gb18030");
    assert_eq!(manifest["parser_version"], "txt-v1");

    let invalid = app
        .clone()
        .oneshot(authed_request(
            Method::GET,
            &format!("/api/v1/books/{id}?encoding=latin1"),
            &cookie,
            "",
        ))
        .await
        .expect("invalid encoding");
    assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);
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
    assert_eq!(saved["encoding"], "auto");

    // The shelf reflects the progress.
    let books = list_books(&app, &cookie).await;
    assert_eq!(find_book(&books, "txt")["percent"], 42.5);
}

#[tokio::test]
async fn progress_sync_is_idempotent_and_keeps_the_farthest_position() {
    let (_temp, app) = build_app().await;
    let cookie = setup_and_login(&app).await;
    run_scan(&app, &cookie).await;
    let books = list_books(&app, &cookie).await;
    let id = find_book(&books, "txt")["id"].as_i64().expect("id");
    let version = find_book(&books, "txt")["content_version"]
        .as_str()
        .expect("content version");

    let first = serde_json::json!({
        "chapter_index": 0,
        "page_index": 1,
        "percent": 20.0,
        "content_version": version,
        "base_revision": 0,
        "operation_id": "device-a-1"
    });
    let response = app
        .clone()
        .oneshot(authed_request(
            Method::POST,
            &format!("/api/v1/books/{id}/progress/sync"),
            &cookie,
            &first.to_string(),
        ))
        .await
        .expect("first sync");
    assert_eq!(response.status(), StatusCode::OK);
    let saved = response_json(response).await;
    assert_eq!(saved["revision"], 1);

    // A retry of the same operation does not advance the revision again.
    let response = app
        .clone()
        .oneshot(authed_request(
            Method::POST,
            &format!("/api/v1/books/{id}/progress/sync"),
            &cookie,
            &first.to_string(),
        ))
        .await
        .expect("idempotent retry");
    let saved = response_json(response).await;
    assert_eq!(saved["revision"], 1);

    // A stale, lower position loses to the current 20% position.
    let stale = serde_json::json!({
        "chapter_index": 0,
        "page_index": 0,
        "percent": 5.0,
        "content_version": version,
        "base_revision": 0,
        "operation_id": "device-b-1"
    });
    let response = app
        .clone()
        .oneshot(authed_request(
            Method::POST,
            &format!("/api/v1/books/{id}/progress/sync"),
            &cookie,
            &stale.to_string(),
        ))
        .await
        .expect("stale sync");
    let saved = response_json(response).await;
    assert_eq!(saved["conflict"], true);
    assert_eq!(saved["progress"]["percent"], 20.0);

    // A retry of the first operation after a newer write reports the current
    // revision and position, rather than moving the client back to revision 1.
    let newer = serde_json::json!({
        "chapter_index": 1,
        "page_index": 2,
        "percent": 45.0,
        "content_version": version,
        "base_revision": 1,
        "operation_id": "device-c-1"
    });
    let response = app
        .clone()
        .oneshot(authed_request(
            Method::POST,
            &format!("/api/v1/books/{id}/progress/sync"),
            &cookie,
            &newer.to_string(),
        ))
        .await
        .expect("newer sync");
    let saved = response_json(response).await;
    assert_eq!(saved["revision"], 3);

    let response = app
        .clone()
        .oneshot(authed_request(
            Method::POST,
            &format!("/api/v1/books/{id}/progress/sync"),
            &cookie,
            &first.to_string(),
        ))
        .await
        .expect("historical retry");
    let saved = response_json(response).await;
    assert_eq!(saved["revision"], 3);
    assert_eq!(saved["progress"]["percent"], 45.0);
}

#[tokio::test]
async fn progress_sync_does_not_compare_different_txt_encodings() {
    let (temp, app) = build_app().await;
    let cookie = setup_and_login(&app).await;
    run_scan(&app, &cookie).await;
    let books = list_books(&app, &cookie).await;
    let txt = find_book(&books, "txt");
    let id = txt["id"].as_i64().expect("id");
    let version = txt["content_version"].as_str().expect("content version");

    let auto = serde_json::json!({
        "chapter_index": 1,
        "page_index": 4,
        "percent": 80.0,
        "content_version": version,
        "base_revision": 0,
        "operation_id": "encoding-auto"
    });
    let response = app
        .clone()
        .oneshot(authed_request(
            Method::POST,
            &format!("/api/v1/books/{id}/progress/sync"),
            &cookie,
            &auto.to_string(),
        ))
        .await
        .expect("auto sync");
    let saved = response_json(response).await;
    assert_eq!(saved["progress"]["encoding"], "auto");
    assert_eq!(saved["revision"], 1);

    // A lower position in another decoded representation starts a separate
    // stream; it must not lose by comparing itself with the auto position.
    let explicit = serde_json::json!({
        "chapter_index": 0,
        "page_index": 1,
        "percent": 10.0,
        "content_version": version,
        "base_revision": 1,
        "operation_id": "encoding-gbk",
        "encoding": "GB18030"
    });
    let response = app
        .clone()
        .oneshot(authed_request(
            Method::POST,
            &format!("/api/v1/books/{id}/progress/sync"),
            &cookie,
            &explicit.to_string(),
        ))
        .await
        .expect("explicit sync");
    let saved = response_json(response).await;
    assert_eq!(saved["conflict"], false);
    assert_eq!(saved["progress"]["percent"], 10.0);
    assert_eq!(saved["progress"]["encoding"], "gb18030");
    assert_eq!(saved["revision"], 2);

    // Once the encoding is the same, the normal stale-write rule applies.
    let stale = serde_json::json!({
        "chapter_index": 0,
        "page_index": 0,
        "percent": 5.0,
        "content_version": version,
        "base_revision": 1,
        "operation_id": "encoding-gbk-stale",
        "encoding": "gb18030"
    });
    let response = app
        .clone()
        .oneshot(authed_request(
            Method::POST,
            &format!("/api/v1/books/{id}/progress/sync"),
            &cookie,
            &stale.to_string(),
        ))
        .await
        .expect("stale explicit sync");
    let saved = response_json(response).await;
    assert_eq!(saved["conflict"], true);
    assert_eq!(saved["progress"]["percent"], 10.0);
    assert_eq!(saved["progress"]["encoding"], "gb18030");

    // Simulate a row written before the encoding migration. NULL is treated as
    // the scan-selected auto decoder, so an auto operation can still merge.
    let database_path = temp.path().join("data").join("moth.db");
    let pool = SqlitePoolOptions::new()
        .connect_with(SqliteConnectOptions::new().filename(database_path))
        .await
        .expect("open test database");
    sqlx::query("UPDATE reading_progress SET encoding = NULL WHERE book_id = ?")
        .bind(id)
        .execute(&pool)
        .await
        .expect("clear encoding");
    pool.close().await;

    let legacy_auto = serde_json::json!({
        "chapter_index": 1,
        "page_index": 5,
        "percent": 20.0,
        "content_version": version,
        "base_revision": 3,
        "operation_id": "encoding-legacy-auto"
    });
    let response = app
        .oneshot(authed_request(
            Method::POST,
            &format!("/api/v1/books/{id}/progress/sync"),
            &cookie,
            &legacy_auto.to_string(),
        ))
        .await
        .expect("legacy auto sync");
    let saved = response_json(response).await;
    assert_eq!(saved["conflict"], false);
    assert_eq!(saved["progress"]["encoding"], "auto");
    assert_eq!(saved["progress"]["percent"], 20.0);
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
    assert_eq!(
        resource.headers()["x-moth-resource-path"],
        "OEBPS/Images/cover.png"
    );
    let version = epub["content_version"].as_str().expect("version");
    assert_eq!(
        resource.headers()[header::ETAG].to_str().expect("etag"),
        format!("\"{version}\"")
    );

    let stale_resource = Request::builder()
        .method(Method::GET)
        .uri(format!("/api/v1/books/{id}/resource/0"))
        .header(header::COOKIE, &cookie)
        .header(header::IF_MATCH, "\"stale-version\"")
        .body(Body::empty())
        .expect("stale resource request");
    let stale_resource = app
        .clone()
        .oneshot(stale_resource)
        .await
        .expect("stale resource response");
    assert_eq!(stale_resource.status(), StatusCode::PRECONDITION_FAILED);

    let manifest = app
        .clone()
        .oneshot(authed_request(
            Method::GET,
            &format!("/api/v1/books/{id}/offline-manifest"),
            &cookie,
            "",
        ))
        .await
        .expect("offline manifest");
    let manifest = response_json(manifest).await;
    assert_eq!(manifest["content_version"], epub["content_version"]);
    assert_eq!(manifest["parser_version"], serde_json::Value::Null);
    assert_eq!(manifest["file_url"], format!("/api/v1/books/{id}/file"));
    assert_eq!(
        manifest["resource_urls"]
            .as_array()
            .expect("resources")
            .len(),
        2
    );
}

#[tokio::test]
async fn cbz_pages_are_served_from_the_archive() {
    let (_temp, app) = build_app().await;
    let cookie = setup_and_login(&app).await;
    run_scan(&app, &cookie).await;

    let books = list_books(&app, &cookie).await;
    let cbz = find_book(&books, "cbz");
    let id = cbz["id"].as_i64().expect("id");

    let detail = app
        .clone()
        .oneshot(authed_request(
            Method::GET,
            &format!("/api/v1/books/{id}"),
            &cookie,
            "",
        ))
        .await
        .expect("cbz detail");
    let detail = response_json(detail).await;
    assert_eq!(
        detail["pages"],
        serde_json::json!(["page_1.png", "page_2.png", "page_10.png"])
    );

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

    let version = cbz["content_version"].as_str().expect("version");
    let stale_page = Request::builder()
        .method(Method::GET)
        .uri(format!("/api/v1/books/{id}/page/0"))
        .header(header::COOKIE, &cookie)
        .header(header::IF_MATCH, "\"stale-version\"")
        .body(Body::empty())
        .expect("stale page request");
    let stale_page = app
        .clone()
        .oneshot(stale_page)
        .await
        .expect("stale page response");
    assert_eq!(stale_page.status(), StatusCode::PRECONDITION_FAILED);

    let page = Request::builder()
        .method(Method::GET)
        .uri(format!("/api/v1/books/{id}/page/0"))
        .header(header::COOKIE, &cookie)
        .header(header::IF_MATCH, format!("\"{version}\""))
        .body(Body::empty())
        .expect("matching page request");
    let page = app.oneshot(page).await.expect("matching page response");
    assert_eq!(page.status(), StatusCode::OK);
    assert_eq!(
        page.headers()[header::ETAG].to_str().expect("etag"),
        format!("\"{version}\"")
    );
}

#[tokio::test]
async fn raw_file_endpoint_supports_byte_ranges() {
    let (_temp, app) = build_app().await;
    let cookie = setup_and_login(&app).await;
    run_scan(&app, &cookie).await;

    let books = list_books(&app, &cookie).await;
    let epub = find_book(&books, "epub");
    let id = epub["id"].as_i64().expect("id");
    let full = std::fs::read(_temp.path().join("books/fixture.epub")).expect("epub file");
    let size = full.len();

    // No Range header: full 200 response, advertises byte ranges.
    let response = app
        .clone()
        .oneshot(authed_request(
            Method::GET,
            &format!("/api/v1/books/{id}/file"),
            &cookie,
            "",
        ))
        .await
        .expect("full file");
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers()[header::CONTENT_TYPE],
        "application/epub+zip"
    );
    assert_eq!(response.headers()[header::ACCEPT_RANGES], "bytes");
    let etag = response.headers()[header::ETAG]
        .to_str()
        .expect("etag")
        .to_owned();
    let body = response
        .into_body()
        .collect()
        .await
        .expect("body")
        .to_bytes();
    assert_eq!(body.as_ref(), full.as_slice());

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::GET)
                .uri(format!("/api/v1/books/{id}/file"))
                .header(header::COOKIE, &cookie)
                .header(header::IF_NONE_MATCH, etag)
                .body(Body::empty())
                .expect("conditional request"),
        )
        .await
        .expect("conditional response");
    assert_eq!(response.status(), StatusCode::NOT_MODIFIED);

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::GET)
                .uri(format!("/api/v1/books/{id}/file"))
                .header(header::COOKIE, &cookie)
                .header(header::IF_MATCH, "\"stale-version\"")
                .body(Body::empty())
                .expect("precondition request"),
        )
        .await
        .expect("precondition response");
    assert_eq!(response.status(), StatusCode::PRECONDITION_FAILED);

    // A closed range returns 206 with the exact slice.
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::GET)
                .uri(format!("/api/v1/books/{id}/file"))
                .header(header::COOKIE, &cookie)
                .header(header::RANGE, "bytes=0-3")
                .body(Body::empty())
                .expect("ranged request"),
        )
        .await
        .expect("ranged");
    assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(
        response.headers()[header::CONTENT_RANGE],
        format!("bytes 0-3/{size}")
    );
    assert_eq!(response.headers()[header::CONTENT_LENGTH], "4".to_owned());
    let body = response
        .into_body()
        .collect()
        .await
        .expect("body")
        .to_bytes();
    assert_eq!(body.as_ref(), &full[0..4]);

    // A suffix range returns the last N bytes.
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::GET)
                .uri(format!("/api/v1/books/{id}/file"))
                .header(header::COOKIE, &cookie)
                .header(header::RANGE, "bytes=-4")
                .body(Body::empty())
                .expect("suffix request"),
        )
        .await
        .expect("suffix");
    assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(
        response.headers()[header::CONTENT_RANGE],
        format!("bytes {}-{}/{}", size - 4, size - 1, size)
    );
    let body = response
        .into_body()
        .collect()
        .await
        .expect("body")
        .to_bytes();
    assert_eq!(body.as_ref(), &full[size - 4..]);

    // An unsatisfiable range returns 416 with the total size.
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::GET)
                .uri(format!("/api/v1/books/{id}/file"))
                .header(header::COOKIE, &cookie)
                .header(header::RANGE, "bytes=999999-")
                .body(Body::empty())
                .expect("bad range request"),
        )
        .await
        .expect("bad range");
    assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE);
    assert_eq!(
        response.headers()[header::CONTENT_RANGE],
        format!("bytes */{size}")
    );

    // The endpoint requires login.
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::GET)
                .uri(format!("/api/v1/books/{id}/file"))
                .body(Body::empty())
                .expect("unauthenticated request"),
        )
        .await
        .expect("unauthenticated");
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}
