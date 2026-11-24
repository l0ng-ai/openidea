//! Ref decorations of the history, reused while git's ref storage has not changed.
//!
//! Listing and peeling every ref costs about 25 µs each, which a history page paid in full
//! even for a one-row page. A page now stats `HEAD`, `packed-refs` and the directories under
//! `refs/` instead: git replaces a loose ref by renaming a lock file over it, which changes
//! the modification time of the ref's directory, and rewrites `packed-refs` the same way.

use crate::Repo;
use crate::repo::absolute;
use gix::ObjectId;
use ide_core::IdeResult;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

/// A timestamp this close to the time it was read cannot tell two writes apart: a later write
/// may leave the same value (coarse file systems, FAT's 2 s). Such a snapshot is never reused.
const RACY_WINDOW: Duration = Duration::from_secs(2);

type Stat = Option<(SystemTime, u64)>;
pub(crate) type Decorations = Arc<HashMap<ObjectId, Vec<String>>>;

#[derive(Default)]
pub(crate) struct RefDecorations {
    snapshot: Option<Snapshot>,
    /// Changes when the decorations do, so cached views of them can be keyed by it.
    generation: u64,
}

struct Snapshot {
    map: Decorations,
    stamp: Vec<(PathBuf, Stat)>,
    reusable: bool,
}

fn stat(path: &Path) -> Stat {
    let metadata = std::fs::metadata(path).ok()?;
    Some((metadata.modified().ok()?, metadata.len()))
}

/// `HEAD`, `packed-refs` and every directory under `refs/`.
fn stamp(git_dir: &Path, common_dir: &Path) -> Vec<(PathBuf, Stat)> {
    let mut paths = vec![git_dir.join("HEAD"), common_dir.join("packed-refs")];
    let mut pending = vec![common_dir.join("refs")];
    while let Some(dir) = pending.pop() {
        if let Ok(entries) = std::fs::read_dir(&dir) {
            pending.extend(entries.flatten().filter(|e| e.file_type().is_ok_and(|t| t.is_dir())).map(|e| e.path()));
        }
        paths.push(dir);
    }
    paths.into_iter().map(|path| (path.clone(), stat(&path))).collect()
}

impl RefDecorations {
    fn get(&mut self, repo: &gix::Repository, git_dir: &Path, common_dir: &Path) -> IdeResult<(Decorations, u64)> {
        if let Some(snapshot) = &self.snapshot
            && snapshot.reusable
            && snapshot.stamp.iter().all(|(path, before)| stat(path) == *before)
        {
            return Ok((snapshot.map.clone(), self.generation));
        }
        // Stamped before the refs are read, so a write after the stamp shows in the next one.
        let taken = SystemTime::now();
        let stamp = stamp(git_dir, common_dir);
        let map = crate::history::decorations(repo)?;
        let reusable = stamp.iter().all(|(_, stat)| stat.is_none_or(|(modified, _)| modified + RACY_WINDOW <= taken));
        let unchanged = self.snapshot.as_ref().is_some_and(|old| *old.map == map);
        let map = match &self.snapshot {
            Some(old) if unchanged => old.map.clone(),
            _ => {
                self.generation += 1;
                Arc::new(map)
            }
        };
        self.snapshot = Some(Snapshot { map: map.clone(), stamp, reusable });
        Ok((map, self.generation))
    }
}

impl Repo {
    /// Commit id → decoration labels, and a number that changes whenever they do.
    pub(crate) fn ref_decorations(&self, repo: &gix::Repository) -> IdeResult<(Decorations, u64)> {
        let common_dir = absolute(repo.common_dir())?;
        self.ref_decorations.lock().unwrap_or_else(|p| p.into_inner()).get(repo, &self.git_dir, &common_dir)
    }
}

#[cfg(test)]
mod tests {
    use crate::history::decorations_scans;
    use crate::{LogOrder, LogQuery, Repo};
    use std::path::Path;
    use std::time::{Duration, SystemTime};

    fn git(dir: &Path, args: &[&str]) -> String {
        let out = std::process::Command::new("git")
            .current_dir(dir)
            .args(["-c", "init.defaultBranch=main", "-c", "user.name=T", "-c", "user.email=t@example.com"])
            .args(["-c", "commit.gpgsign=false"])
            .args(args)
            .output()
            .unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    fn commit(dir: &Path, message: &str) -> String {
        std::fs::write(dir.join("f"), message).unwrap();
        git(dir, &["add", "-A"]);
        git(dir, &["commit", "-qm", message]);
        git(dir, &["rev-parse", "HEAD"])
    }

    /// Sets the modification time of `HEAD`, `packed-refs` and every directory under `refs/`.
    fn set_ref_times(repo: &Repo, time: SystemTime) {
        let git = repo.git_dir.clone();
        let mut paths = vec![git.join("HEAD"), git.join("packed-refs")];
        let mut pending = vec![git.join("refs")];
        while let Some(dir) = pending.pop() {
            pending.extend(std::fs::read_dir(&dir).unwrap().flatten().filter(|e| e.path().is_dir()).map(|e| e.path()));
            paths.push(dir);
        }
        let mut options = std::fs::File::options();
        options.read(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            const FILE_WRITE_ATTRIBUTES: u32 = 0x100;
            const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
            options.access_mode(FILE_WRITE_ATTRIBUTES).custom_flags(FILE_FLAG_BACKUP_SEMANTICS);
        }
        for path in paths.into_iter().filter(|p| p.exists()) {
            options.open(path).unwrap().set_modified(time).unwrap();
        }
    }

    /// As if the refs were written long ago, then reads the history once so the decorations
    /// are cached; a second read must not list the refs again.
    fn settle(repo: &Repo) {
        set_ref_times(repo, SystemTime::now() - Duration::from_secs(3600));
        page(repo, 0, 1);
        let scans = decorations_scans();
        page(repo, 0, 1);
        assert_eq!(decorations_scans(), scans, "the decorations were not reusable");
    }

    fn page(repo: &Repo, skip: u32, limit: u32) -> Vec<crate::Commit> {
        repo.log(&LogQuery { skip, limit, summary_only: true, order: LogOrder::Topo, ..Default::default() }).unwrap()
    }

    fn labels(repo: &Repo, id: &str) -> Vec<String> {
        let all = page(repo, 0, 0);
        all.into_iter().find(|c| c.id == id).unwrap().refs
    }

    #[test]
    fn warm_pages_do_not_list_the_refs() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        git(dir, &["init", "-q"]);
        for i in 0..30 {
            commit(dir, &format!("c{i}"));
        }
        for i in 0..20 {
            git(dir, &["branch", &format!("b{i}")]);
        }
        let repo = Repo::discover(dir).unwrap().unwrap();
        settle(&repo);
        let after_first = decorations_scans();
        for skip in [10, 20, 0, 5] {
            assert_eq!(page(&repo, skip, 1).len(), 1);
            assert_eq!(page(&repo, skip, 10).len(), 10);
        }
        assert_eq!(decorations_scans(), after_first, "a warm page listed the refs again");
    }

    #[test]
    fn fresh_ref_timestamps_are_not_trusted() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        git(dir, &["init", "-q"]);
        let first = commit(dir, "first");
        let repo = Repo::discover(dir).unwrap().unwrap();
        set_ref_times(&repo, SystemTime::now());
        page(&repo, 0, 10);
        let scans = decorations_scans();
        // A write within the timestamp's resolution would leave it unchanged: rescan every time.
        page(&repo, 0, 10);
        assert!(decorations_scans() > scans);
        assert!(labels(&repo, &first).contains(&"main".to_string()));
    }

    #[test]
    fn decorations_follow_every_kind_of_ref_change() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        git(dir, &["init", "-q"]);
        let first = commit(dir, "first");
        let repo = Repo::discover(dir).unwrap().unwrap();
        settle(&repo);
        let first_labels = labels(&repo, &first);
        assert!(first_labels.contains(&"HEAD".to_string()) && first_labels.contains(&"main".to_string()));

        // A new commit moves HEAD and the branch.
        settle(&repo);
        let second = commit(dir, "second");
        assert_eq!(labels(&repo, &first), Vec::<String>::new());
        assert!(labels(&repo, &second).contains(&"main".to_string()));

        // A new tag, then an annotated one, in a directory that did not exist before.
        settle(&repo);
        git(dir, &["tag", "v1", &first]);
        assert_eq!(labels(&repo, &first), ["tag: v1"]);
        settle(&repo);
        git(dir, &["tag", "-a", "-m", "m", "rel/v2", &first]);
        assert_eq!(labels(&repo, &first), ["tag: rel/v2", "tag: v1"]);

        // A new branch, one moved to another commit, and one deleted.
        settle(&repo);
        git(dir, &["branch", "side", &first]);
        assert!(labels(&repo, &first).contains(&"side".to_string()));
        settle(&repo);
        git(dir, &["branch", "-f", "side", &second]);
        assert!(!labels(&repo, &first).contains(&"side".to_string()));
        assert!(labels(&repo, &second).contains(&"side".to_string()));
        settle(&repo);
        git(dir, &["branch", "-D", "side"]);
        assert!(!labels(&repo, &second).contains(&"side".to_string()));

        // Refs in packed-refs: packing changes nothing visible, deleting one rewrites the file.
        git(dir, &["branch", "packed", &first]);
        git(dir, &["pack-refs", "--all"]);
        settle(&repo);
        assert!(labels(&repo, &first).contains(&"packed".to_string()));
        git(dir, &["branch", "-D", "packed"]);
        assert!(!labels(&repo, &first).contains(&"packed".to_string()));

        // A detached HEAD and a tag deleted again.
        settle(&repo);
        git(dir, &["checkout", "-q", "--detach", &first]);
        assert!(labels(&repo, &first).contains(&"HEAD".to_string()));
        assert!(!labels(&repo, &second).contains(&"HEAD".to_string()));
        settle(&repo);
        git(dir, &["tag", "-d", "v1"]);
        assert_eq!(labels(&repo, &first), ["HEAD", "tag: rel/v2"]);
    }

    #[test]
    fn a_ref_change_between_pages_replaces_the_cached_view() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        git(dir, &["init", "-q"]);
        let first = commit(dir, "first");
        commit(dir, "second");
        let repo = Repo::discover(dir).unwrap().unwrap();
        settle(&repo);
        page(&repo, 0, 10);
        settle(&repo);
        git(dir, &["tag", "v1", &first]);
        let rows = page(&repo, 0, 10);
        assert_eq!(rows.iter().find(|c| c.id == first).unwrap().refs, ["tag: v1"]);
    }
}
