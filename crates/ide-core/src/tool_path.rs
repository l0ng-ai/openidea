//! Where the IDE looks up the executables it runs: language servers, the tools
//! their settings come from, installers. An app started from the desktop gets a
//! minimal `PATH`, and version managers set theirs up in shell rc files.

use crate::process::{host_var_os, login_env};
use crate::version_managers;
use std::collections::HashSet;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

/// Where executables are looked up: this process's `PATH` (the login shell's in the
/// app), the login shell's `PATH` as last read, then per-user directories and mise's,
/// asdf's and pyenv's shims, for when the shell's setup didn't reach the app. Language server
/// launchers, their settings hooks and tool detection all look here, so a settings
/// hook finds the executable its server is launched from.
pub fn search_path() -> OsString {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from);
    let shell_path = login_env().and_then(|env| env.iter().find(|(k, _)| k == "PATH").map(|(_, v)| v.clone()));
    let shims: Vec<PathBuf> = version_managers::managers().iter().map(|m| m.shims()).collect();
    let dirs = search_dirs(host_var_os("PATH").as_deref(), shell_path.as_deref(), home.as_deref(), &shims);
    std::env::join_paths(dirs).unwrap_or_default()
}

/// [`search_path`]'s directories, in order and once each. Only absolute ones: a
/// relative entry (`.`, `node_modules/.bin`) resolves against the project, which
/// could then supply the tools the IDE runs. One that can't be joined (a `:` in a
/// directory name) is left out rather than failing the whole path.
fn search_dirs(
    process_path: Option<&OsStr>,
    shell_path: Option<&OsStr>,
    home: Option<&Path>,
    shims: &[PathBuf],
) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = process_path.into_iter().chain(shell_path).flat_map(std::env::split_paths).collect();
    if let Some(home) = home {
        dirs.extend(USER_DIRS.iter().map(|d| home.join(d)));
        dirs.extend(nvm_bins(&home.join(".nvm/versions/node")));
    }
    // Version managers' shims after real tool directories: a shim exists for a command any
    // installed version has, and fails when the selected one lacks it. Before the system's,
    // as the managers' shell setup puts them.
    dirs.extend(home.map(|h| h.join(".pyenv/shims")));
    dirs.extend(shims.iter().cloned());
    dirs.extend(SYSTEM_DIRS.iter().map(PathBuf::from));
    let mut seen = HashSet::new();
    dirs.retain(|d| d.is_absolute() && std::env::join_paths([d]).is_ok() && seen.insert(d.clone()));
    dirs
}

/// Tool directories below the home directory.
const USER_DIRS: &[&str] = &[
    ".cargo/bin",
    ".local/bin",
    "go/bin",
    ".bun/bin",
    ".deno/bin",
    ".npm-global/bin",
    ".volta/bin",
    // Set up in shell rc files: fnm's default Node and pnpm's global bin (Linux, then macOS).
    ".local/share/fnm/aliases/default/bin",
    "Library/Application Support/fnm/aliases/default/bin",
    ".fnm/aliases/default/bin",
    ".local/share/pnpm/bin",
    ".local/share/pnpm",
    "Library/pnpm/bin",
    "Library/pnpm",
];

const SYSTEM_DIRS: &[&str] = &["/opt/homebrew/bin", "/usr/local/go/bin", "/usr/local/bin", "/usr/bin", "/bin"];

/// The `bin` directories of nvm's Node versions in `dir`, newest first.
fn nvm_bins(dir: &Path) -> Vec<PathBuf> {
    let mut versions: Vec<(Vec<u64>, PathBuf)> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| (version_key(&e.file_name().to_string_lossy()), e.path().join("bin")))
        .collect();
    versions.sort();
    versions.into_iter().rev().map(|(_, bin)| bin).collect()
}

/// `v22.10.1` as `[22, 10, 1]`: v22 is newer than v9, v20.10 newer than v20.9.
fn version_key(name: &str) -> Vec<u64> {
    name.trim_start_matches('v').split('.').map(|n| n.parse().unwrap_or(0)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn search_dirs_put_the_process_path_first_and_shims_after_real_tools() {
        let shims = [PathBuf::from("/home/me/.local/share/mise/shims"), "/home/me/.asdf/shims".into()];
        let dirs = search_dirs(
            Some(OsStr::new("/usr/bin:.:node_modules/.bin:/opt/tools")),
            // nushell prints `$PATH` as is.
            Some(OsStr::new("$PATH:/opt/tools:/home/me/.asdf/shims")),
            Some(Path::new("/home/me")),
            &shims,
        );
        let at = |d: &str| dirs.iter().position(|p| p == Path::new(d)).unwrap();
        assert_eq!(dirs[..3], [PathBuf::from("/usr/bin"), "/opt/tools".into(), "/home/me/.asdf/shims".into()]);
        assert!(at("/home/me/.npm-global/bin") < at("/home/me/.pyenv/shims"));
        assert!(at("/home/me/.local/share/mise/shims") < at("/usr/local/bin"));
        assert!(dirs.iter().all(|d| d.is_absolute()));
        let unique: HashSet<&PathBuf> = dirs.iter().collect();
        assert_eq!(unique.len(), dirs.len());
        // A `:` can't be in a `PATH` entry: those below such a home are left out.
        let dirs = search_dirs(Some(OsStr::new("/usr/bin")), None, Some(Path::new("/home/a:b")), &[]);
        assert!(dirs.contains(&PathBuf::from("/usr/bin")) && !dirs.iter().any(|d| d.starts_with("/home")));
    }

    #[test]
    fn nvm_versions_newest_first() {
        let dir = std::env::temp_dir().join(format!("openidea-nvm-{}", std::process::id()));
        for v in ["v9.11.2", "v20.9.0", "v22.1.0", "v20.10.0"] {
            std::fs::create_dir_all(dir.join(v).join("bin")).unwrap();
        }
        let bins = nvm_bins(&dir);
        std::fs::remove_dir_all(&dir).unwrap();
        let names: Vec<_> = bins.iter().map(|b| b.parent().unwrap().file_name().unwrap().to_owned()).collect();
        assert_eq!(names, ["v22.1.0", "v20.10.0", "v20.9.0", "v9.11.2"]);
    }
}
