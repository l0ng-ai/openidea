//! First launch adopts the OS language as the default UI language, and the
//! user's explicit choice is never overridden by it.

use ide_host::{Host, HostConfig};
use std::sync::Arc;

fn new_host(base: &std::path::Path) -> Arc<Host> {
    Arc::new(Host::new(HostConfig {
        config_dir: base.join("config"),
        data_dir: base.join("data"),
        languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
        syntax: Arc::default(),
        sink_for: Box::new(|_| Arc::new(ide_core::NullSink)),
        owner: |w| w,
        runtime: tokio::runtime::Handle::current(),
        project_environment: false,
    }))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn first_launch_writes_the_system_language_and_later_launches_keep_it() {
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path().join("app");
    let expected = ide_workspace::settings::locale_for_system(sys_locale::get_locale().as_deref());
    assert!(matches!(expected, "en" | "zh"));

    // First launch on a fresh config dir: the OS language is detected, applied
    // and persisted to settings.toml.
    let host = new_host(&base);
    assert_eq!(host.global_settings.effective().appearance.locale, expected);
    let text = std::fs::read_to_string(base.join("config/settings.toml")).unwrap();
    assert!(text.contains(&format!("locale = \"{expected}\"")), "{text}");

    // Later launches keep the stored language; the OS is not re-detected.
    drop(host);
    let host = new_host(&base);
    assert_eq!(host.global_settings.effective().appearance.locale, expected);
    assert_eq!(std::fs::read_to_string(base.join("config/settings.toml")).unwrap(), text);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_explicit_language_setting_is_never_overridden() {
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path().join("app");
    std::fs::create_dir_all(base.join("config")).unwrap();
    std::fs::write(base.join("config/settings.toml"), "[appearance]\nlocale = \"en\"\n").unwrap();

    // English stays English even though this machine reports Simplified Chinese.
    let host = new_host(&base);
    assert_eq!(host.global_settings.effective().appearance.locale, "en");
    assert!(std::fs::read_to_string(base.join("config/settings.toml")).unwrap().contains("locale = \"en\""));

    // A Chinese choice survives later launches the same way.
    drop(host);
    std::fs::write(base.join("config/settings.toml"), "[appearance]\nlocale = \"zh\"\n").unwrap();
    let host = new_host(&base);
    assert_eq!(host.global_settings.effective().appearance.locale, "zh");
}
