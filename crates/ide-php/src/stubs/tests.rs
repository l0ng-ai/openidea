use std::io::Write;
use std::time::Instant;

use super::*;
use crate::summary::{ClassKind, TypeHint};

fn v(text: &str) -> PhpVersion {
    PhpVersion::parse(text).unwrap()
}

fn defaults(version: &str) -> StubSet {
    BundledStubs::get().summaries(&StubFilter::new(v(version), ide_sdk::php::default_stub_sets()))
}

fn hint(set: &StubSet, function: &str) -> Option<String> {
    set.function(function).unwrap().1.return_type.as_ref().map(ToString::to_string)
}

/// An archive laid out like the embedded one.
fn archive(files: &[(&str, &str)]) -> Vec<u8> {
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for (path, text) in files {
        zip.start_file(*path, zip::write::SimpleFileOptions::default()).unwrap();
        zip.write_all(text.as_bytes()).unwrap();
    }
    zip.finish().unwrap().into_inner()
}

#[test]
fn versions_parse_and_order() {
    assert_eq!(v("8.1.0"), PhpVersion::new(8, 1));
    assert_eq!(v("v7"), PhpVersion::new(7, 0));
    assert_eq!(v(" 8.3.*"), PhpVersion::new(8, 3));
    assert_eq!(PhpVersion::parse("next"), None);
    assert!(v("7.4") < v("8.0") && v("8.0") < v("8.10"));
    assert_eq!(PhpVersion::LATEST.to_string(), "8.5");
}

#[test]
fn core_functions_and_classes_are_present() {
    let started = Instant::now();
    let stubs = BundledStubs::get();
    eprintln!("loaded {} stub files in {:?}", stubs.paths().count(), started.elapsed());
    assert!(stubs.paths().count() > 400);
    assert!(stubs.extensions().contains(&"standard"));

    for version in ["7.4", "8.1", "8.5"] {
        let set = defaults(version);
        let (file, strlen) = set.function("strlen").unwrap_or_else(|| panic!("strlen at {version}"));
        assert_eq!(file.path, "Core/Core.php");
        assert_eq!(strlen.params.len(), 1);
        assert_eq!(hint(&set, "\\STRLEN").as_deref(), Some("int"));
        let (file, iterator) = set.class_like("ArrayIterator").unwrap_or_else(|| panic!("ArrayIterator at {version}"));
        assert_eq!((file.extension.as_str(), iterator.kind), ("SPL", ClassKind::Class));
        assert!(iterator.implements.iter().any(|name| name == "SeekableIterator"));
        assert!(iterator.method("getArrayCopy").is_some());
        assert!(set.constant("PHP_EOL").is_some());
    }
    // The text is there for hover and goto.
    let text = stubs.source("Core/Core.php").unwrap();
    let strlen = stubs.raw_summary("Core/Core.php").unwrap().function("strlen").unwrap();
    assert_eq!(&text[strlen.name_loc.start as usize..strlen.name_loc.end as usize], "strlen");
}

#[test]
fn newer_functions_are_hidden_at_older_versions() {
    // `@since 8.3` in the docblock.
    for function in ["json_validate", "mb_str_pad"] {
        assert!(defaults("8.1").function(function).is_none(), "{function} at 8.1");
        assert!(defaults("8.3").function(function).is_some(), "{function} at 8.3");
    }
    // `@removed 5.5`, `@removed 8.0`.
    assert!(defaults("5.4").function("php_logo_guid").is_some());
    assert!(defaults("8.1").function("php_logo_guid").is_none());
    assert!(defaults("7.4").function("money_format").is_some());
    assert!(defaults("8.0").function("money_format").is_none());
}

#[test]
fn members_and_parameters_follow_the_version() {
    // `Directory::$path`: untyped and `@removed 8.1`, then `readonly string` `@since 8.1`.
    let path = |version: &str| {
        let set = defaults(version);
        let directory = set.class_like("Directory").unwrap().1;
        let paths: Vec<_> = directory.properties.iter().filter(|p| p.name == "path").collect();
        assert_eq!(paths.len(), 1, "one Directory::$path at {version}");
        (paths[0].is_readonly, paths[0].type_hint.as_ref().map(ToString::to_string))
    };
    assert_eq!(path("8.0"), (false, None));
    assert_eq!(path("8.1"), (true, Some("string".to_owned())));

    // `hash()` gains `#[PhpStormStubsElementAvailable('8.1')] array $options`.
    let params = |version: &str| defaults(version).function("hash").unwrap().1.params.len();
    assert_eq!(params("8.0"), 3);
    assert_eq!(params("8.1"), 4);
}

#[test]
fn language_level_type_aware_picks_the_type() {
    // `#[LanguageLevelTypeAware(['8.0' => 'CurlHandle|false'], default: 'resource|false')]`
    let curl = |version: &str| {
        BundledStubs::get()
            .summaries(&StubFilter::new(v(version), ["curl"]))
            .function("curl_init")
            .unwrap()
            .1
            .return_type
            .clone()
    };
    assert_eq!(
        curl("7.4"),
        Some(TypeHint::Union(vec![TypeHint::Builtin("resource".into()), TypeHint::Builtin("false".into())]))
    );
    assert_eq!(curl("8.0").map(|t| t.to_string()).as_deref(), Some("CurlHandle|false"));
    // `['8.2' => 'true'], default: 'bool'`
    assert_eq!(hint(&defaults("8.1"), "phpcredits").as_deref(), Some("bool"));
    assert_eq!(hint(&defaults("8.2"), "phpcredits").as_deref(), Some("true"));
    // `@return string|false` on `substr()`, whose 8.0 type is `string`: the
    // docblock loses its `false` from 8.0 on.
    let doc_return = |version: &str| {
        let set = defaults(version);
        set.function("substr").unwrap().1.doc.as_ref().and_then(|doc| doc.return_type.clone()).map(|t| t.0)
    };
    assert_eq!(doc_return("7.4").as_deref(), Some("string|false"));
    assert_eq!(doc_return("8.0").as_deref(), Some("string"));
    // `['8.0' => 'string[]'], default: 'string[]|false'` on `explode()`:
    // PHPDoc types, kept as the `@return`.
    let explode = |version: &str| {
        let set = defaults(version);
        let function = set.function("explode").unwrap().1.clone();
        (function.return_type.clone(), function.doc.and_then(|doc| doc.return_type).map(|t| t.0))
    };
    assert_eq!(explode("8.1"), (None, Some("string[]".to_owned())));
    assert_eq!(explode("7.4"), (None, Some("string[]|false".to_owned())));
}

#[test]
fn drop_false_keeps_what_the_native_type_allows() {
    let doc = |text: &str, hint: Option<TypeHint>| {
        let mut ty = DocType(text.into());
        drop_false(&mut ty, &hint);
        ty.0
    };
    let builtin = |name: &str| Some(TypeHint::Builtin(name.into()));
    assert_eq!(doc("array<int|false, string>|false", builtin("array")), "array<int|false, string>");
    assert_eq!(doc("string|false", builtin("bool")), "string|false");
    assert_eq!(doc("string|false", None), "string|false");
    assert_eq!(doc("false", builtin("string")), "false");
}

#[test]
fn only_enabled_stub_sets_are_included() {
    let stubs = BundledStubs::get();
    assert!(defaults("8.3").class_like("Redis").is_none());
    let with_redis = stubs.summaries(&StubFilter::new(v("8.3"), ["standard", "Redis"]));
    assert!(with_redis.class_like("Redis").is_some());
    assert!(with_redis.function("strlen").is_none(), "Core is not enabled");
    assert!(with_redis.function("str_repeat").is_some());
    // Spellings of the same set.
    let opcache = stubs.summaries(&StubFilter::new(v("8.3"), ["zend-opcache"]));
    assert!(opcache.function("opcache_get_status").is_some());
    assert!(stubs.summaries(&StubFilter::all_extensions(v("8.3"))).class_like("Redis").is_some());
}

#[test]
fn filter_from_project_settings() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(tmp.path().join("composer.json"), r#"{"require": {"php": "^8.1", "ext-redis": "*"}}"#).unwrap();
    let filter = StubFilter::from_settings(tmp.path(), &Settings::default());
    assert_eq!(filter.version, v("8.1"));
    assert!(filter.includes_extension("redis") && filter.includes_extension("Zend OPcache"));
    assert!(!filter.includes_extension("swoole"));
    let set = BundledStubs::get().summaries(&filter);
    assert!(set.function("json_validate").is_none());
    assert!(set.class_like("Redis").is_some());

    let empty = tempfile::tempdir().unwrap();
    assert_eq!(StubFilter::from_settings(empty.path(), &Settings::default()).version, PhpVersion::LATEST);
}

const CORE: &str = r#"<?php
use JetBrains\PhpStorm\Internal\PhpStormStubsElementAvailable as Available;
use JetBrains\PhpStorm\Internal\LanguageLevelTypeAware;

/** @since 8.2 */
function newer(): int {}

/**
 * @removed 8.0
 * @since 5.3
 */
function older() {}

#[Available(from: '7.0', to: '7.4')]
function pair(int $a) {}

#[Available('8.0')]
function pair(int $a, #[Available(from: '8.3')] string ...$rest) {}

#[LanguageLevelTypeAware(['8.1' => '?Handle', '8.0' => 'object'], default: '')]
function handle(#[LanguageLevelTypeAware(['8.0' => 'int'], default: 'resource')] $h) {}

/** @since PECL thing >= 1.0 */
function unversioned() {}

class Box {
    #[Available(to: '7.4')]
    const OLD = 1;
    /** @since 8.1 */
    public const NEW = 2;
    #[LanguageLevelTypeAware(['8.0' => 'string'], default: '')]
    public $label;
    #[Available(from: '8.1')]
    public function open() {}
}

/** @since 8.1 */
enum Suit { case Hearts; }

/** @removed 7.0 */
define('OLD_FLAG', 1);
"#;

const EXTENSION: &str = r#"<?php
namespace Ext;

/** @since 9.9 */
function versioned_by_the_extension() {}

#[\JetBrains\PhpStorm\Internal\LanguageLevelTypeAware(['8.0' => 'Conn'], default: 'resource')]
function connect() {}
"#;

fn synthetic(version: &str) -> StubSet {
    let stubs = BundledStubs::load(&archive(&[
        ("LICENSE", "Apache-2.0"),
        ("Core/core.php", CORE),
        ("myext/ext.php", EXTENSION),
        ("myext/notes.txt", "not php"),
    ]))
    .unwrap();
    assert_eq!(stubs.extensions(), ["Core", "myext"]);
    stubs.summaries(&StubFilter::all_extensions(v(version)))
}

fn names(set: &StubSet) -> Vec<String> {
    let mut names: Vec<String> = set
        .files
        .iter()
        .flat_map(|file| {
            let functions = file.summary.functions.iter().map(|f| format!("{}({})", f.fqn, f.params.len()));
            let constants = file.summary.constants.iter().map(|c| c.fqn.clone());
            let classes = file.summary.class_likes.iter().map(|c| {
                let mut members: Vec<String> = c.constants.iter().map(|k| k.name.clone()).collect();
                members.extend(c.methods.iter().map(|m| format!("{}()", m.name)));
                format!("{}{{{}}}", c.fqn, members.join(","))
            });
            functions.chain(constants).chain(classes).collect::<Vec<_>>()
        })
        .collect();
    names.sort();
    names
}

#[test]
fn availability_rules_on_a_synthetic_archive() {
    assert_eq!(
        names(&synthetic("5.6")),
        [
            "Box{OLD}",
            "Ext\\connect(0)",
            "Ext\\versioned_by_the_extension(0)",
            "OLD_FLAG",
            "handle(1)",
            "older(0)",
            "unversioned(0)"
        ]
    );
    assert_eq!(
        names(&synthetic("7.4")),
        [
            "Box{OLD}",
            "Ext\\connect(0)",
            "Ext\\versioned_by_the_extension(0)",
            "handle(1)",
            "older(0)",
            "pair(1)",
            "unversioned(0)"
        ]
    );
    assert_eq!(
        names(&synthetic("8.1")),
        [
            "Box{NEW,open()}",
            "Ext\\connect(0)",
            "Ext\\versioned_by_the_extension(0)",
            "Suit{}",
            "handle(1)",
            "pair(1)",
            "unversioned(0)"
        ]
    );
    let latest = names(&synthetic("8.3"));
    assert!(latest.contains(&"newer(0)".to_owned()) && latest.contains(&"pair(2)".to_owned()));
}

#[test]
fn type_aware_types_on_a_synthetic_archive() {
    let types = |version: &str| {
        let set = synthetic(version);
        let handle = set.function("handle").unwrap().1;
        let label = set.class_like("Box").unwrap().1.property("label").unwrap();
        let connect = set.function("Ext\\connect").unwrap().1;
        [&handle.return_type, &handle.params[0].type_hint, &label.type_hint, &connect.return_type]
            .map(|ty| ty.as_ref().map(ToString::to_string).unwrap_or_default())
    };
    assert_eq!(types("7.4"), ["", "resource", "", "resource"]);
    assert_eq!(types("8.0"), ["object", "int", "string", "Ext\\Conn"]);
    assert_eq!(types("8.4"), ["?Handle", "int", "string", "Ext\\Conn"]);
}
