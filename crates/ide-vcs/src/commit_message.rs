use crate::{Repo, cherry_pick_plan, cli, ops};
use ide_core::workflow_settings::EmptyCherryPickAction;
use ide_core::{CancellationToken, IdeError, IdeResult, IpcPath};
use notify::event::{MetadataKind, ModifyKind};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::BTreeSet;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

const MESSAGE_LIMIT: usize = 1 << 20;
const PREPARED_MESSAGE_FILES: [&str; 2] = ["SQUASH_MSG", "MERGE_MSG"];
const APPLY_HEADS: [(CommitApplyKind, &str); 2] =
    [(CommitApplyKind::CherryPick, "CHERRY_PICK_HEAD"), (CommitApplyKind::Revert, "REVERT_HEAD")];

fn apply_changed() -> IdeError {
    IdeError::invalid("The Git operation changed. Review the current changes and try again.")
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CommitMessages {
    pub template: Option<String>,
    pub prepared: Option<String>,
    #[serde(default)]
    pub pending_apply: Option<PendingCommitApply>,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum CommitApplyKind {
    #[default]
    CherryPick,
    Revert,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CommitApplySource {
    #[serde(default)]
    pub kind: CommitApplyKind,
    pub repo: IpcPath,
    pub commit: String,
    pub base: String,
    pub author: Option<String>,
    pub author_date: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, Type)]
pub struct PendingCommitApply {
    pub source: CommitApplySource,
    pub paths: Vec<IpcPath>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ApplyCommitReview {
    pub kind: CommitApplyKind,
    pub checkpoint: String,
    pub message: String,
    pub paths: Vec<IpcPath>,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub author_date: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct ApplyCommitOptions {
    pub author: Option<String>,
    pub author_date: Option<String>,
    pub sign_off: bool,
    pub run_hooks: bool,
}

impl Default for ApplyCommitOptions {
    fn default() -> Self {
        Self { author: None, author_date: None, sign_off: false, run_hooks: true }
    }
}

/// Watches Git-prepared messages and the effective template, including files outside the worktree.
pub struct CommitMessageWatch {
    watcher: RecommendedWatcher,
    base_files: BTreeSet<PathBuf>,
    files: Arc<Mutex<BTreeSet<PathBuf>>>,
    dirs: BTreeSet<PathBuf>,
}

impl CommitMessageWatch {
    fn new(base_files: BTreeSet<PathBuf>, changed: impl Fn() + Send + 'static) -> IdeResult<Self> {
        let files = Arc::new(Mutex::new(BTreeSet::<PathBuf>::new()));
        let watched = files.clone();
        let watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
            if let Ok(event) = event
                && (event.need_rescan()
                    || (!event.kind.is_access()
                        && event.kind != notify::EventKind::Modify(ModifyKind::Metadata(MetadataKind::AccessTime))
                        && event.paths.iter().any(|p| {
                            watched.lock().unwrap_or_else(|e| e.into_inner()).iter().any(|f| f.starts_with(p))
                        })))
            {
                changed();
            }
        })
        .map_err(|e| IdeError::internal(format!("Git commit message watcher: {e}")))?;
        let mut watch = Self { watcher, base_files, files, dirs: BTreeSet::new() };
        watch.replace_files(BTreeSet::new());
        Ok(watch)
    }

    fn replace_files(&mut self, paths: BTreeSet<PathBuf>) -> bool {
        let mut files = BTreeSet::new();
        let mut dirs = BTreeSet::new();
        for path in self.base_files.iter().chain(&paths) {
            // Track both a symlink's name and the file it resolves to. Watching the nearest
            // existing directory also catches a missing template or config appearing later.
            for file in [watch_path(path), dunce::canonicalize(path).ok()].into_iter().flatten() {
                if let Some(dir) = file.ancestors().skip(1).find(|dir| dir.is_dir()) {
                    dirs.insert(dir.to_path_buf());
                    files.insert(file);
                }
            }
        }
        let changed = {
            let mut watched = self.files.lock().unwrap_or_else(|e| e.into_inner());
            let changed = *watched != files || self.dirs != dirs;
            *watched = files;
            changed
        };
        for dir in self.dirs.difference(&dirs) {
            let _ = self.watcher.unwatch(dir);
        }
        dirs.retain(|dir| {
            self.dirs.contains(dir)
                || self
                    .watcher
                    .watch(dir, RecursiveMode::NonRecursive)
                    .map_err(|e| {
                        tracing::debug!("Git commit message watcher {}: {e}", dir.display());
                    })
                    .is_ok()
        });
        self.dirs = dirs;
        changed
    }
}

fn watch_path(path: &Path) -> Option<PathBuf> {
    let parent = path.parent()?.ancestors().find(|p| p.is_dir())?;
    Some(dunce::canonicalize(parent).ok()?.join(path.strip_prefix(parent).ok()?))
}

#[derive(Default)]
struct MessageConfig {
    configured: bool,
    encoding: Option<String>,
    comment: Option<String>,
    files: BTreeSet<PathBuf>,
}

impl MessageConfig {
    fn parse(root: &Path, bytes: &[u8]) -> Self {
        let mut config = Self::default();
        let mut fields = bytes.split(|byte| *byte == 0);
        while let (Some(origin), Some(entry)) = (fields.next(), fields.next()) {
            let source = origin.strip_prefix(b"file:").map(|path| root.join(String::from_utf8_lossy(path).as_ref()));
            config.files.extend(source.iter().cloned());
            let entry = String::from_utf8_lossy(entry);
            let (key, value) = entry.split_once('\n').unwrap_or((&entry, ""));
            match key {
                "commit.template" => config.configured = !value.is_empty(),
                "i18n.commitencoding" => config.encoding = Some(value.to_owned()),
                "core.commentchar" | "core.commentstring" => config.comment = Some(value.to_owned()),
                key if key == "include.path" || (key.starts_with("includeif.") && key.ends_with(".path")) => {
                    // Git only reports origins that produced entries. Keep watching an include
                    // even when its file is empty or has yet to be created.
                    if let Some(path) = include_path(source.as_deref(), value) {
                        config.files.insert(path);
                    }
                }
                _ => {}
            }
        }
        config
    }
}

fn include_path(source: Option<&Path>, value: &str) -> Option<PathBuf> {
    if value.is_empty() {
        return None;
    }
    if let Some(relative) = value.strip_prefix("~/") {
        return Some(gix::path::env::home_dir()?.join(relative));
    }
    let path = Path::new(value);
    if path.is_absolute() {
        return Some(path.to_path_buf());
    }
    Some(source?.parent()?.join(path))
}

impl Repo {
    pub fn watch_commit_messages(
        &self,
        cancel: &CancellationToken,
        changed: impl Fn() + Send + 'static,
    ) -> IdeResult<CommitMessageWatch> {
        let _scope = self.execution_scope();
        let [git_dir, common_dir] = self.metadata_dirs()?;
        let mut files =
            BTreeSet::from([git_dir.join("HEAD"), git_dir.join("config.worktree"), common_dir.join("config")]);
        files.extend(PREPARED_MESSAGE_FILES.map(|name| git_dir.join(name)));
        files.extend(APPLY_HEADS.map(|(_, name)| git_dir.join(name)));
        for variable in ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM"] {
            if let Ok(out) = cli::run_bounded(self.root(), &["var", variable], cancel, 65536) {
                files.extend(out.stdout_str().lines().filter(|line| !line.is_empty()).map(PathBuf::from));
            }
        }
        CommitMessageWatch::new(files, changed)
    }

    pub fn commit_messages(
        &self,
        watch: &mut CommitMessageWatch,
        cancel: &CancellationToken,
    ) -> IdeResult<CommitMessages> {
        // Read again after installing newly discovered watches. This closes the gap between
        // reading the configuration and observing changes to a newly configured template.
        let (mut config, mut path) = self.commit_message_config(cancel)?;
        if set_template_paths(watch, &config, path.as_deref()) {
            (config, path) = self.commit_message_config(cancel)?;
            set_template_paths(watch, &config, path.as_deref());
        }
        let template = path.and_then(|path| read_message(&path, &config, false));
        let prepared = PREPARED_MESSAGE_FILES
            .iter()
            .filter_map(|file| read_message(&self.git_dir.join(file), &config, true))
            .collect::<Vec<_>>();
        let prepared = (!prepared.is_empty()).then(|| prepared.join("\n\n"));
        let pending_apply = prepared.as_ref().and_then(|_| self.pending_apply(cancel));
        Ok(CommitMessages { template, prepared, pending_apply })
    }

    fn pending_apply(&self, cancel: &CancellationToken) -> Option<PendingCommitApply> {
        let _scope = self.execution_scope();
        let (kind, marker, revision) = self.apply_head()?;
        let commit = gix::ObjectId::from_hex(revision.as_bytes()).ok()?.to_string();
        let (_, base) = self.head().ok()?;
        let base = base?;
        let (author, author_date) = self.apply_author(kind, &commit, cancel);
        let index = cli::run_bounded(
            self.root(),
            &["diff", "--cached", "--name-only", "-z", "--no-renames", "--no-ext-diff", "--no-relative", &base, "--"],
            cancel,
            4 << 20,
        )
        .ok()?;
        // Git starts these operations with a clean index. The cached paths include both
        // applied and unmerged changes, leaving pre-existing unstaged changes alone.
        let paths = index
            .stdout
            .split(|byte| *byte == 0)
            .filter(|path| !path.is_empty())
            .map(|path| IpcPath(self.root().join(String::from_utf8_lossy(path).as_ref())))
            .collect();
        if read_message(&marker, &MessageConfig::default(), false).as_deref() != Some(&revision)
            || self.head().ok()?.1.as_deref() != Some(&base)
        {
            return None;
        }
        Some(PendingCommitApply {
            source: CommitApplySource {
                kind,
                repo: IpcPath(self.root().to_path_buf()),
                commit,
                base,
                author,
                author_date,
            },
            paths,
        })
    }

    fn apply_head(&self) -> Option<(CommitApplyKind, PathBuf, String)> {
        APPLY_HEADS.into_iter().find_map(|(kind, name)| {
            let marker = self.git_dir.join(name);
            let revision = read_message(&marker, &MessageConfig::default(), false)?;
            Some((kind, marker, revision))
        })
    }

    /// The staged changes Git would commit after a cherry-pick or revert stopped.
    pub fn review_apply_commit(&self, cancel: &CancellationToken) -> IdeResult<Option<ApplyCommitReview>> {
        let _scope = self.execution_scope();
        self.review_apply_index(cancel, &[])
    }

    pub(crate) fn review_apply_index(
        &self,
        cancel: &CancellationToken,
        env: &[(&str, &std::ffi::OsStr)],
    ) -> IdeResult<Option<ApplyCommitReview>> {
        let Some((kind, marker, revision)) = self.apply_head() else { return Ok(None) };
        let (branch, head) = self.head()?;
        let head = head.ok_or_else(|| IdeError::invalid("Git operation has no current commit"))?;
        let modified = marker.metadata()?.modified()?;
        let raw = cli::run_bounded_env(
            self.root(),
            &[
                "diff",
                "--cached",
                "--raw",
                "-z",
                "--no-abbrev",
                "--no-renames",
                "--no-ext-diff",
                "--no-relative",
                "--ignore-submodules=none",
                &head,
                "--",
            ],
            cancel,
            16 << 20,
            env,
        )?;
        let mut paths = Vec::new();
        let mut fields = raw.stdout.split(|&b| b == 0).filter(|field| !field.is_empty());
        while let (Some(change), Some(path)) = (fields.next(), fields.next()) {
            if change.ends_with(b" U") {
                return Err(IdeError::invalid("Resolve all conflicts before continuing"));
            }
            paths.push(IpcPath(self.root().join(String::from_utf8_lossy(path).as_ref())));
        }
        if paths.is_empty() {
            return Ok(None);
        }
        let (config, _) = self.commit_message_config(cancel)?;
        let message = read_message(&self.git_dir.join("MERGE_MSG"), &config, true).unwrap_or_default();
        if self.apply_head().as_ref() != Some(&(kind, marker.clone(), revision.clone()))
            || marker.metadata()?.modified()? != modified
            || self.head()? != (branch.clone(), Some(head.clone()))
        {
            return Err(apply_changed());
        }
        let mut digest = blake3::Hasher::new();
        digest.update(format!("{kind:?}\0{revision}\0{branch:?}\0{head}\0{modified:?}\0{message}\0").as_bytes());
        digest.update(&raw.stdout);
        let (author, author_date) = self.apply_author(kind, &revision, cancel);
        Ok(Some(ApplyCommitReview {
            kind,
            checkpoint: digest.finalize().to_hex().to_string(),
            message,
            paths,
            author,
            author_date,
        }))
    }

    pub fn continue_reviewed_apply(
        &self,
        checkpoint: &str,
        message: &str,
        options: &ApplyCommitOptions,
        empty_action: EmptyCherryPickAction,
        cancel: &CancellationToken,
        out: &dyn Fn(String),
    ) -> IdeResult<u32> {
        let _scope = self.execution_scope();
        if message.trim().is_empty() || message.contains('\0') || message.len() > MESSAGE_LIMIT {
            return Err(IdeError::invalid("Invalid commit message"));
        }
        ops::continue_op(self, false, |args| {
            let review = self.require_apply_review(checkpoint, cancel)?;
            let edited =
                (message != review.message || *options != ApplyCommitOptions::default()).then_some((message, options));
            cherry_pick_plan::resume(self, args, edited, empty_action, cancel, out)
        })
    }

    pub(crate) fn require_apply_review(
        &self,
        checkpoint: &str,
        cancel: &CancellationToken,
    ) -> IdeResult<ApplyCommitReview> {
        self.review_apply_index(cancel, &[])?.filter(|review| review.checkpoint == checkpoint).ok_or_else(apply_changed)
    }

    fn apply_author(
        &self,
        kind: CommitApplyKind,
        commit: &str,
        cancel: &CancellationToken,
    ) -> (Option<String>, Option<String>) {
        if kind == CommitApplyKind::CherryPick
            && gix::ObjectId::from_hex(commit.as_bytes()).is_ok()
            && let Some((author, date)) = self.commit_author(commit, cancel)
        {
            return (Some(author), Some(date));
        }
        (None, None)
    }

    fn commit_author(&self, commit: &str, cancel: &CancellationToken) -> Option<(String, String)> {
        let raw = cli::run_bounded(
            self.root(),
            &["show", "-s", "--no-show-signature", "--format=%an%x00%ae%x00%aI", commit, "--"],
            cancel,
            64 << 10,
        )
        .ok()?;
        let text = raw.stdout_str();
        let mut fields = text.trim_end().split('\0');
        let author = format!("{} <{}>", fields.next()?, fields.next()?);
        Some((author, fields.next()?.to_owned()))
    }

    fn commit_message_config(&self, cancel: &CancellationToken) -> IdeResult<(MessageConfig, Option<PathBuf>)> {
        let _scope = self.execution_scope();
        let raw = cli::run_bounded(
            self.root(),
            &["config", "--includes", "--show-origin", "--null", "--list"],
            cancel,
            4 << 20,
        )?;
        let config = MessageConfig::parse(self.root(), &raw.stdout);
        let path = if config.configured {
            let raw = cli::run_bounded(
                self.root(),
                &["config", "--type=path", "--null", "--get", "commit.template"],
                cancel,
                65536,
            )?;
            let value = raw.stdout.strip_suffix(&[0]).unwrap_or(&raw.stdout);
            let path = String::from_utf8_lossy(value);
            (!path.is_empty() && !path.ends_with('/')).then(|| self.root().join(path.as_ref()))
        } else {
            None
        };
        Ok((config, path))
    }
}

fn set_template_paths(watch: &mut CommitMessageWatch, config: &MessageConfig, path: Option<&Path>) -> bool {
    let mut files = config.files.clone();
    files.extend(path.map(Path::to_path_buf));
    watch.replace_files(files)
}

fn read_message(path: &Path, config: &MessageConfig, prepared: bool) -> Option<String> {
    let mut options = File::options();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    let file = options.open(path).ok()?;
    let metadata = file.metadata().ok()?;
    if !metadata.is_file() || metadata.len() > MESSAGE_LIMIT as u64 {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(MESSAGE_LIMIT as u64 + 1).read_to_end(&mut bytes).ok()?;
    if bytes.len() > MESSAGE_LIMIT {
        return None;
    }
    let encoding = config
        .encoding
        .as_deref()
        .and_then(|label| encoding_rs::Encoding::for_label(label.as_bytes()))
        .unwrap_or(encoding_rs::UTF_8);
    let (text, _, _) = encoding.decode(&bytes);
    let comment = config.comment.as_deref().filter(|prefix| !prefix.is_empty() && *prefix != "auto").unwrap_or("#");
    let message = text
        .lines()
        .filter(|line| !(line.starts_with(comment) || prepared && line.starts_with('\u{1}')))
        .collect::<Vec<_>>()
        .join("\n");
    let message = message.trim();
    (!message.is_empty()).then(|| message.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::process::Command;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    fn git(root: &Path, args: &[&str]) {
        let output = Command::new("git").current_dir(root).args(args).output().unwrap();
        assert!(output.status.success(), "{args:?}: {}", String::from_utf8_lossy(&output.stderr));
    }

    fn conflicting_git(root: &Path, args: &[&str]) {
        let output = Command::new("git").current_dir(root).args(args).output().unwrap();
        assert_eq!(output.status.code(), Some(1), "{args:?}: {}", String::from_utf8_lossy(&output.stderr));
        assert!(String::from_utf8_lossy(&output.stdout).contains("CONFLICT"), "{args:?} did not conflict");
    }

    #[test]
    fn follows_an_included_config_and_a_template_outside_the_repository() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("repo");
        fs::create_dir(&root).unwrap();
        git(&root, &["init", "-q"]);
        let include = tmp.path().join("template.gitconfig");
        let template = tmp.path().join("commit message.txt");
        let template_arg = template.to_str().unwrap();
        let include_arg = include.to_str().unwrap();
        git(&root, &["config", "--file", include_arg, "commit.template", template_arg]);
        git(&root, &["config", "--file", include_arg, "i18n.commitEncoding", "windows-1252"]);
        git(&root, &["config", "--file", include_arg, "core.commentChar", ";"]);
        git(&root, &["config", "--add", "include.path", "../../template.gitconfig"]);
        fs::write(&template, b"R\xe9sum\xe9\r\n; instructions\r\n# Keep this").unwrap();

        let repo = Repo::discover(&root).unwrap().unwrap();
        let token = CancellationToken::new();
        let (tx, rx) = mpsc::channel();
        let mut watch = repo
            .watch_commit_messages(&token, move || {
                let _ = tx.send(());
            })
            .unwrap();
        let message = repo.commit_messages(&mut watch, &token).unwrap().template;
        assert_eq!(message.as_deref(), Some("Résumé\n# Keep this"));

        let mut expect_update = |expected: Option<&str>| {
            let deadline = Instant::now() + Duration::from_secs(8);
            loop {
                rx.recv_timeout(deadline.saturating_duration_since(Instant::now()))
                    .expect("template watcher did not report the change");
                let message = repo.commit_messages(&mut watch, &token).unwrap().template;
                if message.as_deref() == expected {
                    return;
                }
            }
        };
        fs::write(&template, "Updated").unwrap();
        expect_update(Some("Updated"));
        fs::remove_file(&template).unwrap();
        expect_update(None);
        fs::write(&template, "Restored").unwrap();
        expect_update(Some("Restored"));
        fs::write(root.join("local template"), "Local template").unwrap();
        git(&root, &["config", "--file", include_arg, "commit.template", "local template"]);
        expect_update(Some("Local template"));
        fs::write(&include, "").unwrap();
        expect_update(None);
        git(&root, &["config", "--file", include_arg, "commit.template", "local template"]);
        expect_update(Some("Local template"));
    }

    #[test]
    fn follows_prepared_messages_in_the_linked_git_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let main = tmp.path().join("main");
        let linked = tmp.path().join("linked");
        fs::create_dir(&main).unwrap();
        git(&main, &["init", "-q", "-b", "main"]);
        for (key, value) in [
            ("user.name", "Fixture"),
            ("user.email", "fixture@example.invalid"),
            ("commit.gpgsign", "false"),
            ("core.commentChar", ";"),
            ("core.autocrlf", "false"),
        ] {
            git(&main, &["config", "--local", key, value]);
        }
        fs::write(main.join("notes.txt"), "base\n").unwrap();
        fs::write(main.join("local.txt"), "untouched\n").unwrap();
        git(&main, &["add", "notes.txt", "local.txt"]);
        git(&main, &["commit", "-qm", "Base notes"]);
        git(&main, &["switch", "-qc", "incoming"]);
        fs::write(main.join("notes.txt"), "incoming\n").unwrap();
        git(&main, &["commit", "-qam", "Incoming notes"]);
        git(&main, &["worktree", "add", "-qb", "workspace", linked.to_str().unwrap(), "main"]);
        fs::write(linked.join("notes.txt"), "local\n").unwrap();
        git(&linked, &["commit", "-qam", "Local notes"]);

        let repo = Repo::discover(&linked).unwrap().unwrap();
        let [git_dir, common_dir] = repo.metadata_dirs().unwrap();
        assert_ne!(git_dir, common_dir);
        let token = CancellationToken::new();
        let (tx, rx) = mpsc::channel();
        let mut watch = repo
            .watch_commit_messages(&token, move || {
                let _ = tx.send(());
            })
            .unwrap();
        assert_eq!(repo.commit_messages(&mut watch, &token).unwrap().prepared, None);
        let mut expect_update = |subject: Option<&str>| {
            let deadline = Instant::now() + Duration::from_secs(8);
            loop {
                rx.recv_timeout(deadline.saturating_duration_since(Instant::now()))
                    .expect("prepared message watcher did not report the change");
                let message = repo.commit_messages(&mut watch, &token).unwrap().prepared;
                if message.as_deref().and_then(|m| m.lines().next()) == subject {
                    return message;
                }
            }
        };

        conflicting_git(&linked, &["merge", "incoming"]);
        let merge = expect_update(Some("Merge branch 'incoming' into workspace")).unwrap();
        assert!(!merge.contains("Conflicts:") && !merge.contains("notes.txt"));
        fs::write(git_dir.join("MERGE_MSG"), "Message edited on disk\n; Conflicts:\n").unwrap();
        assert_eq!(expect_update(Some("Message edited on disk")).as_deref(), Some("Message edited on disk"));
        git(&linked, &["merge", "--abort"]);
        expect_update(None);

        fs::write(linked.join("local.txt"), "unrelated local edit\n").unwrap();
        conflicting_git(&linked, &["cherry-pick", "incoming"]);
        expect_update(Some("Incoming notes"));
        let mut read = repo.watch_commit_messages(&token, || {}).unwrap();
        let pending = repo.commit_messages(&mut read, &token).unwrap().pending_apply.unwrap();
        assert_eq!(pending.source.kind, CommitApplyKind::CherryPick);
        assert_eq!(pending.source.author.as_deref(), Some("Fixture <fixture@example.invalid>"));
        assert_eq!(pending.source.base, repo.head().unwrap().1.unwrap());
        assert_eq!(pending.paths, [IpcPath(repo.root().join("notes.txt"))]);
        git(&linked, &["cherry-pick", "--abort"]);
        expect_update(None);
        assert!(repo.commit_messages(&mut read, &token).unwrap().pending_apply.is_none());

        conflicting_git(&linked, &["revert", "--no-edit", "incoming"]);
        expect_update(Some("Revert \"Incoming notes\""));
        let pending = repo.commit_messages(&mut read, &token).unwrap().pending_apply.unwrap();
        assert_eq!(pending.source.kind, CommitApplyKind::Revert);
        assert_eq!(pending.source.author, None);
        assert_eq!(pending.source.author_date, None);
        assert_eq!(pending.paths, [IpcPath(repo.root().join("notes.txt"))]);
        git(&linked, &["revert", "--abort"]);
        expect_update(None);
        assert!(repo.commit_messages(&mut read, &token).unwrap().pending_apply.is_none());

        conflicting_git(&linked, &["merge", "--squash", "incoming"]);
        let squash = expect_update(Some("Squashed commit of the following:")).unwrap();
        assert!(squash.contains("Incoming notes"));
        fs::write(git_dir.join("MERGE_MSG"), "Extra context\n; Conflicts:\n").unwrap();
        assert!(expect_update(Some("Squashed commit of the following:")).is_some());
        let prepared = repo.commit_messages(&mut watch, &token).unwrap().prepared.unwrap();
        assert!(prepared.ends_with("\n\nExtra context"));
    }
}
