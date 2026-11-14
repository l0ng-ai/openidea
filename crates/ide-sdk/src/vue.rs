//! Vue Language Server (Volar 3): the TypeScript it loads as a library, and the
//! `@vue/typescript-plugin` that vtsls' tsserver hosts for it (hybrid mode).

use crate::libraries::{Stamp, package_dependencies, stamp};
use crate::npm::{find_command, package_dir};
use std::collections::{BTreeMap, HashMap};
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

pub(crate) const SERVER: &str = "vue-language-server";
const PACKAGE: &str = "@vue/language-server";
const PLUGIN: &str = "@vue/typescript-plugin";
/// The file extension the plugin adds to tsserver.
pub(crate) const EXTENSION: &str = "vue";
const CLI_SERVICE: &str = "@vue/cli-service";
const CLI_CONFIG_TIMEOUT: Duration = Duration::from_secs(30);
const ALIASES_MARKER: &str = "openidea-webpack-aliases:";
/// Prints the `resolve.alias` of the webpack configuration module `argv[1]` (an object, an
/// ES module's default, a function of the environment, or a list of configurations), after
/// whatever the configuration itself prints.
const PRINT_ALIASES: &str = "let c = require(process.argv[1]); if (c && c.__esModule) c = c.default; \
    if (typeof c === 'function') c = c({}, { mode: 'development' }); if (Array.isArray(c)) c = c[0]; \
    const a = (c && c.resolve && c.resolve.alias) || {}; \
    const e = Array.isArray(a) ? a.map((x) => [x.name, x.alias]) : Object.entries(a); \
    process.stdout.write('\\n' + process.argv[2] + JSON.stringify(e));";
/// Webpack configurations of Vue projects without Vue CLI: the project's own, and the
/// `vue init webpack` (Vue CLI 2) template's.
const WEBPACK_CONFIGS: &[&str] =
    &["webpack.config.js", "webpack.config.cjs", "build/webpack.base.conf.js", "build/webpack.dev.conf.js"];

type Paths = BTreeMap<String, Vec<String>>;
static CLI_PATHS: LazyLock<Mutex<HashMap<PathBuf, (Stamp, Paths)>>> = LazyLock::new(Default::default);

/// `@vue/language-server`'s directory for the `vue-language-server` command.
pub(crate) fn server_package(command: &str, path: &OsStr) -> Option<PathBuf> {
    package_dir(&find_command(command, path)?, PACKAGE)
}

/// vtsls `globalPlugins` entry loading the Vue plugin shipped with `package`.
pub(crate) fn tsserver_plugin(package: &Path) -> serde_json::Value {
    serde_json::json!({
        "name": PLUGIN,
        "location": package.to_string_lossy(),
        "languages": ["vue"],
        "configNamespace": "typescript",
        "enableForWorkspaceTypeScriptVersions": true,
    })
}

/// `compilerOptions.paths` for the webpack aliases of a Vue project at `root` (`@/*` →
/// `<root>/src/*`), for its tsserver project when it has no `jsconfig.json`: tsserver can't
/// read webpack configurations, so `@/` imports resolve to nothing, and a mixin imported
/// that way makes the component's whole `this` `any`. Like IntelliJ, evaluates the webpack
/// configuration (the project is trusted: language servers only run then): the one
/// `@vue/cli-service` resolves with the project's `vue.config.js`, else the project's own
/// (`webpack.config.js`, Vue CLI 2's `build/webpack.base.conf.js`). Without one (Vite, or
/// no Node), the `@` → `src` alias every Vue template sets up. Empty for other projects.
pub(crate) fn cli_paths(root: &Path, node: Option<&Path>) -> Paths {
    let Ok(manifest) = std::fs::read_to_string(root.join("package.json")) else { return Paths::new() };
    let dependencies = package_dependencies(&manifest);
    let cli = dependencies.iter().any(|d| d == CLI_SERVICE);
    if !cli && !dependencies.iter().any(|d| d == "vue") {
        return Paths::new();
    }
    let config = if cli {
        root.ancestors()
            .map(|dir| dir.join("node_modules").join(CLI_SERVICE).join("webpack.config.js"))
            .find(|f| f.is_file())
    } else {
        WEBPACK_CONFIGS.iter().map(|f| root.join(f)).find(|f| f.is_file())
    };
    let mut inputs: Vec<PathBuf> = ["package.json", "vue.config.js", "vue.config.cjs", "vue.config.mjs"]
        .iter()
        .chain(WEBPACK_CONFIGS)
        .map(|f| root.join(f))
        .collect();
    inputs.extend(config.iter().cloned());
    inputs.extend(node.map(Path::to_path_buf));
    let now = stamp(&inputs);
    if let Some((then, paths)) = CLI_PATHS.lock().unwrap_or_else(|e| e.into_inner()).get(root)
        && *then == now
    {
        return paths.clone();
    }
    let aliases = config
        .zip(node)
        .and_then(|(config, node)| webpack_aliases(root, &config, node))
        .filter(|aliases| !aliases.is_empty())
        .unwrap_or_else(|| vec![("@".into(), root.join("src").to_string_lossy().into_owned())]);
    let paths = alias_paths(&aliases);
    CLI_PATHS.lock().unwrap_or_else(|e| e.into_inner()).insert(root.to_path_buf(), (now, paths.clone()));
    paths
}

/// `[alias, target]` pairs of the webpack configuration module `config`.
fn webpack_aliases(root: &Path, config: &Path, node: &Path) -> Option<Vec<(String, String)>> {
    let root_s = root.to_string_lossy();
    let out = crate::exec::query_in(
        node,
        &["-e", PRINT_ALIASES, &config.to_string_lossy(), ALIASES_MARKER],
        Some(root),
        &[("VUE_CLI_CONTEXT", &root_s), ("NODE_ENV", "development")],
        CLI_CONFIG_TIMEOUT,
    );
    let json = out.as_deref().and_then(|o| o.rsplit_once(ALIASES_MARKER)).map(|(_, json)| json);
    let Some(pairs) = json.and_then(|j| serde_json::from_str::<Vec<(serde_json::Value, serde_json::Value)>>(j).ok())
    else {
        tracing::debug!("no webpack aliases from {}", config.display());
        return None;
    };
    Some(
        pairs
            .into_iter()
            .filter_map(|(name, target)| Some((name.as_str()?.to_owned(), target.as_str()?.to_owned())))
            .collect(),
    )
}

/// Directory aliases as `paths`; `name$` (exact module) and file aliases have no equivalent.
fn alias_paths(aliases: &[(String, String)]) -> Paths {
    let mut paths = Paths::new();
    for (name, target) in aliases {
        let dir = Path::new(target);
        if name.is_empty() || name.ends_with('$') || name.contains('*') || !dir.is_absolute() || !dir.is_dir() {
            continue;
        }
        let dir = target.replace('\\', "/");
        let dir = dir.trim_end_matches('/');
        paths.insert(format!("{name}/*"), vec![format!("{dir}/*")]);
        paths.insert(name.clone(), vec![dir.to_owned()]);
    }
    paths
}

pub(crate) fn missing_typescript_message() -> String {
    "Vue Language Server needs TypeScript 5 or 6 (TypeScript 7 has no language service API). \
     Reinstall it in Settings › Languages & Frameworks › Language Servers, add typescript@6 \
     to the project, or pick a TypeScript version in Settings › Languages & Frameworks › TypeScript."
        .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::npm::own_typescript;

    fn touch(p: &Path) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, "{}").unwrap();
    }

    #[test]
    fn finds_the_package_of_every_npm_install_layout() {
        let tmp = tempfile::tempdir().unwrap();
        let t = tmp.path();
        // (executable, package.json) per layout.
        let layouts = [
            // The IDE's tools dir / a project: node_modules/.bin shim.
            ("tools/node_modules/.bin/vue-language-server", "tools/node_modules/@vue/language-server/package.json"),
            // Windows global: %APPDATA%\npm\vue-language-server(.cmd) + %APPDATA%\npm\node_modules.
            ("npm/vue-language-server", "npm/node_modules/@vue/language-server/package.json"),
            // Unix global prefix: <prefix>/bin + <prefix>/lib/node_modules.
            ("prefix/bin/vue-language-server", "prefix/lib/node_modules/@vue/language-server/package.json"),
        ];
        for (bin, pkg) in layouts {
            touch(&t.join(bin));
            touch(&t.join(pkg));
            let found = server_package(&t.join(bin).to_string_lossy(), OsStr::new(""));
            assert_eq!(found, Some(t.join(pkg).parent().unwrap().to_path_buf()), "{bin}");
        }
        let path = std::env::join_paths([t.join("tools/node_modules/.bin")]).unwrap();
        // npm's `.bin` shims on Windows get a `.cmd` (or `.exe`) name; the bare
        // name is not executable there.
        let shim = if cfg!(windows) { "vue-language-server.cmd" } else { SERVER };
        touch(&t.join("tools/node_modules/.bin").join(shim));
        assert_eq!(server_package(SERVER, &path), Some(t.join("tools/node_modules/@vue/language-server")));
        assert_eq!(server_package("not-installed", &path), None);
    }

    fn cli_project(t: &Path) {
        std::fs::create_dir_all(t.join("src/components")).unwrap();
        std::fs::write(t.join("package.json"), r#"{"devDependencies":{"@vue/cli-service":"~5.0.0"}}"#).unwrap();
    }

    #[test]
    fn vue_cli_projects_get_the_at_alias_without_their_webpack_configuration() {
        let tmp = tempfile::tempdir().unwrap();
        let t = tmp.path();
        std::fs::write(t.join("package.json"), r#"{"dependencies":{"vue":"^2.6.14"}}"#).unwrap();
        assert!(cli_paths(t, None).is_empty());
        cli_project(t);
        let src = t.join("src").to_string_lossy().replace('\\', "/");
        assert_eq!(
            cli_paths(t, None),
            Paths::from([("@".into(), vec![src.clone()]), ("@/*".into(), vec![format!("{src}/*")])])
        );
    }

    #[test]
    fn other_vue_projects_get_their_webpack_aliases_else_the_at_alias() {
        let tmp = tempfile::tempdir().unwrap();
        // As `__dirname` sees it (macOS: /private/var).
        let t = &dunce::canonicalize(tmp.path()).unwrap();
        std::fs::write(t.join("package.json"), r#"{"dependencies":{"react":"^18.0.0"}}"#).unwrap();
        std::fs::create_dir_all(t.join("src/views")).unwrap();
        assert!(cli_paths(t, None).is_empty(), "not a Vue project");
        std::fs::write(t.join("package.json"), r#"{"dependencies":{"vue":"^2.6.14"}}"#).unwrap();
        let slash = |p: PathBuf| p.to_string_lossy().replace('\\', "/");
        let (src, views) = (slash(t.join("src")), slash(t.join("src/views")));
        let at = Paths::from([("@".into(), vec![src.clone()]), ("@/*".into(), vec![format!("{src}/*")])]);
        assert_eq!(cli_paths(t, None), at, "Vite or no Node: the template alias");
        let Some(node) = crate::exec::which("node") else { return };
        // `vue init webpack`: a function of the environment is called, its aliases taken.
        std::fs::create_dir_all(t.join("build")).unwrap();
        std::fs::write(
            t.join("build/webpack.base.conf.js"),
            r#"const path = require('path');
const resolve = (dir) => path.join(__dirname, '..', dir);
module.exports = (env) => ({ resolve: { alias: { vue$: 'vue/dist/vue.esm.js', '@': resolve('src'), views: resolve('src/views') } } });"#,
        )
        .unwrap();
        assert_eq!(
            cli_paths(t, Some(&node)),
            Paths::from([
                ("@".into(), vec![src.clone()]),
                ("@/*".into(), vec![format!("{src}/*")]),
                ("views".into(), vec![views.clone()]),
                ("views/*".into(), vec![format!("{views}/*")]),
            ])
        );
        // A configuration that can't be loaded (dependencies not installed): the template alias.
        std::fs::write(t.join("build/webpack.base.conf.js"), "require('not-installed-plugin');").unwrap();
        assert_eq!(cli_paths(t, Some(&node)), at);
    }

    #[test]
    fn vue_cli_aliases_come_from_the_resolved_webpack_configuration() {
        let Some(node) = crate::exec::which("node") else { return };
        let tmp = tempfile::tempdir().unwrap();
        let t = tmp.path();
        cli_project(t);
        let service = t.join("node_modules/@vue/cli-service");
        std::fs::create_dir_all(&service).unwrap();
        // What `vue.config.js` can add, and what the configuration may print while loading.
        std::fs::write(
            service.join("webpack.config.js"),
            r#"const path = require('path');
console.log('loading plugins');
module.exports = { resolve: { alias: {
  '@': path.join(process.env.VUE_CLI_CONTEXT, 'src'),
  comps: path.join(process.env.VUE_CLI_CONTEXT, 'src/components'),
  vue$: 'vue/dist/vue.runtime.esm.js',
  missing: path.join(process.env.VUE_CLI_CONTEXT, 'nowhere'),
} } };"#,
        )
        .unwrap();
        let slash = |p: PathBuf| p.to_string_lossy().replace('\\', "/");
        let (src, comps) = (slash(t.join("src")), slash(t.join("src/components")));
        assert_eq!(
            cli_paths(t, Some(&node)),
            Paths::from([
                ("@".into(), vec![src.clone()]),
                ("@/*".into(), vec![format!("{src}/*")]),
                ("comps".into(), vec![comps.clone()]),
                ("comps/*".into(), vec![format!("{comps}/*")]),
            ])
        );
    }

    #[test]
    fn own_typescript_skips_typescript_7() {
        let tmp = tempfile::tempdir().unwrap();
        let pkg = tmp.path().join("node_modules/@vue/language-server");
        touch(&pkg.join("package.json"));
        // TypeScript 7 ships only `tsc`.
        touch(&tmp.path().join("node_modules/typescript/lib/tsc.js"));
        assert_eq!(own_typescript(&pkg), None);
        touch(&tmp.path().join("node_modules/typescript/lib/typescript.js"));
        assert_eq!(own_typescript(&pkg), Some(tmp.path().join("node_modules/typescript/lib")));
    }
}
