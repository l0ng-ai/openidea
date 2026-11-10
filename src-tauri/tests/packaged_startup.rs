//! Headless startup boundary: bundled debug apps must not use the build worktree.
#![cfg(all(debug_assertions, not(dev)))]

#[test]
fn bundled_startup_uses_distribution_identity_and_embedded_frontend() {
    assert!(!tauri::is_dev(), "run with --features tauri/custom-protocol");
    let context = openidea_lib::startup_context(&openidea_lib::specta_builder());
    let package: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
    assert_eq!(
        context.config().identifier,
        package["identifier"].as_str().unwrap(),
        "a bundled build uses the configured identity, not the worktree one"
    );
    assert!(context.assets().get(&"index.html".into()).is_some(), "bundled frontend is missing");
    println!(
        "GITAI_PACKAGED_STARTUP={}",
        serde_json::json!({
            "runtimeIdentifier": context.config().identifier,
            "configuredIdentifier": package["identifier"],
            "customProtocol": !tauri::is_dev(),
            "developmentHooks": cfg!(all(debug_assertions, dev)),
            "embeddedFrontend": context.assets().get(&"index.html".into()).is_some()
        })
    );
}
