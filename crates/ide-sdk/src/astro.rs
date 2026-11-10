//! Astro (Volar) requires a TypeScript language-service library at initialize.

use crate::apply::{merge_init_options, setting_path, tsdk};
use crate::npm::{has_ts_api, own_typescript, package_dir};
use ide_core::settings::Settings;
use ide_core::tool_path::{find_command, search_path};
use ide_language::LanguageServerConfig;
use serde_json::json;
use std::ffi::OsString;
use std::path::Path;

pub(crate) const SERVER: &str = "astro-ls";

pub(crate) fn configure(cfg: &mut LanguageServerConfig, root: &Path, server_root: &Path, s: &Settings) {
    let overrides = s.language_servers.get(SERVER);
    let search = overrides
        .and_then(|server| server.env.get("PATH"))
        .or_else(|| cfg.env.get("PATH"))
        .map_or_else(search_path, OsString::from);
    // A project's installation wins over managed / global tools. Explicit
    // executable settings still win, as they do for other language servers.
    if cfg.command == SERVER
        && let Some(bin) = server_root
            .ancestors()
            .take_while(|dir| dir.starts_with(root))
            .find_map(|dir| find_command(SERVER, dir.join("node_modules/.bin").as_os_str(), server_root))
    {
        cfg.command = bin.to_string_lossy().into_owned();
    }
    // Missing servers use the normal install hint and installation flow.
    let Some(bin) = find_command(&cfg.command, &search, server_root) else { return };
    cfg.command = bin.to_string_lossy().into_owned();
    let node = setting_path(root, &s.languages.node.interpreter).filter(|p| p.is_file()).or_else(|| {
        s.languages.node.interpreter.trim().is_empty().then(|| find_command("node", &search, server_root)).flatten()
    });
    if node.is_none() || find_command("node", &search, server_root).is_none() {
        cfg.launch_error = Some(
            "Astro Language Server needs Node.js. Install it or select its executable in Settings › Languages & Frameworks › Node.js."
                .into(),
        );
        return;
    }

    // Respect an explicit initialization option before the shared SDK setting.
    let explicit = overrides
        .and_then(|ls| ls.initialization_options.as_ref())
        .and_then(|v| v.pointer("/typescript/tsdk"))
        .and_then(|v| v.as_str())
        .and_then(|p| setting_path(server_root, p));
    let explicit = explicit.or_else(|| {
        cfg.initialization_options
            .as_ref()?
            .get("typescript")?
            .get("tsdk")?
            .as_str()
            .and_then(|p| setting_path(server_root, p))
    });
    let selected = explicit.or_else(|| {
        if s.languages.typescript.version.trim() == "workspace" { tsdk(server_root, s) } else { tsdk(root, s) }
    });
    let lib = if let Some(lib) = selected {
        // An invalid explicit SDK is a settings error; silently using another
        // version would hide it. TypeScript 7 has no language-service API.
        has_ts_api(&lib).then_some(lib)
    } else {
        server_root
            .ancestors()
            .take_while(|dir| dir.starts_with(root))
            .map(|dir| dir.join("node_modules/typescript/lib"))
            .find(|lib| has_ts_api(lib))
            .or_else(|| {
                let package = package_dir(&bin, "@astrojs/language-server").or_else(|| {
                    crate::npm::shim_package(&bin, "@astrojs/language-server", &search, server_root, &cfg.env)
                })?;
                let real = dunce::canonicalize(&package).unwrap_or_else(|_| package.clone());
                own_typescript(&real).or_else(|| own_typescript(&package))
            })
    };
    match lib {
        Some(lib) => merge_init_options(cfg, json!({ "typescript": { "tsdk": lib.to_string_lossy() } })),
        None => {
            cfg.launch_error = Some(
                "Astro Language Server needs a TypeScript language-service library. Install typescript@6 in the project or select a TypeScript lib directory in Settings."
                    .into(),
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::apply::{configure_server, language_servers, server_launch_overrides, server_protocol_overrides};
    use ide_core::LanguageId;
    use ide_language::LanguageRegistry;
    use std::path::PathBuf;

    fn touch(path: &Path) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, "{}").unwrap();
        #[cfg(unix)]
        std::fs::set_permissions(path, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    }

    fn binary(dir: &Path, name: &str) -> PathBuf {
        let bin = dir.join(if cfg!(windows) { format!("{name}.cmd") } else { name.into() });
        touch(&bin);
        bin
    }

    fn config() -> LanguageServerConfig {
        LanguageRegistry::load(None).unwrap().get(&LanguageId::new("astro")).unwrap().language_servers.remove(0)
    }

    fn configured(tmp: &Path, command: &Path, settings: &Settings) -> LanguageServerConfig {
        let mut cfg = config();
        cfg.command = command.to_string_lossy().into_owned();
        let node = binary(&tmp.join("runtime"), "node");
        let mut settings = settings.clone();
        settings.languages.node.interpreter = node.to_string_lossy().into_owned();
        server_launch_overrides(&mut cfg, &settings);
        configure_server(&mut cfg, &tmp.join("project"), &tmp.join("project/apps/web"), &settings);
        server_protocol_overrides(&mut cfg, &settings);
        cfg
    }

    fn sdk(cfg: &LanguageServerConfig) -> Option<PathBuf> {
        Some(PathBuf::from(cfg.initialization_options.as_ref()?.get("typescript")?.get("tsdk")?.as_str()?))
    }

    #[test]
    fn project_sdk_then_managed_sdk_with_explicit_settings_winning() {
        let tmp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(tmp.path()).unwrap();
        let t = root.as_path();
        let bin = binary(&t.join("tools/node_modules/.bin"), SERVER);
        touch(&t.join("tools/node_modules/@astrojs/language-server/package.json"));
        let managed = t.join("tools/node_modules/typescript/lib");
        touch(&managed.join("typescript.js"));
        assert_eq!(sdk(&configured(t, &bin, &Settings::default())), Some(managed.clone()));
        let workspace = t.join("project/node_modules/typescript/lib");
        touch(&workspace.join("typescript.js"));
        assert_eq!(sdk(&configured(t, &bin, &Settings::default())), Some(workspace));
        let member = t.join("project/apps/web/node_modules/typescript/lib");
        touch(&member.join("typescript.js"));
        assert_eq!(sdk(&configured(t, &bin, &Settings::default())), Some(member));
        let mut s = Settings::default();
        s.languages.typescript.version = managed.to_string_lossy().into_owned();
        assert_eq!(sdk(&configured(t, &bin, &s)), Some(managed));
        let custom = t.join("custom lib");
        touch(&custom.join("typescript.js"));
        s.language_servers.entry(SERVER.into()).or_default().initialization_options =
            Some(json!({ "typescript": { "tsdk": custom }, "customOption": true }));
        assert_eq!(sdk(&configured(t, &bin, &s)), Some(custom));
    }

    #[test]
    fn local_server_is_preferred_but_an_explicit_command_is_preserved() {
        let tmp = tempfile::tempdir().unwrap();
        let t = tmp.path();
        let local = binary(&t.join("project/apps/web/node_modules/.bin"), SERVER);
        touch(&t.join("project/node_modules/typescript/lib/typescript.js"));
        let cfg = configured(t, Path::new(SERVER), &Settings::default());
        assert_eq!(Path::new(&cfg.command), local);
        assert!(cfg.launch_error.is_none());
        let custom = binary(&t.join("custom"), SERVER);
        assert_eq!(Path::new(&configured(t, &custom, &Settings::default()).command), custom);
        // Existing global/project enable switches use the ordinary lifecycle.
        let mut s = Settings::default();
        s.language_servers.entry(SERVER.into()).or_default().enabled = false;
        assert!(language_servers("astro", &[config()], &s).is_empty());
    }

    #[test]
    fn missing_node_or_typescript_is_actionable_and_missing_server_can_be_installed() {
        let tmp = tempfile::tempdir().unwrap();
        let t = tmp.path();
        let bin = binary(&t.join("tools/node_modules/.bin"), SERVER);
        let mut cfg = config();
        cfg.command = bin.to_string_lossy().into_owned();
        cfg.env.insert("PATH".into(), String::new());
        configure(&mut cfg, t, t, &Settings::default());
        assert!(cfg.launch_error.unwrap().contains("Node.js"));
        let cfg = configured(t, &bin, &Settings::default());
        assert!(cfg.launch_error.unwrap().contains("TypeScript language-service library"));
        // A native TypeScript compiler is not a language-service library.
        touch(&t.join("project/node_modules/typescript/lib/tsc.js"));
        assert!(configured(t, &bin, &Settings::default()).launch_error.is_some());
        // An invalid explicit SDK does not silently fall back to the project.
        touch(&t.join("project/node_modules/typescript/lib/typescript.js"));
        let mut s = Settings::default();
        s.languages.typescript.version = "missing/lib".into();
        assert!(configured(t, &bin, &s).launch_error.is_some());
        let mut cfg = config();
        cfg.command = t.join("missing/astro-ls").to_string_lossy().into_owned();
        configure(&mut cfg, t, t, &Settings::default());
        assert!(cfg.launch_error.is_none());
        assert!(cfg.install_hint.unwrap().contains("@astrojs/language-server"));
    }

    #[test]
    fn relative_sdk_settings_remain_resolved_after_protocol_overrides() {
        let tmp = tempfile::tempdir().unwrap();
        let t = tmp.path();
        let bin = binary(&t.join("tools/node_modules/.bin"), SERVER);
        let lib = t.join("project/apps/web/custom lib");
        touch(&lib.join("typescript.js"));
        let mut s = Settings::default();
        s.language_servers.entry(SERVER.into()).or_default().initialization_options =
            Some(json!({ "typescript": { "tsdk": "custom lib" }, "customOption": true }));
        let cfg = configured(t, &bin, &s);
        assert_eq!(sdk(&cfg), Some(lib));
        assert_eq!(cfg.initialization_options.unwrap()["customOption"].as_bool(), Some(true));
    }

    #[test]
    fn node_must_be_available_on_the_servers_effective_path() {
        let tmp = tempfile::tempdir().unwrap();
        let t = tmp.path();
        let bin = binary(&t.join("tools/node_modules/.bin"), SERVER);
        touch(&t.join("project/node_modules/typescript/lib/typescript.js"));
        let mut s = Settings::default();
        s.language_servers.entry(SERVER.into()).or_default().env.insert("PATH".into(), String::new());
        let cfg = configured(t, &bin, &s);
        assert!(cfg.launch_error.is_some_and(|e| e.contains("Node.js")));
    }
}
