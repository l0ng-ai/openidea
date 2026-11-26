//! Path aliases of the project's Vite, Rollup (`@rollup/plugin-alias`) or esbuild
//! configuration, for tsserver (vtsls), which only reads tsconfig.json / jsconfig.json
//! `paths`. Read statically: the configuration is never run.

use sha2::{Digest, Sha256};
use std::path::Path;

pub(crate) type Paths = std::collections::BTreeMap<String, Vec<String>>;
/// [`paths`] of each directory holding a bundler configuration, by directory (`/` separated).
pub(crate) type Packages = std::collections::BTreeMap<String, Paths>;

/// The tsserver plugin that adds a project's [`Packages`] entry to its `compilerOptions.paths`.
pub(crate) const PLUGIN: &str = "openidea-path-aliases";
const PLUGIN_JS: &str = include_str!("path-aliases.js");

/// Configurations read, in priority order (the first one defining an alias wins).
const CONFIGS: &[&str] = &[
    "vite.config.ts",
    "vite.config.mts",
    "vite.config.cts",
    "vite.config.js",
    "vite.config.mjs",
    "vite.config.cjs",
    "rollup.config.ts",
    "rollup.config.mts",
    "rollup.config.js",
    "rollup.config.mjs",
    "rollup.config.cjs",
    "esbuild.config.ts",
    "esbuild.config.mts",
    "esbuild.config.js",
    "esbuild.config.mjs",
    "esbuild.config.cjs",
];

/// `compilerOptions.paths` (`@/*` → `<root>/src/*`) for the directory aliases of the
/// bundler configurations in `root` itself. Empty without any.
pub(crate) fn paths(root: &Path) -> Paths {
    let mut aliases: Vec<(String, String)> = Vec::new();
    for config in CONFIGS.iter().map(|f| root.join(f)) {
        let Ok(text) = std::fs::read_to_string(&config) else { continue };
        for (name, target) in ide_language::bundler_aliases(&text, root) {
            if !aliases.iter().any(|(n, _)| *n == name) {
                aliases.push((name, target_dir(root, &target)));
            }
        }
    }
    crate::vue::alias_paths(&aliases)
}

/// The aliases of every package (workspace member) under `root`: the bundler configurations
/// of each directory down to a monorepo's `apps/web` / `packages/ui/demo`, honouring ignore
/// files and skipping `node_modules`. The plugin gives a tsserver project the entry of its
/// own package only.
pub(crate) fn packages(root: &Path) -> Packages {
    // ponytail: bounded walk; deeper workspace members go without aliases.
    const MAX_DEPTH: usize = 4;
    const MAX_ENTRIES: usize = 50_000;
    let mut walker = ignore::WalkBuilder::new(root);
    walker
        .max_depth(Some(MAX_DEPTH))
        .require_git(ide_core::ignored::inside_git_repo(root))
        .follow_links(false)
        .filter_entry(|e| e.file_name() != "node_modules");
    let mut dirs: Vec<std::path::PathBuf> = walker
        .build()
        .take(MAX_ENTRIES)
        .flatten()
        .filter(|e| CONFIGS.iter().any(|c| e.file_name() == *c))
        .filter_map(|e| e.path().parent().map(Path::to_path_buf))
        .collect();
    dirs.sort();
    dirs.dedup();
    dirs.into_iter()
        .map(|dir| (dir.to_string_lossy().replace('\\', "/"), paths(&dir)))
        .filter(|(_, paths)| !paths.is_empty())
        .collect()
}

/// Vite resolves `/src` from the project root; esbuild a relative target from the working
/// directory (the project root here). A `/`-rooted target without a drive or UNC prefix is
/// root-relative on Windows too, unless it is an existing directory elsewhere.
fn target_dir(root: &Path, target: &str) -> String {
    let path = Path::new(target);
    let path = if path.is_absolute() && (path.is_dir() || !target.starts_with('/')) {
        path.to_path_buf()
    } else {
        root.join(target.trim_start_matches('/').trim_start_matches("./"))
    };
    path.to_string_lossy().into_owned()
}

/// The vtsls `globalPlugins` entry of the plugin, written with `packages` under `data_dir`.
/// Each server root gets its own copy, as the plugin reads its aliases next to itself.
/// `None` when the data dir cannot be written.
pub(crate) fn tsserver_plugin(data_dir: &Path, root: &Path, packages: &Packages) -> Option<serde_json::Value> {
    let key = Sha256::digest(root.to_string_lossy().as_bytes());
    let key: String = key.iter().take(8).map(|b| format!("{b:02x}")).collect();
    let location = data_dir.join("tsplugins").join("path-aliases").join(key);
    let dir = location.join("node_modules").join(PLUGIN);
    std::fs::create_dir_all(&dir).ok()?;
    let json = serde_json::to_string(packages).ok()?;
    for (file, content) in [("index.js", PLUGIN_JS), ("paths.json", json.as_str())] {
        if std::fs::read(dir.join(file)).ok().as_deref() != Some(content.as_bytes()) {
            std::fs::write(dir.join(file), content).ok()?;
        }
    }
    Some(serde_json::json!({
        "name": PLUGIN,
        "location": location.to_string_lossy(),
        "enableForWorkspaceTypeScriptVersions": true,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vite_aliases_become_paths() {
        let tmp = tempfile::tempdir().unwrap();
        let t = &dunce::canonicalize(tmp.path()).unwrap();
        std::fs::create_dir_all(t.join("src/components")).unwrap();
        std::fs::create_dir_all(t.join("lib")).unwrap();
        assert!(paths(t).is_empty());
        std::fs::write(
            t.join("vite.config.ts"),
            r#"import path from 'path';
export default { resolve: { alias: [
  { find: '@', replacement: path.resolve(__dirname, 'src') },
  { find: 'comps', replacement: '/src/components' },
  { find: 'vue', replacement: 'vue/dist/vue.esm-bundler.js' },
] } };"#,
        )
        .unwrap();
        // A later configuration adds aliases but doesn't override the Vite ones.
        std::fs::write(
            t.join("rollup.config.mjs"),
            "import alias from '@rollup/plugin-alias';\nexport default { plugins: [alias({ entries: { '@': './lib', lib: './lib' } })] };",
        )
        .unwrap();
        let slash = |p: std::path::PathBuf| p.to_string_lossy().replace('\\', "/");
        let (src, comps, lib) = (slash(t.join("src")), slash(t.join("src/components")), slash(t.join("lib")));
        assert_eq!(
            paths(t),
            Paths::from([
                ("@".into(), vec![src.clone()]),
                ("@/*".into(), vec![format!("{src}/*")]),
                ("comps".into(), vec![comps.clone()]),
                ("comps/*".into(), vec![format!("{comps}/*")]),
                ("lib".into(), vec![lib.clone()]),
                ("lib/*".into(), vec![format!("{lib}/*")]),
            ])
        );
    }

    #[test]
    fn each_workspace_member_gets_its_own_configuration() {
        let tmp = tempfile::tempdir().unwrap();
        let t = &dunce::canonicalize(tmp.path()).unwrap();
        let vite = |dir: &str| {
            std::fs::create_dir_all(t.join(dir).join("src")).unwrap();
            let config = "export default { resolve: { alias: { '@': path.resolve(__dirname, 'src') } } };";
            std::fs::write(t.join(dir).join("vite.config.ts"), config).unwrap();
        };
        vite("");
        vite("apps/web");
        vite("node_modules/dep");
        std::fs::create_dir_all(t.join("packages/ui")).unwrap();
        let slash = |p: std::path::PathBuf| p.to_string_lossy().replace('\\', "/");
        let packages = packages(t);
        assert_eq!(packages.keys().cloned().collect::<Vec<_>>(), [slash(t.to_path_buf()), slash(t.join("apps/web"))]);
        assert_eq!(packages[&slash(t.join("apps/web"))]["@"], [slash(t.join("apps/web/src"))]);
    }

    #[test]
    fn root_relative_targets_stay_in_the_root_on_every_platform() {
        let root = Path::new("/p");
        let slash = |s: String| s.replace('\\', "/");
        assert_eq!(slash(target_dir(root, "/src/components")), "/p/src/components");
        assert_eq!(slash(target_dir(root, "./lib")), "/p/lib");
        let here = std::env::current_dir().unwrap();
        assert_eq!(target_dir(root, &here.to_string_lossy()), here.to_string_lossy());
    }

    #[test]
    fn the_plugin_is_written_with_its_aliases() {
        let tmp = tempfile::tempdir().unwrap();
        let packages = Packages::from([("/p".into(), Paths::from([("@/*".into(), vec!["/p/src/*".into()])]))]);
        let plugin = tsserver_plugin(tmp.path(), Path::new("/p"), &packages).unwrap();
        assert_eq!(plugin["name"], PLUGIN);
        let dir = Path::new(plugin["location"].as_str().unwrap()).join("node_modules").join(PLUGIN);
        assert_eq!(std::fs::read_to_string(dir.join("index.js")).unwrap(), PLUGIN_JS);
        assert_eq!(std::fs::read_to_string(dir.join("paths.json")).unwrap(), r#"{"/p":{"@/*":["/p/src/*"]}}"#);
        let other = tsserver_plugin(tmp.path(), Path::new("/q"), &packages).unwrap();
        assert_ne!(other["location"], plugin["location"], "one copy per server root");
    }

    #[test]
    fn the_plugin_adds_the_aliases_of_the_projects_package_below_its_own_paths() {
        let Some(node) = crate::exec::which("node") else { return };
        let tmp = tempfile::tempdir().unwrap();
        let t = &dunce::canonicalize(tmp.path()).unwrap();
        for dir in ["", "apps/web/nested", "apps/api"] {
            std::fs::create_dir_all(t.join(dir)).unwrap();
        }
        for dir in ["", "apps/web", "apps/api"] {
            std::fs::write(t.join(dir).join("package.json"), "{}").unwrap();
        }
        let slash = |p: std::path::PathBuf| p.to_string_lossy().replace('\\', "/");
        let packages = Packages::from([
            (slash(t.to_path_buf()), Paths::from([("@/*".into(), vec!["/root/*".into()])])),
            (
                slash(t.join("apps/web")),
                Paths::from([("@/*".into(), vec!["/web/*".into()]), ("~/*".into(), vec!["/web/lib/*".into()])]),
            ),
        ]);
        let plugin = tsserver_plugin(&t.join("data"), t, &packages).unwrap();
        let index = Path::new(plugin["location"].as_str().unwrap()).join("node_modules").join(PLUGIN);
        // tsserver calls the factory, then `create` with the project and its host.
        let script = "const create = (dir, settings) => { const host = { getCompilationSettings: settings }; \
              require(process.argv[1])({}).create({ project: { getCurrentDirectory: () => dir }, \
                languageServiceHost: host, languageService: {} }); return host; }; \
            let own = { strict: true, paths: { '@/*': ['./own/*'] } }; \
            const web = create(process.argv[2] + '/apps/web/nested', () => own); \
            const a = web.getCompilationSettings(); const same = a === web.getCompilationSettings(); \
            own = { strict: false }; const b = web.getCompilationSettings(); \
            const api = create(process.argv[2] + '/apps/api', () => ({})).getCompilationSettings(); \
            const root = create(process.argv[2], () => ({})).getCompilationSettings(); \
            process.stdout.write(JSON.stringify({ a, same, b, api, root }));";
        let out = crate::exec::query_in(
            &node,
            &["-e", script, &index.to_string_lossy(), &t.to_string_lossy()],
            None,
            &[],
            std::time::Duration::from_secs(30),
        );
        let out: serde_json::Value = serde_json::from_str(&out.unwrap()).unwrap();
        assert_eq!(
            out,
            serde_json::json!({
                "a": { "strict": true, "paths": { "@/*": ["./own/*"], "~/*": ["/web/lib/*"] } },
                "same": true,
                "b": { "strict": false, "paths": { "@/*": ["/web/*"], "~/*": ["/web/lib/*"] } },
                "api": {},
                "root": { "paths": { "@/*": ["/root/*"] } },
            })
        );
    }
}
