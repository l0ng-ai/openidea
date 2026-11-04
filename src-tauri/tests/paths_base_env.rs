//! `OPENIDEA_HOME` redirects everything; this binary owns its process, so
//! setting the variable here cannot leak into other tests.

#[test]
fn base_takes_the_environment_variable() {
    let tmp = tempfile::TempDir::new().unwrap();
    let custom = tmp.path().join("custom");
    // SAFETY: sole test in this binary; no other thread reads the environment.
    unsafe { std::env::set_var("OPENIDEA_HOME", &custom) };

    openidea_lib::paths::init("ai.l0ng.openidea");
    let resolved = openidea_lib::paths::current();

    assert_eq!(resolved.layout, openidea_lib::paths::Layout::Custom(custom.clone()));
    assert_eq!(resolved.locations.config, custom.join("config"));
    assert_eq!(resolved.locations.data, custom.join("system"));
}
