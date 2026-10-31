// Ported from JetBrains intellij-community plugins/mcp-server (src/com/intellij/mcpserver/impl/McpSessionProjectResolverImpl.kt, util/fs.util.kt), Apache-2.0.
//! Which open project a call is for, and paths relative to it.
//!
//! An explicit `projectPath` argument must name an open project. Without one the
//! project comes from, in order: the call's `OPENIDEA_MCP_PROJECT_PATH` header (or
//! `_meta` entry), the same header of the request that opened the session, the
//! client's roots, then the focused window, then the only open project.

use ide_core::{IdeError, IdeResult};
use ide_host::{Host, Project};
use serde_json::json;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

/// The header (and `_meta` key) that names the project of a call or, on the request
/// that opens a session, of the whole session (JetBrains: `IJ_MCP_SERVER_PROJECT_PATH`).
pub const PROJECT_PATH_HEADER: &str = "OPENIDEA_MCP_PROJECT_PATH";

/// The project a call runs against and the window it is open in.
#[derive(Clone)]
pub struct Target {
    pub window: String,
    pub project: Arc<Project>,
}

/// Where a call's project can come from, strongest first.
#[derive(Default)]
pub struct Sources<'a> {
    /// The `projectPath` argument.
    pub argument: Option<&'a str>,
    /// The project path header (or `_meta` entry) of this call.
    pub call_header: Option<&'a str>,
    /// The project path header of the request that opened the session.
    pub session_header: Option<&'a str>,
    /// The client's roots (`file://` URIs).
    pub roots: &'a [String],
}

fn given(s: Option<&str>) -> Option<&str> {
    s.map(str::trim).filter(|s| !s.is_empty())
}

/// The project for `sources`, falling back to the focused window's project and then
/// to the only open one.
pub fn target(host: &Host, sources: &Sources, focused: Option<&str>) -> IdeResult<Target> {
    let open = open_projects(host);
    if open.is_empty() {
        return Err(IdeError::not_found("No project is open in OpenIDEA. Ask the user to open one."));
    }
    if let Some(path) = given(sources.argument) {
        return find(&open, path).ok_or_else(|| {
            no_suitable_project(
                &open,
                &format!("`{}`=`{path}` doesn't correspond to any open project.", crate::tool::PROJECT_PATH),
            )
        });
    }
    if let Some(found) = known_upfront(&open, sources) {
        return Ok(found);
    }
    if let Some(focused) = focused {
        let owner = host.owner_window(focused);
        if let Some(found) = open.iter().find(|t| t.window == owner) {
            return Ok(found.clone());
        }
    }
    match open.as_slice() {
        [only] => Ok(only.clone()),
        _ => Err(no_suitable_project(&open, "No exact project is specified while multiple projects are opened.")),
    }
}

/// The project the headers or roots name, without the focus fallbacks: when the session
/// knows it up front, `projectPath` is left out of the tool schemas.
pub fn session_target(host: &Host, sources: &Sources) -> Option<Target> {
    known_upfront(&open_projects(host), sources)
}

fn known_upfront(open: &[Target], sources: &Sources) -> Option<Target> {
    given(sources.call_header)
        .and_then(|p| find(open, p))
        .or_else(|| given(sources.session_header).and_then(|p| find(open, p)))
        .or_else(|| sources.roots.iter().find_map(|root| find(open, root)))
}

fn open_projects(host: &Host) -> Vec<Target> {
    host.project_windows()
        .into_iter()
        .filter(|(_, p)| !p.light)
        .map(|(window, project)| Target { window, project })
        .collect()
}

/// The error that lists the open projects so that the model passes one as `projectPath`.
fn no_suitable_project(open: &[Target], prefix: &str) -> IdeError {
    let projects = json!({
        "projects": open.iter().map(|t| json!({ "path": t.project.root.display().to_string() })).collect::<Vec<_>>()
    });
    let p = crate::tool::PROJECT_PATH;
    IdeError::not_found(format!(
        "{prefix}\nYou may specify the project path via `{p}` parameter when calling a tool. \nIf you're aware of the \
current working directory you may pass it as `{p}`. \nIn the case when it's unobvious which project to use you have to \
ASK the USER about a project providing him a numbered list of the projects.\nCurrently open projects: {projects}"
    ))
}

/// The open project `path` (absolute, or a `file://` URL) is in: the one whose directory,
/// or one of whose content roots, contains it most closely. A content root that two
/// projects share tells neither apart, so it names none.
fn find(open: &[Target], path: &str) -> Option<Target> {
    let wanted = file_url_path(path);
    if !wanted.is_absolute() {
        return None;
    }
    let wanted = normalize(&wanted);
    let wanted = dunce::canonicalize(&wanted).unwrap_or(wanted);
    let canon = |p: &Path| dunce::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    // (target, directory, is the project's own directory)
    let mut matches: Vec<(&Target, PathBuf, bool)> = Vec::new();
    for t in open {
        let dirs = std::iter::once((t.project.root.clone(), true))
            .chain(t.project.content_roots().into_iter().map(|r| (r, false)));
        for (dir, own) in dirs {
            let dir = canon(&dir);
            if wanted.starts_with(&dir) {
                matches.push((t, dir, own));
            }
        }
    }
    let (best, dir, own) = matches.iter().max_by_key(|(_, dir, own)| (dir.components().count(), *own))?;
    let shared = !own && matches.iter().any(|(t, d, _)| t.window != best.window && d == dir);
    (!shared).then(|| (*best).clone())
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
