//! The pointer file inside the default config dir redirects every path; this
//! binary owns its process (HOME is redirected to a temp dir, which `dirs`
//! resolves through).

#[test]
fn base_reads_the_pointer_file_from_its_fixed_location() {
    let tmp = tempfile::TempDir::new().unwrap();
    let home = tmp.path().join("home");
    std::fs::create_dir_all(&home).unwrap();
    // SAFETY: sole test in this binary; no other thread reads the environment.
    unsafe { std::env::set_var("HOME", &home) };

    let target = tmp.path().join("moved-base");
    std::fs::create_dir_all(&target).unwrap();
    let defaults = openidea_lib::paths::default_dirs("ai.l0ng.openidea");
    openidea_lib::paths::write_pointer(&defaults.0, &openidea_lib::paths::Layout::Custom(target.clone()), None)
        .unwrap();

    openidea_lib::paths::init("ai.l0ng.openidea");
    let resolved = openidea_lib::paths::current();

    assert_eq!(resolved.layout, openidea_lib::paths::Layout::Custom(target.clone()));
    assert_eq!(resolved.locations.config, target.join("config"));
    assert_eq!(resolved.locations.data, target.join("system"));

    // Same guarantee as the env test: after a recorded switch, every
    // consumer root hangs off the base, never off the platform dirs.
    let (layout, locations) = (resolved.layout.clone(), resolved.locations.clone());
    assert_eq!(openidea_lib::paths::plugins_dir(&layout, &locations), target.join("config"));
    assert_eq!(openidea_lib::paths::log_dir(&layout, "ai.l0ng.openidea"), Some(target.join("log")));
    assert_eq!(openidea_lib::paths::login_cache_root(&layout, &locations, "ai.l0ng.openidea"), target.join("system"));
    assert_eq!(openidea_lib::paths::tools_home(&layout, "ai.l0ng.openidea"), Some(target));
}
