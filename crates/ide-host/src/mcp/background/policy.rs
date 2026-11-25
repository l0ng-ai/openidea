//! Which folder serves a client's path as a background project: a pure function of the
//! setting, the listed folders, the trust decisions, the recent projects and the project
//! markers on disk.

use crate::trust::TrustDecisions;
use ide_core::settings::McpBackgroundProjects;
use std::path::{Path, PathBuf};

/// The root of the background project that serves `path`: the innermost of the `listed`
/// folders containing it and, in `Trusted` mode, of the trusted projects, the trusted recent
/// projects and the nearest trusted folder with a project marker. `None` when the mode is
/// `Off`, when `path` is relative or missing, and when no folder qualifies. Listed and
/// recent folders that are gone or not absolute paths are skipped.
pub(crate) fn resolve(
    mode: McpBackgroundProjects,
    listed: &[PathBuf],
    decisions: &TrustDecisions,
    recents: &[PathBuf],
    home: Option<&Path>,
    path: &Path,
) -> Option<PathBuf> {
    let by_trust = match mode {
        McpBackgroundProjects::Off => return None,
        McpBackgroundProjects::Trusted => true,
        McpBackgroundProjects::Listed => false,
    };
    if !path.is_absolute() {
        return None;
    }
    let path = dunce::canonicalize(path).ok()?;
    // A relative entry would be read against the working directory, which says nothing
    // about the user's folders (`/` for an app started from the Finder).
    let existing = |entry: &PathBuf| entry.is_absolute().then(|| dunce::canonicalize(entry).ok()).flatten();
    // A listed folder serves its subtree whether or not it is trusted: it opens restricted then.
    let mut candidates: Vec<PathBuf> = listed.iter().filter_map(existing).collect();
    if by_trust {
        candidates.extend(decisions.projects.iter().filter(|p| trusted_here(decisions, p)).cloned());
        // Remote projects are recorded as locations (`ssh://…`), not as folders of this machine.
        let local = recents.iter().filter(|p| !p.to_string_lossy().contains("://"));
        candidates.extend(local.filter_map(existing).filter(|p| trusted_here(decisions, p)));
        let home = home.map(|h| dunce::canonicalize(h).unwrap_or_else(|_| h.to_path_buf()));
        // A trusted location and the home folder hold projects; neither is one.
        candidates
            .extend(marker_root(&path).filter(|a| {
                trusted_here(decisions, a) && !decisions.locations.contains(a) && home.as_ref() != Some(a)
            }));
    }
    innermost(&candidates, &path).cloned()
}

/// The entry with the most components among those of `entries` that contain `path`.
fn innermost<'a>(entries: impl IntoIterator<Item = &'a PathBuf>, path: &Path) -> Option<&'a PathBuf> {
    entries.into_iter().filter(|entry| path.starts_with(entry)).max_by_key(|entry| entry.components().count())
}

/// Whether the decisions trust a project at `root`: its innermost grant (the project itself
/// or a trusted location around it) lies deeper than every restricted folder around it, so a
/// restricted folder vetoes everything below it short of a grant made further down.
fn trusted_here(decisions: &TrustDecisions, root: &Path) -> bool {
    let own = decisions.projects.iter().filter(|project| *project == root);
    let Some(grant) = innermost(own.chain(&decisions.locations), root) else { return false };
    innermost(&decisions.restricted, root).is_none_or(|veto| veto.components().count() < grant.components().count())
}

/// The first ancestor of `path`, itself included, that looks like a project: it holds an
/// `.openidea` folder, or a `.git` or `.jj` entry (a linked worktree's `.git` is a file).
fn marker_root(path: &Path) -> Option<PathBuf> {
    let marked = |dir: &&Path| dir.join(".openidea").is_dir() || dir.join(".git").exists() || dir.join(".jj").exists();
    path.ancestors().find(marked).map(Path::to_path_buf)
}

#[cfg(test)]
mod tests {
    use super::*;
    use McpBackgroundProjects::{Listed, Off, Trusted};

    type Folders = &'static [&'static str];
    /// What is asked, the mode, the listed folders, the trusted projects, the trusted
    /// locations, the restricted folders, the recent projects, the path and the root that
    /// serves it; folders are relative to the tree.
    type Case = (
        &'static str,
        McpBackgroundProjects,
        Folders,
        Folders,
        Folders,
        Folders,
        Folders,
        &'static str,
        Option<&'static str>,
    );

    /// `code/` with projects of every marker kind, and `home/` standing in for the user's home.
    fn tree() -> (tempfile::TempDir, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(tmp.path()).unwrap();
        for dir in [
            "code/app/.git",
            "code/app/src",
            "code/app/.wt/feature/src",
            "code/lib/.jj",
            "code/tool/.openidea",
            "code/tool/sub",
            "code/plain/src",
            "code/vendor/dep/.git",
            "home/.openidea",
            "home/notes",
            "home/work/.git",
        ] {
            std::fs::create_dir_all(base.join(dir)).unwrap();
        }
        // A linked worktree's `.git` is a file.
        std::fs::write(base.join("code/app/.wt/feature/.git"), "gitdir: ../../.git/worktrees/feature\n").unwrap();
        // A file named like the settings folder is no marker.
        std::fs::write(base.join("code/plain/.openidea"), "").unwrap();
        (tmp, base)
    }

    #[test]
    fn the_innermost_folder_the_policy_allows_serves_a_path() {
        let (_tmp, base) = tree();
        let paths = |names: &[&str]| names.iter().map(|n| base.join(n)).collect::<Vec<_>>();
        #[rustfmt::skip]
        let cases: &[Case] = &[
            ("off serves nothing", Off, &["code/app"], &["code/app"], &["code"], &[], &["code/app"], "code/app/src", None),
            ("a listed folder, trusted or not", Listed, &["code/app"], &[], &[], &[], &[], "code/app/src", Some("code/app")),
            ("a listed folder itself", Listed, &["code/app"], &[], &[], &[], &[], "code/app", Some("code/app")),
            ("listed mode ignores trust", Listed, &[], &["code/app"], &["code"], &[], &["code/app"], "code/app/src", None),
            ("a sibling of a listed folder", Listed, &["code/app"], &[], &[], &[], &[], "code/lib", None),
            ("a listed folder that is gone", Listed, &["code/gone", "code/app"], &[], &[], &[], &[], "code/app/src", Some("code/app")),
            ("a trusted project", Trusted, &[], &["code/plain"], &[], &[], &[], "code/plain/src", Some("code/plain")),
            ("a recent project in a trusted location", Trusted, &[], &[], &["code"], &[], &["code/plain"], "code/plain/src", Some("code/plain")),
            ("a recent project nobody trusted", Trusted, &[], &[], &[], &[], &["code/plain"], "code/plain/src", None),
            ("a recent project that was restricted", Trusted, &[], &[], &["code"], &["code/plain"], &["code/plain"], "code/plain/src", None),
            ("a recent project that is gone", Trusted, &[], &[], &["code"], &[], &["code/gone"], "code/plain/src", None),
            ("a .git folder", Trusted, &[], &[], &["code"], &[], &[], "code/app/src", Some("code/app")),
            ("a .git file", Trusted, &[], &[], &["code"], &[], &[], "code/app/.wt/feature/src", Some("code/app/.wt/feature")),
            ("a .jj folder, from the root itself", Trusted, &[], &[], &["code"], &[], &[], "code/lib", Some("code/lib")),
            ("an .openidea folder", Trusted, &[], &[], &["code"], &[], &[], "code/tool/sub", Some("code/tool")),
            ("an .openidea file is no marker", Trusted, &[], &[], &["code"], &[], &[], "code/plain/src", None),
            ("a marker nobody trusted", Trusted, &[], &[], &[], &[], &[], "code/app/src", None),
            ("the walk stops at the first marker", Trusted, &[], &[], &["code"], &["code/app/.wt/feature"], &[], "code/app/.wt/feature/src", None),
            ("a worktree in a trusted location inside a trusted project", Trusted, &[], &["code/app"], &["code/app/.wt"], &[], &[], "code/app/.wt/feature/src", Some("code/app/.wt/feature")),
            ("an untrusted worktree inside a trusted project", Trusted, &[], &["code/app"], &[], &[], &[], "code/app/.wt/feature/src", Some("code/app")),
            ("a trusted child of a listed untrusted parent", Trusted, &["code"], &["code/plain"], &[], &[], &[], "code/plain/src", Some("code/plain")),
            ("the listed parent for the rest of it", Trusted, &["code"], &["code/plain"], &[], &[], &[], "code/tool/sub", Some("code")),
            ("a marker under a restricted folder", Trusted, &[], &[], &["code"], &["code/vendor"], &[], "code/vendor/dep", None),
            ("a deeper grant under a restricted folder", Trusted, &[], &["code/vendor/dep"], &["code"], &["code/vendor"], &[], "code/vendor/dep", Some("code/vendor/dep")),
            ("a restricted trusted location", Trusted, &[], &[], &["code"], &["code"], &[], "code/app/src", None),
            ("a trusted location is no project", Trusted, &[], &[], &["code/app"], &[], &[], "code/app/src", None),
            ("the home folder is no project", Trusted, &[], &[], &[""], &[], &[], "home/notes", None),
            ("a repository in the home folder", Trusted, &[], &[], &[""], &[], &[], "home/work", Some("home/work")),
            ("a missing path", Listed, &["code/app"], &[], &[], &[], &[], "code/app/missing", None),
        ];
        for (what, mode, listed, projects, locations, restricted, recents, path, expected) in cases {
            let decisions = TrustDecisions {
                projects: paths(projects),
                locations: paths(locations),
                restricted: paths(restricted),
            };
            let home = base.join("home");
            let found = resolve(*mode, &paths(listed), &decisions, &paths(recents), Some(&home), &base.join(path));
            assert_eq!(found, expected.map(|root| base.join(root)), "{what}");
        }
    }

    #[test]
    fn a_relative_path_is_served_by_nothing() {
        let (_tmp, base) = tree();
        let listed = [base.join("code/app"), PathBuf::from("code/app"), PathBuf::from(".")];
        let none = TrustDecisions::default();
        for path in ["code/app/src", ".", "src"] {
            assert_eq!(resolve(Listed, &listed, &none, &[], None, Path::new(path)), None, "{path}");
        }
    }

    #[test]
    fn a_relative_list_or_recent_entry_serves_nothing() {
        // Read against the working directory, `.` would serve whatever folder the app was started from.
        let here = dunce::canonicalize(std::env::current_dir().unwrap()).unwrap();
        let around = TrustDecisions { locations: vec![here.parent().unwrap().to_path_buf()], ..Default::default() };
        let none = TrustDecisions::default();
        let (dot, absolute): (&[PathBuf], &[PathBuf]) = (&[PathBuf::from(".")], std::slice::from_ref(&here));
        for (what, mode, listed, decisions, recents, expected) in [
            ("a listed `.`", Listed, dot, &none, &[][..], None),
            ("a listed `.` with trusted projects served", Trusted, dot, &none, &[][..], None),
            ("a recent `.`", Trusted, &[][..], &around, dot, None),
            ("the same folder listed by its full path", Listed, absolute, &none, &[][..], Some(&here)),
            ("the same folder recent by its full path", Trusted, &[][..], &around, absolute, Some(&here)),
        ] {
            assert_eq!(resolve(mode, listed, decisions, recents, None, &here).as_ref(), expected, "{what}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_folder_reached_through_a_link_is_the_folder_itself() {
        let (_tmp, base) = tree();
        std::os::unix::fs::symlink(base.join("code"), base.join("link")).unwrap();
        let none = TrustDecisions::default();
        // Listed by the link, asked for by the real path, and the other way round (`/tmp` and `/private/tmp`).
        for (listed, path) in [("link/app", "code/app/src"), ("code/app", "link/app/src"), ("link/app", "link/app")] {
            let found = resolve(Listed, &[base.join(listed)], &none, &[], None, &base.join(path));
            assert_eq!(found, Some(base.join("code/app")), "{listed} for {path}");
        }
        let trusted = TrustDecisions { locations: vec![base.join("code")], ..Default::default() };
        let recent = [base.join("link/plain")];
        assert_eq!(
            resolve(Trusted, &[], &trusted, &recent, None, &base.join("link/plain/src")),
            Some(base.join("code/plain"))
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_remote_recent_project_is_skipped_even_when_its_text_names_a_local_folder() {
        let (_tmp, base) = tree();
        // `<base>/ssh://box/app` reads as the local folder `<base>/ssh:/box/app`.
        std::fs::create_dir_all(base.join("ssh:/box/app/src")).unwrap();
        let recent = [PathBuf::from(format!("{}/ssh://box/app", base.display()))];
        let trusted = TrustDecisions { locations: vec![base.clone()], ..Default::default() };
        assert_eq!(resolve(Trusted, &[], &trusted, &recent, None, &base.join("ssh:/box/app/src")), None);
        let local = [base.join("ssh:/box/app")];
        assert_eq!(
            resolve(Trusted, &[], &trusted, &local, None, &base.join("ssh:/box/app/src")),
            Some(base.join("ssh:/box/app"))
        );
    }
}
