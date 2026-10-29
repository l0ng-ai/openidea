//! System Settings › HTTP Proxy: applied on write, the password kept out of settings.toml.

use ide_core::NullSink;
use ide_core::proxy_settings::{ProxyMode, ProxyRoute, proxy};
use ide_host::{Host, HostConfig, ops};
use ide_workspace::SettingsScope;
use std::sync::Arc;

fn host(base: &std::path::Path) -> Arc<Host> {
    Arc::new(Host::new(HostConfig {
        config_dir: base.join("config"),
        data_dir: base.join("data"),
        languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
        syntax: Arc::default(),
        sink_for: Box::new(|_| Arc::new(NullSink)),
        owner: |w| w,
        runtime: tokio::runtime::Handle::current(),
        project_environment: false,
    }))
}

fn set(host: &Host, key: &str, value: &str) -> ide_core::settings::Settings {
    ops::project::set_settings(host, "main", SettingsScope::Global, key, value).unwrap().settings
}

fn settings_files(base: &std::path::Path) -> String {
    let mut text = String::new();
    for entry in walk(&base.join("config")) {
        text.push_str(&std::fs::read_to_string(entry).unwrap_or_default());
    }
    text
}

fn walk(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let path = entry.path();
        if path.is_dir() { out.extend(walk(&path)) } else { out.push(path) }
    }
    out
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn manual_proxy_applies_and_the_password_is_saved_apart() {
    let tmp = tempfile::tempdir().unwrap();
    let host = host(tmp.path());
    assert_eq!(proxy().mode, ProxyMode::Auto);

    set(&host, "proxy.mode", "\"manual\"");
    set(&host, "proxy.host", "\"proxy.corp\"");
    set(&host, "proxy.port", "3128");
    set(&host, "proxy.authenticate", "true");
    set(&host, "proxy.login", "\"me\"");
    let settings = set(&host, "proxy.password", "\"s3cret\"");
    assert_eq!(settings.proxy.password, "s3cret", "the dialog sees the saved password");
    assert_eq!(
        proxy().route_for_url("https://example.com/"),
        ProxyRoute::Via("http://me:s3cret@proxy.corp:3128".into())
    );

    assert!(!settings_files(tmp.path()).contains("s3cret"), "no password in settings.toml");
    let saved = std::fs::read_to_string(tmp.path().join("data/proxy-password.json")).unwrap();
    assert!(saved.contains("s3cret"));
    assert_eq!(ops::project::settings(&host, "main").proxy.password, "s3cret");

    // A whole-table write keeps the password out of the file too; an empty one forgets it.
    let settings = set(&host, "proxy", r#"{"mode":"none","host":"proxy.corp","password":""}"#);
    assert_eq!(settings.proxy.password, "");
    assert!(!settings_files(tmp.path()).contains("password"));
    assert_eq!(proxy().route_for_url("https://example.com/"), ProxyRoute::Direct);

    set(&host, "proxy", r#"{"mode":"auto"}"#);
    assert_eq!(proxy().mode, ProxyMode::Auto);
}
