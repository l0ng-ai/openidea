//! Hermes Agent profiles on disk: `default` is the Hermes home itself, the others are
//! `<home>/profiles/<name>` directories holding one of Hermes' identity files.

use std::path::{Path, PathBuf};

use serde::Serialize;
use specta::Type;

const PROFILE_FILES: &[&str] = &["config.yaml", ".env", "SOUL.md", "profile.yaml", "auth.json", "state.db"];

/// Hermes' home directory (`~/.hermes`; `%LOCALAPPDATA%\hermes` on Windows).
pub fn root(home: Option<&Path>) -> Option<PathBuf> {
    #[cfg(windows)]
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        return Some(PathBuf::from(local).join("hermes"));
    }
    home.map(|h| h.join(".hermes"))
}

/// The profile names under `root`: `default` first, then the others by name; none without `root`.
pub fn profiles(root: &Path) -> Vec<String> {
    if !root.is_dir() {
        return Vec::new();
    }
    let mut named: Vec<String> = std::fs::read_dir(root.join("profiles"))
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| PROFILE_FILES.iter().any(|f| e.path().join(f).exists()))
        .filter_map(|e| e.file_name().to_str().map(str::to_owned))
        .filter(|name| name != "default")
        .collect();
    named.sort();
    std::iter::once("default".to_owned()).chain(named).collect()
}

/// A profile and the name Hermes shows for it (`hermes profile list`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Type)]
pub struct HermesProfile {
    /// What `hermes -p` takes; `default` is the Hermes home itself.
    pub name: String,
    /// `display_name` from the profile's `profile.yaml`, else the name.
    pub label: String,
}

/// [`profiles`] with the names Hermes shows for them.
pub fn labeled_profiles(root: &Path) -> Vec<HermesProfile> {
    profiles(root)
        .into_iter()
        .map(|name| {
            let home = if name == "default" { root.to_path_buf() } else { root.join("profiles").join(&name) };
            let label = display_name(&home).unwrap_or_else(|| name.clone());
            HermesProfile { name, label }
        })
        .collect()
}

/// The top-level `display_name:` of `<home>/profile.yaml`, the only key read (no YAML parser).
fn display_name(home: &Path) -> Option<String> {
    let text = std::fs::read_to_string(home.join("profile.yaml")).ok()?;
    let value = text.lines().find_map(|l| l.strip_prefix("display_name:"))?;
    let value = value.trim().trim_matches(['"', '\'']).trim();
    (!value.is_empty()).then(|| value.to_owned())
}

/// The home of the profile an agent id stands for: `hermes` and `hermes-default` are the
/// default profile, `hermes-<slug>` the profile whose name slugifies to `<slug>`.
pub fn profile_home(root: &Path, provider: &str) -> Option<PathBuf> {
    let slug = match provider {
        "hermes" | "hermes-default" => return Some(root.to_path_buf()),
        _ => provider.strip_prefix("hermes-")?,
    };
    profiles(root).into_iter().find(|p| crate::provider::slugify_id(p) == slug).map(|p| root.join("profiles").join(p))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_default_and_profiles_with_an_identity_file() {
        let dir = tempfile::tempdir().unwrap();
        assert!(profiles(&dir.path().join("missing")).is_empty());
        let root = dir.path().join(".hermes");
        std::fs::create_dir_all(root.join("profiles/empty")).unwrap();
        assert_eq!(profiles(&root), ["default"]);
        for (name, file) in [("work", "config.yaml"), ("Dom 2", "SOUL.md"), ("db", "state.db")] {
            std::fs::create_dir_all(root.join("profiles").join(name)).unwrap();
            std::fs::write(root.join("profiles").join(name).join(file), "").unwrap();
        }
        std::fs::write(root.join("profiles/stray.yaml"), "").unwrap();
        assert_eq!(profiles(&root), ["default", "Dom 2", "db", "work"]);
        assert_eq!(profile_home(&root, "hermes"), Some(root.clone()));
        assert_eq!(profile_home(&root, "hermes-dom-2"), Some(root.join("profiles/Dom 2")));
        assert_eq!(profile_home(&root, "hermes-empty"), None);
        assert_eq!(profile_home(&root, "claude"), None);
    }

    #[test]
    fn labels_profiles_with_their_display_name() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join(".hermes");
        std::fs::create_dir_all(root.join("profiles/work")).unwrap();
        std::fs::write(root.join("profile.yaml"), "description: mine\ndisplay_name: \"qb\"\n").unwrap();
        std::fs::write(root.join("profiles/work/profile.yaml"), "ui_meta:\n  display_name: nested\n").unwrap();
        let label = |name: &str, label: &str| HermesProfile { name: name.into(), label: label.into() };
        assert_eq!(labeled_profiles(&root), [label("default", "qb"), label("work", "work")]);
        std::fs::remove_file(root.join("profile.yaml")).unwrap();
        assert_eq!(labeled_profiles(&root)[0], label("default", "default"));
    }
}
