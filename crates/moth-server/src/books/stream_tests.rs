use super::*;
use tokio::sync::Semaphore;
use tokio_stream::StreamExt;

fn zip_fixture(path: &Path, entries: &[(&str, &[u8])]) {
    let file = std::fs::File::create(path).unwrap();
    let mut zip = ZipWriter::new(file);
    for (name, bytes) in entries {
        zip.start_file(*name, SimpleFileOptions::default()).unwrap();
        zip.write_all(bytes).unwrap();
    }
    zip.finish().unwrap();
}

fn png(width: u32, height: u32) -> Vec<u8> {
    let mut bytes = Cursor::new(Vec::new());
    image::DynamicImage::new_rgba8(width, height)
        .write_to(&mut bytes, image::ImageFormat::Png)
        .unwrap();
    bytes.into_inner()
}

#[tokio::test]
async fn ranges_preserve_headers_and_exact_bytes() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("file");
    std::fs::write(&path, b"0123456789").unwrap();
    for (range, status, expected, content_range) in [
        (None, 200, "0123456789", None),
        (Some("bytes=2-4"), 206, "234", Some("bytes 2-4/10")),
        (Some("bytes=7-"), 206, "789", Some("bytes 7-9/10")),
        (Some("bytes=-3"), 206, "789", Some("bytes 7-9/10")),
        (Some("bytes=-100"), 206, "0123456789", Some("bytes 0-9/10")),
        (Some("bytes=8-100"), 206, "89", Some("bytes 8-9/10")),
        (Some("bytes=10-"), 416, "", Some("bytes */10")),
        (Some("bytes=6-4"), 416, "", Some("bytes */10")),
        (Some("bytes=-0"), 416, "", Some("bytes */10")),
        (Some("invalid"), 416, "", Some("bytes */10")),
    ] {
        let mut headers = HeaderMap::new();
        if let Some(range) = range {
            headers.insert(header::RANGE, range.parse().unwrap());
        }
        let response = range_response(&path, &headers, "application/epub+zip", "\"version\"")
            .await
            .unwrap();
        assert_eq!(response.status().as_u16(), status);
        assert_eq!(response.headers()[header::ETAG], "\"version\"");
        assert_eq!(response.headers()[header::ACCEPT_RANGES], "bytes");
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-cache");
        assert_eq!(
            response
                .headers()
                .get(header::CONTENT_RANGE)
                .map(|v| v.to_str().unwrap()),
            content_range
        );
        if status != 416 {
            assert_eq!(
                response.headers()[header::CONTENT_LENGTH],
                expected.len().to_string()
            );
        }
        assert_eq!(
            axum::body::to_bytes(response.into_body(), 100)
                .await
                .unwrap()
                .as_ref(),
            expected.as_bytes()
        );
    }
    std::fs::write(&path, []).unwrap();
    let response = range_response(&path, &HeaderMap::new(), "application/epub+zip", "v")
        .await
        .unwrap();
    assert_eq!(response.headers()[header::CONTENT_LENGTH], "0");
    assert!(
        axum::body::to_bytes(response.into_body(), 1)
            .await
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn cbz_stream_is_bounded_and_disconnect_releases_its_permit() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("book.cbz");
    let raw = vec![42_u8; 4 * 1024 * 1024];
    zip_fixture(&source, &[("page", &raw)]);
    let slots = Arc::new(Semaphore::new(1));
    let (size, mut stream) = cbz_page_stream(source.clone(), "page".into(), slots.clone())
        .await
        .unwrap();
    assert_eq!(size, raw.len() as u64);
    let first = stream.next().await.unwrap().unwrap();
    assert!(first.len() <= PAGE_STREAM_CHUNK);
    assert_eq!(slots.available_permits(), 0);
    // Let the producer fill its queue, without consuming the remaining body.
    tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    assert!(stream.as_ref().len() <= PAGE_STREAM_BUFFER);
    assert_eq!(slots.available_permits(), 0);
    drop(stream);
    let permit = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        slots.clone().acquire_owned(),
    )
    .await
    .unwrap()
    .unwrap();
    drop(permit);

    let (_, mut stream) = cbz_page_stream(source.clone(), "page".into(), slots.clone())
        .await
        .unwrap();
    let mut received = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.unwrap();
        assert!(chunk.len() <= PAGE_STREAM_CHUNK);
        received.extend_from_slice(&chunk);
    }
    assert_eq!(received, raw);
    assert!(
        cbz_page_stream(source, "missing".into(), slots.clone())
            .await
            .is_err()
    );
    assert_eq!(slots.available_permits(), 1);
}

#[tokio::test]
async fn dimensions_cache_hits_rebuilds_and_invalidates_by_content_version() {
    let temp = tempfile::tempdir().unwrap();
    let db = sqlx::sqlite::SqlitePoolOptions::new()
        .connect_lazy("sqlite::memory:")
        .unwrap();
    let state = AppState::new(crate::config::Config::for_test(temp.path().into()), db);
    assert_eq!(state.image_tasks.available_permits(), 1);
    let source = temp.path().join("book.cbz");
    let mut raw = png(31, 47);
    // A >1 MiB entry must still yield dimensions from its bounded header.
    raw.resize(2 * 1024 * 1024, 0);
    zip_fixture(&source, &[("page", &raw), ("broken", b"not an image")]);
    let pages = ["page", "broken"].map(|name| PageInfo {
        idx: 0,
        path: name.into(),
        mime: "image/png".into(),
        width: None,
        height: None,
    });
    let expected = vec![Some((31, 47)), None];
    assert_eq!(
        page_dimensions(&state, "original", source.clone(), &pages)
            .await
            .unwrap(),
        expected
    );
    // Removing the source proves a cache hit, rather than another successful read.
    std::fs::remove_file(&source).unwrap();
    assert_eq!(
        page_dimensions(&state, "original", source.clone(), &pages)
            .await
            .unwrap(),
        expected
    );
    assert!(
        page_dimensions(&state, "changed", source.clone(), &pages)
            .await
            .is_err()
    );
    zip_fixture(&source, &[("page", &png(19, 23)), ("broken", b"broken")]);
    for corrupt in ["broken JSON", "[]", "[[0,4],null]"] {
        std::fs::write(state.page_dimensions_path("original"), corrupt).unwrap();
        assert_eq!(
            page_dimensions(&state, "original", source.clone(), &pages)
                .await
                .unwrap(),
            vec![Some((19, 23)), None]
        );
    }
    assert_eq!(
        page_dimensions(&state, "changed", source, &pages)
            .await
            .unwrap(),
        vec![Some((19, 23)), None]
    );
}

#[tokio::test]
async fn thumbnails_recheck_cache_after_waiting_and_accept_rgba() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("book.cbz");
    zip_fixture(&source, &[("page", &png(300, 450))]);
    let target = temp.path().join("thumbnails/0.jpg");
    let slots = Arc::new(Semaphore::new(1));
    let (first, second) = tokio::join!(
        ensure_page_thumbnail(slots.clone(), source, "page".into(), target.clone()),
        ensure_page_thumbnail(
            slots.clone(),
            temp.path().join("missing"),
            "page".into(),
            target.clone()
        ),
    );
    first.unwrap();
    second.unwrap();
    let result = image::open(&target).unwrap();
    assert_eq!((result.width(), result.height()), (160, 240));
    assert_eq!(slots.available_permits(), 1);
    assert_eq!(
        std::fs::read_dir(target.parent().unwrap()).unwrap().count(),
        1
    );
}

#[tokio::test]
async fn oversized_and_corrupt_pages_have_placeholders_but_original_streams_remain_readable() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("book.cbz");
    let huge = vec![0_u8; IMAGE_MAX_BYTES + 1];
    let dimensions = png(IMAGE_MAX_DIMENSION + 1, 1);
    let pixels = png(4001, 4000);
    zip_fixture(
        &source,
        &[
            ("large", &huge),
            ("dimensions", &dimensions),
            ("pixels", &pixels),
            ("corrupt", b"bad image"),
        ],
    );
    let slots = Arc::new(Semaphore::new(1));
    for entry in ["large", "dimensions", "pixels", "corrupt"] {
        let target = temp.path().join(format!("{entry}.jpg"));
        ensure_page_thumbnail(slots.clone(), source.clone(), entry.into(), target.clone())
            .await
            .unwrap();
        let result = image::open(target).unwrap();
        assert_eq!((result.width(), result.height()), (2, 2));
    }
    let (size, mut stream) = cbz_page_stream(source, "large".into(), slots)
        .await
        .unwrap();
    assert_eq!(size, huge.len() as u64);
    let mut count = 0;
    while let Some(chunk) = stream.next().await {
        count += chunk.unwrap().len();
    }
    assert_eq!(count, huge.len());
}
