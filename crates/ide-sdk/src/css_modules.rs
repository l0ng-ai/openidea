//! CSS Modules Kit (`@css-modules-kit/ts-plugin`): the tsserver plugin vtsls loads for class
//! name navigation, completion, references and rename between TS/JSX and `*.module.css`. The
//! plugin only works in a tsserver project whose tsconfig.json sets `cmkOptions.enabled`.

use std::path::Path;

/// The package (and tsserver plugin name) the IDE installs as the `css-modules-kit` tool.
pub(crate) const PLUGIN: &str = "@css-modules-kit/ts-plugin";
/// The tsconfig.json switch the plugin needs; also the CSS vtsls route's root marker.
pub(crate) const MARKER: &str = "tsconfig.json#cmkOptions.enabled";

/// A tsconfig.json at `server_root`, above it, or in a package below it turns the plugin on.
pub(crate) fn enabled(server_root: &Path) -> bool {
    let markers = [MARKER.to_string()];
    if ide_language::marked_root(None, server_root, &markers).is_some() {
        return true;
    }
    // ponytail: bounded walk, as for the path aliases; deeper workspace members go without.
    const MAX_DEPTH: usize = 4;
    const MAX_ENTRIES: usize = 50_000;
    let mut walker = ignore::WalkBuilder::new(server_root);
    walker
        .max_depth(Some(MAX_DEPTH))
        .require_git(ide_core::ignored::inside_git_repo(server_root))
        .follow_links(false)
        .filter_entry(|e| e.file_name() != "node_modules");
    walker
        .build()
        .take(MAX_ENTRIES)
        .flatten()
        .filter(|e| e.file_name() == "tsconfig.json")
        .any(|e| e.path().parent().is_some_and(|dir| ide_language::marked_root(Some(dir), dir, &markers).is_some()))
}

/// vtsls `globalPlugins` entry of the plugin installed under `location` (the folder holding its
/// `node_modules`). `languages` has vtsls serve CSS documents too.
pub(crate) fn tsserver_plugin(location: &Path) -> serde_json::Value {
    serde_json::json!({
        "name": PLUGIN,
        "location": location.to_string_lossy(),
        "languages": ["css"],
        "enableForWorkspaceTypeScriptVersions": true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_tsconfig_with_cmk_options_turns_it_on() {
        let tmp = tempfile::tempdir().unwrap();
        let root = &dunce::canonicalize(tmp.path()).unwrap();
        std::fs::create_dir_all(root.join("apps/web/node_modules/dep")).unwrap();
        std::fs::write(root.join("tsconfig.json"), "{ // no CSS Modules Kit\n \"compilerOptions\": {} }").unwrap();
        let on = r#"{ "cmkOptions": { "enabled": true } }"#;
        std::fs::write(root.join("apps/web/node_modules/dep/tsconfig.json"), on).unwrap();
        assert!(!enabled(root), "dependencies don't count");
        std::fs::write(root.join("apps/web/tsconfig.json"), on).unwrap();
        assert!(enabled(root), "a package below the server root");
        assert!(enabled(&root.join("apps/web/src")), "the tsconfig above");
        std::fs::write(root.join("apps/web/tsconfig.json"), r#"{ "cmkOptions": { "enabled": false } }"#).unwrap();
        assert!(!enabled(root));
    }
}
