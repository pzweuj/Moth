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
    let archives = Arc::new(CbzArchiveCache::default());
    let (size, mut stream) = cbz_page_stream(
        source.clone(),
        "page".into(),
        slots.clone(),
        archives.clone(),
    )
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

    let (_, mut stream) = cbz_page_stream(
        source.clone(),
        "page".into(),
        slots.clone(),
        archives.clone(),
    )
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
        cbz_page_stream(source, "missing".into(), slots.clone(), archives)
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
    let archives = Arc::new(CbzArchiveCache::default());
    let (first, second) = tokio::join!(
        ensure_page_thumbnail(
            slots.clone(),
            archives.clone(),
            source,
            "page".into(),
            target.clone()
        ),
        ensure_page_thumbnail(
            slots.clone(),
            archives,
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
    let archives = Arc::new(CbzArchiveCache::default());
    for entry in ["large", "dimensions", "pixels", "corrupt"] {
        let target = temp.path().join(format!("{entry}.jpg"));
        ensure_page_thumbnail(
            slots.clone(),
            archives.clone(),
            source.clone(),
            entry.into(),
            target.clone(),
        )
        .await
        .unwrap();
        let result = image::open(target).unwrap();
        assert_eq!((result.width(), result.height()), (2, 2));
    }
    let (size, mut stream) = cbz_page_stream(source, "large".into(), slots, archives)
        .await
        .unwrap();
    assert_eq!(size, huge.len() as u64);
    let mut count = 0;
    while let Some(chunk) = stream.next().await {
        count += chunk.unwrap().len();
    }
    assert_eq!(count, huge.len());
}

#[tokio::test]
async fn cover_and_thumbnail_cache_headers_are_private_and_require_matching_version() {
    let temp = tempfile::tempdir().unwrap();
    let books = temp.path().join("books");
    let data = temp.path().join("data");
    std::fs::create_dir_all(&books).unwrap();
    let cbz_path = books.join("comic.cbz");
    zip_fixture(&cbz_path, &[("001.png", &png(320, 480))]);

    let mut config = crate::config::Config::for_test(data);
    config.books_dir = books;
    let pool = crate::db::connect(&config).await.unwrap();
    let state = AppState::new(config, pool);

    let meta = std::fs::metadata(&cbz_path).unwrap();
    let size = i64::try_from(meta.len()).unwrap();
    let mtime = meta
        .modified()
        .unwrap()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos() as i64;
    let hash = crate::library::hash_file(&cbz_path).unwrap();
    let version = content_version(&hash, "cbz", None);
    crate::state::write_cache(&state.cover_path(&version), b"fake-jpeg").unwrap();

    sqlx::query(
        "INSERT INTO directories (parent_id, name, relative_path, updated_at) VALUES (NULL, '书库', '', 1)",
    )
    .execute(&state.db)
    .await
    .unwrap();
    let dir_id: i64 = sqlx::query_scalar("SELECT id FROM directories WHERE relative_path=''")
        .fetch_one(&state.db)
        .await
        .unwrap();
    let pub_id: i64 = sqlx::query_scalar(
        "INSERT INTO publications (directory_id, relative_path, filename, format, title, file_size, mtime_ns, sha256, has_cover, parse_status, added_at, updated_at) VALUES (?, 'comic.cbz', 'comic.cbz', 'cbz', 'comic', ?, ?, ?, 1, 'ok', 1, 1) RETURNING id",
    )
    .bind(dir_id)
    .bind(size)
    .bind(mtime)
    .bind(&hash)
    .fetch_one(&state.db)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO cbz_pages (publication_id, idx, path, mime) VALUES (?, 0, '001.png', 'image/png')",
    )
    .bind(pub_id)
    .execute(&state.db)
    .await
    .unwrap();

    let user = Authenticated {
        session_hash: String::new(),
        username: "moth".to_owned(),
    };

    let cover_versioned = get_cover(
        State(state.clone()),
        Authenticated {
            session_hash: String::new(),
            username: user.username.clone(),
        },
        AxumPath(pub_id),
        Query(VersionQuery {
            v: Some(hash.clone()),
        }),
        HeaderMap::new(),
    )
    .await
    .unwrap();
    assert_eq!(
        cover_versioned.headers()[header::CACHE_CONTROL],
        "private, max-age=31536000, immutable"
    );
    let cover_etag = cover_versioned.headers()[header::ETAG]
        .to_str()
        .unwrap()
        .to_owned();
    let mut cover_inm = HeaderMap::new();
    cover_inm.insert(header::IF_NONE_MATCH, cover_etag.parse().unwrap());
    let cover_not_modified = get_cover(
        State(state.clone()),
        Authenticated {
            session_hash: String::new(),
            username: user.username.clone(),
        },
        AxumPath(pub_id),
        Query(VersionQuery {
            v: Some(hash.clone()),
        }),
        cover_inm,
    )
    .await
    .unwrap();
    assert_eq!(cover_not_modified.status(), StatusCode::NOT_MODIFIED);

    let cover_unversioned = get_cover(
        State(state.clone()),
        Authenticated {
            session_hash: String::new(),
            username: user.username.clone(),
        },
        AxumPath(pub_id),
        Query(VersionQuery::default()),
        HeaderMap::new(),
    )
    .await
    .unwrap();
    assert_eq!(
        cover_unversioned.headers()[header::CACHE_CONTROL],
        "private, no-cache"
    );

    let thumb_versioned = get_page_thumbnail(
        State(state.clone()),
        Authenticated {
            session_hash: String::new(),
            username: user.username.clone(),
        },
        AxumPath((pub_id, 0)),
        Query(VersionQuery {
            v: Some(version.clone()),
        }),
        HeaderMap::new(),
    )
    .await
    .unwrap();
    assert_eq!(
        thumb_versioned.headers()[header::CACHE_CONTROL],
        "private, max-age=31536000, immutable"
    );
    let thumb_etag = thumb_versioned.headers()[header::ETAG]
        .to_str()
        .unwrap()
        .to_owned();
    let mut thumb_inm = HeaderMap::new();
    thumb_inm.insert(
        header::IF_NONE_MATCH,
        format!("W/{thumb_etag}").parse().unwrap(),
    );
    let thumb_not_modified = get_page_thumbnail(
        State(state.clone()),
        Authenticated {
            session_hash: String::new(),
            username: user.username.clone(),
        },
        AxumPath((pub_id, 0)),
        Query(VersionQuery {
            v: Some(version.clone()),
        }),
        thumb_inm,
    )
    .await
    .unwrap();
    assert_eq!(thumb_not_modified.status(), StatusCode::NOT_MODIFIED);

    let thumb_stale = get_page_thumbnail(
        State(state.clone()),
        Authenticated {
            session_hash: String::new(),
            username: user.username.clone(),
        },
        AxumPath((pub_id, 0)),
        Query(VersionQuery {
            v: Some("stale-version".to_owned()),
        }),
        HeaderMap::new(),
    )
    .await
    .unwrap();
    assert_eq!(
        thumb_stale.headers()[header::CACHE_CONTROL],
        "private, no-cache"
    );

    let page_response = get_page(
        State(state.clone()),
        Authenticated {
            session_hash: String::new(),
            username: user.username.clone(),
        },
        AxumPath((pub_id, 0)),
        HeaderMap::new(),
    )
    .await
    .unwrap();
    assert_eq!(page_response.status(), StatusCode::OK);
    assert_eq!(
        page_response.headers()[header::CACHE_CONTROL],
        "private, no-cache"
    );
    let page_etag = page_response.headers()[header::ETAG]
        .to_str()
        .unwrap()
        .to_owned();
    let mut page_inm = HeaderMap::new();
    page_inm.insert(header::IF_NONE_MATCH, page_etag.parse().unwrap());
    let page_not_modified = get_page(State(state), user, AxumPath((pub_id, 0)), page_inm)
        .await
        .unwrap();
    assert_eq!(page_not_modified.status(), StatusCode::NOT_MODIFIED);
    assert_eq!(page_not_modified.headers()[header::ETAG], page_etag);
}

#[tokio::test]
async fn concurrent_txt_encoding_requests_share_one_rebuild() {
    let temp = tempfile::tempdir().unwrap();
    let books = temp.path().join("books");
    let data = temp.path().join("data");
    std::fs::create_dir_all(&books).unwrap();
    let txt_path = books.join("novel.txt");
    std::fs::write(&txt_path, "第一章 序\n正文内容\n\n第二章 终\n尾声内容").unwrap();

    let mut config = crate::config::Config::for_test(data);
    config.books_dir = books.clone();
    let pool = crate::db::connect(&config).await.unwrap();
    let state = AppState::new(config, pool);

    let meta = std::fs::metadata(&txt_path).unwrap();
    let size = i64::try_from(meta.len()).unwrap();
    let mtime = meta
        .modified()
        .unwrap()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos() as i64;
    let hash = crate::library::hash_file(&txt_path).unwrap();

    sqlx::query(
        "INSERT INTO directories (parent_id, name, relative_path, updated_at) VALUES (NULL, '书库', '', 1)",
    )
    .execute(&state.db)
    .await
    .unwrap();
    let dir_id: i64 = sqlx::query_scalar("SELECT id FROM directories WHERE relative_path=''")
        .fetch_one(&state.db)
        .await
        .unwrap();
    let pub_id: i64 = sqlx::query_scalar(
        "INSERT INTO publications (directory_id, relative_path, filename, format, title, file_size, mtime_ns, sha256, has_cover, parse_status, added_at, updated_at) VALUES (?, 'novel.txt', 'novel.txt', 'txt', 'novel', ?, ?, ?, 0, 'ok', 1, 1) RETURNING id",
    )
    .bind(dir_id)
    .bind(size)
    .bind(mtime)
    .bind(&hash)
    .fetch_one(&state.db)
    .await
    .unwrap();

    let row = publication_row(&state.db, &books, pub_id).await.unwrap();
    let (a, b) = tokio::join!(
        ensure_txt_encoding(&state, &row, "utf-8"),
        ensure_txt_encoding(&state, &row, "utf-8"),
    );
    a.unwrap();
    b.unwrap();
    assert_eq!(state.txt_tasks.available_permits(), 1);
    let chapter_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM text_chapters WHERE publication_id=? AND encoding='utf-8'",
    )
    .bind(pub_id)
    .fetch_one(&state.db)
    .await
    .unwrap();
    assert_eq!(chapter_count, 2);
}
