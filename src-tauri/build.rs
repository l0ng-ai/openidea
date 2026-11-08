fn main() {
    // Read when the script runs: a path compiled into the script would outlive a move of the checkout.
    let manifest_dir =
        std::path::PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR"));
    let root = dunce::canonicalize(manifest_dir.parent().unwrap()).expect("worktree root");
    println!("cargo:rustc-env=OPENIDEA_WORKTREE_ROOT={}", root.display());
    // Windows (MSVC): link the Common-Controls v6 manifest into every binary of
    // this package, not only the app's resources, so test executables such as
    // `export_bindings` can load comctl32 and don't exit with
    // STATUS_ENTRYPOINT_NOT_FOUND.
    let mut windows = tauri_build::WindowsAttributes::new();
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        windows = tauri_build::WindowsAttributes::new_without_app_manifest();
        let manifest = manifest_dir.join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    }
    tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows)).expect("tauri build");
}
