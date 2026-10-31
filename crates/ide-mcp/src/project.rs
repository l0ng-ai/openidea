//! Which open project a call is for (`projectPath`, else the focused window, else
//! the only project), and paths relative to it.

use ide_core::{IdeError, IdeResult};
use ide_host::{Host, Project};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

/// The project a call runs against and the window it is open in.
#[derive(Clone)]
pub struct Target {
    pub window: String,
    pub project: Arc<Project>,
}

/// Picks the project for `project_path`: the open project whose root contains it
/// (the innermost one); without it, the focused window's project, or the only one.
pub fn target(host: &Host, project_path: Option<&str>, focused: Option<&str>) -> IdeResult<Target> {
    let open: Vec<_> = host.project_windows().into_iter().filter(|(_, p)| !p.light).collect();
    if open.is_empty() {
        return Err(IdeError::not_found("No project is open in OpenIDEA. Ask the user to open one."));
    }
    let list = || open.iter().map(|(_, p)| p.root.display().to_string()).collect::<Vec<_>>().join(", ");
    if let Some(path) = project_path.map(str::trim).filter(|p| !p.is_empty()) {
        let wanted = normalize(&file_url_path(path));
        let wanted = dunce::canonicalize(&wanted).unwrap_or(wanted);
        let found = open
            .iter()
            .filter(|(_, p)| {
                let root = dunce::canonicalize(&p.root).unwrap_or_else(|_| p.root.clone());
                wanted.starts_with(&root)
            })
            .max_by_key(|(_, p)| p.root.components().count());
        return match found {
            Some((window, project)) => Ok(Target { window: window.clone(), project: project.clone() }),
            None => Err(IdeError::not_found(format!(
                "No open project contains {path}. Open projects: {}. Pass one of them as `projectPath`.",
                list()
            ))),
        };
    }
    if let Some(focused) = focused {
        let owner = host.owner_window(focused);
        if let Some((window, project)) = open.iter().find(|(w, _)| w == owner) {
            return Ok(Target { window: window.clone(), project: project.clone() });
        }
    }
    match open.as_slice() {
        [(window, project)] => Ok(Target { window: window.clone(), project: project.clone() }),
        _ => Err(IdeError::invalid(format!(
            "Several projects are open: {}. Pass the one you mean as `projectPath`.",
            list()
        ))),
    }
}

fn file_url_path(path: &str) -> PathBuf {
    let path = path.trim();
    let stripped = path.strip_prefix("file://").map(percent_decode).unwrap_or_else(|| path.to_owned());
    PathBuf::from(stripped)
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let Ok(b) = u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("-"), 16)
        {
            out.push(b);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Removes `.` and resolves `..` lexically (the path may not exist yet).
pub fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    out.push("..");
                }
            }
            c => out.push(c.as_os_str()),
        }
    }
    out
}

/// A project-relative or absolute path (or `file://` URL) as an absolute path.
pub fn resolve(root: &Path, path: &str) -> IdeResult<PathBuf> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(IdeError::invalid("the path is empty"));
    }
    let raw = file_url_path(trimmed);
    let joined = if raw.is_absolute() { raw } else { root.join(raw) };
    Ok(normalize(&joined))
}

/// Directories (or, for `.git` in a worktree, files) of version control metadata.
const VCS_METADATA: &[&str] = &[".git", ".hg", ".svn", ".jj", ".bzr"];

/// Errors unless `path` (resolved, symlinks included where they exist) is inside `root`
/// and not version control metadata.
pub fn ensure_inside(root: &Path, path: &Path) -> IdeResult<()> {
    let root = dunce::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    // The deepest existing ancestor decides where symlinks lead.
    let mut existing = path.to_path_buf();
    let mut rest = Vec::new();
    while !existing.exists() {
        match (existing.file_name().map(|n| n.to_owned()), existing.parent()) {
            (Some(name), Some(parent)) => {
                rest.push(name);
                existing = parent.to_path_buf();
            }
            _ => break,
        }
    }
    let mut real = dunce::canonicalize(&existing).unwrap_or(existing);
    for name in rest.into_iter().rev() {
        real.push(name);
    }
    if let Ok(rel) = real.strip_prefix(&root) {
        // Hooks and config there (`core.fsmonitor`, `core.hooksPath`) run code on the next
        // VCS command: changing them must not bypass the confirmation of the execute tools.
        let metadata = rel.components().any(|c| {
            let name = c.as_os_str().to_string_lossy().to_ascii_lowercase();
            VCS_METADATA.contains(&name.as_str())
        });
        if metadata {
            return Err(IdeError::new(
                ide_core::error::ErrorKind::PermissionDenied,
                format!("{} is version control metadata; the MCP tools do not change it", path.display()),
            ));
        }
        Ok(())
    } else {
        Err(IdeError::new(
            ide_core::error::ErrorKind::PermissionDenied,
            format!(
                "{} is outside the project ({}); only project files can be changed",
                path.display(),
                root.display()
            ),
        ))
    }
}

/// Project-relative (with `/`) inside `root`, else absolute.
pub fn display(root: &Path, path: &Path) -> String {
    match path.strip_prefix(root) {
        Ok(rel) if rel.as_os_str().is_empty() => ".".into(),
        Ok(rel) => rel.to_string_lossy().replace('\\', "/"),
        Err(_) => {
            // The root may be spelled differently (symlinks, `/private/tmp`).
            let canon_root = dunce::canonicalize(root).ok();
            let canon = dunce::canonicalize(path).ok();
            match (canon_root, canon) {
                (Some(r), Some(p)) if p.starts_with(&r) => display(&r, &p),
                _ => path.to_string_lossy().into_owned(),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_relative_absolute_and_urls() {
        let root = Path::new("/p");
        assert_eq!(resolve(root, "src/a.rs").unwrap(), PathBuf::from("/p/src/a.rs"));
        assert_eq!(resolve(root, "./src/../b.rs").unwrap(), PathBuf::from("/p/b.rs"));
        assert_eq!(resolve(root, "/q/c.rs").unwrap(), PathBuf::from("/q/c.rs"));
        assert_eq!(resolve(root, "file:///p/a%20b.rs").unwrap(), PathBuf::from("/p/a b.rs"));
        assert!(resolve(root, "  ").is_err());
    }

    #[test]
    fn displays_project_relative() {
        let root = Path::new("/p");
        assert_eq!(display(root, Path::new("/p/src/a.rs")), "src/a.rs");
        assert_eq!(display(root, Path::new("/p")), ".");
        assert_eq!(display(root, Path::new("/elsewhere/x")), "/elsewhere/x");
    }

    #[test]
    fn keeps_changes_inside_the_project() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir(root.join("src")).unwrap();
        assert!(ensure_inside(root, &root.join("src/new/file.txt")).is_ok());
        assert!(ensure_inside(root, &normalize(&root.join("../escape.txt"))).is_err());
        for meta in [".git/config", ".git/hooks/pre-commit", ".GIT/config", "sub/.hg/hgrc", ".git"] {
            assert!(ensure_inside(root, &root.join(meta)).is_err(), "{meta}");
        }
        assert!(ensure_inside(root, &root.join(".github/workflows/ci.yml")).is_ok());
        assert!(ensure_inside(root, &root.join(".gitignore")).is_ok());
        #[cfg(unix)]
        {
            let outside = tempfile::tempdir().unwrap();
            std::os::unix::fs::symlink(outside.path(), root.join("link")).unwrap();
            assert!(ensure_inside(root, &root.join("link/x.txt")).is_err());
        }
    }
}
