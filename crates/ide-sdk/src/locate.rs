//! Locating runtimes for "run this file" (IDEA's run-context producers): an
//! executable per name, project-local `node_modules/.bin` first, then the
//! search path, with the version of the tools whose version picks the command
//! line (`node` → type stripping, `rustc` → edition). Versions are cached by
//! path and modification time, so repeated lookups only stat files.

use crate::exec::{query, search_path};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime};

/// One looked-up executable.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LocatedTool {
    pub name: String,
    /// Absolute path, `None` when not found.
    pub path: Option<ide_core::IpcPath>,
    /// `22.6.0`, `1.85.0-nightly`; only for tools whose version matters.
    pub version: Option<String>,
}

/// Tools whose `--version` output is queried.
const VERSIONED: &[&str] = &["node", "rustc", "deno", "bun"];
const VERSION_TIMEOUT: Duration = Duration::from_secs(4);
/// `node_modules/.bin` lookups walk at most this many ancestors.
const MAX_ANCESTORS: usize = 12;

/// Accepts bare command names only (no paths, no shell syntax).
fn valid_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 64 && name.chars().all(|c| c.is_ascii_alphanumeric() || "._+-".contains(c))
}

/// `node_modules/.bin/<name>` (`<name>.cmd` on Windows) in `near` or an ancestor.
fn local_bin(near: &Path, name: &str) -> Option<PathBuf> {
    let pathext = std::env::var("PATHEXT").ok();
    let names = ide_run::which::executable_names(name, cfg!(windows), pathext.as_deref());
    near.ancestors().take(MAX_ANCESTORS).find_map(|dir| {
        let bin = dir.join("node_modules").join(".bin");
        names.iter().map(|n| bin.join(n)).find(|p| p.is_file())
    })
}

/// On the search path; on Windows through `PATHEXT` (`kotlinc.bat`, `npx.cmd`).
fn on_path(name: &str, search: &std::ffi::OsStr) -> Option<PathBuf> {
    ide_run::which::find_executable(name, search)
}

/// `v22.6.0` → `22.6.0`; `rustc 1.85.0-nightly (…)` → `1.85.0-nightly`.
pub fn parse_tool_version(output: &str) -> Option<String> {
    output.split_whitespace().map(|w| w.trim_start_matches('v')).find_map(|w| {
        let first = w.split('.').next()?;
        (w.contains('.') && !first.is_empty() && first.chars().all(|c| c.is_ascii_digit()))
            .then(|| w.trim_end_matches(|c: char| !c.is_ascii_alphanumeric()).to_owned())
    })
}

type VersionCache = Mutex<HashMap<PathBuf, (Option<SystemTime>, Option<String>)>>;

fn version_of(path: &Path) -> Option<String> {
    static CACHE: OnceLock<VersionCache> = OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    let mtime = std::fs::metadata(path).and_then(|m| m.modified()).ok();
    if let Some((_, version)) = cache.lock().ok()?.get(path).filter(|(cached, _)| *cached == mtime) {
        return version.clone();
    }
    let version = query(path, &["--version"], VERSION_TIMEOUT).as_deref().and_then(parse_tool_version);
    if let Ok(mut c) = cache.lock() {
        c.insert(path.to_path_buf(), (mtime, version.clone()));
    }
    version
}

/// Looks up `names`; `near` (a file or directory) enables project-local `node_modules/.bin` tools.
pub fn locate_tools(names: &[String], near: Option<&Path>) -> Vec<LocatedTool> {
    locate_tools_in(names, near, &search_path())
}

pub fn locate_tools_in(names: &[String], near: Option<&Path>, search: &std::ffi::OsStr) -> Vec<LocatedTool> {
    let near = near.map(|p| if p.is_file() { p.parent().unwrap_or(p) } else { p });
    let found: Vec<LocatedTool> = names
        .iter()
        .map(|name| {
            let path = valid_name(name)
                .then(|| {
                    near.and_then(|n| local_bin(n, name))
                        .or_else(|| on_path(name, search))
                        .or_else(|| jdk_tool(name, &crate::java::installed_jdks()))
                })
                .flatten();
            LocatedTool { name: name.clone(), path: path.map(Into::into), version: None }
        })
        .collect();
    std::thread::scope(|s| {
        let handles: Vec<_> = found
            .into_iter()
            .map(|mut t| {
                s.spawn(move || {
                    if let Some(p) = t.path.as_deref().filter(|_| VERSIONED.contains(&t.name.as_str())) {
                        t.version = version_of(p);
                    }
                    t
                })
            })
            .collect();
        handles.into_iter().filter_map(|h| h.join().ok()).collect()
    })
}

/// `java` / `javac` / `jshell` of the newest installed JDK when none is on the
/// search path (JDKs installed without `PATH` changes, or downloaded by the IDE).
fn jdk_tool(name: &str, jdks: &[crate::java::Jdk]) -> Option<PathBuf> {
    if !["java", "javac", "jshell"].contains(&name) {
        return None;
    }
    let jdk = jdks.iter().max_by_key(|j| j.major)?;
    Some(jdk.home.join("bin").join(crate::exe(name))).filter(|p| p.is_file())
}

/// Directory for binaries compiled from single source files (`rustc`, `clang`).
pub fn compile_dir() -> PathBuf {
    std::env::temp_dir().join("openidea-run")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_versions() {
        assert_eq!(parse_tool_version("v22.6.0").as_deref(), Some("22.6.0"));
        assert_eq!(parse_tool_version("rustc 1.85.0-nightly (abc 2024-12-01)").as_deref(), Some("1.85.0-nightly"));
        assert_eq!(parse_tool_version("deno 2.1.4 (stable, release, aarch64-apple-darwin)").as_deref(), Some("2.1.4"));
        assert_eq!(parse_tool_version("1.1.38").as_deref(), Some("1.1.38"));
        assert_eq!(parse_tool_version("no version here"), None);
    }

    #[test]
    fn java_falls_back_to_the_newest_installed_jdk() {
        let tmp = tempfile::tempdir().unwrap();
        let jdk = |major: u32| {
            let home = tmp.path().join(format!("jdk{major}"));
            std::fs::create_dir_all(home.join("bin")).unwrap();
            for t in ["java", "javac"] {
                std::fs::write(home.join("bin").join(crate::exe(t)), "").unwrap();
            }
            crate::java::Jdk { major, home }
        };
        let jdks = [jdk(17), jdk(25), jdk(21)];
        let newest = tmp.path().join("jdk25/bin");
        assert_eq!(jdk_tool("java", &jdks), Some(newest.join(crate::exe("java"))));
        assert_eq!(jdk_tool("javac", &jdks), Some(newest.join(crate::exe("javac"))));
        assert_eq!(jdk_tool("jshell", &jdks), None, "not in this JDK");
        assert_eq!(jdk_tool("node", &jdks), None);
        assert_eq!(jdk_tool("java", &[]), None);
    }

    #[test]
    fn rejects_paths_and_shell_syntax() {
        assert!(valid_name("ts-node"));
        assert!(valid_name("clang++"));
        assert!(!valid_name("../bin/sh"));
        assert!(!valid_name("node; rm"));
        assert!(!valid_name(""));
    }

    #[cfg(unix)]
    #[test]
    fn prefers_project_local_tools_then_search_path() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("app");
        let local = project.join("node_modules/.bin");
        let global = dir.path().join("global");
        std::fs::create_dir_all(&local).unwrap();
        std::fs::create_dir_all(project.join("src")).unwrap();
        std::fs::create_dir_all(&global).unwrap();
        for p in [local.join("tsx"), global.join("tsx"), global.join("ruby")] {
            std::fs::write(&p, "#!/bin/sh\n").unwrap();
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let file = project.join("src/main.ts");
        std::fs::write(&file, "").unwrap();
        let names: Vec<String> = ["tsx", "ruby", "nope"].map(String::from).to_vec();
        let search = std::env::join_paths([&global]).unwrap();
        let found = locate_tools_in(&names, Some(&file), &search);
        assert_eq!(found[0].path.as_deref(), Some(local.join("tsx").as_path()));
        assert_eq!(found[1].path.as_deref(), Some(global.join("ruby").as_path()));
        assert_eq!(found[2].path, None);
        // Without a project directory the global tool is used.
        let found = locate_tools_in(&names[..1], None, &search);
        assert_eq!(found[0].path.as_deref(), Some(global.join("tsx").as_path()));
    }
}
