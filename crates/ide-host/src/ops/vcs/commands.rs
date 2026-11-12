#[allow(unused_imports)]
use super::*;
use crate::Host;
use crate::Project;
use crate::ops::Channel;
use crate::rpc::Dispatcher;
use ide_core::{IdeResult, RequestId};
use ide_vcs::*;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};

use crate::apply_git_executable;

/// Read-only repository access also works in a standalone log window.
struct LogAccess {
    project: Option<std::sync::Arc<Project>>,
    external: Option<std::sync::Arc<Repo>>,
    cache: PathBuf,
}

/// Immutable Git objects exposed through the editor's ordinary read-only VFS.
/// `encoding` re-decodes the blob with it ("Reload with Encoding") instead of
/// the project's detection.
pub async fn revision_virtual_document(
    host: &Host,
    window: &str,
    uri: &str,
    encoding: Option<&str>,
) -> IdeResult<ide_lsp::types::VirtualDocument> {
    #[derive(Deserialize)]
    struct Target {
        repo: PathBuf,
        revision: String,
        path: PathBuf,
    }
    let encoded = uri
        .strip_prefix("git-revision:")
        .and_then(|s| s.split('/').next())
        .ok_or_else(|| ide_core::IdeError::invalid("invalid Git revision URI"))?;
    if encoded.len() > 32768 || encoded.len() % 2 != 0 || !encoded.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(ide_core::IdeError::invalid("invalid Git revision URI"));
    }
    let bytes = (0..encoded.len())
        .step_by(2)
        .map(|i| {
            u8::from_str_radix(&encoded[i..i + 2], 16)
                .map_err(|_| ide_core::IdeError::invalid("invalid Git revision URI"))
        })
        .collect::<IdeResult<Vec<_>>>()?;
    let target: Target = serde_json::from_slice(&bytes).map_err(|e| ide_core::IdeError::invalid(e.to_string()))?;
    let path = target.repo.join(&target.path);
    let (text, charset, has_bom) = revision_text(host, window, &path, &target.revision, encoding)
        .await?
        .ok_or_else(|| ide_core::IdeError::not_found("file is absent at this revision"))?;
    Ok(ide_lsp::types::VirtualDocument {
        uri: uri.into(),
        language_id: host.languages.detect(&target.path, text.lines().next()),
        text,
        title: target.path.file_name().unwrap_or_default().to_string_lossy().into_owned(),
        description: Some(format!("{} · {}", target.repo.display(), target.revision)),
        decompiled: false,
        encoding: charset.name().to_ascii_lowercase(),
        has_bom,
        can_reload_encoding: true,
    })
}

/// Revision text with the charset it was decoded with and whether a matching
/// BOM was stripped; `None` when the file is absent at the revision.
async fn revision_text(
    host: &Host,
    window: &str,
    path: &Path,
    rev: &str,
    encoding: Option<&str>,
) -> IdeResult<Option<(String, &'static encoding_rs::Encoding, bool)>> {
    let project = host.project(window).ok();
    let external = host.external_logs.read().get(host.owner_window(window)).and_then(|rs| {
        rs.iter().filter(|r| path.starts_with(r.root())).max_by_key(|r| r.root().components().count()).cloned()
    });
    let (path, rev, encoding) = (path.to_path_buf(), rev.to_owned(), encoding.map(str::to_owned));
    blocking(move || {
        fn with_repo<T>(
            project: &Option<std::sync::Arc<Project>>,
            external: &Option<std::sync::Arc<ide_vcs::Repo>>,
            path: &Path,
            f: impl FnOnce(&ide_vcs::Repo) -> IdeResult<T>,
        ) -> IdeResult<T> {
            match project {
                Some(project) => project.with_log_repo_of(path, f),
                None => f(external
                    .as_ref()
                    .ok_or_else(|| ide_core::IdeError::unavailable("external Git log is not open"))?),
            }
        }
        let (text_encoding, charset) = match &encoding {
            Some(label) => {
                let charset = encoding_rs::Encoding::for_label(label.trim().as_bytes())
                    .ok_or_else(|| ide_core::IdeError::invalid(format!("unknown encoding {label:?}")))?;
                (ide_vcs::TextEncoding::from(charset), charset)
            }
            None => match &project {
                Some(project) => {
                    let text_encoding = project.vcs_encoding(&path, Some(&rev))?;
                    (text_encoding, text_encoding.charset)
                }
                None => (ide_vcs::TextEncoding::from(encoding_rs::UTF_8), encoding_rs::UTF_8),
            },
        };
        let bytes = with_repo(&project, &external, &path, |r| r.file_bytes_at(&path, Some(&rev)))?;
        let Some(bytes) = bytes else { return Ok(None) };
        let has_bom = encoding_rs::Encoding::for_bom(&bytes).is_some_and(|(enc, _)| enc == charset);
        let text =
            with_repo(&project, &external, &path, |r| r.file_at(&path, Some(&rev), text_encoding))?.unwrap_or_default();
        Ok(Some((text, charset, has_bom)))
    })
    .await
}
impl LogAccess {
    fn new(host: &Host, window: &str, at: Option<&Path>) -> Self {
        let project = host.project(window).ok();
        let external = host
            .external_logs
            .read()
            .get(host.owner_window(window))
            .and_then(|rs| rs.iter().find(|r| Some(r.root()) == at).cloned())
            .filter(|repo| project.as_ref().is_none_or(|p| p.repos().at_root(repo.root()).is_none()));
        Self { project, external, cache: host.local_data_dir.join("cache/git-log") }
    }
    fn with_log_repo_at<T>(&self, at: Option<&Path>, f: impl FnOnce(&Repo) -> IdeResult<T>) -> IdeResult<T> {
        if let Some(repo) = &self.external {
            repo.enable_log_index(&self.cache);
            return f(repo);
        }
        self.project
            .as_ref()
            .ok_or_else(|| ide_core::IdeError::unavailable("external Git log is not open"))?
            .with_log_repo_at(at, f)
    }
}

/// A repository of the project (IDEA's VCS root).
#[derive(Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct VcsRoot {
    /// Worktree root.
    pub root: ide_core::IpcPath,
    /// Merge / rebase / cherry-pick / revert in progress.
    pub operation: Option<String>,
    /// Current branch; `None` when HEAD is detached (or unreadable).
    pub head: Option<String>,
    /// HEAD commit; `None` before the first commit.
    pub head_commit: Option<String>,
}

#[derive(Clone, Serialize, Deserialize, Type)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum RemoteOp {
    Fetch,
    Pull {
        rebase: bool,
    },
    /// Update Project › Reset to the Remote Branch.
    ResetToUpstream,
    Push {
        force_with_lease: bool,
        set_upstream: bool,
        /// Push dialog › Push tags.
        #[serde(default)]
        tags: Option<PushTags>,
        /// Plain `--force` (Force push anyway).
        #[serde(default)]
        force: bool,
        /// Push dialog › Run Git hooks unchecked (`--no-verify`).
        #[serde(default)]
        no_verify: bool,
    },
    /// Deletes a remote branch; `branch` is the remote-tracking name (`origin/feature`).
    DeleteBranch {
        branch: String,
    },
    /// Pushes local `branch` (only up to `revision` when set) to its upstream, or to
    /// remote branch `target`; `remote` overrides the upstream's remote (Push dialog's
    /// remote picker).
    PushBranch {
        branch: String,
        revision: Option<String>,
        force_with_lease: bool,
        #[serde(default)]
        target: Option<String>,
        #[serde(default)]
        remote: Option<String>,
        #[serde(default)]
        force: bool,
        /// Record the target as upstream (Push dialog › Set upstream).
        #[serde(default)]
        set_upstream: bool,
        #[serde(default)]
        no_verify: bool,
    },
    /// Push Tag › Push to `remote`.
    PushTag {
        tag: String,
        remote: String,
    },
    /// Deletes tag `tag` on `remote` (Delete on Remote).
    DeleteRemoteTag {
        tag: String,
        remote: String,
    },
    /// Fast-forwards local `branch` (not checked out) to its upstream.
    UpdateBranch {
        branch: String,
    },
    /// Pull dialog: `branches` of `remote` (none = the configured merge branch).
    PullFrom {
        remote: String,
        branches: Vec<String>,
        rebase: bool,
        options: MergeOptions,
    },
}

#[derive(Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitExecutableInfo {
    /// `git version …` output.
    pub version: String,
    /// The executable that was run.
    pub path: String,
}

// ---- in-progress operations, history rewriting (Git Log actions) ----

#[derive(Clone, Serialize, Deserialize, Type)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum GitOperation {
    /// Continue the merge / rebase / cherry-pick / revert in progress.
    Continue,
    /// Stage and Retry: stage the changes of tracked files, then continue.
    StageAndContinue,
    Abort,
    Skip,
    /// Commits oldest first; `record_origin` adds "(cherry picked from commit …)".
    CherryPick {
        commits: Vec<String>,
        #[serde(default, rename = "recordOrigin")]
        record_origin: bool,
    },
    /// Commits newest first.
    Revert {
        commits: Vec<String>,
    },
    Reset {
        commit: String,
        mode: ResetMode,
    },
    /// Rebases `base..HEAD` (`base: None` = from the root) following `entries`, oldest first.
    InteractiveRebase {
        base: Option<String>,
        entries: Vec<RebaseEntry>,
    },
}

/// Runs `f` once per repository with the `paths` that belong to it.
fn per_repo(
    project: &Project,
    paths: &[PathBuf],
    recorded: Option<&str>,
    f: impl Fn(&Repo, &[PathBuf]) -> IdeResult<()>,
) -> IdeResult<()> {
    let groups = project.repos().group(paths);
    if groups.is_empty() {
        return project.with_repo_recorded(None, recorded, |r| f(r, paths));
    }
    for (repo, paths) in groups {
        project.with_repo_recorded(Some(repo.root()), recorded, |r| f(r, &paths))?;
    }
    Ok(())
}

/// A shelf is one patch for one owning repository. Validate the whole selection before reverting files.
fn shelf_repository(project: &Project, paths: &[PathBuf]) -> IdeResult<PathBuf> {
    let repos = project.repos();
    let root = paths
        .first()
        .and_then(|p| repos.for_path(p))
        .map(|r| r.root())
        .ok_or_else(|| ide_core::IdeError::invalid("select files in a git repository to shelve"))?;
    if paths.iter().any(|p| repos.for_path(p).map(|r| r.root()) != Some(root)) {
        return Err(ide_core::IdeError::invalid("select files from a single git repository to shelve"));
    }
    Ok(root.to_path_buf())
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> IdeResult<T> + Send + 'static) -> IdeResult<T> {
    tokio::task::spawn_blocking(f).await.map_err(|e| ide_core::IdeError::internal(e.to_string()))?
}

// ---- patches ----

#[derive(Clone, Serialize, Deserialize, Type)]
#[serde(tag = "from", rename_all = "camelCase")]
pub enum PatchSource {
    /// Local changes of these files (absolute paths).
    Changes { paths: Vec<ide_core::IpcPath>, reverse: bool },
    /// Changes made by these commits (oldest first).
    Commits { commits: Vec<String>, reverse: bool },
}

// ---- shelf (`.openidea/shelf`) and change lists (`.openidea/changelists.json`) ----

const PRIVATE_ENTRIES: [&str; 2] = ["/shelf/", "/changelists.json"];

fn shelf_dir(root: &Path) -> PathBuf {
    ide_core::project_dir::path(root, "shelf")
}

fn keep_private(root: &Path) {
    if let Err(e) = ide_vcs::changelists::ensure_ignored(&ide_core::project_dir::path(root, ""), &PRIVATE_ENTRIES) {
        tracing::warn!("could not update .openidea/.gitignore: {e}");
    }
}

/// The project's repositories, the primary one first.
pub fn vcs_roots(host: &Host, window: &str) -> IdeResult<Vec<VcsRoot>> {
    let repos = host.project(window)?.repos();
    let primary = repos.primary().map(|r| r.root().to_path_buf());
    let mut all: Vec<&std::sync::Arc<Repo>> = repos.all().iter().collect();
    all.sort_by_key(|r| Some(r.root()) != primary.as_deref());
    Ok(all
        .into_iter()
        .map(|r| {
            let (head, head_commit) = r.head().unwrap_or_default();
            VcsRoot { root: r.root().to_path_buf().into(), operation: r.operation().ok().flatten(), head, head_commit }
        })
        .collect())
}

pub async fn vcs_branch_info(host: &Host, window: &str, repo: Option<PathBuf>) -> IdeResult<BranchInfo> {
    let project = LogAccess::new(host, window, repo.as_deref());
    blocking(move || project.with_log_repo_at(repo.as_deref(), |r| r.branch_info())).await
}

/// Gutter change markers for a file, computed against its current (unsaved) text.
pub async fn vcs_line_hunks(host: &Host, window: &str, path: PathBuf) -> IdeResult<Vec<LineHunk>> {
    let project = host.project(window)?;
    blocking(move || {
        let text = project.text_of(&path)?;
        project.with_repo_of(&path, |r| r.line_hunks(&path, &text, false, project.vcs_encoding(&path, None)?))
    })
    .await
}

pub async fn vcs_file_at(host: &Host, window: &str, path: PathBuf, rev: Option<String>) -> IdeResult<Option<String>> {
    let project = host.project(window).ok();
    let external = host.external_logs.read().get(host.owner_window(window)).and_then(|rs| {
        rs.iter().filter(|r| path.starts_with(r.root())).max_by_key(|r| r.root().components().count()).cloned()
    });
    blocking(move || {
        if let Some(project) = project {
            return project.with_log_repo_of(&path, |r| {
                r.file_at(&path, rev.as_deref(), project.vcs_encoding(&path, rev.as_deref())?)
            });
        }
        external.ok_or_else(|| ide_core::IdeError::unavailable("external Git log is not open"))?.file_at(
            &path,
            rev.as_deref(),
            encoding_rs::UTF_8,
        )
    })
    .await
}

pub async fn vcs_blame(
    host: &Host,
    window: &str,
    path: PathBuf,
    text: Option<String>,
    revision: Option<String>,
) -> IdeResult<Vec<BlameLine>> {
    let project = host.project(window)?;
    // An explicit text wins (merge view annotates its side panes, not the worktree).
    blocking(move || {
        let text = text.or_else(|| project.documents.text_of(&path));
        project.with_repo_of(&path, |r| {
            r.blame(&path, text.as_deref(), revision.as_deref(), project.vcs_encoding(&path, revision.as_deref())?)
        })
    })
    .await
}

/// History for Selection: the commits that changed `lines` (0-based, inclusive) of the
/// editor's text of `path`. Cancellable.
pub async fn vcs_block_history(
    host: &Host,
    window: &str,
    request: RequestId,
    path: PathBuf,
    text: Option<String>,
    lines: (u32, u32),
) -> IdeResult<BlockHistory> {
    let project = host.project(window)?;
    let cancel = host.begin_request(request);
    let result = blocking(move || {
        let text = text.or_else(|| project.documents.text_of(&path));
        project.with_repo_of(&path, |r| {
            r.block_history(&path, text.as_deref(), lines, project.vcs_encoding(&path, None)?, &cancel)
        })
    })
    .await;
    host.end_request(request);
    result
}

pub async fn vcs_log(host: &Host, window: &str, repo: Option<PathBuf>, query: LogQuery) -> IdeResult<Vec<Commit>> {
    let project = LogAccess::new(host, window, repo.as_deref());
    let request = query.request;
    let cancel =
        request.map_or_else(ide_core::CancellationToken::new, |id| host.begin_project_read_request(window, id));
    let result = blocking(move || {
        project.with_log_repo_at(repo.as_deref(), |r| {
            r.enable_log_index(&project.cache);
            r.log_cancellable(&query, &cancel)
        })
    })
    .await;
    if let Some(id) = request {
        host.end_request(id);
    }
    result
}

pub async fn vcs_log_refs(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
) -> IdeResult<std::collections::BTreeMap<String, String>> {
    let project = LogAccess::new(host, window, repo.as_deref());
    blocking(move || project.with_log_repo_at(repo.as_deref(), |r| r.log_refs())).await
}

pub async fn vcs_log_users(host: &Host, window: &str, repo: Option<PathBuf>) -> IdeResult<Vec<String>> {
    let project = LogAccess::new(host, window, repo.as_deref());
    blocking(move || project.with_log_repo_at(repo.as_deref(), |r| r.log_users())).await
}

pub async fn vcs_open_external_log(host: &Host, window: &str, path: PathBuf) -> IdeResult<ide_core::IpcPath> {
    let path = dunce::canonicalize(path)?;
    let repo = Repo::discover(&path)?.ok_or_else(|| ide_core::IdeError::unavailable("folder is not a Git worktree"))?;
    let root = repo.root().to_path_buf();
    repo.set_execution_allowed(false);
    repo.enable_log_index(&host.local_data_dir.join("cache/git-log"));
    if let Ok(project) = host.project(window) {
        project.open_external_log(&root)?;
    }
    let mut logs = host.external_logs.write();
    let roots = logs.entry(host.owner_window(window).to_string()).or_default();
    if !roots.iter().any(|r| r.root() == root) {
        roots.push(std::sync::Arc::new(repo));
    }
    Ok(root.into())
}

pub async fn vcs_log_details(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    revision: String,
) -> IdeResult<LogDetails> {
    let project = LogAccess::new(host, window, repo.as_deref());
    blocking(move || project.with_log_repo_at(repo.as_deref(), |r| r.log_details(&revision))).await
}

pub async fn vcs_log_details_batch(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    revisions: Vec<String>,
    request: RequestId,
) -> IdeResult<Vec<LogDetails>> {
    let project = LogAccess::new(host, window, repo.as_deref());
    let cancel = host.begin_project_read_request(window, request);
    let result = blocking(move || {
        project.with_log_repo_at(repo.as_deref(), |r| {
            r.enable_log_index(&project.cache);
            r.log_details_batch_cancellable(&revisions, &cancel)
        })
    })
    .await;
    host.end_request(request);
    result
}

pub async fn vcs_revision_children(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    revision: String,
    directory: String,
) -> IdeResult<Vec<String>> {
    let project = LogAccess::new(host, window, repo.as_deref());
    blocking(move || project.with_log_repo_at(repo.as_deref(), |r| r.revision_children(&revision, &directory))).await
}

pub async fn vcs_revision_files(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    revision: String,
) -> IdeResult<Vec<String>> {
    let project = LogAccess::new(host, window, repo.as_deref());
    blocking(move || project.with_log_repo_at(repo.as_deref(), |r| r.revision_files(&revision))).await
}

pub async fn vcs_commit_files(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    commit: String,
) -> IdeResult<Vec<ChangedFile>> {
    let project = LogAccess::new(host, window, repo.as_deref());
    blocking(move || project.with_log_repo_at(repo.as_deref(), |r| r.commit_files(&commit))).await
}

/// Combined changes of several commits, `commits` oldest first.
pub async fn vcs_commits_changes(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    commits: Vec<String>,
) -> IdeResult<Vec<RevisionChange>> {
    let project = LogAccess::new(host, window, repo.as_deref());
    blocking(move || project.with_log_repo_at(repo.as_deref(), |r| r.commits_changes(&commits))).await
}

pub async fn vcs_branches(host: &Host, window: &str, repo: Option<PathBuf>) -> IdeResult<Vec<Branch>> {
    let project = LogAccess::new(host, window, repo.as_deref());
    blocking(move || project.with_log_repo_at(repo.as_deref(), |r| r.branches())).await
}

pub async fn vcs_stashes(host: &Host, window: &str, repo: Option<PathBuf>) -> IdeResult<Vec<Stash>> {
    let project = host.project(window)?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.stashes())).await
}

pub async fn vcs_stage(host: &Host, window: &str, paths: Vec<PathBuf>) -> IdeResult<()> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    blocking(move || per_repo(&project, &paths, None, |r, paths| r.stage(paths))).await
}

/// Project-host operation (also registered with the remote dispatcher).
/// Returns the ignore files that were updated, so the UI can show them.
pub async fn vcs_add_to_ignore(
    host: &Host,
    window: &str,
    paths: Vec<PathBuf>,
    destination: IgnoreDestination,
) -> IdeResult<Vec<ide_core::IpcPath>> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    blocking(move || {
        for path in &paths {
            if path == &project.root || !path.starts_with(&project.root) {
                return Err(ide_core::IdeError::invalid("Ignore selection is outside the project"));
            }
        }
        apply_git_executable(&project.settings.effective());
        let result = project.with_disk_sync(|| ide_vcs::add_to_ignore(&paths, destination));
        // Exclude may live outside a worktree's watched directory. Refresh filters and UI explicitly.
        project.watcher.reload_ignore_rules();
        for (_, watcher) in project.content_watchers.lock().iter() {
            watcher.reload_ignore_rules();
        }
        project.sink.emit(ide_core::IdeEvent::VcsChanged { root: project.root.clone().into() });
        result.map(|files| files.into_iter().map(Into::into).collect())
    })
    .await
}

pub async fn vcs_unstage(host: &Host, window: &str, paths: Vec<PathBuf>) -> IdeResult<()> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    blocking(move || per_repo(&project, &paths, None, |r, paths| r.unstage(paths))).await
}

pub async fn vcs_stage_patch(host: &Host, window: &str, patch: String) -> IdeResult<()> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    blocking(move || project.with_repo(|r| r.stage_patch(&patch, &|path| project.vcs_encoding(path, Some(":0"))))).await
}

pub async fn vcs_discard(host: &Host, window: &str, paths: Vec<PathBuf>) -> IdeResult<()> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    blocking(move || per_repo(&project, &paths, Some("Rollback"), |r, paths| r.discard(paths))).await
}

pub async fn vcs_commit(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    message: String,
    options: CommitOptions,
) -> IdeResult<String> {
    host.require_trust(window)?;
    // Commit hooks may run for a long time.
    let project = host.project(window)?;
    blocking(move || {
        project.with_repo_recorded(repo.as_deref(), None, |r| {
            r.commit_with(&message, &options, &|path| project.vcs_encoding(path, None))
        })
    })
    .await
}

pub async fn vcs_checkout(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    branch: String,
    create: bool,
    options: Option<ide_vcs::CheckoutOptions>,
) -> IdeResult<ide_vcs::CheckoutOutcome> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    let options = options.unwrap_or_default();
    blocking(move || {
        project
            .with_repo_recorded(repo.as_deref(), Some("Git checkout"), |r| r.checkout_with(&branch, create, &options))
    })
    .await
}

/// New Branch: creates `name` at `start` (HEAD when absent), optionally checking it out.
pub async fn vcs_create_branch(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    name: String,
    start: Option<String>,
    checkout: bool,
    overwrite: Option<bool>,
) -> IdeResult<()> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    let recorded = checkout.then_some("Git checkout");
    blocking(move || {
        project.with_repo_recorded(repo.as_deref(), recorded, |r| {
            r.create_branch_with_overwrite(&name, start.as_deref(), checkout, overwrite.unwrap_or(false))
        })
    })
    .await
}

/// Undo Commit: moves HEAD back to the commit's parent, keeping its changes staged.
/// Returns the undone commit's message.
pub async fn vcs_undo_commit(host: &Host, window: &str, repo: Option<PathBuf>, commit: String) -> IdeResult<String> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.undo_commit(&commit))).await
}

/// Edit Commit Message: rewrites the commit and its descendants without touching the
/// working tree.
pub async fn vcs_reword(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    commit: String,
    message: String,
) -> IdeResult<ide_vcs::HeadChange> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.reword(&commit, &message))).await
}

/// Undo of a history rewrite (Edit Commit Message, Drop, Squash).
pub async fn vcs_restore_head(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    before: String,
    after: String,
) -> IdeResult<()> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.restore_head(&before, &after))).await
}

pub async fn vcs_delete_branch(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    branch: String,
) -> IdeResult<ide_vcs::DeletedBranch> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.delete_branch_restorable(&branch))).await
}

/// "Restore" of the branch-deleted notification.
/// Deletes a local tag; the result restores it.
pub async fn vcs_delete_tag(host: &Host, window: &str, repo: Option<PathBuf>, name: String) -> IdeResult<DeletedTag> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.delete_tag(&name))).await
}

pub async fn vcs_restore_tag(host: &Host, window: &str, repo: Option<PathBuf>, deleted: DeletedTag) -> IdeResult<()> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.restore_tag(&deleted))).await
}

pub async fn vcs_restore_branch(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    deleted: ide_vcs::DeletedBranch,
) -> IdeResult<()> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.restore_branch(&deleted))).await
}

pub async fn vcs_rename_branch(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    from: String,
    to: String,
    unset_upstream: bool,
) -> IdeResult<()> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.rename_branch(&from, &to, unset_upstream))).await
}

pub async fn vcs_merge(host: &Host, window: &str, repo: Option<PathBuf>, branch: String) -> IdeResult<()> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    blocking(move || project.with_repo_recorded(repo.as_deref(), Some("Git merge"), |r| r.merge(&branch))).await
}

pub async fn vcs_rebase(host: &Host, window: &str, repo: Option<PathBuf>, onto: String) -> IdeResult<()> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    blocking(move || project.with_repo_recorded(repo.as_deref(), Some("Git rebase"), |r| r.rebase(&onto))).await
}

pub async fn vcs_stash_push(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    message: Option<String>,
    include_untracked: bool,
    keep_index: bool,
) -> IdeResult<()> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    blocking(move || {
        project.with_repo_recorded(repo.as_deref(), Some("Git stash"), |r| {
            r.stash_push(message.as_deref(), include_untracked, keep_index)
        })
    })
    .await
}

pub async fn vcs_stash_apply(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    index: u32,
    pop: bool,
    reinstate_index: bool,
    branch: Option<String>,
) -> IdeResult<()> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    blocking(move || {
        project.with_repo_recorded(repo.as_deref(), Some("Git unstash"), |r| match branch.as_deref() {
            Some(name) => r.stash_branch(index, name),
            None => r.stash_apply(index, pop, reinstate_index),
        })
    })
    .await
}

pub async fn vcs_stash_drop(host: &Host, window: &str, repo: Option<PathBuf>, index: u32) -> IdeResult<()> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.stash_drop(index))).await
}

/// Network operation; progress lines stream through `on_output`. Cancellable.
pub async fn vcs_remote(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    request: RequestId,
    op: RemoteOp,
    on_output: Channel<String>,
) -> IdeResult<()> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    let cancel = host.begin_request(request);
    let result = tokio::task::spawn_blocking(move || {
        let out = |line: String| {
            let _ = on_output.send(line);
        };
        let recorded = matches!(op, RemoteOp::Pull { .. } | RemoteOp::PullFrom { .. } | RemoteOp::ResetToUpstream)
            .then_some("Git pull");
        project.with_repo_recorded(repo.as_deref(), recorded, |r| match op {
            RemoteOp::Fetch => r.fetch(&cancel, &out),
            RemoteOp::Pull { rebase } => r.pull(rebase, &cancel, &out),
            RemoteOp::ResetToUpstream => r.reset_to_upstream(&cancel, &out),
            RemoteOp::Push { force_with_lease, set_upstream, tags, force, no_verify } => {
                r.push_with(PushOptions { force_with_lease, force, set_upstream, tags, no_verify }, &cancel, &out)
            }
            RemoteOp::DeleteBranch { branch } => r.delete_remote_branch(&branch, &cancel, &out),
            RemoteOp::PushBranch {
                branch,
                revision,
                force_with_lease,
                target,
                remote,
                force,
                set_upstream,
                no_verify,
            } => r.push_branch_to(
                &branch,
                PushBranchOptions {
                    revision: revision.as_deref(),
                    target: target.as_deref(),
                    remote: remote.as_deref(),
                    force_with_lease,
                    force,
                    set_upstream,
                    no_verify,
                },
                &cancel,
                &out,
            ),
            RemoteOp::UpdateBranch { branch } => r.update_branch(&branch, &cancel, &out),
            RemoteOp::PushTag { tag, remote } => r.push_tag(&tag, &remote, &cancel, &out),
            RemoteOp::DeleteRemoteTag { tag, remote } => r.delete_remote_tag(&tag, &remote, &cancel, &out),
            RemoteOp::PullFrom { remote, branches, rebase, options } => {
                r.pull_from(&remote, &branches, rebase, &options, &cancel, &out)
            }
        })
    })
    .await
    .map_err(|e| ide_core::IdeError::internal(e.to_string()))?;
    host.end_request(request);
    result
}

/// The user's side is `ours` (sides swapped during a rebase, as in IDEA).
pub async fn vcs_conflict_versions(host: &Host, window: &str, path: PathBuf) -> IdeResult<ide_vcs::MergeVersions> {
    let project = host.project(window)?;
    blocking(move || project.with_repo_of(&path, |r| r.merge_versions(&path, project.vcs_encoding(&path, Some(":2"))?)))
        .await
}

pub async fn vcs_diff_text(host: &Host, window: &str, path: PathBuf, staged: bool) -> IdeResult<String> {
    let project = host.project(window)?;
    blocking(move || project.with_repo_of(&path, |r| r.diff_text(&path, staged, project.vcs_encoding(&path, None)?)))
        .await
}

/// Line hunks between two arbitrary texts (diff viewer, commit dialog).
pub fn vcs_diff_hunks(_host: &Host, _window: &str, old_text: String, new_text: String) -> Vec<LineHunk> {
    ide_vcs::diff_hunks(&old_text, &new_text)
}

/// Stages only the selected hunks of a file's working-tree changes.
/// Indices refer to `vcs_diff_hunks(index_text, worktree_text)`.
pub async fn vcs_stage_hunks(host: &Host, window: &str, path: PathBuf, hunks: Vec<u32>) -> IdeResult<()> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    blocking(move || {
        let encoding = project.vcs_encoding(&path, Some(":0"))?;
        let current = project.documents.load_file_as(&path, encoding.charset.name())?.text;
        project.with_repo_of(&path, |r| {
            let selected: Vec<usize> = hunks.iter().map(|&h| h as usize).collect();
            r.stage_hunks(&path, &current, &selected, encoding)
        })
    })
    .await
}

/// Clones a repository (Get from VCS). Works without an open project.
pub async fn vcs_clone(
    host: &Host,
    _window: &str,
    request: RequestId,
    url: String,
    dest: PathBuf,
    depth: Option<u32>,
    on_output: Channel<String>,
) -> IdeResult<()> {
    apply_git_executable(&host.global_settings.effective());
    let cancel = host.begin_request(request);
    let result = tokio::task::spawn_blocking(move || {
        ide_vcs::clone(&url, &dest, depth, &cancel, &|line| {
            let _ = on_output.send(line);
        })
    })
    .await
    .map_err(|e| ide_core::IdeError::internal(e.to_string()))?;
    host.end_request(request);
    result
}

/// `git init` in `dir` (File › New Project… "Create Git repository").
pub async fn vcs_init(host: &Host, _window: &str, dir: PathBuf) -> IdeResult<()> {
    apply_git_executable(&host.global_settings.effective());
    blocking(move || ide_vcs::init(&dir)).await
}

/// Settings › Git › Test: runs `git --version` on `path`, or on the auto-detected
/// executable when `path` is empty.
pub async fn vcs_git_version(host: &Host, window: &str, path: String) -> IdeResult<GitExecutableInfo> {
    host.require_trust(window)?;
    tokio::task::spawn_blocking(move || {
        let explicit = path.trim();
        let exe = if explicit.is_empty() {
            ide_vcs::detected_git_executable()
                .ok_or_else(|| ide_core::IdeError::unavailable("git executable not found on PATH"))?
        } else {
            PathBuf::from(explicit)
        };
        let version = ide_vcs::git_version(Some(&exe))?;
        Ok(GitExecutableInfo { version, path: exe.to_string_lossy().into_owned() })
    })
    .await
    .map_err(|e| ide_core::IdeError::internal(e.to_string()))?
}

/// The auto-detected git executable (shown as the field's placeholder).
pub fn vcs_detected_git(_host: &Host, _window: &str) -> Option<String> {
    ide_vcs::detected_git_executable().map(|p| p.to_string_lossy().into_owned())
}

/// `git config --get <key>` in the project repository; `None` when unset.
pub async fn vcs_config_get(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    key: String,
) -> IdeResult<Option<String>> {
    let project = LogAccess::new(host, window, repo.as_deref());
    blocking(move || project.with_log_repo_at(repo.as_deref(), |r| r.config_get(&key))).await
}

/// Local history operation that may take a while (hooks, large checkouts); git's
/// output streams through `on_output`. Cancellable.
pub async fn vcs_operation(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    request: RequestId,
    op: GitOperation,
    on_output: Channel<String>,
) -> IdeResult<()> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    let cancel = host.begin_request(request);
    let result = tokio::task::spawn_blocking(move || {
        let out = |line: String| {
            let _ = on_output.send(line);
        };
        let recorded = match &op {
            GitOperation::CherryPick { .. } => Some("Git cherry-pick"),
            GitOperation::Revert { .. } => Some("Git revert"),
            GitOperation::Reset { .. } => Some("Git reset"),
            GitOperation::InteractiveRebase { .. } => Some("Git rebase"),
            _ => None,
        };
        project.with_repo_recorded(repo.as_deref(), recorded, |r| match op {
            GitOperation::Continue => r.continue_operation(&cancel, &out),
            GitOperation::StageAndContinue => r.stage_and_continue(&cancel, &out),
            GitOperation::Abort => r.abort_operation(&cancel, &out),
            GitOperation::Skip => r.skip_operation(&cancel, &out),
            GitOperation::CherryPick { commits, record_origin } => {
                r.cherry_pick_with(&commits, record_origin, &cancel, &out)
            }
            GitOperation::Revert { commits } => r.revert(&commits, &cancel, &out),
            GitOperation::Reset { commit, mode } => r.reset(&commit, mode, &cancel, &out),
            GitOperation::InteractiveRebase { base, entries } => {
                r.interactive_rebase(base.as_deref(), &entries, &cancel, &out)
            }
        })
    })
    .await
    .map_err(|e| ide_core::IdeError::internal(e.to_string()))?;
    host.end_request(request);
    result
}

pub async fn vcs_create_tag(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    name: String,
    commit: String,
    message: Option<String>,
    force: bool,
) -> IdeResult<()> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.create_tag(&name, &commit, message.as_deref(), force)))
        .await
}

pub async fn vcs_tags(host: &Host, window: &str, repo: Option<PathBuf>) -> IdeResult<Vec<String>> {
    let project = LogAccess::new(host, window, repo.as_deref());
    blocking(move || project.with_log_repo_at(repo.as_deref(), |r| r.tags())).await
}

/// Merge dialog: merges `branches` into the current branch.
pub async fn vcs_merge_with(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    branches: Vec<String>,
    options: MergeOptions,
) -> IdeResult<()> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    blocking(move || {
        project.with_repo_recorded(repo.as_deref(), Some("Git merge"), |r| r.merge_with(&branches, &options))
    })
    .await
}

/// Rebase dialog: rebases the current branch onto `upstream` (or `--onto`).
pub async fn vcs_rebase_with(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    upstream: String,
    options: RebaseOptions,
) -> IdeResult<()> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    blocking(move || {
        project.with_repo_recorded(repo.as_deref(), Some("Git rebase"), |r| r.rebase_with(&upstream, &options))
    })
    .await
}

pub async fn vcs_remotes(host: &Host, window: &str, repo: Option<PathBuf>) -> IdeResult<Vec<Remote>> {
    let project = LogAccess::new(host, window, repo.as_deref());
    blocking(move || {
        let mut remotes = project.with_log_repo_at(repo.as_deref(), |r| r.remotes())?;
        for r in &mut remotes {
            let resolved = ide_ssh::resolve_ssh_remote_url(&r.url);
            if resolved != r.url {
                r.resolved_url = Some(resolved);
            }
        }
        Ok(remotes)
    })
    .await
}

pub async fn vcs_edit_remote(host: &Host, window: &str, repo: Option<PathBuf>, edit: RemoteEdit) -> IdeResult<()> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.edit_remote(&edit))).await
}

pub async fn vcs_worktrees(host: &Host, window: &str, repo: Option<PathBuf>) -> IdeResult<Vec<Worktree>> {
    let project = host.project(window)?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.worktrees())).await
}

pub async fn vcs_add_worktree(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    path: PathBuf,
    commitish: String,
    new_branch: Option<String>,
) -> IdeResult<()> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    blocking(move || {
        let result = project
            .with_repo_recorded(repo.as_deref(), None, |r| r.add_worktree(&path, &commitish, new_branch.as_deref()));
        // A worktree below the project is a new repository: rescan so its files
        // join the status and gutter queries (the watcher picks the gitfile up
        // too, but only as a debounced event later).
        project.refresh_repositories();
        result
    })
    .await
}

pub async fn vcs_remove_worktree(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    path: PathBuf,
    force: bool,
) -> IdeResult<()> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    blocking(move || {
        let path = if path.is_absolute() {
            path
        } else {
            project.with_repo_at(repo.as_deref(), |r| Ok(r.root().join(&path)))?
        };
        check_worktree_away_from_project(
            &project.root,
            &path,
            "Cannot remove a worktree containing the open project.",
        )?;
        let result = project.with_repo_at(repo.as_deref(), |r| r.remove_worktree(&path, force));
        project.refresh_repositories();
        result
    })
    .await
}

/// Move Worktree…: moves the linked worktree at `path` to `to`.
pub async fn vcs_move_worktree(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    path: PathBuf,
    to: PathBuf,
) -> IdeResult<()> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    blocking(move || {
        check_worktree_away_from_project(&project.root, &path, "Cannot move a worktree containing the open project.")?;
        let result = project.with_repo_at(repo.as_deref(), |r| r.move_worktree(&path, &to));
        project.refresh_repositories();
        result
    })
    .await
}

pub async fn vcs_compare_scope(host: &Host, window: &str, paths: Vec<PathBuf>) -> IdeResult<CompareScope> {
    let project = host.project(window)?;
    blocking(move || Ok(project.repos().compare_scope(&paths))).await
}

pub async fn vcs_compare_paths(
    host: &Host,
    window: &str,
    paths: Vec<PathBuf>,
    revision: String,
    repositories: Option<Vec<PathBuf>>,
    request: RequestId,
) -> IdeResult<CompareResult> {
    let project = host.project(window)?;
    let cancel = host.begin_request(request);
    let result = blocking(move || {
        let settings = project.settings.effective();
        if project.is_trusted() {
            apply_git_executable(&settings);
        }
        project.repos().compare_paths(&paths, &revision, repositories.as_deref(), &cancel)
    })
    .await;
    host.end_request(request);
    result
}

/// Compare with Local: tracked files that differ between `rev` and the working tree.
pub async fn vcs_diff_with_worktree(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    rev: String,
) -> IdeResult<Vec<ChangedFile>> {
    let project = LogAccess::new(host, window, repo.as_deref());
    blocking(move || project.with_log_repo_at(repo.as_deref(), |r| r.diff_with_worktree(&rev))).await
}

/// Files that differ between two revisions (the "N files updated" of Update Project).
pub async fn vcs_diff_revisions(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    from: String,
    to: String,
) -> IdeResult<Vec<ChangedFile>> {
    let project = LogAccess::new(host, window, repo.as_deref());
    blocking(move || project.with_log_repo_at(repo.as_deref(), |r| r.diff_revisions(&from, &to))).await
}

/// Added and deleted lines between two revisions. `paths` limits the diff; empty diffs every file.
pub async fn vcs_diff_numstat(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    from: String,
    to: String,
    paths: Vec<String>,
) -> IdeResult<Vec<FileLineStats>> {
    let project = LogAccess::new(host, window, repo.as_deref());
    blocking(move || project.with_log_repo_at(repo.as_deref(), |r| r.diff_numstat(&from, &to, &paths))).await
}

/// Whether the repository has the executable Git hook `name` (Push dialog › Run Git hooks).
pub async fn vcs_has_hook(host: &Host, window: &str, repo: Option<PathBuf>, name: String) -> IdeResult<bool> {
    let project = host.project(window)?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.has_hook(&name))).await
}

/// The best common ancestor of `a` and `b` (`git merge-base`), if any: the New Pull
/// Request tab's three-dot diff.
pub async fn vcs_merge_base(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    a: String,
    b: String,
) -> IdeResult<Option<String>> {
    let project = host.project(window)?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.merge_base(&a, &b))).await
}

pub async fn vcs_create_patch(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    source: PatchSource,
) -> IdeResult<String> {
    let project = host.project(window)?;
    blocking(move || {
        project.with_repo_at(repo.as_deref(), |r| match source {
            PatchSource::Changes { paths, reverse } => {
                let paths: Vec<PathBuf> = paths.into_iter().map(Into::into).collect();
                r.create_patch(&paths, reverse)
            }
            PatchSource::Commits { commits, reverse } => r.create_commits_patch(&commits, reverse),
        })
    })
    .await
}

pub async fn vcs_patch_preview(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    patch: String,
) -> IdeResult<Vec<PatchFile>> {
    let project = host.project(window)?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.patch_preview(&patch))).await
}

pub async fn vcs_apply_patch(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    patch: String,
) -> IdeResult<ApplyOutcome> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    blocking(move || project.with_repo_recorded(repo.as_deref(), None, |r| r.apply_patch(&patch))).await
}

/// Shelve Changes: saves the changes of `paths` as a patch on the shelf and reverts them.
pub async fn vcs_shelve(host: &Host, window: &str, name: String, paths: Vec<PathBuf>) -> IdeResult<ShelvedChangeList> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    blocking(move || {
        let repo = shelf_repository(&project, &paths)?;
        keep_private(&project.root);
        project.with_repo_recorded(Some(&repo), Some("Shelve"), |r| r.shelve(&shelf_dir(&project.root), &name, &paths))
    })
    .await
}

pub fn vcs_shelves(host: &Host, window: &str) -> IdeResult<Vec<ShelvedChangeList>> {
    let project = host.project(window)?;
    let mut shelves = ide_vcs::shelf::list(&shelf_dir(&project.root))?;
    let primary = project.repos().primary().map(|r| ide_core::IpcPath::from(r.root().to_path_buf()));
    for entry in &mut shelves {
        if entry.repo.is_none() {
            entry.repo = primary.clone();
        }
    }
    Ok(shelves)
}

/// Unshelve: applies the shelved patch (3-way merging; conflicts are left for the
/// merge UI); with `remove`, deletes it from the shelf.
pub async fn vcs_unshelve(
    host: &Host,
    window: &str,
    id: String,
    remove: bool,
    path: Option<String>,
) -> IdeResult<ApplyOutcome> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    blocking(move || {
        let repo = ide_vcs::shelf::repository(&shelf_dir(&project.root), &id)?;
        project.with_repo_recorded(repo.as_deref(), Some("Unshelve"), |r| {
            ide_vcs::shelf::unshelve_path(r, &shelf_dir(&project.root), &id, remove, path.as_deref())
        })
    })
    .await
}

pub fn vcs_shelf_delete(host: &Host, window: &str, id: String, path: Option<String>) -> IdeResult<()> {
    let project = host.project(window)?;
    ide_vcs::shelf::delete_path(&shelf_dir(&project.root), &id, path.as_deref())
}

pub fn vcs_shelf_rename(host: &Host, window: &str, id: String, name: String) -> IdeResult<()> {
    let project = host.project(window)?;
    ide_vcs::shelf::rename(&shelf_dir(&project.root), &id, &name)
}

pub fn vcs_shelf_patch(host: &Host, window: &str, id: String, path: Option<String>) -> IdeResult<String> {
    let project = host.project(window)?;
    ide_vcs::shelf::selected_patch(&shelf_dir(&project.root), &id, path.as_deref())
}

pub async fn vcs_shelf_diff(host: &Host, window: &str, id: String) -> IdeResult<Vec<ide_vcs::shelf::ShelfDiffFile>> {
    let project = host.project(window)?;
    blocking(move || {
        let repo = ide_vcs::shelf::repository(&shelf_dir(&project.root), &id)?;
        project.with_repo_at(repo.as_deref(), |r| ide_vcs::shelf::diff_files(r, &shelf_dir(&project.root), &id))
    })
    .await
}

pub async fn vcs_shelf_import(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    name: String,
    patch: String,
) -> IdeResult<()> {
    let project = host.project(window)?;
    blocking(move || {
        if repo.is_none() && project.repos().is_empty() {
            return ide_vcs::shelf::import_patch(&shelf_dir(&project.root), &name, &patch, None);
        }
        project.with_repo_at(repo.as_deref(), |r| {
            ide_vcs::shelf::import_patch(&shelf_dir(&project.root), &name, &patch, Some(r.root()))
        })
    })
    .await
}

pub fn vcs_changelists_load(host: &Host, window: &str) -> IdeResult<ChangelistState> {
    let project = host.project(window)?;
    Ok(ide_vcs::changelists::load(&ide_core::project_dir::path(&project.root, "changelists.json")))
}

pub fn vcs_changelists_save(host: &Host, window: &str, changelists: ChangelistState) -> IdeResult<()> {
    let project = host.project(window)?;
    keep_private(&project.root);
    ide_vcs::changelists::save(&ide_core::project_dir::path(&project.root, "changelists.json"), &changelists)
}

/// Create Patch › Save to file.
pub async fn vcs_write_patch(host: &Host, window: &str, path: PathBuf, patch: String) -> IdeResult<()> {
    let project = host.project(window).ok();
    blocking(move || {
        let write = || {
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir)?;
            }
            std::fs::write(&path, patch)?;
            Ok(())
        };
        match project {
            Some(project) => project.with_disk_sync(write),
            None => write(),
        }
    })
    .await
}

/// Commands of this module the remote server answers.
pub(crate) fn register(d: &mut Dispatcher) {
    d.add("vcs_roots", |c| async move { vcs_roots(&c.host, &c.window) });
    d.add("vcs_branch_info", |c| async move { vcs_branch_info(&c.host, &c.window, c.arg("repo")?).await });
    d.add("vcs_line_hunks", |c| async move { vcs_line_hunks(&c.host, &c.window, c.arg("path")?).await });
    d.add("vcs_file_at", |c| async move { vcs_file_at(&c.host, &c.window, c.arg("path")?, c.arg("rev")?).await });
    d.add("vcs_blame", |c| async move {
        vcs_blame(&c.host, &c.window, c.arg("path")?, c.arg("text")?, c.arg("revision")?).await
    });
    d.add("vcs_block_history", |c| async move {
        let (request, path, text, lines) = (c.arg("request")?, c.arg("path")?, c.arg("text")?, c.arg("lines")?);
        vcs_block_history(&c.host, &c.window, request, path, text, lines).await
    });
    d.add("vcs_log", |c| async move { vcs_log(&c.host, &c.window, c.arg("repo")?, c.arg("query")?).await });
    d.add("vcs_log_refs", |c| async move { vcs_log_refs(&c.host, &c.window, c.arg("repo")?).await });
    d.add("vcs_log_users", |c| async move { vcs_log_users(&c.host, &c.window, c.arg("repo")?).await });
    d.add("vcs_open_external_log", |c| async move { vcs_open_external_log(&c.host, &c.window, c.arg("path")?).await });
    d.add("vcs_log_details", |c| async move {
        vcs_log_details(&c.host, &c.window, c.arg("repo")?, c.arg("revision")?).await
    });
    d.add("vcs_log_details_batch", |c| async move {
        vcs_log_details_batch(&c.host, &c.window, c.arg("repo")?, c.arg("revisions")?, c.arg("request")?).await
    });
    d.add("vcs_revision_children", |c| async move {
        vcs_revision_children(&c.host, &c.window, c.arg("repo")?, c.arg("revision")?, c.arg("directory")?).await
    });
    d.add("vcs_revision_files", |c| async move {
        vcs_revision_files(&c.host, &c.window, c.arg("repo")?, c.arg("revision")?).await
    });
    d.add("vcs_commit_files", |c| async move {
        vcs_commit_files(&c.host, &c.window, c.arg("repo")?, c.arg("commit")?).await
    });
    d.add("vcs_commits_changes", |c| async move {
        vcs_commits_changes(&c.host, &c.window, c.arg("repo")?, c.arg("commits")?).await
    });
    d.add("vcs_branches", |c| async move { vcs_branches(&c.host, &c.window, c.arg("repo")?).await });
    d.add("vcs_stashes", |c| async move { vcs_stashes(&c.host, &c.window, c.arg("repo")?).await });
    d.add("vcs_stage", |c| async move { vcs_stage(&c.host, &c.window, c.arg("paths")?).await });
    d.add("vcs_add_to_ignore", |c| async move {
        vcs_add_to_ignore(&c.host, &c.window, c.arg("paths")?, c.arg("destination")?).await
    });
    d.add("vcs_unstage", |c| async move { vcs_unstage(&c.host, &c.window, c.arg("paths")?).await });
    d.add("vcs_stage_patch", |c| async move { vcs_stage_patch(&c.host, &c.window, c.arg("patch")?).await });
    d.add("vcs_discard", |c| async move { vcs_discard(&c.host, &c.window, c.arg("paths")?).await });
    d.add("vcs_commit", |c| async move {
        vcs_commit(&c.host, &c.window, c.arg("repo")?, c.arg("message")?, c.arg("options")?).await
    });
    d.add("vcs_checkout", |c| async move {
        vcs_checkout(&c.host, &c.window, c.arg("repo")?, c.arg("branch")?, c.arg("create")?, c.arg("options")?).await
    });
    d.add("vcs_create_branch", |c| async move {
        vcs_create_branch(
            &c.host,
            &c.window,
            c.arg("repo")?,
            c.arg("name")?,
            c.arg("start")?,
            c.arg("checkout")?,
            c.arg("overwrite")?,
        )
        .await
    });
    d.add(
        "vcs_undo_commit",
        |c| async move { vcs_undo_commit(&c.host, &c.window, c.arg("repo")?, c.arg("commit")?).await },
    );
    d.add("vcs_reword", |c| async move {
        vcs_reword(&c.host, &c.window, c.arg("repo")?, c.arg("commit")?, c.arg("message")?).await
    });
    d.add("vcs_restore_head", |c| async move {
        vcs_restore_head(&c.host, &c.window, c.arg("repo")?, c.arg("before")?, c.arg("after")?).await
    });
    d.add("vcs_delete_branch", |c| async move {
        vcs_delete_branch(&c.host, &c.window, c.arg("repo")?, c.arg("branch")?).await
    });
    d.add(
        "vcs_delete_tag",
        |c| async move { vcs_delete_tag(&c.host, &c.window, c.arg("repo")?, c.arg("name")?).await },
    );
    d.add("vcs_restore_tag", |c| async move {
        vcs_restore_tag(&c.host, &c.window, c.arg("repo")?, c.arg("deleted")?).await
    });
    d.add("vcs_restore_branch", |c| async move {
        vcs_restore_branch(&c.host, &c.window, c.arg("repo")?, c.arg("deleted")?).await
    });
    d.add("vcs_rename_branch", |c| async move {
        vcs_rename_branch(&c.host, &c.window, c.arg("repo")?, c.arg("from")?, c.arg("to")?, c.arg("unset_upstream")?)
            .await
    });
    d.add("vcs_merge", |c| async move { vcs_merge(&c.host, &c.window, c.arg("repo")?, c.arg("branch")?).await });
    d.add("vcs_rebase", |c| async move { vcs_rebase(&c.host, &c.window, c.arg("repo")?, c.arg("onto")?).await });
    d.add("vcs_stash_push", |c| async move {
        vcs_stash_push(
            &c.host,
            &c.window,
            c.arg("repo")?,
            c.arg("message")?,
            c.arg("includeUntracked")?,
            c.arg("keepIndex")?,
        )
        .await
    });
    d.add("vcs_stash_apply", |c| async move {
        vcs_stash_apply(
            &c.host,
            &c.window,
            c.arg("repo")?,
            c.arg("index")?,
            c.arg("pop")?,
            c.arg("reinstateIndex")?,
            c.arg("branch")?,
        )
        .await
    });
    d.add(
        "vcs_stash_drop",
        |c| async move { vcs_stash_drop(&c.host, &c.window, c.arg("repo")?, c.arg("index")?).await },
    );
    d.add("vcs_remote", |c| async move {
        vcs_remote(&c.host, &c.window, c.arg("repo")?, c.arg("request")?, c.arg("op")?, c.sender("onOutput")?).await
    });
    d.add("vcs_conflict_versions", |c| async move { vcs_conflict_versions(&c.host, &c.window, c.arg("path")?).await });
    d.add(
        "vcs_diff_text",
        |c| async move { vcs_diff_text(&c.host, &c.window, c.arg("path")?, c.arg("staged")?).await },
    );
    d.add(
        "vcs_diff_hunks",
        |c| async move { Ok(vcs_diff_hunks(&c.host, &c.window, c.arg("oldText")?, c.arg("newText")?)) },
    );
    d.add(
        "vcs_stage_hunks",
        |c| async move { vcs_stage_hunks(&c.host, &c.window, c.arg("path")?, c.arg("hunks")?).await },
    );
    d.add("vcs_clone", |c| async move {
        vcs_clone(
            &c.host,
            &c.window,
            c.arg("request")?,
            c.arg("url")?,
            c.arg("dest")?,
            c.arg("depth")?,
            c.sender("onOutput")?,
        )
        .await
    });
    d.add("vcs_init", |c| async move { vcs_init(&c.host, &c.window, c.arg("dir")?).await });
    d.add("vcs_git_version", |c| async move { vcs_git_version(&c.host, &c.window, c.arg("path")?).await });
    d.add("vcs_detected_git", |c| async move { Ok(vcs_detected_git(&c.host, &c.window)) });
    d.add("vcs_config_get", |c| async move { vcs_config_get(&c.host, &c.window, c.arg("repo")?, c.arg("key")?).await });
    d.add("vcs_operation", |c| async move {
        vcs_operation(&c.host, &c.window, c.arg("repo")?, c.arg("request")?, c.arg("op")?, c.sender("onOutput")?).await
    });
    d.add("vcs_create_tag", |c| async move {
        vcs_create_tag(
            &c.host,
            &c.window,
            c.arg("repo")?,
            c.arg("name")?,
            c.arg("commit")?,
            c.arg("message")?,
            c.arg("force")?,
        )
        .await
    });
    d.add("vcs_tags", |c| async move { vcs_tags(&c.host, &c.window, c.arg("repo")?).await });
    d.add("vcs_merge_with", |c| async move {
        vcs_merge_with(&c.host, &c.window, c.arg("repo")?, c.arg("branches")?, c.arg("options")?).await
    });
    d.add("vcs_rebase_with", |c| async move {
        vcs_rebase_with(&c.host, &c.window, c.arg("repo")?, c.arg("upstream")?, c.arg("options")?).await
    });
    d.add("vcs_remotes", |c| async move { vcs_remotes(&c.host, &c.window, c.arg("repo")?).await });
    d.add(
        "vcs_edit_remote",
        |c| async move { vcs_edit_remote(&c.host, &c.window, c.arg("repo")?, c.arg("edit")?).await },
    );
    d.add("vcs_worktrees", |c| async move { vcs_worktrees(&c.host, &c.window, c.arg("repo")?).await });
    d.add("vcs_add_worktree", |c| async move {
        vcs_add_worktree(&c.host, &c.window, c.arg("repo")?, c.arg("path")?, c.arg("commitish")?, c.arg("newBranch")?)
            .await
    });
    d.add("vcs_move_worktree", |c| async move {
        vcs_move_worktree(&c.host, &c.window, c.arg("repo")?, c.arg("path")?, c.arg("to")?).await
    });
    d.add("vcs_remove_worktree", |c| async move {
        vcs_remove_worktree(&c.host, &c.window, c.arg("repo")?, c.arg("path")?, c.arg("force")?).await
    });
    d.add("vcs_compare_scope", |c| async move { vcs_compare_scope(&c.host, &c.window, c.arg("paths")?).await });
    d.add("vcs_compare_paths", |c| async move {
        vcs_compare_paths(
            &c.host,
            &c.window,
            c.arg("paths")?,
            c.arg("revision")?,
            c.arg("repositories")?,
            c.arg("request")?,
        )
        .await
    });
    d.add("vcs_diff_with_worktree", |c| async move {
        vcs_diff_with_worktree(&c.host, &c.window, c.arg("repo")?, c.arg("rev")?).await
    });
    d.add("vcs_diff_revisions", |c| async move {
        vcs_diff_revisions(&c.host, &c.window, c.arg("repo")?, c.arg("from")?, c.arg("to")?).await
    });
    d.add("vcs_diff_numstat", |c| async move {
        vcs_diff_numstat(&c.host, &c.window, c.arg("repo")?, c.arg("from")?, c.arg("to")?, c.arg("paths")?).await
    });
    d.add("vcs_has_hook", |c| async move { vcs_has_hook(&c.host, &c.window, c.arg("repo")?, c.arg("name")?).await });
    d.add("vcs_merge_base", |c| async move {
        vcs_merge_base(&c.host, &c.window, c.arg("repo")?, c.arg("a")?, c.arg("b")?).await
    });
    d.add("vcs_create_patch", |c| async move {
        vcs_create_patch(&c.host, &c.window, c.arg("repo")?, c.arg("source")?).await
    });
    d.add("vcs_patch_preview", |c| async move {
        vcs_patch_preview(&c.host, &c.window, c.arg("repo")?, c.arg("patch")?).await
    });
    d.add(
        "vcs_apply_patch",
        |c| async move { vcs_apply_patch(&c.host, &c.window, c.arg("repo")?, c.arg("patch")?).await },
    );
    d.add("vcs_shelve", |c| async move { vcs_shelve(&c.host, &c.window, c.arg("name")?, c.arg("paths")?).await });
    d.add("vcs_shelves", |c| async move { vcs_shelves(&c.host, &c.window) });
    d.add("vcs_unshelve", |c| async move {
        vcs_unshelve(&c.host, &c.window, c.arg("id")?, c.arg("remove")?, c.arg("path")?).await
    });
    d.add("vcs_shelf_delete", |c| async move { vcs_shelf_delete(&c.host, &c.window, c.arg("id")?, c.arg("path")?) });
    d.add("vcs_shelf_rename", |c| async move { vcs_shelf_rename(&c.host, &c.window, c.arg("id")?, c.arg("name")?) });
    d.add("vcs_shelf_diff", |c| async move { vcs_shelf_diff(&c.host, &c.window, c.arg("id")?).await });
    d.add("vcs_shelf_import", |c| async move {
        vcs_shelf_import(&c.host, &c.window, c.arg("repo")?, c.arg("name")?, c.arg("patch")?).await
    });
    d.add("vcs_shelf_patch", |c| async move { vcs_shelf_patch(&c.host, &c.window, c.arg("id")?, c.arg("path")?) });
    d.add("vcs_changelists_load", |c| async move { vcs_changelists_load(&c.host, &c.window) });
    d.add("vcs_changelists_save", |c| async move { vcs_changelists_save(&c.host, &c.window, c.arg("changelists")?) });
    d.add(
        "vcs_write_patch",
        |c| async move { vcs_write_patch(&c.host, &c.window, c.arg("path")?, c.arg("patch")?).await },
    );
}
