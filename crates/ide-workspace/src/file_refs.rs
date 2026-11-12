//! File references in text (`href="css/a.css"`, `url(../img/x.png)`,
//! `open("data/x.csv")`), resolved like IDEA's file references: relative to the
//! referencing file, `/`-rooted paths against the project root and its resource
//! roots (`public/`, `src/main/resources`), which web servers serve at `/`.

use std::path::{Component, Path, PathBuf};

/// Whether `value` names a local file at all (not a URL, an anchor, a data URI
/// or a template expression), so an unresolved one is worth reporting.
pub fn is_file_reference(value: &str) -> bool {
    let v = value.trim();
    !(v.is_empty()
        || v.starts_with('#')
        || v.starts_with("//")
        || v.starts_with('~')
        || has_scheme(v)
        || ["{{", "${", "<%", "{%", "<?", "@{"].iter().any(|t| v.contains(t)))
}

/// `http:`, `mailto:`, `data:`, `javascript:`… (a Windows drive `C:` is a path).
fn has_scheme(v: &str) -> bool {
    match v.find(':') {
        Some(i) if i > 1 => v[..i].chars().all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c)),
        _ => false,
    }
}

/// The path part: no `?query` / `#fragment`, percent-decoded.
pub fn path_part(value: &str) -> String {
    let bare = value.trim().split(['?', '#']).next().unwrap_or_default();
    percent_decode(bare)
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && let Some(b) = s.get(i + 1..i + 3).and_then(|h| u8::from_str_radix(h, 16).ok())
        {
            out.push(b);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| s.to_owned())
}

/// Removes `.` and resolves `..` lexically.
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    out.push("..");
                }
            }
            other => out.push(other),
        }
    }
    out
}

/// Directories a reference's path is looked up in, most likely first.
pub fn base_dirs(path: &str, from: &Path, root: Option<&Path>, resource_roots: &[PathBuf]) -> Vec<PathBuf> {
    // A file outside the project is not served from its roots.
    let root = root.filter(|r| from.starts_with(r));
    let mut dirs: Vec<PathBuf> = Vec::new();
    if path.starts_with('/') {
        dirs.extend(root.map(Path::to_path_buf));
        if root.is_some() {
            dirs.extend(resource_roots.iter().cloned());
        }
        dirs.push(PathBuf::from("/"));
    } else {
        dirs.extend(from.parent().map(Path::to_path_buf));
        // `img/a.png` from a page served at the root; never for `./` or `../`.
        if !path.starts_with('.') {
            dirs.extend(root.map(Path::to_path_buf));
        }
    }
    let mut seen = Vec::new();
    dirs.retain(|d| {
        let fresh = !seen.contains(d);
        seen.push(d.clone());
        fresh
    });
    dirs
}

/// Whether a path written in `from` may be looked up: joining a share's path replaces the
/// directory it is joined to, and looking it up signs in to that share's server.
fn reachable(path: &Path, from: &Path) -> bool {
    ide_vfs::content_path_allowed(path, &[from])
}

/// Paths `value` may point at, most likely first.
pub fn candidates(value: &str, from: &Path, root: Option<&Path>, resource_roots: &[PathBuf]) -> Vec<PathBuf> {
    let path = path_part(value);
    let rel = path.trim_start_matches('/');
    base_dirs(&path, from, root, resource_roots)
        .iter()
        .map(|d| normalize(&d.join(rel)))
        .filter(|p| reachable(p, from))
        .collect()
}

/// The existing file or directory `value` names, if any.
pub fn resolve(value: &str, from: &Path, root: Option<&Path>, resource_roots: &[PathBuf]) -> Option<PathBuf> {
    if !is_file_reference(value) || path_part(value).is_empty() {
        return None;
    }
    candidates(value, from, root, resource_roots).into_iter().find(|p| p.exists())
}

/// An entry offered when completing a path.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PathCompletion {
    pub name: String,
    pub dir: bool,
}

/// Entries of the directories `prefix` (the path typed so far) continues in:
/// the part before its last `/`, looked up like a reference. Dot files only
/// when the last segment starts with `.`.
pub fn complete(prefix: &str, from: &Path, root: Option<&Path>, resource_roots: &[PathBuf]) -> Vec<PathCompletion> {
    let prefix = percent_decode(prefix);
    let (dir_part, last) = prefix.rsplit_once('/').map_or(("", prefix.as_str()), |(d, l)| (d, l));
    let dir_value =
        if prefix.starts_with('/') { format!("/{}", dir_part.trim_start_matches('/')) } else { dir_part.to_owned() };
    let show_hidden = last.starts_with('.');
    let rel = dir_value.trim_start_matches('/');
    let mut out: Vec<PathCompletion> = Vec::new();
    for base in base_dirs(&dir_value, from, root, resource_roots) {
        // The file system root only as a last resort for `/` paths.
        if base == Path::new("/") && !out.is_empty() {
            continue;
        }
        let dir = normalize(&base.join(rel));
        if !reachable(&dir, from) {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(dir) else { continue };
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if (name.starts_with('.') && !show_hidden) || out.iter().any(|c| c.name == name) {
                continue;
            }
            let dir = e.file_type().is_ok_and(|t| t.is_dir()) || e.path().is_dir();
            out.push(PathCompletion { name, dir });
        }
    }
    out.sort_by(|a, b| b.dir.cmp(&a.dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn what_counts_as_a_file_reference() {
        for v in ["a.css", "./a", "../img/x.png", "/splash.css", "a%20b.png?v=1#x", "C:/x"] {
            assert!(is_file_reference(v), "{v}");
        }
        for v in [
            "",
            "#top",
            "https://x.org",
            "//cdn.x/a.js",
            "mailto:a@b",
            "data:image/png;base64,x",
            "{{ url }}",
            "${base}/a.js",
            "~/x",
        ] {
            assert!(!is_file_reference(v), "{v}");
        }
        assert_eq!(path_part(" img/a%20b.png?v=2#i "), "img/a b.png");
    }

    #[cfg(unix)]
    #[test]
    fn candidates_follow_ideas_rules() {
        let from = Path::new("/p/web/pages/index.html");
        let root = Some(Path::new("/p"));
        let res = [PathBuf::from("/p/public")];
        let s = |v| candidates(v, from, root, &res).into_iter().map(|p| p.display().to_string()).collect::<Vec<_>>();
        assert_eq!(s("../img/a.png"), ["/p/web/img/a.png"]);
        assert_eq!(s("img/a.png"), ["/p/web/pages/img/a.png", "/p/img/a.png"]);
        assert_eq!(s("/splash.css"), ["/p/splash.css", "/p/public/splash.css", "/splash.css"]);
    }

    #[test]
    fn resolves_and_completes_against_the_file_system() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        for f in ["web/index.html", "web/css/a.css", "web/css/.hidden", "public/splash.css", "public/img/logo.svg"] {
            let p = root.join(f);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, "").unwrap();
        }
        let from = root.join("web/index.html");
        let res = [root.join("public")];
        let r = |v| resolve(v, &from, Some(root), &res);
        assert_eq!(r("css/a.css?v=1"), Some(root.join("web/css/a.css")));
        assert_eq!(r("/splash.css"), Some(root.join("public/splash.css")));
        assert_eq!(r("css/missing.css"), None);
        assert_eq!(r("https://x.org/a.css"), None);

        let names = |p| complete(p, &from, Some(root), &res).into_iter().map(|c| (c.name, c.dir)).collect::<Vec<_>>();
        assert_eq!(names("css/"), [("a.css".into(), false)]);
        assert_eq!(names("css/."), [(".hidden".into(), false), ("a.css".into(), false)]);
        assert_eq!(
            names("/im"),
            [("img".into(), true), ("public".into(), true), ("web".into(), true), ("splash.css".into(), false)]
        );
        assert_eq!(names("/img/"), [("logo.svg".into(), false)]);
    }

    /// A path written in a page must not make the host open a share on another server: on
    /// Windows that signs in to it with the user's credentials. The inspection of unresolved
    /// references looks every path up as soon as the page opens.
    #[cfg(windows)]
    #[test]
    fn references_reach_no_share_but_the_one_the_page_is_on() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("web/img")).unwrap();
        for f in ["web/index.html", "web/img/a.png"] {
            std::fs::write(root.join(f), "").unwrap();
        }
        // The same folder reached over SMB through the loopback admin share.
        let s = root.to_str().unwrap();
        let share = PathBuf::from(format!(r"\\127.0.0.1\{}${}", &s[..1], &s[2..]));
        let image = share.join(r"web\img\a.png");
        assert!(image.exists(), "control: {} is not reachable over SMB, fixture not live", image.display());
        let unc = image.to_str().unwrap();

        let from = root.join("web/index.html");
        // The last one is the NT spelling `\??\UNC\…` (a bare `?` would start the query).
        for value in [unc.to_owned(), unc.replace('\\', "%5C"), format!(r"/\%3F%3F\UNC{}", &unc[1..])] {
            assert_eq!(resolve(&value, &from, Some(root), &[]), None, "{value}");
        }
        let typed = format!("{}/", share.join("web").display());
        assert_eq!(complete(&typed, &from, Some(root), &[]), [], "{typed}");

        // A page that is on the share names its own files.
        let from = share.join(r"web\index.html");
        assert_eq!(resolve("img/a.png", &from, Some(&share), &[]), Some(image.clone()));
        assert_eq!(complete("img/", &from, Some(&share), &[]), [PathCompletion { name: "a.png".into(), dir: false }]);
        // The same page as the webview names it: the canonical path, with `/`.
        let from = PathBuf::from(ide_core::ipc_path::to_ipc(&dunce::canonicalize(&from).unwrap()));
        assert!(from.starts_with("//?/UNC/127.0.0.1"), "{}", from.display());
        assert_eq!(resolve("img/a.png", &from, None, &[]), Some(from.parent().unwrap().join("img/a.png")));
        assert_eq!(resolve(unc, &from, None, &[]), Some(image.clone()));
        let other = format!(r"\\localhost\{}", &unc[r"\\127.0.0.1\".len()..]);
        assert!(Path::new(&other).exists(), "control: {other} is not reachable over SMB");
        assert_eq!(resolve(&other, &from, None, &[]), None);
    }
}
