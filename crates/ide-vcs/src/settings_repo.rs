//! The Git repository Settings Sync keeps the IDE settings in: a bare clone in the app data,
//! written with plumbing commands only, so no working tree or hook of the repository runs.
//! Only the files Settings Sync owns are read or written; the rest of the tree is kept as is.

use crate::cli::{Output, run, run_cancellable_raw, run_env, run_raw};
use ide_core::error::ErrorKind;
use ide_core::{CancellationToken, IdeError, IdeResult};
use std::collections::BTreeMap;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// The commit this machine last synced with: the base of the next three-way merge.
const SYNCED: &str = "refs/openidea/synced";
const IDENTITY: [(&str, &str); 4] = [
    ("GIT_AUTHOR_NAME", "OpenIDEA Settings Sync"),
    ("GIT_AUTHOR_EMAIL", "settings-sync@openidea.invalid"),
    ("GIT_COMMITTER_NAME", "OpenIDEA Settings Sync"),
    ("GIT_COMMITTER_EMAIL", "settings-sync@openidea.invalid"),
];

/// Longest a fetch or push may take, credential prompts included.
const NETWORK_TIMEOUT: Duration = Duration::from_secs(120);

pub struct SettingsRepo {
    dir: PathBuf,
}

/// The remote branch settings are read from and pushed to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SettingsBranch {
    pub name: String,
    /// `None` while the branch (or the whole repository) is still empty.
    pub commit: Option<String>,
}

fn text(out: Output) -> String {
    out.stdout_str().trim().to_owned()
}

/// Runs a network command, stopped after [`NETWORK_TIMEOUT`].
fn network(dir: &Path, args: &[&str]) -> IdeResult<Output> {
    let cancel = CancellationToken::new();
    let (done, wait) = std::sync::mpsc::channel::<()>();
    let timer = std::thread::spawn({
        let cancel = cancel.clone();
        move || {
            if matches!(wait.recv_timeout(NETWORK_TIMEOUT), Err(std::sync::mpsc::RecvTimeoutError::Timeout)) {
                cancel.cancel();
            }
        }
    });
    let out = run_cancellable_raw(dir, args, &cancel);
    drop(done);
    let _ = timer.join();
    if cancel.is_cancelled() {
        return Err(IdeError::new(ErrorKind::TimedOut, "the settings repository did not answer in time"));
    }
    out
}

impl SettingsRepo {
    /// The clone of `url` in `dir`, created on first use and started over for another URL.
    pub fn open(dir: &Path, url: &str) -> IdeResult<Self> {
        let repo = Self { dir: dir.to_path_buf() };
        if dir.join("HEAD").is_file() {
            let current = run_raw(dir, &["config", "--get", "remote.origin.url"], None)?;
            if text(current) == url {
                return Ok(repo);
            }
            std::fs::remove_dir_all(dir)?;
        }
        std::fs::create_dir_all(dir)?;
        run(dir, &["init", "--bare", "-q"], None)?;
        run(dir, &["remote", "add", "origin", url], None)?;
        Ok(repo)
    }

    /// Fetches the remote's branches; the one settings live on is `main`, else `master`, else the
    /// first there is (an empty repository gets `main`).
    pub fn fetch(&self) -> IdeResult<SettingsBranch> {
        let args = ["fetch", "--prune", "--no-tags", "origin", "+refs/heads/*:refs/remotes/origin/*"];
        let out = network(&self.dir, &args)?;
        if out.code != Some(0) {
            return Err(crate::cli::failure(&args, &out.stderr, &out.stdout, out.code));
        }
        let refs = text(run(
            &self.dir,
            &["for-each-ref", "--format=%(refname:lstrip=3) %(objectname)", "refs/remotes/origin"],
            None,
        )?);
        let branches: Vec<(&str, &str)> = refs.lines().filter_map(|l| l.split_once(' ')).collect();
        let pick = ["main", "master"]
            .iter()
            .find_map(|name| branches.iter().find(|(b, _)| b == name))
            .or_else(|| branches.iter().find(|(b, _)| *b != "HEAD"));
        Ok(match pick {
            Some((name, commit)) => SettingsBranch { name: (*name).into(), commit: Some((*commit).into()) },
            None => SettingsBranch { name: "main".into(), commit: None },
        })
    }

    /// The commit this machine last synced with, if it ever did with this repository.
    pub fn synced(&self) -> Option<String> {
        let out = run_raw(&self.dir, &["rev-parse", "--verify", "-q", SYNCED], None).ok()?;
        (out.code == Some(0)).then(|| text(out))
    }

    pub fn mark_synced(&self, commit: &str) -> IdeResult<()> {
        run(&self.dir, &["update-ref", SYNCED, commit], None).map(drop)
    }

    /// The named top-level files of `commit` that it has.
    pub fn files(&self, commit: &str, names: &[String]) -> IdeResult<BTreeMap<String, String>> {
        let mut files = BTreeMap::new();
        for name in names {
            let out = run_raw(&self.dir, &["cat-file", "blob", &format!("{commit}:{name}")], None)?;
            if out.code == Some(0) {
                files.insert(name.clone(), String::from_utf8_lossy(&out.stdout).into_owned());
            }
        }
        Ok(files)
    }

    /// Commits `files` on top of `branch`, replacing those top-level files and keeping the rest
    /// of its tree, and pushes it. Returns the new commit, or an `OutOfSync` error when the
    /// branch moved on since it was fetched.
    pub fn publish(
        &self,
        branch: &SettingsBranch,
        files: &BTreeMap<String, String>,
        message: &str,
    ) -> IdeResult<String> {
        let index = self.dir.join("openidea-sync.index");
        let env = [("GIT_INDEX_FILE", index.as_os_str())];
        let _ = std::fs::remove_file(&index);
        let tree = (|| {
            match &branch.commit {
                Some(parent) => run_env(&self.dir, &["read-tree", parent], None, &env)?,
                None => run_env(&self.dir, &["read-tree", "--empty"], None, &env)?,
            };
            for (name, contents) in files {
                let blob = text(run(&self.dir, &["hash-object", "-w", "--stdin"], Some(contents.as_bytes()))?);
                let entry = format!("100644,{blob},{name}");
                run_env(&self.dir, &["update-index", "--add", "--cacheinfo", &entry], None, &env)?;
            }
            Ok::<_, IdeError>(text(run_env(&self.dir, &["write-tree"], None, &env)?))
        })();
        let _ = std::fs::remove_file(&index);
        let tree = tree?;
        let mut args = vec!["commit-tree", tree.as_str(), "-m", message];
        if let Some(parent) = &branch.commit {
            args.extend(["-p", parent.as_str()]);
        }
        let identity: Vec<(&str, &OsStr)> = IDENTITY.iter().map(|(k, v)| (*k, OsStr::new(*v))).collect();
        let commit = text(run_env(&self.dir, &args, None, &identity)?);
        let refspec = format!("{commit}:refs/heads/{}", branch.name);
        let out = network(&self.dir, &["push", "--porcelain", "origin", &refspec])?;
        if out.code != Some(0) {
            let stdout = out.stdout_str();
            if stdout.contains("[rejected]") || stdout.contains("(fetch first)") || stdout.contains("non-fast-forward")
            {
                return Err(IdeError::new(ErrorKind::OutOfSync, "the settings repository changed"));
            }
            return Err(crate::cli::failure(&["push"], &out.stderr, &out.stdout, out.code));
        }
        self.mark_synced(&commit)?;
        Ok(commit)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bare(dir: &Path) -> String {
        run(dir.parent().unwrap(), &["init", "--bare", "-q", dir.to_str().unwrap()], None).unwrap();
        dir.to_str().unwrap().to_owned()
    }

    #[test]
    fn publishes_reads_back_and_detects_a_moved_branch() {
        let tmp = tempfile::tempdir().unwrap();
        let url = bare(&tmp.path().join("remote.git"));
        let a = SettingsRepo::open(&tmp.path().join("a"), &url).unwrap();
        let b = SettingsRepo::open(&tmp.path().join("b"), &url).unwrap();

        let empty = a.fetch().unwrap();
        assert_eq!(empty, SettingsBranch { name: "main".into(), commit: None });
        assert_eq!(a.synced(), None);
        let files = BTreeMap::from([("editor.json".to_owned(), "{\"fontSize\": 14}\n".to_owned())]);
        let first = a.publish(&empty, &files, "Sync settings").unwrap();
        assert_eq!(a.synced().as_deref(), Some(first.as_str()));

        let seen = b.fetch().unwrap();
        assert_eq!(seen.commit.as_deref(), Some(first.as_str()));
        assert_eq!(b.files(&first, &["editor.json".into(), "keymaps.json".into()]).unwrap(), files);
        let keymaps = BTreeMap::from([("keymaps.json".to_owned(), "{}\n".to_owned())]);
        b.publish(&seen, &keymaps, "Sync settings").unwrap();

        // `a` still believes `first` is the tip.
        let stale = SettingsBranch { name: "main".into(), commit: Some(first) };
        let error = a.publish(&stale, &files, "Sync settings").err().unwrap();
        assert_eq!(error.kind, ErrorKind::OutOfSync);

        // Another URL starts the clone over.
        let other = bare(&tmp.path().join("other.git"));
        let a = SettingsRepo::open(&tmp.path().join("a"), &other).unwrap();
        assert_eq!(a.synced(), None);
    }

    #[cfg(unix)]
    #[test]
    fn keeps_the_files_it_does_not_own() {
        let tmp = tempfile::tempdir().unwrap();
        let url = bare(&tmp.path().join("remote.git"));
        let work = tmp.path().join("work");
        run(tmp.path(), &["init", "-q", "-b", "main", work.to_str().unwrap()], None).unwrap();
        std::fs::create_dir(work.join("sub")).unwrap();
        std::fs::write(work.join("sub/readme.md"), "notes").unwrap();
        std::fs::write(work.join("run.sh"), "#!/bin/sh\n").unwrap();
        std::os::unix::fs::symlink("run.sh", work.join("link")).unwrap();
        std::fs::write(work.join("back\\slash.json"), "{}").unwrap();
        std::fs::write(work.join("editor.json"), "{}").unwrap();
        run(&work, &["add", "-A"], None).unwrap();
        run(&work, &["update-index", "--chmod=+x", "run.sh"], None).unwrap();
        let env: Vec<(&str, &OsStr)> = IDENTITY.iter().map(|(k, v)| (*k, OsStr::new(*v))).collect();
        run_env(&work, &["commit", "-qm", "theirs"], None, &env).unwrap();
        run(&work, &["push", "-q", &url, "main"], None).unwrap();
        let tree = |rev: &str| text(run(&work, &["ls-tree", "-r", &format!("{rev}^{{tree}}")], None).unwrap());
        run(&work, &["fetch", "-q", &url, "main"], None).unwrap();
        let before = tree("FETCH_HEAD");

        let repo = SettingsRepo::open(&tmp.path().join("clone"), &url).unwrap();
        let branch = repo.fetch().unwrap();
        let files = BTreeMap::from([("editor.json".to_owned(), "{\"fontSize\": 14}\n".to_owned())]);
        repo.publish(&branch, &files, "Sync settings").unwrap();
        run(&work, &["fetch", "-q", &url, "main"], None).unwrap();
        let after = tree("FETCH_HEAD");
        let without_editor =
            |t: &str| t.lines().filter(|l| !l.ends_with("\teditor.json")).collect::<Vec<_>>().join("\n");
        assert_eq!(without_editor(&after), without_editor(&before));
        assert!(after.contains("100755 blob") && after.contains("120000 blob") && after.contains("sub/readme.md"));
        assert_ne!(after, before);
    }
}
