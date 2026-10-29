//! Tool versions a project pins for mise / asdf (`mise.toml`, `.tool-versions`), and the
//! installs that match them.

use ide_core::version_managers::{self, Manager, Tool};
use std::path::{Path, PathBuf};

/// mise's config files in a directory, the one that wins first; `.tool-versions` (asdf's,
/// read by mise too) last.
const CONFIG_FILES: [&str; 9] = [
    "mise.local.toml",
    ".mise.local.toml",
    "mise.toml",
    ".mise.toml",
    "mise/config.toml",
    ".mise/config.toml",
    ".config/mise.toml",
    ".config/mise/config.toml",
    ".tool-versions",
];

/// The version of `tool` pinned for `root`: the closest directory from `root` up that
/// pins it, then the global config (`~/.config/mise/config.toml`).
pub fn pinned_version(root: &Path, tool: Tool) -> Option<String> {
    pinned_version_in(root, &global_configs(), tool)
}

fn pinned_version_in(root: &Path, global: &[PathBuf], tool: Tool) -> Option<String> {
    let files = root.ancestors().flat_map(|dir| CONFIG_FILES.iter().map(move |f| dir.join(f)));
    files.chain(global.iter().cloned()).find_map(|file| {
        let text = std::fs::read_to_string(&file).ok()?;
        if file.file_name().is_some_and(|n| n == ".tool-versions") {
            tool_versions_entry(&text, tool)
        } else {
            mise_toml_entry(&text, tool)
        }
    })
}

fn global_configs() -> Vec<PathBuf> {
    let var = |k: &str| ide_core::process::host_var_os(k).filter(|v| !v.is_empty()).map(PathBuf::from);
    if let Some(file) = var("MISE_GLOBAL_CONFIG_FILE") {
        return vec![file];
    }
    let dir = var("MISE_CONFIG_DIR")
        .or_else(|| var("XDG_CONFIG_HOME").map(|d| d.join("mise")))
        .or_else(|| crate::home_dir().map(|h| h.join(".config/mise")));
    dir.map(|d| vec![d.join("config.toml")]).unwrap_or_default()
}

/// The tool's key under `[tools]`: its name, or with a backend (`core:java`, `asdf:maven`).
fn is_key_for(key: &str, tool: Tool) -> bool {
    let name = key.rsplit_once(':').map_or(key, |(_, n)| n);
    let name = name.rsplit_once('/').map_or(name, |(_, n)| n);
    tool.names().contains(&name)
}

/// `node = "20"`, `python = ["3.12", "3.11"]` (the first) or `java = { version = "21" }`.
fn mise_toml_entry(text: &str, tool: Tool) -> Option<String> {
    let doc: toml::Table = toml::from_str(text).ok()?;
    let tools = doc.get("tools")?.as_table()?;
    let value = tools.iter().find(|(k, _)| is_key_for(k, tool)).map(|(_, v)| v)?;
    let first = match value {
        toml::Value::Array(a) => a.first()?,
        v => v,
    };
    let version = match first {
        toml::Value::String(s) => s.as_str(),
        toml::Value::Table(t) => t.get("version")?.as_str()?,
        _ => return None,
    };
    Some(version.trim().to_owned()).filter(|v| !v.is_empty())
}

/// `nodejs 20.11.0 18.19.0` (the first version).
fn tool_versions_entry(text: &str, tool: Tool) -> Option<String> {
    text.lines().find_map(|line| {
        let line = line.split('#').next()?;
        let mut words = line.split_whitespace();
        let name = words.next()?;
        is_key_for(name, tool).then(|| words.next().map(str::to_owned))?
    })
}

/// Numbers in a version, for ordering (`temurin-21.0.2+13` → 21, 0, 2, 13).
fn version_key(v: &str) -> Vec<u64> {
    v.split(|c: char| !c.is_ascii_digit()).filter_map(|n| n.parse().ok()).collect()
}

/// Whether the install `dir_name` is what mise resolves `version` to: the same name, or a
/// longer one it is a prefix of (`21` → `21.0.2`, `temurin-21` → `temurin-21.0.2+13.0.LTS`).
fn matches(dir_name: &str, version: &str) -> bool {
    dir_name == version || dir_name.strip_prefix(version).is_some_and(|rest| rest.starts_with(['.', '-', '+', '_']))
}

/// The install of `tool` that `version` selects among `managers`' installs.
fn install_for(managers: &[Manager], tool: Tool, version: &str) -> Option<(PathBuf, &'static str)> {
    if let Some(path) = version.strip_prefix("path:") {
        let path = PathBuf::from(path.trim());
        return path.is_dir().then_some((path, version_managers::MISE));
    }
    managers.iter().find_map(|m| {
        if let Some(exact) = m.install_named(tool, version) {
            return Some((dunce::canonicalize(&exact).unwrap_or(exact), m.name));
        }
        let installs = m.installs(tool);
        let name = |p: &PathBuf| p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let best = if version == "latest" {
            installs.into_iter().max_by_key(|p| version_key(&name(p)))
        } else {
            installs.into_iter().filter(|p| matches(&name(p), version)).max_by_key(|p| version_key(&name(p)))
        };
        best.map(|p| (p, m.name))
    })
}

/// The mise / asdf install of `tool` that `root` pins, with the manager's name.
pub fn pinned_install(root: &Path, tool: Tool) -> Option<(PathBuf, &'static str)> {
    let version = pinned_version(root, tool)?;
    install_for(&version_managers::managers(), tool, &version)
}

/// The pinned Python's executable.
pub(crate) fn pinned_python(root: &Path) -> Option<PathBuf> {
    let (dir, _) = pinned_install(root, Tool::Python)?;
    python_in_install(&dir)
}

/// `bin/python3` of a Python install (`python.exe` at its root on Windows).
pub(crate) fn python_in_install(dir: &Path) -> Option<PathBuf> {
    let candidates = if cfg!(windows) {
        vec![dir.join("python.exe")]
    } else {
        vec![dir.join("bin/python3"), dir.join("bin/python")]
    };
    candidates.into_iter().find(|p| p.is_file())
}

/// A Go install's GOROOT: the install itself (mise) or its `go` folder (asdf).
pub(crate) fn goroot_in_install(dir: &Path) -> Option<PathBuf> {
    [dir.to_path_buf(), dir.join("go")].into_iter().find(|d| d.join("bin").join(crate::exe("go")).is_file())
}

/// A JDK install's home: the install itself, or `Contents/Home` of a macOS bundle.
pub(crate) fn jdk_in_install(dir: &Path) -> Option<crate::java::Jdk> {
    [dir.join("Contents/Home"), dir.to_path_buf()].iter().find_map(|h| crate::java::jdk_at(h))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    #[test]
    fn reads_mise_toml_forms() {
        let toml = r#"
            [env]
            NODE_ENV = "dev"
            [tools]
            node = "20"
            python = ["3.12", "3.11"]
            "core:java" = { version = "temurin-21", os = ["macos"] }
            "asdf:mise-plugins/mise-maven" = "3.9.6"
        "#;
        assert_eq!(mise_toml_entry(toml, Tool::Node).as_deref(), Some("20"));
        assert_eq!(mise_toml_entry(toml, Tool::Python).as_deref(), Some("3.12"));
        assert_eq!(mise_toml_entry(toml, Tool::Java).as_deref(), Some("temurin-21"));
        assert_eq!(mise_toml_entry(toml, Tool::Maven).as_deref(), None, "the plugin is mise-maven, not maven");
        assert_eq!(mise_toml_entry("[tools]\nmaven = '3.9.6'\n", Tool::Maven).as_deref(), Some("3.9.6"));
        assert_eq!(mise_toml_entry(toml, Tool::Go), None);
        assert_eq!(mise_toml_entry("not toml [", Tool::Node), None);
    }

    #[test]
    fn reads_tool_versions() {
        let text = "# pinned\nnodejs 20.11.0 18.19.0\ngolang 1.22.1 # comment\njava\n";
        assert_eq!(tool_versions_entry(text, Tool::Node).as_deref(), Some("20.11.0"));
        assert_eq!(tool_versions_entry(text, Tool::Go).as_deref(), Some("1.22.1"));
        assert_eq!(tool_versions_entry(text, Tool::Java), None);
        assert_eq!(tool_versions_entry(text, Tool::Python), None);
    }

    #[test]
    fn the_closest_config_wins_then_the_global_one() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");
        let app = repo.join("apps/web");
        std::fs::create_dir_all(&app).unwrap();
        let global = tmp.path().join("global/config.toml");
        write(&global, "[tools]\nnode = 'lts'\npython = '3.13'\ngo = '1.23'\n");
        write(&repo.join("mise.toml"), "[tools]\nnode = '20'\njava = '21'\n");
        write(&repo.join(".tool-versions"), "nodejs 18.0.0\npython 3.11.9\n");
        write(&app.join(".mise.toml"), "[tools]\nnode = '22'\n");
        let g = [global];
        assert_eq!(pinned_version_in(&app, &g, Tool::Node).as_deref(), Some("22"));
        assert_eq!(pinned_version_in(&repo, &g, Tool::Node).as_deref(), Some("20"), "mise.toml over .tool-versions");
        assert_eq!(pinned_version_in(&app, &g, Tool::Python).as_deref(), Some("3.11.9"));
        assert_eq!(pinned_version_in(&app, &g, Tool::Java).as_deref(), Some("21"));
        assert_eq!(pinned_version_in(&app, &g, Tool::Go).as_deref(), Some("1.23"));
        assert_eq!(pinned_version_in(&app, &g, Tool::Gradle), None);
        write(&repo.join("mise.local.toml"), "[tools]\nnode = '21'\n");
        assert_eq!(pinned_version_in(&repo, &g, Tool::Node).as_deref(), Some("21"));
    }

    #[test]
    fn prefixes_resolve_to_the_newest_matching_install() {
        assert!(matches("21.0.2", "21"));
        assert!(matches("temurin-21.0.2+13.0.LTS", "temurin-21"));
        assert!(!matches("210.0", "21"));
        assert!(!matches("3.1.0", "3.12"));
        let tmp = tempfile::tempdir().unwrap();
        let mise = Manager { name: version_managers::MISE, dir: tmp.path().join("mise") };
        let asdf = Manager { name: version_managers::ASDF, dir: tmp.path().join("asdf") };
        for v in ["20.9.0", "20.11.1", "22.1.0"] {
            std::fs::create_dir_all(mise.dir.join("installs/node").join(v)).unwrap();
        }
        std::fs::create_dir_all(asdf.dir.join("installs/nodejs/18.19.0")).unwrap();
        let managers = [mise.clone(), asdf.clone()];
        let pick = |v: &str| install_for(&managers, Tool::Node, v).map(|(p, m)| (p.file_name().unwrap().to_owned(), m));
        assert_eq!(pick("20"), Some(("20.11.1".into(), "mise")));
        assert_eq!(pick("22.1.0"), Some(("22.1.0".into(), "mise")));
        assert_eq!(pick("latest"), Some(("22.1.0".into(), "mise")));
        assert_eq!(pick("18"), Some(("18.19.0".into(), "asdf")));
        assert_eq!(pick("16"), None);
        let external = tmp.path().join("node-dev");
        std::fs::create_dir_all(&external).unwrap();
        let path = format!("path:{}", external.display());
        assert_eq!(install_for(&managers, Tool::Node, &path), Some((external, "mise")));
    }
}
