use crate::Repo;
use ide_core::{IdeError, IdeResult};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, Instant};

const QUIET: Duration = Duration::from_millis(100);
const MAX_WAIT: Duration = Duration::from_secs(1);

/// Watches the Git metadata (`HEAD`, `index`, `packed-refs`, `refs/**`) of repositories whose
/// git directories lie outside the project's own file watcher: a project opened in a
/// subfolder of its repository, a linked worktree, a mapped repository elsewhere. Commits,
/// checkouts and resets run in a terminal then reach the IDE like those below the project.
pub struct MetadataWatch {
    watcher: Mutex<RecommendedWatcher>,
    /// Watched directory → whether only its top-level metadata files count (`false`: a
    /// recursively watched `refs` directory, where every non-lock file counts).
    dirs: Arc<Mutex<BTreeMap<PathBuf, bool>>>,
}

impl MetadataWatch {
    /// `changed` receives the metadata files that changed, coalesced over short bursts.
    pub fn new(changed: impl Fn(Vec<PathBuf>) + Send + 'static) -> IdeResult<Self> {
        let dirs = Arc::new(Mutex::new(BTreeMap::<PathBuf, bool>::new()));
        let (tx, rx) = mpsc::channel::<PathBuf>();
        let watched = dirs.clone();
        let watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
            let Ok(event) = event else { return };
            if event.kind.is_access() {
                return;
            }
            let dirs = watched.lock().unwrap_or_else(|e| e.into_inner());
            for path in event.paths.iter().filter(|p| is_metadata(&dirs, p)) {
                let _ = tx.send(path.clone());
            }
        })
        .map_err(|e| IdeError::internal(format!("Git metadata watcher: {e}")))?;
        std::thread::Builder::new()
            .name("openidea-git-metadata".into())
            .spawn(move || {
                while let Ok(first) = rx.recv() {
                    let deadline = Instant::now() + MAX_WAIT;
                    let mut paths = BTreeSet::from([first]);
                    while Instant::now() < deadline
                        && let Ok(path) = rx.recv_timeout(QUIET)
                    {
                        paths.insert(path);
                    }
                    changed(paths.into_iter().collect());
                }
            })
            .map_err(|e| IdeError::internal(format!("Git metadata watcher: {e}")))?;
        Ok(Self { watcher: Mutex::new(watcher), dirs })
    }

    /// Watches the metadata of `repos` that the project watcher of `covered` doesn't report:
    /// git directories outside it, and submodule git directories (`.git/modules/…`) inside it.
    pub fn set_repos(&self, repos: &[Arc<Repo>], covered: &Path) {
        let covered = dunce::canonicalize(covered).unwrap_or_else(|_| covered.to_path_buf());
        let mut wanted = BTreeMap::new();
        for repo in repos {
            let Ok([git_dir, common_dir]) = repo.metadata_dirs() else { continue };
            for (dir, top_level) in [(git_dir, true), (common_dir.clone(), true), (common_dir.join("refs"), false)] {
                if let Ok(dir) = dunce::canonicalize(&dir)
                    && !watched_by_project(&covered, &dir)
                {
                    wanted.insert(dir, top_level);
                }
            }
        }
        let mut watcher = self.watcher.lock().unwrap_or_else(|e| e.into_inner());
        let mut dirs = self.dirs.lock().unwrap_or_else(|e| e.into_inner());
        for dir in dirs.keys().filter(|d| !wanted.contains_key(*d)) {
            let _ = watcher.unwatch(dir);
        }
        wanted.retain(|dir, top_level| {
            if dirs.contains_key(dir) {
                return true;
            }
            let mode = if *top_level { RecursiveMode::NonRecursive } else { RecursiveMode::Recursive };
            watcher.watch(dir, mode).map_err(|e| tracing::debug!("Git metadata watcher {}: {e}", dir.display())).is_ok()
        });
        *dirs = wanted;
    }

    pub fn watched_dirs(&self) -> Vec<PathBuf> {
        self.dirs.lock().unwrap_or_else(|e| e.into_inner()).keys().cloned().collect()
    }
}

fn watched_by_project(root: &Path, dir: &Path) -> bool {
    dir.strip_prefix(root)
        .is_ok_and(|rel| !rel.components().skip_while(|c| c.as_os_str() != ".git").any(|c| c.as_os_str() == "modules"))
}

fn is_metadata(dirs: &BTreeMap<PathBuf, bool>, path: &Path) -> bool {
    if path.file_name().is_some_and(|n| n.to_string_lossy().ends_with(".lock")) {
        return false;
    }
    dirs.iter().any(|(dir, top_level)| match path.strip_prefix(dir) {
        Ok(rest) if *top_level => rest.to_str().is_some_and(|r| matches!(r, "HEAD" | "index" | "packed-refs")),
        Ok(rest) => !rest.as_os_str().is_empty(),
        Err(_) => false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git(dir: &Path, args: &[&str]) {
        let out = std::process::Command::new("git")
            .current_dir(dir)
            .args(["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false"])
            .args(args)
            .output()
            .unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    }

    fn wait_for(seen: &Mutex<Vec<PathBuf>>, pred: impl Fn(&[PathBuf]) -> bool) -> bool {
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if pred(&seen.lock().unwrap()) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        false
    }

    #[test]
    fn metadata_files_count_and_locks_and_objects_do_not() {
        let dirs = BTreeMap::from([(PathBuf::from("/r/.git"), true), (PathBuf::from("/r/.git/refs"), false)]);
        for (path, expected) in [
            ("/r/.git/HEAD", true),
            ("/r/.git/index", true),
            ("/r/.git/packed-refs", true),
            ("/r/.git/refs/heads/main", true),
            ("/r/.git/refs/heads/feature/x", true),
            ("/r/.git/index.lock", false),
            ("/r/.git/refs/heads/main.lock", false),
            ("/r/.git/objects/aa/bb", false),
            ("/r/.git/logs/HEAD", false),
            ("/r/.git/COMMIT_EDITMSG", false),
            ("/r/src/HEAD", false),
        ] {
            assert_eq!(is_metadata(&dirs, Path::new(path)), expected, "{path}");
        }
    }

    /// The project folder is a subfolder of its repository, or a linked worktree: a commit made
    /// in a terminal writes only outside it, and still surfaces.
    #[test]
    fn external_commits_surface_for_projects_outside_their_git_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(tmp.path()).unwrap();
        let main = base.join("main");
        std::fs::create_dir_all(main.join("sub")).unwrap();
        git(&main, &["init", "-q", "-b", "main"]);
        git(&main, &["commit", "-q", "--allow-empty", "-m", "init"]);
        git(&main, &["worktree", "add", "-q", "-b", "topic", base.join("wt").to_str().unwrap()]);
        for project in [main.join("sub"), base.join("wt")] {
            let repo = Arc::new(Repo::discover(&project).unwrap().unwrap());
            let seen = Arc::new(Mutex::new(Vec::new()));
            let watch = {
                let seen = seen.clone();
                MetadataWatch::new(move |paths| seen.lock().unwrap().extend(paths)).unwrap()
            };
            watch.set_repos(std::slice::from_ref(&repo), &project);
            assert!(!watch.watched_dirs().is_empty(), "{}", project.display());
            std::thread::sleep(Duration::from_millis(300));
            std::fs::write(project.join("a.txt"), project.to_string_lossy().as_bytes()).unwrap();
            git(&project, &["add", "a.txt"]);
            git(&project, &["commit", "-q", "-m", "change"]);
            assert!(
                wait_for(&seen, |p| p.iter().any(|p| p.starts_with(repo.metadata_dirs().unwrap()[1].join("refs")))),
                "{}: {:?}",
                project.display(),
                seen.lock().unwrap()
            );
            assert!(
                wait_for(&seen, |p| p.iter().any(|p| p.ends_with("index"))),
                "{}: {:?}",
                project.display(),
                seen.lock().unwrap()
            );
        }
    }

    #[test]
    fn the_project_watcher_reports_its_git_dirs_but_not_submodule_ones() {
        let root = Path::new("/p");
        for (dir, expected) in [
            ("/p/.git", true),
            ("/p/.git/refs", true),
            ("/p/.git/worktrees/wt", true),
            ("/p/nested/.git", true),
            ("/p/.git/modules/lib", false),
            ("/p/.git/modules/lib/refs", false),
            ("/p/.git/modules/a/modules/b", false),
            ("/elsewhere/.git", false),
        ] {
            assert_eq!(watched_by_project(root, Path::new(dir)), expected, "{dir}");
        }
    }

    #[test]
    fn metadata_below_the_covered_folder_is_left_to_the_project_watcher() {
        let tmp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(tmp.path()).unwrap();
        git(&root, &["init", "-q"]);
        let repo = Arc::new(Repo::discover(&root).unwrap().unwrap());
        let watch = MetadataWatch::new(|_| {}).unwrap();
        watch.set_repos(std::slice::from_ref(&repo), &root);
        assert!(watch.watched_dirs().is_empty());
        watch.set_repos(std::slice::from_ref(&repo), &root.join("elsewhere"));
        assert_eq!(watch.watched_dirs().len(), 2, "{:?}", watch.watched_dirs());
        watch.set_repos(&[], &root);
        assert!(watch.watched_dirs().is_empty());
    }
}
