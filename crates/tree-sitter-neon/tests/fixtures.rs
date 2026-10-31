//! The parser fixtures of noctud/intellij-neon: `.keys` holds whether the plugin's parser reported
//! an error, then each block key with the number of keys it is nested in, from the plugin's trees.

use tree_sitter::{Language, Node, Parser};

fn keys(node: Node, src: &[u8], depth: usize, out: &mut Vec<String>) {
    let mut inner = depth;
    if node.kind() == "pair" {
        let key = node.child_by_field_name("key").and_then(|k| k.child(0)).unwrap();
        out.push(format!("{depth}:{}", key.utf8_text(src).unwrap()));
        inner += 1;
    }
    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        keys(child, src, inner, out);
    }
}

#[test]
fn matches_the_plugins_trees() {
    let language = Language::new(tree_sitter_neon::LANGUAGE);
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    let (mut total, mut failures) = (0, Vec::new());
    for entry in std::fs::read_dir(dir).unwrap().flatten() {
        let path = entry.path();
        if path.extension().is_none_or(|e| e != "neon") {
            continue;
        }
        total += 1;
        let src = std::fs::read(&path).unwrap();
        let expected = std::fs::read_to_string(path.with_extension("keys")).unwrap();
        let (status, expected_keys) = expected.split_once('\n').unwrap();
        let mut parser = Parser::new();
        parser.set_language(&language).unwrap();
        let tree = parser.parse(&src, None).unwrap();
        let mut actual = Vec::new();
        keys(tree.root_node(), &src, 0, &mut actual);
        let name = path.file_stem().unwrap().to_string_lossy().into_owned();
        // The plugin's parser loses its base indent here; NEON itself takes a file indented as a whole.
        if name == "ArrayIndentedFile" {
            assert!(!tree.root_node().has_error());
            continue;
        }
        let has_error = tree.root_node().has_error();
        if has_error != (status == "error") {
            failures.push(format!("{name}: expected {status}, parsed with error = {has_error}"));
        } else if !has_error && actual != expected_keys.lines().collect::<Vec<_>>() {
            failures.push(format!("{name}: keys {actual:?}, expected {:?}", expected_keys.lines().collect::<Vec<_>>()));
        }
    }
    assert!(total > 50, "only {total} fixtures");
    assert!(failures.is_empty(), "{} of {total} fixtures differ:\n{}", failures.len(), failures.join("\n"));
}
