//! The MDX language server (Volar) refuses to start without `typescript.tsdk`.

use crate::apply::{merge_init_options, setting_path, tsdk};
use crate::discover::workspace_tsdk;
use crate::npm::{own_typescript, package_dir};
use ide_core::settings::Settings;
use ide_core::tool_path::{find_command, search_path};
use ide_language::LanguageServerConfig;
use serde_json::json;
use std::ffi::OsString;
use std::path::Path;

pub(crate) const SERVER: &str = "mdx-language-server";

/// The TypeScript vtsls runs with: the selected version, else vtsls' bundled one.
/// Without vtsls, the one installed with the server, then the project's.
pub(crate) fn configure(cfg: &mut LanguageServerConfig, root: &Path, server_root: &Path, s: &Settings) {
    let explicit = |o: Option<&toml::Value>| o.and_then(|o| o.get("typescript")?.get("tsdk")).is_some();
    let overridden = s.language_servers.get(SERVER).and_then(|ls| ls.initialization_options.as_ref());
    if explicit(cfg.initialization_options.as_ref())
        || overridden.is_some_and(|o| o.pointer("/typescript/tsdk").is_some())
    {
        return;
    }
    let search = cfg.env.get("PATH").map_or_else(search_path, OsString::from);
    // Missing servers keep the normal install hint.
    let Some(bin) = find_command(&cfg.command, &search, server_root) else { return };
    let bundled = |command: &Path, package: &str| own_typescript(&package_dir(command, package)?);
    let vtsls = s
        .tool_path("vtsls")
        .and_then(|p| setting_path(root, p))
        .or_else(|| find_command("vtsls", &search, server_root));
    let lib = tsdk(server_root, s)
        .or_else(|| tsdk(root, s))
        .or_else(|| bundled(vtsls.as_deref()?, "@vtsls/language-server"))
        .or_else(|| bundled(&bin, "@mdx-js/language-server"))
        .or_else(|| workspace_tsdk(server_root))
        .or_else(|| workspace_tsdk(root));
    match lib {
        Some(lib) => merge_init_options(cfg, json!({ "typescript": { "tsdk": lib.to_string_lossy() } })),
        None => {
            cfg.launch_error = Some(
                "MDX Language Server needs TypeScript. Install typescript@6 in the project or select a TypeScript lib directory in Settings."
                    .into(),
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ide_core::LanguageId;
    use ide_language::LanguageRegistry;
    use std::path::PathBuf;

    fn touch(path: &Path) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, "{}").unwrap();
        #[cfg(unix)]
        std::fs::set_permissions(path, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    }

    fn bin(dir: &Path, name: &str) {
        touch(&dir.join("node_modules/.bin").join(if cfg!(windows) { format!("{name}.cmd") } else { name.into() }));
    }

    /// An npm install of `package` with command `bin` under `dir`, and its TypeScript lib.
    fn install(dir: &Path, package: &str, bin: &str, typescript: &Path) -> PathBuf {
        self::bin(dir, bin);
        touch(&dir.join("node_modules").join(package).join("package.json"));
        let lib = typescript.join("node_modules/typescript/lib");
        touch(&lib.join("typescript.js"));
        touch(&lib.join("tsserver.js"));
        lib
    }

    fn sdk(root: &Path, path: &[&Path], settings: &Settings) -> LanguageServerConfig {
        let reg = LanguageRegistry::load(None).unwrap();
        let mut cfg = reg.get(&LanguageId::new("mdx")).unwrap().language_servers.remove(0);
        let bins: Vec<PathBuf> = path.iter().map(|p| p.join("node_modules/.bin")).collect();
        cfg.env.insert("PATH".into(), std::env::join_paths(bins).unwrap().to_string_lossy().into_owned());
        configure(&mut cfg, root, root, settings);
        cfg
    }

    fn tsdk_of(cfg: &LanguageServerConfig) -> Option<PathBuf> {
        let options = cfg.initialization_options.as_ref()?;
        assert_eq!(options.get("typescript")?.get("enabled")?.as_bool(), Some(true));
        Some(PathBuf::from(options.get("typescript")?.get("tsdk")?.as_str()?))
    }

    #[test]
    fn uses_the_typescript_of_vtsls_then_its_own_then_the_project() {
        let tmp = tempfile::tempdir().unwrap();
        let t = dunce::canonicalize(tmp.path()).unwrap();
        let (mdx, vtsls, project) = (t.join("mdx"), t.join("vtsls"), t.join("project"));
        let own = install(&mdx, "@mdx-js/language-server", SERVER, &mdx);
        let vtsls_lib =
            install(&vtsls, "@vtsls/language-server", "vtsls", &vtsls.join("node_modules/@vtsls/language-server"));
        let workspace = project.join("node_modules/typescript/lib");
        touch(&workspace.join("tsserver.js"));
        let mut settings = Settings::default();

        assert_eq!(tsdk_of(&sdk(&project, &[&mdx], &settings)), Some(own));
        assert_eq!(tsdk_of(&sdk(&project, &[&mdx, &vtsls], &settings)), Some(vtsls_lib));
        settings.languages.typescript.version = "workspace".into();
        assert_eq!(tsdk_of(&sdk(&project, &[&mdx, &vtsls], &settings)), Some(workspace));

        // Missing server: the usual install hint, nothing derived.
        let missing = sdk(&project, &[&vtsls], &settings);
        assert_eq!((tsdk_of(&missing), missing.launch_error), (None, None));
        // No TypeScript anywhere.
        let bare = t.join("bare");
        bin(&bare, SERVER);
        let none = sdk(&t.join("empty"), &[&bare], &Settings::default());
        assert_eq!(tsdk_of(&none), None);
        assert!(none.launch_error.unwrap().contains("TypeScript"));
    }
}
