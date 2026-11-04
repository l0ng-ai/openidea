//! Without a switch, everything stays on the platform dirs; this binary owns
//! its process (HOME is redirected to a temp dir, which `dirs` resolves
//! through).

#[test]
fn default_resolution_stays_on_the_platform_dirs() {
    let tmp = tempfile::TempDir::new().unwrap();
    let home = tmp.path().join("home");
    std::fs::create_dir_all(&home).unwrap();
    // SAFETY: sole test in this binary; no other thread reads the environment.
    unsafe { std::env::set_var("HOME", &home) };

    openidea_lib::paths::init("ai.l0ng.openidea");
    let resolved = openidea_lib::paths::current();
    let defaults = openidea_lib::paths::default_dirs("ai.l0ng.openidea");

    assert_eq!(resolved.layout, openidea_lib::paths::Layout::Default);
    assert_eq!(resolved.locations.config, defaults.0);
    assert_eq!(resolved.locations.data, defaults.1);
    assert_eq!(openidea_lib::paths::plugins_dir(&resolved.layout, &resolved.locations), defaults.1);
    assert_eq!(openidea_lib::paths::tools_home(&resolved.layout, "ai.l0ng.openidea"), Some(defaults.1));
    assert_eq!(
        openidea_lib::paths::login_cache_root(&resolved.layout, &resolved.locations, "ai.l0ng.openidea"),
        dirs::cache_dir().unwrap().join("ai.l0ng.openidea")
    );
    assert!(
        openidea_lib::paths::log_dir(&resolved.layout, "ai.l0ng.openidea")
            .is_some_and(|d| d.ends_with("ai.l0ng.openidea"))
    );
}
