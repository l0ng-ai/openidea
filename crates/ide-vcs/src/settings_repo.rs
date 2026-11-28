//! The Git repository Settings Sync keeps the IDE settings in: a bare clone in the app data,
//! written with plumbing commands only, so no working tree or hook of the repository runs.

use crate::cli::{run, run_raw};
use ide_core::{IdeError, IdeResult};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// The commit this machine last synced with: the base of the next three-way merge.
const SYNCED: &str = "refs/openidea/synced";
const IDENTITY: [(&str, &str); 4] = [
    ("GIT_AUTHOR_NAME", "OpenIDEA Settings Sync"),
    ("GIT_AUTHOR_EMAIL", "settings-sync@openidea.invalid"),
    ("GIT_COMMITTER_NAME", "OpenIDEA Settings Sync"),
    ("GIT_COMMITTER_EMAIL", "settings-sync@openidea.invalid"),
];

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

fn text(out: crate::cli::Output) -> String {
    out.stdout_str().trim().to_owned()
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
        run(&self.dir, &["fetch", "--prune", "--no-tags", "origin", "+refs/heads/*:refs/remotes/origin/*"], None)?;
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

    /// The top-level files of `commit`, by name.
    pub fn files(&self, commit: &str) -> IdeResult<BTreeMap<String, String>> {
        let listing = text(run(&self.dir, &["ls-tree", "-z", commit], None)?);
        let mut files = BTreeMap::new();
        for entry in listing.split('\0').filter(|e| !e.is_empty()) {
            let Some((meta, name)) = entry.split_once('\t') else { continue };
            let mut meta = meta.split(' ');
            if meta.nth(1) != Some("blob") {
                continue;
            }
            let Some(object) = meta.next() else { continue };
            let blob = run(&self.dir, &["cat-file", "blob", object], None)?;
            files.insert(name.to_owned(), String::from_utf8_lossy(&blob.stdout).into_owned());
        }
        Ok(files)
    }

    /// Commits `files` as the whole tree on top of `branch` and pushes it. Returns the new commit,
    /// or an `OutOfSync` error when the branch moved on since it was fetched.
    pub fn publish(
        &self,
        branch: &SettingsBranch,
        files: &BTreeMap<String, String>,
        message: &str,
    ) -> IdeResult<String> {
        let mut tree = String::new();
        for (name, contents) in files {
            if name.contains(['/', '\\', '\t', '\n', '\0']) {
                return Err(IdeError::invalid(format!("invalid settings file name {name:?}")));
            }
            let blob = text(run(&self.dir, &["hash-object", "-w", "--stdin"], Some(contents.as_bytes()))?);
            tree.push_str(&format!("100644 blob {blob}\t{name}\n"));
        }
        let tree = text(run(&self.dir, &["mktree"], Some(tree.as_bytes()))?);
        let mut args = vec!["commit-tree", tree.as_str(), "-m", message];
        if let Some(parent) = &branch.commit {
            args.extend(["-p", parent.as_str()]);
        }
        let env: Vec<(&str, &std::ffi::OsStr)> = IDENTITY.iter().map(|(k, v)| (*k, std::ffi::OsStr::new(*v))).collect();
        let commit = text(crate::cli::run_env(&self.dir, &args, None, &env)?);
        let refspec = format!("{commit}:refs/heads/{}", branch.name);
        let out = run_raw(&self.dir, &["push", "--porcelain", "origin", &refspec], None)?;
        if out.code != Some(0) {
            let stdout = out.stdout_str();
            if stdout.contains("[rejected]") || stdout.contains("(fetch first)") || stdout.contains("non-fast-forward")
            {
                return Err(IdeError::new(ide_core::error::ErrorKind::OutOfSync, "the settings repository changed"));
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
        assert_eq!(b.files(&first).unwrap(), files);
        b.publish(&seen, &BTreeMap::new(), "Sync settings").unwrap();

        // `a` still believes `first` is the tip.
        let stale = SettingsBranch { name: "main".into(), commit: Some(first) };
        let error = a.publish(&stale, &files, "Sync settings").err().unwrap();
        assert_eq!(error.kind, ide_core::error::ErrorKind::OutOfSync);

        // Another URL starts the clone over.
        let other = bare(&tmp.path().join("other.git"));
        let a = SettingsRepo::open(&tmp.path().join("a"), &other).unwrap();
        assert_eq!(a.synced(), None);
    }
}
