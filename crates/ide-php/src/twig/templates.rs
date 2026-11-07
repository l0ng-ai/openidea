//! Where a project's Twig templates live, and template names ⇄ files.
//!
//! A name is a path below a template directory (`base.html.twig`,
//! `admin/list.html.twig`), or `@Namespace/path` for a namespaced directory.
//! The directories are Symfony's `templates/` (or the `default_path` of
//! `config/packages/twig.yaml`), the `paths` of that file (with or without
//! a namespace), the legacy `app/Resources/views`, and `resources/views`
//! (TwigBridge for Laravel).

use std::path::{Component, Path, PathBuf};

use crate::symfony::yaml;

/// The most template names [`TemplatePaths::names`] lists.
pub const MAX_NAMES: usize = 2000;

/// The template directories of one project.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TemplatePaths {
    /// `(namespace, directory)`; unnamespaced ones first, in lookup order.
    dirs: Vec<(Option<String>, PathBuf)>,
}

impl TemplatePaths {
    /// The directories of the project at `root` (only the ones that exist).
    pub fn discover(root: &Path) -> Self {
        let mut dirs: Vec<(Option<String>, PathBuf)> = Vec::new();
        let mut default = root.join("templates");
        let config = ["config/packages/twig.yaml", "config/packages/twig.yml"]
            .iter()
            .find_map(|file| std::fs::read_to_string(root.join(file)).ok());
        let mut configured = Vec::new();
        if let Some(text) = config {
            let doc = yaml::parse(&text);
            if let Some(twig) = doc.get("twig") {
                if let Some(path) = twig.get("default_path").and_then(yaml::Node::as_str) {
                    default = expand(root, path);
                }
                for entry in twig.get("paths").map(yaml::Node::entries).unwrap_or_default() {
                    let namespace = entry.value.as_str().map(|ns| ns.trim_start_matches('@').to_string());
                    configured.push((namespace.filter(|ns| !ns.is_empty()), expand(root, &entry.key)));
                }
            }
        }
        dirs.push((None, default));
        dirs.extend(configured);
        dirs.push((None, root.join("app/Resources/views")));
        dirs.push((None, root.join("resources/views")));
        let mut seen = Vec::new();
        dirs.retain(|entry| {
            entry.1.is_dir() && !seen.contains(entry) && {
                seen.push(entry.clone());
                true
            }
        });
        dirs.sort_by_key(|(ns, _)| ns.is_some());
        Self { dirs }
    }

    /// From explicit directories (tests).
    pub fn from_dirs(dirs: Vec<(Option<String>, PathBuf)>) -> Self {
        Self { dirs }
    }

    /// The file of template `name`, if it exists.
    pub fn resolve(&self, name: &str) -> Option<PathBuf> {
        let (namespace, path) = split_name(name);
        let relative = Path::new(path);
        if path.is_empty() || relative.components().any(|c| !matches!(c, Component::Normal(_))) {
            return None;
        }
        self.dirs
            .iter()
            .filter(|(ns, _)| ns.as_deref() == namespace)
            .map(|(_, dir)| dir.join(relative))
            .find(|file| file.is_file())
    }

    /// The names of the project's templates (files ending in `.twig`), sorted;
    /// at most [`MAX_NAMES`].
    pub fn names(&self) -> Vec<String> {
        let mut names = Vec::new();
        for (namespace, dir) in &self.dirs {
            let prefix = namespace.as_ref().map(|ns| format!("@{ns}/")).unwrap_or_default();
            collect(dir, dir, &prefix, &mut names);
            if names.len() >= MAX_NAMES {
                break;
            }
        }
        names.sort();
        names.dedup();
        names.truncate(MAX_NAMES);
        names
    }
}

/// `@Ns/path` → `(Some("Ns"), "path")`.
fn split_name(name: &str) -> (Option<&str>, &str) {
    match name.strip_prefix('@').and_then(|rest| rest.split_once('/')) {
        Some((ns, path)) => (Some(ns), path),
        None => (None, name),
    }
}

/// A path of `twig.yaml`: `%kernel.project_dir%` is the project folder,
/// relative paths are relative to it.
fn expand(root: &Path, path: &str) -> PathBuf {
    let path = path.replace("%kernel.project_dir%", &root.to_string_lossy());
    let path = PathBuf::from(path);
    if path.is_absolute() { path } else { root.join(path) }
}

fn collect(base: &Path, dir: &Path, prefix: &str, out: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        if out.len() >= MAX_NAMES {
            return;
        }
        let path = entry.path();
        let Ok(kind) = entry.file_type() else { continue };
        if kind.is_dir() {
            collect(base, &path, prefix, out);
        } else if path.extension().is_some_and(|ext| ext == "twig")
            && let Ok(relative) = path.strip_prefix(base)
        {
            let relative: Vec<_> = relative.components().map(|c| c.as_os_str().to_string_lossy()).collect();
            out.push(format!("{prefix}{}", relative.join("/")));
        }
    }
}
