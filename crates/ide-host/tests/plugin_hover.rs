use ide_core::Pos;
use ide_host::plugins::{Consent, PluginHost};
use ide_plugin::{Limits, ProviderDocument};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

fn fixture_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../ide-plugin/tests/fixtures/hover")
}

fn host(dir: &Path) -> PluginHost {
    let limits = Limits { edit_soft: Duration::from_secs(5), edit_hard: Duration::from_secs(10), ..Limits::default() };
    PluginHost::new(dir.join("plugins"), Arc::new(|_: Option<&str>, _| {}), limits).unwrap()
}

fn doc(dir: &Path, language: &str, text: &str) -> ProviderDocument {
    ProviderDocument { path: dir.join("Order.php"), language: language.into(), version: 1, text: text.into() }
}

const ORDER: &str = "<?php\nclass Order\n{\n    public function user() {}\n}\n$order->user;\n$order->total;\n";

#[test]
fn a_declared_name_gets_the_plugins_hover() {
    let tmp = tempfile::tempdir().unwrap();
    let host = host(tmp.path());
    host.install_from_dir(&fixture_dir(), &Consent::all()).unwrap();
    let hovers = host.provide_hover(&doc(tmp.path(), "php", ORDER), Pos::new(5, 10));
    assert_eq!(hovers.len(), 1);
    assert_eq!(hovers[0].markdown, "**user** · declared on line 4");
    let range = hovers[0].range.unwrap();
    assert_eq!((range.start.line, range.start.col, range.end.line, range.end.col), (5, 8, 5, 12));
    assert!(host.provide_hover(&doc(tmp.path(), "php", ORDER), Pos::new(6, 10)).is_empty());
}

#[test]
fn only_declared_languages_are_asked() {
    let tmp = tempfile::tempdir().unwrap();
    let host = host(tmp.path());
    host.install_from_dir(&fixture_dir(), &Consent::all()).unwrap();
    assert!(host.provide_hover(&doc(tmp.path(), "javascript", ORDER), Pos::new(5, 10)).is_empty());
}

#[test]
fn the_kind_needs_plugin_api_1_3() {
    let tmp = tempfile::tempdir().unwrap();
    let host = host(tmp.path());
    let pkg = tmp.path().join("old");
    std::fs::create_dir_all(pkg.join("dist")).unwrap();
    std::fs::copy(fixture_dir().join("dist/plugin.wasm"), pkg.join("dist/plugin.wasm")).unwrap();
    let manifest = std::fs::read_to_string(fixture_dir().join("plugin.toml")).unwrap();
    std::fs::write(pkg.join("plugin.toml"), manifest.replace("\"^1.3\"", "\"^1.0\"")).unwrap();
    let err = host.install_from_dir(&pkg, &Consent::all()).unwrap_err();
    assert!(err.message.contains("new in plugin API 1.3"), "{}", err.message);
}
