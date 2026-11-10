use ide_core::{Pos, Range};
use ide_host::plugins::{Consent, PluginHost};
use ide_plugin::{Limits, ProviderDocument};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

fn fixture_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../ide-plugin/tests/fixtures/inlay-hints")
}

fn host(dir: &Path) -> PluginHost {
    let limits = Limits { edit_soft: Duration::from_secs(5), edit_hard: Duration::from_secs(10), ..Limits::default() };
    PluginHost::new(dir.join("plugins"), Arc::new(|_: Option<&str>, _| {}), limits).unwrap()
}

fn doc(dir: &Path, language: &str, text: &str) -> ProviderDocument {
    ProviderDocument { path: dir.join("Order.php"), language: language.into(), version: 1, text: text.into() }
}

const ORDER: &str = "<?php\nclass Order\n{\n    public function user(): ?User {}\n}\n$order->user();\n$order->total();\n$order->user;\n";

fn all() -> Range {
    Range::new(Pos::new(0, 0), Pos::new(100, 0))
}

#[test]
fn calls_of_declared_methods_get_a_type_hint() {
    let tmp = tempfile::tempdir().unwrap();
    let host = host(tmp.path());
    host.install_from_dir(&fixture_dir(), &Consent::all()).unwrap();
    let hints = host.provide_inlay_hints(&doc(tmp.path(), "php", ORDER), all());
    let found: Vec<_> =
        hints.iter().map(|h| (h.position.line, h.position.col, h.label.as_str(), h.kind.as_str())).collect();
    assert_eq!(found, [(5, 14, ": ?User", "type")]);
    assert_eq!(hints[0].tooltip.as_deref(), Some("user() returns ?User"));
    assert!(!hints[0].padding_left && !hints[0].padding_right);
}

#[test]
fn only_declared_languages_are_asked() {
    let tmp = tempfile::tempdir().unwrap();
    let host = host(tmp.path());
    host.install_from_dir(&fixture_dir(), &Consent::all()).unwrap();
    assert!(host.provide_inlay_hints(&doc(tmp.path(), "javascript", ORDER), all()).is_empty());
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
