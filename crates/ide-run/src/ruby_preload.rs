//! Loads a Ruby file into a launched process without touching the project: the directory goes on
//! `RUBYLIB` and `RUBYOPT` gets the bare feature name (`-ropenidea_hook`).
//!
//! `RUBYOPT` is split at spaces with no quoting, so an absolute path in it (`-r/…/Application
//! Support/…/hook.rb`, where the IDE keeps its data) makes Ruby fail with `invalid switch in RUBYOPT`.
//! `RUBYLIB` is a path list and takes spaces.
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// Makes `feature` (a file `<dir>/<feature>.rb`) load first in every Ruby the process starts.
/// `inherit`: the process also sees the IDE's own environment, whose `RUBYLIB` / `RUBYOPT` stay.
pub fn add(env: &mut BTreeMap<String, String>, dir: &Path, feature: &str, inherit: bool) {
    let mut inherited = if inherit { crate::system_env() } else { BTreeMap::new() };
    let mut existing = |name: &str| env.get(name).cloned().or_else(|| inherited.remove(name)).filter(|v| !v.is_empty());

    let mut dirs: Vec<PathBuf> = vec![dir.to_path_buf()];
    if let Some(lib) = existing("RUBYLIB") {
        for d in std::env::split_paths(&lib) {
            if !dirs.contains(&d) {
                dirs.push(d);
            }
        }
    }
    let rubyopt = existing("RUBYOPT");
    if let Ok(joined) = std::env::join_paths(dirs) {
        env.insert("RUBYLIB".into(), joined.to_string_lossy().into_owned());
    }
    let option = format!("-r{feature}");
    let value = match rubyopt {
        Some(e) if e.split_whitespace().any(|o| o == option) => e,
        Some(e) => format!("{e} {option}"),
        None => option,
    };
    env.insert("RUBYOPT".into(), value);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_directory_with_spaces_goes_on_rubylib_not_into_rubyopt() {
        let dir = Path::new("/Users/me/Library/Application Support/ide/ruby");
        let mut env = BTreeMap::new();
        add(&mut env, dir, "openidea_hook", false);
        assert_eq!(env["RUBYLIB"], dir.to_string_lossy());
        assert_eq!(env["RUBYOPT"], "-ropenidea_hook");
        assert!(!env["RUBYOPT"].contains(' '));
    }

    #[test]
    fn keeps_existing_settings_and_adds_once() {
        // Path lists use the platform's separator (`;` on Windows).
        let list = |dirs: &[&str]| std::env::join_paths(dirs).unwrap().to_string_lossy().into_owned();
        let mut env = BTreeMap::from([("RUBYLIB".into(), list(&["/a", "/b"])), ("RUBYOPT".into(), "-w".into())]);
        add(&mut env, Path::new("/hook"), "h", false);
        add(&mut env, Path::new("/hook"), "h", false);
        assert_eq!(env["RUBYLIB"], list(&["/hook", "/a", "/b"]));
        assert_eq!(env["RUBYOPT"], "-w -rh");
    }
}
