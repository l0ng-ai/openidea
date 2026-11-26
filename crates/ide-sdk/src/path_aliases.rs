//! Path aliases of the project's Vite, Rollup (`@rollup/plugin-alias`) or esbuild
//! configuration, for tsserver (vtsls), which only reads tsconfig.json / jsconfig.json
//! `paths`. Read statically: the configuration is never run.

use sha2::{Digest, Sha256};
use std::path::Path;

pub(crate) type Paths = std::collections::BTreeMap<String, Vec<String>>;

/// The tsserver plugin that adds [`paths`] to every project's `compilerOptions.paths`.
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
/// bundler configurations in `root`. Empty without any.
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

/// Vite resolves `/src` from the project root; esbuild a relative target from the working
/// directory (the project root here).
fn target_dir(root: &Path, target: &str) -> String {
    let path = Path::new(target);
    let path = if path.is_absolute() && !path.is_dir() {
        root.join(target.trim_start_matches('/'))
    } else if path.is_relative() {
        root.join(target.trim_start_matches("./"))
    } else {
        path.to_path_buf()
    };
    path.to_string_lossy().into_owned()
}

/// The vtsls `globalPlugins` entry of the plugin, written with `paths` under `data_dir`.
/// Each server root gets its own copy, as the plugin reads its aliases next to itself.
/// `None` when the data dir cannot be written.
pub(crate) fn tsserver_plugin(data_dir: &Path, root: &Path, paths: &Paths) -> Option<serde_json::Value> {
    let key = Sha256::digest(root.to_string_lossy().as_bytes());
    let key: String = key.iter().take(8).map(|b| format!("{b:02x}")).collect();
    let location = data_dir.join("tsplugins").join("path-aliases").join(key);
    let dir = location.join("node_modules").join(PLUGIN);
    std::fs::create_dir_all(&dir).ok()?;
    let json = serde_json::to_string(paths).ok()?;
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
    fn the_plugin_is_written_with_its_aliases() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = Paths::from([("@/*".into(), vec!["/p/src/*".into()])]);
        let plugin = tsserver_plugin(tmp.path(), Path::new("/p"), &paths).unwrap();
        assert_eq!(plugin["name"], PLUGIN);
        let dir = Path::new(plugin["location"].as_str().unwrap()).join("node_modules").join(PLUGIN);
        assert_eq!(std::fs::read_to_string(dir.join("index.js")).unwrap(), PLUGIN_JS);
        assert_eq!(std::fs::read_to_string(dir.join("paths.json")).unwrap(), r#"{"@/*":["/p/src/*"]}"#);
        let other = tsserver_plugin(tmp.path(), Path::new("/q"), &paths).unwrap();
        assert_ne!(other["location"], plugin["location"], "one copy per server root");
    }

    #[test]
    fn the_plugin_adds_the_aliases_below_the_projects_own_paths() {
        let Some(node) = crate::exec::which("node") else { return };
        let tmp = tempfile::tempdir().unwrap();
        let paths = Paths::from([("@/*".into(), vec!["/p/src/*".into()]), ("~/*".into(), vec!["/p/lib/*".into()])]);
        let plugin = tsserver_plugin(tmp.path(), Path::new("/p"), &paths).unwrap();
        let index = Path::new(plugin["location"].as_str().unwrap()).join("node_modules").join(PLUGIN);
        // tsserver calls the factory, then `create` with the project as the host.
        let script = "let own = { strict: true, paths: { '@/*': ['./own/*'] } }; \
            const host = { getCompilationSettings: () => own }; \
            require(process.argv[1])({}).create({ languageServiceHost: host, languageService: {} }); \
            const a = host.getCompilationSettings(); const same = a === host.getCompilationSettings(); \
            own = { strict: false }; const b = host.getCompilationSettings(); \
            process.stdout.write(JSON.stringify({ a, same, b }));";
        let out = crate::exec::query_in(
            &node,
            &["-e", script, &index.to_string_lossy()],
            None,
            &[],
            std::time::Duration::from_secs(30),
        );
        let out: serde_json::Value = serde_json::from_str(&out.unwrap()).unwrap();
        assert_eq!(
            out,
            serde_json::json!({
                "a": { "strict": true, "paths": { "@/*": ["./own/*"], "~/*": ["/p/lib/*"] } },
                "same": true,
                "b": { "strict": false, "paths": { "@/*": ["/p/src/*"], "~/*": ["/p/lib/*"] } },
            })
        );
    }
}
