//! Inertia in a Laravel project with `inertiajs/inertia-laravel` installed
//! ([`super::LaravelPackages`]): the pages ([`InertiaPages`]) that
//! `Inertia::render('Posts/Index')` and `inertia('…')` name.
//!
//! A page's name is its path below a page folder without the extension
//! (`resources/js/Pages/Posts/Index.vue` is `Posts/Index`), as Inertia's
//! documentation on pages and its Laravel adapter's `testing.page_paths`
//! describe it. The folders are the `inertia.pagePaths` of the `ide.json`
//! files (with a name prefix and a file suffix each), else
//! `resources/js/Pages` and `resources/js/pages`; the folders of Settings ›
//! PHP › Laravel win over both. Pages are Vue, React or
//! Svelte files; a new page gets the extension most existing pages have,
//! else the one of the front-end framework `package.json` requires.
//!
//! Only Inertia's documentation (MIT) is a design input.

use std::path::{Path, PathBuf};

use super::LaravelProject;
use crate::project::normalize;

/// The extensions of page files, in order of preference.
pub const PAGE_EXTENSIONS: &[&str] = &["vue", "tsx", "jsx", "svelte", "ts", "js"];

/// A folder of pages.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PageDir {
    pub path: PathBuf,
    /// Put before the names of its pages.
    pub prefix: String,
    /// The end of its page files' names (`.vue`); empty = any page extension.
    pub suffix: String,
}

/// One page.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InertiaPage {
    /// `Posts/Index`.
    pub name: String,
    pub path: PathBuf,
}

/// The pages of a project, sorted by name.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct InertiaPages {
    pub dirs: Vec<PageDir>,
    pub pages: Vec<InertiaPage>,
    /// The extension of new pages, without the dot.
    pub extension: String,
}

impl InertiaPages {
    /// The pages of `project`, empty when Inertia isn't installed;
    /// `package_json` is the text of the project's `package.json`.
    pub fn read(project: &LaravelProject, package_json: Option<&str>) -> Self {
        Self::read_with(project, &[], package_json)
    }

    /// [`InertiaPages::read`] with the page folders of the settings
    /// (Settings › PHP › Laravel, relative to the project), which win over
    /// the `ide.json` ones when there are any.
    pub fn read_with(project: &LaravelProject, configured: &[String], package_json: Option<&str>) -> Self {
        if !project.packages.inertia {
            return Self::default();
        }
        let configured: Vec<PageDir> = configured
            .iter()
            .map(|dir| dir.trim().trim_end_matches(['/', '\\']))
            .filter(|dir| !dir.is_empty())
            .map(|dir| PageDir {
                path: normalize(&project.root.join(dir)),
                prefix: String::new(),
                suffix: String::new(),
            })
            .collect();
        let mut dirs: Vec<PageDir> = if !configured.is_empty() {
            configured
        } else {
            project
                .ide_json
                .packages
                .inertia_pages
                .iter()
                .map(|(path, prefix, suffix)| PageDir {
                    path: normalize(path),
                    prefix: prefix.clone(),
                    suffix: suffix.clone(),
                })
                .collect()
        };
        if dirs.is_empty() {
            let js = project.paths.resources.join("js");
            let found: Vec<PathBuf> =
                ["Pages", "pages"].iter().map(|dir| js.join(dir)).filter(|dir| dir.is_dir()).collect();
            let found = if found.is_empty() { vec![js.join("Pages")] } else { found };
            dirs = found
                .into_iter()
                .map(|path| PageDir { path: normalize(&path), prefix: String::new(), suffix: String::new() })
                .collect();
            dirs.dedup_by(|a, b| a.path == b.path);
        }
        let mut pages = Vec::new();
        for dir in &dirs {
            collect(dir, &dir.path, &mut pages);
        }
        pages.sort_by(|a: &InertiaPage, b| a.name.cmp(&b.name));
        pages.dedup_by(|a, b| a.name == b.name);
        let extension = new_extension(&pages, package_json);
        Self { dirs, pages, extension }
    }

    /// The page named `name`.
    pub fn get(&self, name: &str) -> Option<&InertiaPage> {
        let name = name.trim_matches('/');
        self.pages.iter().find(|page| page.name == name)
    }

    /// Whether any page folder exists (so a missing page is certainly
    /// missing).
    pub fn has_dir(&self) -> bool {
        self.dirs.iter().any(|dir| dir.path.is_dir())
    }

    /// The file a new page `name` goes to: below the first folder whose
    /// prefix it has.
    pub fn new_path(&self, name: &str) -> Option<PathBuf> {
        let name = name.trim_matches('/');
        let dir = self.dirs.iter().find(|dir| name.starts_with(&dir.prefix))?;
        let local = &name[dir.prefix.len()..];
        if local.is_empty() || local.split('/').any(|part| part.is_empty() || part == "." || part == "..") {
            return None;
        }
        if local.contains(['\\', ':', '*', '?', '"', '<', '>', '|']) {
            return None;
        }
        let file = if dir.suffix.is_empty() {
            format!("{local}.{}", self.extension)
        } else {
            format!("{local}{}", dir.suffix)
        };
        Some(dir.path.join(file))
    }
}

/// The pages below `folder` of `dir`.
fn collect(dir: &PageDir, folder: &Path, out: &mut Vec<InertiaPage>) {
    let Ok(entries) = std::fs::read_dir(folder) else { return };
    let mut entries: Vec<PathBuf> = entries.filter_map(|entry| entry.ok().map(|entry| entry.path())).collect();
    entries.sort();
    for path in entries {
        if path.is_dir() {
            collect(dir, &path, out);
            continue;
        }
        let Ok(relative) = path.strip_prefix(&dir.path) else { continue };
        let relative = relative.to_string_lossy().replace('\\', "/");
        let local = if dir.suffix.is_empty() {
            PAGE_EXTENSIONS.iter().find_map(|extension| relative.strip_suffix(&format!(".{extension}")))
        } else {
            relative.strip_suffix(&dir.suffix)
        };
        if let Some(local) = local.filter(|local| !local.is_empty()) {
            out.push(InertiaPage { name: format!("{}{local}", dir.prefix), path: normalize(&path) });
        }
    }
}

/// The extension most of `pages` have, else the one of the front-end
/// framework `package_json` requires (Vue by default).
fn new_extension(pages: &[InertiaPage], package_json: Option<&str>) -> String {
    let mut best: Option<(&str, usize)> = None;
    for extension in PAGE_EXTENSIONS {
        let count = pages
            .iter()
            .filter(|page| page.path.extension().is_some_and(|found| found.eq_ignore_ascii_case(extension)))
            .count();
        if count > 0 && best.is_none_or(|(_, most)| count > most) {
            best = Some((extension, count));
        }
    }
    if let Some((extension, _)) = best {
        return extension.to_owned();
    }
    let json: serde_json::Value = package_json.and_then(|text| serde_json::from_str(text).ok()).unwrap_or_default();
    let has = |name: &str| {
        ["dependencies", "devDependencies"].iter().any(|section| json.get(section).and_then(|s| s.get(name)).is_some())
    };
    if has("@inertiajs/react") || has("react") {
        if has("typescript") { "tsx" } else { "jsx" }.to_owned()
    } else if has("@inertiajs/svelte") || has("svelte") {
        "svelte".to_owned()
    } else {
        "vue".to_owned()
    }
}

/// The text of a new page named `name` with `extension`.
pub fn page_template(name: &str, extension: &str) -> String {
    let component: String =
        name.rsplit('/').next().unwrap_or(name).chars().filter(char::is_ascii_alphanumeric).collect();
    let component = if component.starts_with(|c: char| c.is_ascii_alphabetic()) { component } else { "Page".into() };
    match extension {
        "vue" => "<script setup>\ndefineProps({})\n</script>\n\n<template>\n    <div></div>\n</template>\n".to_owned(),
        "svelte" => "<script>\n</script>\n\n<div></div>\n".to_owned(),
        "tsx" | "jsx" => format!("export default function {component}() {{\n    return <div></div>;\n}}\n"),
        _ => format!("export default function {component}() {{\n    return null;\n}}\n"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page(path: &str) -> InertiaPage {
        InertiaPage { name: String::new(), path: PathBuf::from(path) }
    }

    #[test]
    fn new_pages_get_the_most_common_extension() {
        let pages = [page("a.vue"), page("b.tsx"), page("c.tsx")];
        assert_eq!(new_extension(&pages, None), "tsx");
        assert_eq!(new_extension(&[], None), "vue");
        let react = r#"{"devDependencies": {"@inertiajs/react": "^2.0", "typescript": "^5"}}"#;
        assert_eq!(new_extension(&[], Some(react)), "tsx");
        assert_eq!(new_extension(&[], Some(r#"{"dependencies": {"react": "^19"}}"#)), "jsx");
        assert_eq!(new_extension(&[], Some(r#"{"dependencies": {"@inertiajs/svelte": "^2"}}"#)), "svelte");
    }

    #[test]
    fn page_templates() {
        assert!(page_template("Posts/Index", "vue").contains("<template>"));
        assert!(page_template("Posts/Show", "jsx").starts_with("export default function Show()"));
        assert!(page_template("Auth/2fa", "tsx").starts_with("export default function Page()"));
    }

    #[test]
    fn new_paths_go_below_the_folder_with_the_prefix() {
        let pages = InertiaPages {
            dirs: vec![
                PageDir { path: PathBuf::from("/p/admin"), prefix: "Admin/".into(), suffix: ".vue".into() },
                PageDir { path: PathBuf::from("/p/pages"), prefix: String::new(), suffix: String::new() },
            ],
            pages: Vec::new(),
            extension: "jsx".into(),
        };
        assert_eq!(pages.new_path("Admin/Users"), Some(PathBuf::from("/p/admin").join("Users.vue")));
        assert_eq!(pages.new_path("Posts/Index"), Some(PathBuf::from("/p/pages").join("Posts/Index.jsx")));
        assert_eq!(pages.new_path("../x"), None);
        assert_eq!(pages.new_path(""), None);
    }
}
