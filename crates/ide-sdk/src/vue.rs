//! Vue Language Server (Volar 3): the TypeScript it loads as a library, and the
//! `@vue/typescript-plugin` that vtsls' tsserver hosts for it (hybrid mode).

use crate::npm::{find_command, package_dir};
use std::ffi::OsStr;
use std::path::{Path, PathBuf};

pub(crate) const SERVER: &str = "vue-language-server";
const PACKAGE: &str = "@vue/language-server";
const PLUGIN: &str = "@vue/typescript-plugin";

/// The TypeScript `lib` directory has the language-service API (`typescript.js`).
/// TypeScript 7, the native port, ships only `tsc`.
pub(crate) fn has_ts_api(lib: &Path) -> bool {
    lib.join("typescript.js").is_file()
}

/// `@vue/language-server`'s directory for the `vue-language-server` command.
pub(crate) fn server_package(command: &str, path: &OsStr) -> Option<PathBuf> {
    package_dir(&find_command(command, path)?, PACKAGE)
}

/// The TypeScript `require('typescript')` resolves to from `package`, when usable.
pub(crate) fn own_typescript(package: &Path) -> Option<PathBuf> {
    package.ancestors().map(|a| a.join("node_modules").join("typescript").join("lib")).find(|l| has_ts_api(l))
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

pub(crate) fn missing_typescript_message() -> String {
    "Vue Language Server needs TypeScript 5 or 6 (TypeScript 7 has no language service API). \
     Reinstall it in Settings › Languages & Frameworks › Language Servers, add typescript@\"<7\" \
     to the project, or pick a TypeScript version in Settings › Languages & Frameworks › TypeScript."
        .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert_eq!(server_package(SERVER, &path), Some(t.join("tools/node_modules/@vue/language-server")));
        assert_eq!(server_package("not-installed", &path), None);
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
