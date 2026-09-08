use std::path::Path;

#[test]
fn real_drm_free_mobi_has_metadata_and_readable_text() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/alice.mobi");
    let book = moth_format::ParsedBook::parse(&path).expect("Gutenberg MOBI should parse");
    assert!(book.title.contains("Alice"), "{}", book.title);
    assert!(!book.chapters.is_empty());
    let text = book
        .chapters
        .iter()
        .map(|chapter| chapter.content.as_str())
        .collect::<String>();
    assert!(text.contains("Rabbit"));
    assert!(text.contains("Pool of Tears"));
}
