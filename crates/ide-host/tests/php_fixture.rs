//! `fixtures/php-app` keeps the shape the PHP engine phases and the language smoke test rely
//! on: PSR-4 paths that match namespaces, one of each declaration kind, generics, PHPStorm
//! metadata, PHPUnit tests and one deliberate error. No PHP is needed to run this.

use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/php-app")
}

fn read(rel: &str) -> String {
    fs::read_to_string(root().join(rel)).unwrap_or_else(|e| panic!("{rel}: {e}"))
}

fn php_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            php_files(&path, out);
        } else if path.extension().is_some_and(|e| e == "php") {
            out.push(path);
        }
    }
}

/// The `namespace X;` of a file, if it has one.
fn namespace(src: &str) -> Option<&str> {
    src.lines().find_map(|l| l.strip_prefix("namespace ")?.strip_suffix(';'))
}

/// The kind of the type named `name` declared in `src` (`class`, `interface`, `trait`, `enum`).
fn declared_kind(src: &str, name: &str) -> Option<&'static str> {
    src.lines().find_map(|line| {
        let words: Vec<&str> = line.split_whitespace().collect();
        let at = words.iter().position(|w| w.trim_end_matches(':') == name)?;
        let kind = *words.get(at.checked_sub(1)?)?;
        ["class", "interface", "trait", "enum"].into_iter().find(|k| *k == kind)
    })
}

#[test]
fn composer_json_declares_psr4_roots_and_php_8_2() {
    let composer: Value = serde_json::from_str(&read("composer.json")).unwrap();
    assert_eq!(composer["require"]["php"], "^8.2");
    assert_eq!(composer["autoload"]["psr-4"]["App\\"], "src/");
    assert_eq!(composer["autoload-dev"]["psr-4"]["Tests\\"], "tests/");
    for file in composer["autoload"]["files"].as_array().unwrap() {
        assert!(root().join(file.as_str().unwrap()).is_file(), "{file}");
    }
    assert!(composer["require-dev"]["phpunit/phpunit"].is_string());
}

#[test]
fn every_class_file_follows_psr4() {
    let composer: Value = serde_json::from_str(&read("composer.json")).unwrap();
    let autoload_files: Vec<PathBuf> =
        composer["autoload"]["files"].as_array().unwrap().iter().map(|f| root().join(f.as_str().unwrap())).collect();
    let mut kinds = Vec::new();
    for (prefix, dir) in [("App", "src"), ("Tests", "tests")] {
        let base = root().join(dir);
        let mut files = Vec::new();
        php_files(&base, &mut files);
        assert!(!files.is_empty(), "{dir}");
        for file in files {
            let src = fs::read_to_string(&file).unwrap();
            assert!(src.starts_with("<?php"), "{}", file.display());
            if autoload_files.contains(&file) {
                assert_eq!(namespace(&src), Some("App"), "{}", file.display());
                continue;
            }
            let rel = file.strip_prefix(&base).unwrap();
            let mut expected = vec![prefix.to_owned()];
            expected.extend(rel.parent().unwrap().iter().map(|p| p.to_string_lossy().into_owned()));
            assert_eq!(namespace(&src), Some(expected.join("\\").as_str()), "{}", file.display());
            let name = rel.file_stem().unwrap().to_string_lossy();
            let kind = declared_kind(&src, &name).unwrap_or_else(|| panic!("{} declares no {name}", file.display()));
            let is_abstract = src.contains(&format!("abstract class {name}"));
            kinds.push(if is_abstract { "abstract class" } else { kind });
        }
    }
    for kind in ["class", "abstract class", "interface", "trait", "enum"] {
        assert!(kinds.contains(&kind), "no {kind} in {kinds:?}");
    }
}

#[test]
fn fixture_covers_generics_functions_constants_metadata_and_tests() {
    let collection = read("src/Support/Collection.php");
    assert!(collection.contains("@template T") && collection.contains("@return Collection<U>"));
    assert!(read("src/functions.php").contains("function format_price("));
    let constants = read("src/constants.php");
    assert!(constants.contains("const DEFAULT_CURRENCY") && constants.contains("define('APP_VERSION'"));
    let meta = read(".phpstorm.meta.php");
    assert!(meta.contains("namespace PHPSTORM_META") && meta.contains("override(") && meta.contains("map(["));
    let tests = read("tests/LibraryTest.php");
    assert!(tests.contains("extends TestCase") && tests.contains("OPENIDEA_FAIL"));

    let mut files = Vec::new();
    php_files(&root(), &mut files);
    let deliberate: Vec<_> =
        files.iter().filter(|f| fs::read_to_string(f).unwrap().contains("FIXME: deliberate error")).collect();
    assert_eq!(deliberate.len(), 1, "{deliberate:?}");
    assert!(files.len() <= 20, "keep the fixture small: {} PHP files", files.len());
}

#[test]
fn run_configurations_are_detected() {
    let configs = ide_run::detect(&root());
    let find = |id: &str| configs.iter().find(|c| c.id == id).unwrap_or_else(|| panic!("missing {id}"));
    let phpunit = find("phpunit");
    assert!(phpunit.is_test);
    assert_eq!(phpunit.kind, "phpunit");
    assert!(find("composer:test").is_test);
    assert!(!find("composer:start").is_test);
}
