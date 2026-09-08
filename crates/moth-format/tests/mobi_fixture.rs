use std::path::Path;

#[test]
fn real_drm_free_mobi_has_metadata_and_readable_text() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/alice.mobi");
    let metadata = moth_format::mobi::parse_metadata(&path).expect("Gutenberg MOBI metadata");
    assert!(metadata.title.contains("Alice"), "{}", metadata.title);
    let book = mobi::Mobi::from_path(&path).expect("Gutenberg MOBI should parse");
    let text = book.content_as_string_lossy();
    assert!(text.contains("Rabbit"));
    assert!(text.contains("Pool of Tears"));
}
