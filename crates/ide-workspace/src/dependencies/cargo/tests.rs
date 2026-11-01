use super::*;

#[test]
fn sparse_paths_and_input_validation() {
    for (name, path) in
        [("A", "1/a"), ("ab", "2/ab"), ("AbC", "3/a/abc"), ("serde", "se/rd/serde"), ("my_crate", "my/_c/my_crate")]
    {
        assert_eq!(index_path(name).as_deref(), Some(path));
    }
    for name in ["", "../serde", "a/b", "sé", "-foo", "a?b", "1abc"] {
        assert!(index_path(name).is_none(), "{name}");
    }
}

#[test]
fn sparse_index_filters_yanked_sorts_semver_and_keeps_prereleases_for_completion() {
    let text = r#"{"vers":"1.9.0","yanked":false}
{"vers":"2.0.0-beta.1","yanked":false}
{"vers":"9.0.0","yanked":true}
{"vers":"1.10.0","yanked":false}
{"vers":"1.10.0"}"#;
    assert_eq!(parse_index(text).unwrap(), ["2.0.0-beta.1", "1.10.0", "1.9.0"]);
    assert!(parse_index("{broken").is_none());
    assert!(parse_index(r#"{"vers":"bogus"}"#).is_none());
}

#[test]
fn cargo_requirements_updates_and_precision() {
    for (req, latest, expected) in [
        ("1", "1.9.0", None),
        ("1.0.100", "1.0.228", None),
        ("^1.2", "1.9.0", None),
        ("0.7", "0.7.9", None),
        ("0.0.1", "0.0.2", Some("0.0.2")),
        ("1", "2.3.4", Some("2")),
        ("1.2", "2.3.4", Some("2.3")),
        ("1.2.3", "2.3.0", Some("2.3.0")),
        ("1.2.3", "1.3.0", None),
        ("0.2", "1.3.0", Some("1.3")),
        ("=1.2.3", "1.3.0", Some("=1.3.0")),
        ("~1.2", "1.3.0", Some("~1.3")),
        ("^0.2", "0.3.1", Some("^0.3")),
        ("1.*", "1.9.0", None),
        ("*", "2.3.4", None),
        (">=1, <2", "2.3.4", Some("2.3.4")),
        (">=1, <2", "2.0.0", Some("2.0.0")),
        ("<1", "1.0.0", Some("1.0.0")),
        (">=1, <3", "2.3.4", None),
        (">=9", "2.3.4", None),
        (">1", "1.9.0", None),
        (">1.2", "1.2.9", None),
        (">1.2.3", "1.2.3", None),
        ("=9.1.2", "2.3.4", None),
        ("bad", "2.3.4", None),
        ("1.0", "2.0.0-beta.1", None),
        ("1.0.0-beta.1", "1.0.0-beta.2", None),
        ("=1.0.0-beta.1", "1.0.0-beta.2", Some("1.0.0-beta.2")),
        ("1.0.0-beta.1", "2.0.0-beta.1", Some("2.0.0-beta.1")),
    ] {
        let actual = update(req, &[latest.to_owned()]);
        assert_eq!(actual.as_ref().map(|u| u.replacement.as_str()), expected, "{req} -> {latest}");
        if let Some(u) = actual {
            assert!(VersionReq::parse(&u.replacement).unwrap().matches(&Version::parse(latest).unwrap()));
        }
    }
    let versions = vec!["3.0.0-beta.1".into(), "2.0.0".into(), "1.0.0".into()];
    assert_eq!(update("1", &versions).unwrap().latest, "2.0.0");
}

#[test]
fn locates_all_cargo_sections_and_only_replaces_version_contents() {
    let text = r#"# 中文 😀
[package]
name = "fixture"
version = "1.0.0"
[dependencies]
serde = "1.0.100" # stays
rand = '0.7'
tokio = { version = "0.2", features = ["full"] }
renamed = { package = "real-crate", version = "1.2" }
local = { path = "../local", version = "1" }
git = { git = "https://example.com/repo", version = "1" }
inherited = { workspace = true }
other = { registry = "private", version = "1" }
[dev-dependencies]
check = "1"
[build-dependencies.build]
version = "1.2.3"
[target.'cfg(unix)'.dependencies]
native = "0.1"
[target.'cfg(windows)'.dev-dependencies]
win = { version = "1" }
[target.'cfg(unix)'.build-dependencies]
build-native = "2"
[workspace.dependencies]
shared = { version = "1", features = ["std"] }
[package.metadata.dependencies]
not-a-dependency = "1"
"#;
    let deps = dependencies(text);
    assert_eq!(
        deps.iter().map(|d| d.package.as_str()).collect::<Vec<_>>(),
        ["serde", "rand", "tokio", "real-crate", "check", "build", "native", "win", "build-native", "shared"]
    );
    let utf16: Vec<_> = text.encode_utf16().collect();
    for dep in &deps {
        assert_eq!(String::from_utf16(&utf16[dep.from as usize..dep.to as usize]).unwrap(), dep.requirement);
    }
    let tokio = &deps[2];
    let mut edited = utf16.clone();
    edited.splice(tokio.from as usize..tokio.to as usize, "1.3".encode_utf16());
    assert_eq!(String::from_utf16(&edited).unwrap(), text.replace("version = \"0.2\"", "version = \"1.3\""));
    let rand = &deps[1];
    let mut edited = utf16;
    edited.splice(rand.from as usize..rand.to as usize, "0.9".encode_utf16());
    assert_eq!(String::from_utf16(&edited).unwrap(), text.replace("'0.7'", "'0.9'"));
}

#[test]
fn invalid_toml_and_decoy_tables_are_silent() {
    assert!(dependencies("[dependencies]\na = \"").is_empty());
    assert!(dependencies("[package]\ndescription = '''\n[dependencies]\na = \"1\"\n'''\n").is_empty());
    assert!(dependencies("[dependencies]\na = { version = 1 }\nb = { workspace = true, version = \"1\" }\nc = { version = \"1\", registry-index = \"x\" }").is_empty());
    let deps = dependencies("[dependencies]\na = \"\"\n");
    assert_eq!(deps.len(), 1, "empty version strings still offer completion");
    assert_eq!(deps[0].from, deps[0].to);
}

#[test]
fn replaces_encoded_and_multiline_strings_without_damaging_quotes() {
    for raw in [r#""0.\u0032""#, "\"\"\"\n0.2\"\"\"", "'''0.2'''"] {
        let text = format!("[dependencies]\ntokio = {{ version = {raw}, features = [\"full\"] }}\n");
        let dep = dependencies(&text).pop().unwrap();
        assert_eq!(dep.requirement, "0.2");
        let mut encoded: Vec<_> = text.encode_utf16().collect();
        encoded.splice(dep.from as usize..dep.to as usize, "1.10".encode_utf16());
        let edited = String::from_utf16(&encoded).unwrap();
        assert!(edited.contains("features = [\"full\"]"));
        assert_eq!(dependencies(&edited)[0].requirement, "1.10");
        assert_eq!(edited.matches('"').count(), text.matches('"').count());
        assert_eq!(edited.matches('\'').count(), text.matches('\'').count());
    }
}
