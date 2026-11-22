#[allow(unused_imports)]
use super::*;
use crate::Host;
use crate::Project;
use crate::ops::Channel;
use ide_command::command;
use ide_core::error::PushDivergence;
use ide_core::ipc_path::IpcPath;
use ide_core::workflow_settings::EmptyCherryPickAction;
use ide_core::{IdeResult, RequestId};
use ide_vcs::*;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use super::rebase_editor::RebaseEditorPrompt;

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

    /// `with_log_repo_at` through the backend-agnostic Changes-view surface.
    fn with_log_backend_at<T>(&self, at: Option<&Path>, f: impl FnOnce(&dyn Backend) -> IdeResult<T>) -> IdeResult<T> {
        self.with_log_repo_at(at, |r| f(r as &dyn Backend))
    }
}

/// A repository of the project (IDEA's VCS root).
#[derive(Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct VcsRoot {
    /// Worktree root.
    pub root: ide_core::IpcPath,
    /// Root representing all mapped worktrees of the same Git repository in branch lists.
    pub branch_root: ide_core::IpcPath,
    /// Merge / rebase / cherry-pick / revert in progress.
    pub operation: Option<String>,
    /// The current rebase uses Git's interactive mode.
    #[serde(default)]
    #[specta(optional)]
    pub interactive_rebase: bool,
    /// Current branch; `None` when HEAD is detached (or unreadable).
    pub head: Option<String>,
    /// HEAD commit; `None` before the first commit.
    pub head_commit: Option<String>,
    /// The history ends at a shallow boundary rather than at the initial commit.
    #[serde(default)]
    pub shallow: bool,
    /// Remote availability is unknown in Restricted Mode or when config cannot be read.
    #[serde(default)]
    #[specta(optional)]
    pub has_remotes: Option<bool>,
    /// Conflicts staged during the current operation that can be reopened.
    #[serde(default)]
    pub resolved_conflicts: Vec<ide_core::IpcPath>,
}

#[derive(Clone, Serialize, Deserialize, Type)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum RemoteOp {
    Fetch {
        /// The incoming-commit poll keeps Git's tag handling and uses saved credentials only.
        #[serde(default)]
        #[specta(optional)]
        background: bool,
        #[serde(default)]
        #[specta(optional)]
        report: bool,
        #[serde(default, rename = "skipRemotes")]
        #[specta(optional)]
        skip_remotes: Vec<String>,
    },
    FetchRemote {
        remote: String,
        #[serde(default)]
        #[specta(optional)]
        report: bool,
    },
    FetchPushTarget {
        selection: PushSelection,
    },
    Unshallow,
    Pull {
        rebase: bool,
        #[serde(default, rename = "expectedBranch")]
        expected_branch: Option<String>,
    },
    UpdateProjectBranch {
        rebase: bool,
    },
    UpdateSubmodule {
        parent: PathBuf,
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
    PushSelected {
        selection: PushSelection,
        force_with_lease: bool,
        set_upstream: bool,
        tags: Option<PushTags>,
        no_verify: bool,
        #[serde(default)]
        inspected: Option<PushInspection>,
    },
    ForcePushRejected {
        divergence: PushDivergence,
        tags: Option<PushTags>,
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
    DeleteTagOnRemotes {
        deleted: DeletedTag,
    },
    /// Pull dialog: `branches` of `remote` (none = the configured merge branch).
    PullFrom {
        remote: String,
        branches: Vec<String>,
        /// Explicit rebase or merge. Null uses Git's configured pull behavior.
        rebase: Option<bool>,
        options: MergeOptions,
    },
}

#[derive(Serialize, Deserialize, Type)]
#[serde(untagged)]
pub enum RemoteOpReport {
    Push(PushReport),
    Fetch(FetchReport),
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
    ContinueReviewedApply {
        checkpoint: String,
        message: String,
        #[serde(default)]
        options: ApplyCommitOptions,
    },
    FinishMerge {
        branch: Option<String>,
        head: String,
        target: String,
    },
    /// Stage and Retry: stage the changes of tracked files, then continue.
    StageAndContinue,
    Abort {
        #[serde(default)]
        expected: Option<String>,
        #[serde(default, rename = "expectedRebase", skip_serializing_if = "Option::is_none")]
        expected_rebase: Option<RebaseState>,
    },
    Skip,
    /// Commits oldest first; add the origin for all commits or the specified subset.
    CherryPick {
        commits: Vec<String>,
        #[serde(default, rename = "recordOrigin")]
        record_origin: bool,
        #[serde(default, rename = "recordOriginFor")]
        record_origin_for: Vec<String>,
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
    CheckoutRebase {
        plan: CheckoutRebasePlan,
        #[serde(rename = "shelfBatch")]
        shelf_batch: Option<String>,
    },
    RebaseBranch {
        plan: BranchRebasePlan,
        #[serde(rename = "shelfBatch")]
        shelf_batch: Option<String>,
    },
    DropCommitChanges {
        commit: String,
        #[serde(rename = "expectedHead")]
        expected_head: HistoryTip,
        paths: Vec<PathBuf>,
    },
}

#[derive(Clone, Serialize, Deserialize, Type)]
#[serde(untagged)]
pub enum GitOperationResult {
    Rewritten(RewrittenCommit),
    Rebased {
        rebased: HistoryTip,
    },
    EmptyCherryPicks {
        #[serde(rename = "emptyCherryPicks")]
        empty_cherry_picks: u32,
        action: EmptyCherryPickAction,
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

/// `per_repo` through the backend-agnostic Changes-view surface.
fn per_backend(
    project: &Project,
    paths: &[PathBuf],
    recorded: Option<&str>,
    f: impl Fn(&dyn Backend, &[PathBuf]) -> IdeResult<()>,
) -> IdeResult<()> {
    per_repo(project, paths, recorded, |r, paths| f(r as &dyn Backend, paths))
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> IdeResult<T> + Send + 'static) -> IdeResult<T> {
    tokio::task::spawn_blocking(f).await.map_err(|e| ide_core::IdeError::internal(e.to_string()))?
}

fn with_shelf_batch<T>(project: &Project, batch: Option<String>, operation: impl FnOnce() -> T) -> T {
    let Some(batch) = batch.and_then(|id| uuid::Uuid::parse_str(&id).ok()) else { return operation() };
    let repos = project.repos();
    let Some(base) = project.root.ancestors().find(|base| repos.all().iter().all(|repo| repo.root().starts_with(base)))
    else {
        return operation();
    };
    ide_vcs::shelf::ShelfBatch::new(batch.to_string(), base.to_path_buf()).run(operation)
}

// ---- patches ----

#[derive(Clone, Serialize, Deserialize, Type)]
#[serde(tag = "from", rename_all = "camelCase")]
pub enum PatchSource {
    /// Local changes of these files (absolute paths).
    Changes { paths: Vec<ide_core::IpcPath>, reverse: bool },
    /// Changes selected on either side of the index in the staging tree.
    Staging { entries: Vec<StagingPatchEntry>, reverse: bool },
    /// Changes made by these commits (oldest first).
    Commits { commits: Vec<String>, reverse: bool },
    /// Selected files between two revisions, including both paths of a rename.
    Revisions { before: String, after: String, paths: Vec<PathBuf> },
}

fn patch_export_base(project: &Project, base: PathBuf) -> IdeResult<PathBuf> {
    let base = if base.is_absolute() { base } else { project.root.join(base) };
    dunce::canonicalize(base)
        .ok()
        .filter(|base| base.is_dir())
        .ok_or_else(|| ide_core::IdeError::invalid("Choose an existing base directory"))
}

fn export_patch(patch: String, root: &Path, base: Option<&Path>) -> IdeResult<String> {
    match base {
        Some(base) => rebase_patch(&patch, root, "", base),
        None => Ok(patch),
    }
}

fn create_staging_patch(
    project: &Project,
    entries: Vec<StagingPatchEntry>,
    reverse: bool,
    base: Option<&Path>,
) -> IdeResult<String> {
    let repos = project.repos();
    let mut groups = BTreeMap::<_, Vec<_>>::new();
    for entry in entries {
        let repo = repos.for_path(&entry.path.0).ok_or_else(|| ide_core::IdeError::invalid("no files selected"))?;
        groups.entry(repo.root().to_path_buf()).or_default().push(entry);
    }
    let common = if base.is_none() && groups.len() > 1 {
        Some(
            project
                .root
                .ancestors()
                .find(|base| groups.keys().all(|root| root.starts_with(base)))
                .ok_or_else(|| ide_core::IdeError::invalid("The selected repositories have no common directory"))?,
        )
    } else {
        None
    };
    let mut patch = String::new();
    for (root, entries) in groups {
        let prefix = common
            .and_then(|base| root.strip_prefix(base).ok())
            .filter(|relative| !relative.as_os_str().is_empty())
            .map(|relative| format!("{}/", ide_core::ipc_path::to_ipc(relative)))
            .unwrap_or_default();
        patch.push_str(&project.with_repo_at(Some(&root), |r| {
            let patch = r.create_staging_patch(&entries, reverse, &prefix)?;
            export_patch(patch, r.root(), base)
        })?);
    }
    Ok(patch)
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

/// Directory Mappings: the repository roots detection finds, before any are excluded or added.
#[command(trust = always)]
pub async fn vcs_detected_roots(host: &Host, window: &str) -> IdeResult<Vec<PathBuf>> {
    let project = host.project(window)?;
    blocking(move || project.detected_repository_roots()).await
}

/// The project's repositories, the primary one first.
#[command(trust = always)]
pub async fn vcs_roots(host: &Host, window: &str) -> IdeResult<Vec<VcsRoot>> {
    let project = host.project(window)?;
    let repos = project.repos();
    let trusted = project.is_trusted();
    blocking(move || {
        let primary = repos.primary().map(|r| r.root().to_path_buf());
        let mut all: Vec<_> = repos.all().iter().collect();
        all.sort_by_key(|r| Some(r.root()) != primary.as_deref());
        let roots: Vec<_> = all.into_iter().map(|repo| (repo, repo.metadata_dirs().ok())).collect();
        let mut branch_roots = std::collections::HashMap::new();
        for (repo, dirs) in &roots {
            if let Some([git_dir, common_dir]) = dirs {
                let first = branch_roots.entry(common_dir).or_insert(repo.root());
                if git_dir == common_dir {
                    *first = repo.root();
                }
            }
        }
        Ok(roots
            .iter()
            .map(|(r, dirs)| {
                let branch_root = dirs.as_ref().and_then(|[_, common_dir]| branch_roots.get(common_dir));
                let (head, head_commit) = r.head().unwrap_or_default();
                let operation = r.operation().ok().flatten();
                let interactive_rebase = operation.as_deref() == Some("rebase") && r.is_interactive_rebase();
                let resolved_conflicts = operation
                    .as_ref()
                    .and_then(|_| r.resolved_conflicts().ok())
                    .unwrap_or_default()
                    .into_iter()
                    .map(Into::into)
                    .collect();
                VcsRoot {
                    root: r.root().into(),
                    branch_root: branch_root.copied().unwrap_or_else(|| r.root()).into(),
                    operation,
                    interactive_rebase,
                    head,
                    head_commit,
                    shallow: r.is_shallow().unwrap_or(false),
                    has_remotes: trusted.then(|| r.has_remotes().ok()).flatten(),
                    resolved_conflicts,
                }
            })
            .collect())
    })
    .await
}

#[command(trust = always)]
pub async fn vcs_branch_info(host: &Host, window: &str, repo: Option<PathBuf>) -> IdeResult<BranchInfo> {
    let project = LogAccess::new(host, window, repo.as_deref());
    blocking(move || project.with_log_repo_at(repo.as_deref(), |r| r.branch_info())).await
}

#[command(trust = trusted)]
pub async fn vcs_check_incoming(
    host: &Host,
    window: &str,
    repo: PathBuf,
    request: RequestId,
) -> IdeResult<IncomingRefsReport> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    let cancel = host.begin_project_request(window, request);
    let result = blocking(move || project.with_repo_at(Some(&repo), |r| r.check_incoming_refs(&cancel))).await;
    host.end_request(request);
    result
}

/// Gutter change markers for a file, computed against its current (unsaved) text.
#[command(trust = always)]
pub async fn vcs_line_hunks(host: &Host, window: &str, path: PathBuf) -> IdeResult<Vec<LineHunk>> {
    let project = host.project(window)?;
    blocking(move || {
        let text = project.text_of(&path)?;
        project.with_backend_of(&path, |r| r.line_hunks(&path, &text, false, project.vcs_encoding(&path, None)?))
    })
    .await
}

#[command(trust = always)]
pub async fn vcs_staging_line_hunks(
    host: &Host,
    window: &str,
    path: PathBuf,
    head_path: Option<PathBuf>,
) -> IdeResult<Option<ide_vcs::StagingLineHunks>> {
    let project = host.project(window)?;
    blocking(move || {
        let text = project.text_of(&path)?;
        project.with_repo_of(&path, |repo| {
            repo.staging_line_hunks(
                &path,
                head_path.as_deref(),
                &text,
                ide_vfs::READ_ONLY_THRESHOLD as usize,
                |path, bytes| project.staged_file_encoding(path, bytes),
            )
        })
    })
    .await
}

#[command(trust = always)]
pub async fn vcs_file_at(host: &Host, window: &str, path: PathBuf, rev: Option<String>) -> IdeResult<Option<String>> {
    let project = host.project(window).ok();
    let external = host.external_logs.read().get(host.owner_window(window)).and_then(|rs| {
        rs.iter().filter(|r| path.starts_with(r.root())).max_by_key(|r| r.root().components().count()).cloned()
    });
    blocking(move || {
        if let Some(project) = project {
            return project.with_log_backend_of(&path, |r| {
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

/// The file's git mode at `rev` (`100644`, `100755`, `120000`…), `"WT"` for the
/// worktree; `None` when absent there. Lets the diff viewer report a mode-only change.
#[command(trust = trusted)]
pub async fn vcs_file_mode(host: &Host, window: &str, path: PathBuf, rev: Option<String>) -> IdeResult<Option<String>> {
    let project = host.project(window).ok();
    let external = host.external_logs.read().get(host.owner_window(window)).and_then(|rs| {
        rs.iter().filter(|r| path.starts_with(r.root())).max_by_key(|r| r.root().components().count()).cloned()
    });
    blocking(move || {
        if let Some(project) = project {
            return project.with_log_backend_of(&path, |r| r.file_mode_at(&path, rev.as_deref()));
        }
        external
            .ok_or_else(|| ide_core::IdeError::unavailable("external Git log is not open"))?
            .file_mode_at(&path, rev.as_deref())
    })
    .await
}

#[derive(Serialize, Deserialize, Type)]
pub struct DiffEntryRequest {
    pub path: IpcPath,
    pub rev: String,
}

#[command(trust = always)]
pub async fn vcs_diff_entries(
    host: &Host,
    window: &str,
    entries: Vec<DiffEntryRequest>,
) -> IdeResult<Vec<Option<DiffEntry>>> {
    let project = host.project(window).ok();
    let external = host.external_logs.read().get(host.owner_window(window)).cloned().unwrap_or_default();
    blocking(move || {
        Ok(entries
            .into_iter()
            .map(|DiffEntryRequest { path: IpcPath(path), rev }| {
                if let Some(project) = &project {
                    return project.with_log_repo_of(&path, |repo| repo.diff_entry_at(&path, &rev)).ok().flatten();
                }
                external
                    .iter()
                    .filter(|repo| path.starts_with(repo.root()) && path != repo.root())
                    .max_by_key(|repo| repo.root().components().count())?
                    .diff_entry_at(&path, &rev)
                    .ok()
                    .flatten()
            })
            .collect())
    })
    .await
}

#[command(trust = always)]
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
        project.with_backend_of(&path, |backend| {
            let encoding = project.vcs_encoding(&path, revision.as_deref())?;
            let text = text.as_deref();
            let revision = revision.as_deref();
            if let Some(repo) = backend.as_git() {
                repo.blame_with_options(&path, text, revision, encoding, project.settings.effective().vcs.git.annotate)
            } else {
                backend.blame(&path, text, revision, encoding)
            }
        })
    })
    .await
}

/// History for Selection: commits that changed `lines` (0-based, inclusive) of `path`'s
/// editor text. Cancellable with `cancel_request(request)`.
#[command(trust = always)]
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
        project.with_backend_of(&path, |r| {
            r.block_history(&path, text.as_deref(), lines, project.vcs_encoding(&path, None)?, &cancel)
        })
    })
    .await;
    host.end_request(request);
    result
}

#[command(trust = always)]
pub async fn vcs_log(host: &Host, window: &str, repo: Option<PathBuf>, query: LogQuery) -> IdeResult<Vec<Commit>> {
    let project = LogAccess::new(host, window, repo.as_deref());
    let request = query.request;
    let cancel =
        request.map_or_else(ide_core::CancellationToken::new, |id| host.begin_project_read_request(window, id));
    let result = blocking(move || {
        project.with_log_repo_at(repo.as_deref(), |r| {
            r.enable_log_index(&project.cache);
            (r as &dyn Backend).log(&query, &cancel)
        })
    })
    .await;
    if let Some(id) = request {
        host.end_request(id);
    }
    result
}

#[command(trust = always)]
pub async fn vcs_not_cherry_picked(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    source: String,
    target: String,
    request: RequestId,
) -> IdeResult<Option<Vec<String>>> {
    let project = LogAccess::new(host, window, repo.as_deref());
    let cancel = host.begin_project_read_request(window, request);
    let result =
        blocking(move || project.with_log_repo_at(repo.as_deref(), |r| r.not_cherry_picked(&source, &target, &cancel)))
            .await;
    host.end_request(request);
    result
}

#[command(trust = always)]
pub async fn vcs_log_refs(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
) -> IdeResult<std::collections::BTreeMap<String, String>> {
    let project = LogAccess::new(host, window, repo.as_deref());
    blocking(move || project.with_log_repo_at(repo.as_deref(), |r| r.log_refs())).await
}

#[command(trust = always)]
pub async fn vcs_log_users(host: &Host, window: &str, repo: Option<PathBuf>) -> IdeResult<Vec<String>> {
    let project = LogAccess::new(host, window, repo.as_deref());
    blocking(move || project.with_log_repo_at(repo.as_deref(), |r| r.log_users())).await
}

#[command(trust = always)]
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

#[command(trust = always)]
pub async fn vcs_log_details(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    revision: String,
) -> IdeResult<LogDetails> {
    let project = LogAccess::new(host, window, repo.as_deref());
    blocking(move || project.with_log_repo_at(repo.as_deref(), |r| r.log_details(&revision))).await
}

#[command(trust = always)]
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

/// Clears cached verification results before refreshing the Git Log.
#[command(trust = always)]
pub async fn vcs_invalidate_log_signatures(host: &Host, window: &str, repo: PathBuf) -> IdeResult<()> {
    let project = LogAccess::new(host, window, Some(&repo));
    blocking(move || {
        project.with_log_repo_at(Some(&repo), |repo| {
            repo.invalidate_log_signatures();
            Ok(())
        })
    })
    .await
}

#[command(trust = always)]
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

#[command(trust = always)]
pub async fn vcs_revision_files(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    revision: String,
) -> IdeResult<Vec<String>> {
    let project = LogAccess::new(host, window, repo.as_deref());
    blocking(move || project.with_log_repo_at(repo.as_deref(), |r| r.revision_files(&revision))).await
}

#[command(trust = always)]
pub async fn vcs_commit_files(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    commit: String,
) -> IdeResult<Vec<ChangedFile>> {
    let project = LogAccess::new(host, window, repo.as_deref());
    blocking(move || project.with_log_backend_at(repo.as_deref(), |r| r.commit_files(&commit))).await
}

#[command(trust = trusted)]
pub async fn vcs_preview_partial_commit(host: &Host, window: &str, file: PartialCommitFile) -> IdeResult<String> {
    let project = host.project(window)?;
    blocking(move || {
        let path = &file.path.0;
        let encoding = project.vcs_encoding(path, None)?;
        project.with_repo_of(path, |repo| repo.preview_partial_commit(&file, encoding))
    })
    .await
}

#[command(trust = trusted)]
pub async fn vcs_commit_crlf_paths(
    host: &Host,
    window: &str,
    repo: PathBuf,
    paths: Vec<PathBuf>,
    options: CommitOptions,
    request: RequestId,
) -> IdeResult<Vec<ide_core::IpcPath>> {
    let project = host.project(window)?;
    let cancel = host.begin_project_read_request(window, request);
    let result = blocking(move || {
        project.with_repo_at(Some(&repo), |r| {
            r.commit_crlf_paths(&paths, &options, &|path| project.vcs_encoding(path, None), &cancel)
        })
    })
    .await;
    host.end_request(request);
    result
}

#[command(trust = trusted)]
pub async fn vcs_commit_large_files(
    host: &Host,
    window: &str,
    repo: PathBuf,
    paths: Vec<PathBuf>,
    options: CommitOptions,
    limit: u64,
    request: RequestId,
) -> IdeResult<Vec<LargeCommitFile>> {
    let project = host.project(window)?;
    let cancel = host.begin_project_read_request(window, request);
    let result = blocking(move || {
        project.with_repo_at(Some(&repo), |r| {
            r.commit_large_files(&paths, &options, limit, &|path| project.vcs_encoding(path, None), &cancel)
        })
    })
    .await;
    host.end_request(request);
    result
}

/// Combined changes of several commits, `commits` oldest first.
#[command(trust = always)]
pub async fn vcs_commits_changes(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    commits: Vec<String>,
) -> IdeResult<Vec<RevisionChange>> {
    let project = LogAccess::new(host, window, repo.as_deref());
    blocking(move || project.with_log_backend_at(repo.as_deref(), |r| r.commits_changes(&commits))).await
}

#[command(trust = always)]
pub async fn vcs_commit_selection_changes(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    commits: Vec<String>,
    request: RequestId,
) -> IdeResult<Vec<RevisionChange>> {
    let project = LogAccess::new(host, window, repo.as_deref());
    let cancel = host.begin_project_read_request(window, request);
    let result =
        blocking(move || project.with_log_repo_at(repo.as_deref(), |r| r.commit_selection_changes(&commits, &cancel)))
            .await;
    host.end_request(request);
    result
}

#[command(trust = always)]
pub async fn vcs_branches(host: &Host, window: &str, repo: Option<PathBuf>) -> IdeResult<Vec<Branch>> {
    let project = LogAccess::new(host, window, repo.as_deref());
    blocking(move || project.with_log_repo_at(repo.as_deref(), |r| r.branches())).await
}

#[command(trust = always)]
pub async fn vcs_stashes(host: &Host, window: &str, repo: Option<PathBuf>) -> IdeResult<Vec<Stash>> {
    let project = host.project(window)?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.stashes())).await
}

#[command(trust = trusted)]
pub async fn vcs_stage(host: &Host, window: &str, paths: Vec<PathBuf>) -> IdeResult<()> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    blocking(move || per_backend(&project, &paths, None, |r, paths| r.stage(paths))).await
}

#[command(trust = trusted)]
pub async fn vcs_stage_without_content(host: &Host, window: &str, paths: Vec<PathBuf>) -> IdeResult<()> {
    let project = host.project(window)?;
    blocking(move || per_repo(&project, &paths, None, Repo::stage_without_content)).await
}

#[command(trust = trusted)]
pub async fn vcs_ignore_blame_revision(host: &Host, window: &str, path: PathBuf, commit: String) -> IdeResult<()> {
    // Adds `commit` to annotate's ignore list in `path`'s repository (the file `blame.ignoreRevsFile`
    // names, else `.git-blame-ignore-revs`, which the local config then names).
    host.require_trust(window)?;
    let project = host.project(window)?;
    blocking(move || {
        let result = project.with_disk_sync(|| project.with_repo_of(&path, |r| r.ignore_blame_revision(&commit)));
        if result.is_ok() {
            project.sink.emit(ide_core::IdeEvent::VcsChanged { root: project.root.clone().into() });
        }
        result
    })
    .await
}

#[command(trust = trusted)]
pub async fn vcs_add_to_ignore(
    host: &Host,
    window: &str,
    paths: Vec<PathBuf>,
    destination: IgnoreDestination,
) -> IdeResult<Vec<ide_core::IpcPath>> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    blocking(move || {
        // The Changes view lists every repository of the window (the project's and the
        // attached ones'): a path inside the project folder, or in any of those repositories.
        // The folder check stays so a request right after opening, before the repositories
        // are discovered, still works.
        let repos = project.repos();
        for path in &paths {
            let in_project = path != &project.root && path.starts_with(&project.root);
            if !in_project && repos.for_path(path).is_none() {
                return Err(ide_core::IdeError::invalid("Ignore selection is outside the project"));
            }
        }
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

#[command(trust = trusted)]
pub async fn vcs_unstage(host: &Host, window: &str, paths: Vec<PathBuf>) -> IdeResult<()> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    blocking(move || per_backend(&project, &paths, None, |r, paths| r.unstage(paths))).await
}

#[command(trust = trusted)]
pub async fn vcs_stage_patch(host: &Host, window: &str, patch: String) -> IdeResult<()> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    blocking(move || project.with_repo(|r| r.stage_patch(&patch, &|path| project.vcs_encoding(path, Some(":0"))))).await
}

#[command(trust = trusted)]
pub async fn vcs_stage_formatted_text(
    host: &Host,
    window: &str,
    path: PathBuf,
    before: String,
    after: String,
) -> IdeResult<()> {
    let project = host.project(window)?;
    blocking(move || {
        let encoding = project.vcs_encoding(&path, Some(":0"))?;
        project.with_repo_of(&path, |r| r.stage_formatted_text(&path, &before, &after, encoding))
    })
    .await
}

#[command(trust = trusted)]
pub async fn vcs_staged_text(host: &Host, window: &str, path: PathBuf) -> IdeResult<Option<StagedText>> {
    let project = host.project(window)?;
    blocking(move || {
        project.with_repo_of(&path, |repo| {
            repo.staged_text(&path, ide_vfs::READ_ONLY_THRESHOLD as usize, |bytes| {
                project.staged_file_encoding(&path, bytes)
            })
        })
    })
    .await
}

#[command(trust = trusted)]
pub async fn vcs_save_staged_text(
    host: &Host,
    window: &str,
    path: PathBuf,
    version: String,
    text: String,
) -> IdeResult<String> {
    if text.len() as u64 > ide_vfs::READ_ONLY_THRESHOLD {
        return Err(ide_core::IdeError::invalid("File is too large"));
    }
    let project = host.project(window)?;
    blocking(move || {
        project.with_repo_of(&path, |repo| {
            repo.save_staged_text(&path, &version, &text, |bytes| project.staged_file_encoding(&path, bytes))
        })
    })
    .await
}

#[command(trust = trusted)]
pub async fn vcs_discard(host: &Host, window: &str, paths: Vec<PathBuf>) -> IdeResult<()> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    blocking(move || per_backend(&project, &paths, Some("Rollback"), |r, paths| r.discard(paths))).await
}

#[command(trust = trusted)]
pub async fn vcs_restore_unstaged(host: &Host, window: &str, paths: Vec<PathBuf>) -> IdeResult<()> {
    let project = host.project(window)?;
    blocking(move || per_repo(&project, &paths, Some("Rollback"), Repo::restore_unstaged)).await
}

#[command(trust = trusted)]
pub async fn vcs_rollback_submodules(
    host: &Host,
    window: &str,
    paths: Vec<PathBuf>,
    source: SubmoduleRollbackSource,
    restore_checkout: bool,
) -> IdeResult<()> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    blocking(move || {
        per_repo(&project, &paths, Some("Rollback"), |repo, paths| {
            for path in paths {
                repo.rollback_submodule(path, source, restore_checkout)?;
            }
            Ok(())
        })
    })
    .await
}

#[command(trust = trusted)]
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
        project.with_backend_recorded(repo.as_deref(), None, |r| {
            r.commit(&message, &options, &|path| project.vcs_encoding(path, None))
        })
    })
    .await
}

/// Keeps the prepared amend commit after a conflicting history replay.
#[command(trust = trusted)]
pub async fn vcs_keep_amend_commit(host: &Host, window: &str, repo: PathBuf, commit: String) -> IdeResult<String> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    blocking(move || project.with_repo_recorded(Some(&repo), None, |r| r.keep_amend_commit(&commit))).await
}

#[command(trust = trusted)]
pub async fn vcs_checkout(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    branch: String,
    create: bool,
    options: Option<ide_vcs::CheckoutOptions>,
    shelf_batch: Option<String>,
) -> IdeResult<ide_vcs::CheckoutOutcome> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    let options = options.unwrap_or_default();
    blocking(move || {
        with_shelf_batch(&project, shelf_batch, || {
            project.with_repo_recorded(repo.as_deref(), Some("Git checkout"), |r| {
                r.checkout_with(&branch, create, &options)
            })
        })
    })
    .await
}

#[command(trust = trusted)]
pub async fn vcs_checkout_affected_files(
    host: &Host,
    window: &str,
    repositories: Vec<ide_core::IpcPath>,
    branch: String,
) -> IdeResult<Vec<(ide_core::IpcPath, Vec<String>)>> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    blocking(move || Ok(affected_repo_files(&project, repositories, |r| r.checkout_affected_files(&branch)))).await
}

fn affected_repo_files(
    project: &Project,
    repositories: Vec<ide_core::IpcPath>,
    inspect: impl Fn(&Repo) -> IdeResult<Vec<String>>,
) -> Vec<(ide_core::IpcPath, Vec<String>)> {
    let mut affected = Vec::new();
    for root in repositories {
        match project.with_repo_at(Some(&root), &inspect) {
            Ok(files) if !files.is_empty() => affected.push((root, files)),
            Ok(_) => {}
            Err(error) => tracing::debug!("local changes preview: {}", error.message),
        }
    }
    affected
}

/// New Branch: creates `name` at `start` (HEAD when absent), optionally checking it out.
#[allow(clippy::too_many_arguments)]
#[command(trust = trusted)]
pub async fn vcs_create_branch(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    name: String,
    start: Option<String>,
    checkout: bool,
    overwrite: Option<bool>,
    expected_tip: Option<String>,
    options: Option<CheckoutOptions>,
    shelf_batch: Option<String>,
) -> IdeResult<BranchCreationOutcome> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    let recorded = checkout.then_some("Git checkout");
    let options = checkout.then(|| options.unwrap_or_default());
    blocking(move || {
        with_shelf_batch(&project, shelf_batch, || {
            project.with_repo_recorded(repo.as_deref(), recorded, |r| {
                r.create_branch_with(
                    &name,
                    start.as_deref(),
                    options.as_ref(),
                    overwrite.unwrap_or(false),
                    expected_tip.as_deref(),
                )
            })
        })
    })
    .await
}

#[command(trust = trusted)]
pub async fn vcs_undo_branch_creation(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    name: String,
    created: BranchCreation,
    previous_head: Option<HistoryTip>,
) -> IdeResult<()> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    let recorded = previous_head.is_some().then_some("Git rollback");
    blocking(move || {
        project.with_repo_recorded(repo.as_deref(), recorded, |r| {
            r.undo_branch_creation(&name, &created, previous_head.as_ref())
        })
    })
    .await
}

/// Undo Commit: moves HEAD back to the commit's parent, keeping its changes staged.
/// Returns the undone commit's message.
#[command(trust = trusted)]
pub async fn vcs_undo_commit(host: &Host, window: &str, repo: Option<PathBuf>, commit: String) -> IdeResult<String> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.undo_commit(&commit))).await
}

/// Edit Commit Message: rewrites the commit and its descendants without touching the
/// working tree.
#[command(trust = trusted)]
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

#[command(trust = trusted)]
pub async fn vcs_extract_commit_changes(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    commit: String,
    expected_head: HistoryTip,
    paths: Vec<PathBuf>,
    message: String,
) -> IdeResult<RewrittenCommit> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    blocking(move || {
        project.with_repo_at(repo.as_deref(), |r| r.extract_commit_changes(&commit, &expected_head, &paths, &message))
    })
    .await
}

/// Undo of a history rewrite (Edit Commit Message, Drop, Squash).
#[command(trust = trusted)]
pub async fn vcs_restore_head(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    before: String,
    after: String,
    branch: Option<String>,
    checkout: Option<HistoryTip>,
) -> IdeResult<()> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    blocking(move || {
        let recorded = branch.is_some().then_some("Git rollback");
        project.with_repo_recorded(repo.as_deref(), recorded, |r| match checkout {
            Some(checkout) => {
                let branch = branch.ok_or_else(|| ide_core::IdeError::invalid("The rebased branch is required"))?;
                r.restore_rebase_checkout(&before, &after, &branch, &checkout)
            }
            None => r.restore_head_on_branch(&before, &after, branch.as_deref()),
        })
    })
    .await
}

#[command(trust = trusted)]
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

/// Deletes a local tracking branch the user selected along with its remote branch.
#[command(trust = trusted)]
pub async fn vcs_delete_tracking_branch(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    branch: String,
    expected_tip: String,
    expected_upstream: String,
) -> IdeResult<DeletedBranch> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    blocking(move || {
        project.with_repo_at(repo.as_deref(), |r| r.delete_tracking_branch(&branch, &expected_tip, &expected_upstream))
    })
    .await
}

/// Deletes a branch offered for cleanup by a successful merge.
#[command(trust = trusted)]
pub async fn vcs_delete_merged_branch(
    host: &Host,
    window: &str,
    repo: PathBuf,
    branch: String,
    expected_tip: String,
) -> IdeResult<ide_vcs::DeletedBranch> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    blocking(move || project.with_repo_at(Some(&repo), |r| r.delete_merged_branch(&branch, &expected_tip))).await
}

/// Tag › Delete: the result is what "Restore" needs.
#[command(trust = trusted)]
pub async fn vcs_delete_tag(host: &Host, window: &str, repo: Option<PathBuf>, name: String) -> IdeResult<DeletedTag> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.delete_tag(&name))).await
}

/// "Restore" of the tag-deleted notification.
#[command(trust = trusted)]
pub async fn vcs_restore_tag(host: &Host, window: &str, repo: Option<PathBuf>, deleted: DeletedTag) -> IdeResult<()> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.restore_tag(&deleted))).await
}

/// "Restore" of the branch-deleted notification.
#[command(trust = trusted)]
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

#[command(trust = trusted)]
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

#[command(trust = trusted)]
pub async fn vcs_merge(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    branch: String,
    shelf_batch: Option<String>,
    smart: bool,
) -> IdeResult<MergeOutcome> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    blocking(move || {
        with_shelf_batch(&project, shelf_batch, || {
            project.with_repo_recorded(repo.as_deref(), Some("Git merge"), |r| {
                r.merge_attempt(&[branch], &MergeOptions::default(), smart)
            })
        })
    })
    .await
}

#[command(trust = trusted)]
pub async fn vcs_merge_affected_files(
    host: &Host,
    window: &str,
    repositories: Vec<ide_core::IpcPath>,
    branch: String,
) -> IdeResult<Vec<(ide_core::IpcPath, Vec<String>)>> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    blocking(move || Ok(affected_repo_files(&project, repositories, |r| r.merge_affected_files(&branch)))).await
}

#[command(trust = trusted)]
pub async fn vcs_rebase(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    onto: String,
    shelf_batch: Option<String>,
) -> IdeResult<()> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    blocking(move || {
        with_shelf_batch(&project, shelf_batch, || {
            project.with_repo_recorded(repo.as_deref(), Some("Git rebase"), |r| r.rebase(&onto))
        })
    })
    .await
}

/// Restores the batch's ready repositories. A repository with an operation in progress keeps its Shelf.
#[command(trust = trusted)]
pub async fn vcs_finish_shelf_batch(
    host: &Host,
    window: &str,
    batch: String,
    repositories: Vec<Option<PathBuf>>,
) -> IdeResult<()> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    blocking(move || {
        let mut errors = Vec::new();
        for repo in repositories {
            if let Err(error) = project
                .with_repo_recorded(repo.as_deref(), Some("Restore shelved changes"), |r| r.finish_shelf_batch(&batch))
            {
                errors.push(error);
            }
        }
        match errors.len() {
            0 => Ok(()),
            1 => Err(errors.remove(0)),
            _ => Err(ide_core::IdeError::invalid(
                errors.into_iter().map(|error| error.message).collect::<Vec<_>>().join("\n"),
            )),
        }
    })
    .await
}

#[command(trust = trusted)]
pub async fn vcs_stash_push(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    message: Option<String>,
    include_untracked: bool,
    keep_index: bool,
    paths: Option<Vec<PathBuf>>,
) -> IdeResult<()> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    let paths = paths.unwrap_or_default();
    blocking(move || {
        if paths.is_empty() {
            return project.with_repo_recorded(repo.as_deref(), Some("Git stash"), |r| {
                r.stash_push(message.as_deref(), include_untracked, keep_index, &[])
            });
        }
        per_repo(&project, &paths, Some("Git stash"), |r, paths| {
            r.stash_push(message.as_deref(), include_untracked, keep_index, paths)
        })
    })
    .await
}

#[command(trust = trusted)]
pub async fn vcs_stash_apply(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    stash: Stash,
    pop: bool,
    reinstate_index: bool,
    branch: Option<String>,
) -> IdeResult<StashApplyResult> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    blocking(move || {
        project.with_repo_recorded(repo.as_deref(), Some("Git unstash"), |r| {
            r.unstash_selected(&stash, pop, reinstate_index, branch.as_deref())
        })
    })
    .await
}

#[command(trust = trusted)]
pub async fn vcs_stash_drop(host: &Host, window: &str, repo: Option<PathBuf>, stash: Stash) -> IdeResult<u32> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.drop_selected_stash(&stash))).await
}

#[command(trust = trusted)]
pub async fn vcs_stash_clear(host: &Host, window: &str, repo: Option<PathBuf>) -> IdeResult<()> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    blocking(move || project.with_repo_at(repo.as_deref(), Repo::stash_clear)).await
}

/// Chooses the destination of a local branch or the current HEAD.
#[command(trust = always)]
pub async fn vcs_default_push_target(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    branch: Option<String>,
) -> IdeResult<Option<DefaultPushTarget>> {
    let project = host.project(window)?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.default_push_target(branch.as_deref()))).await
}

/// Chooses the source branch and configured destination for a single Git Log commit.
#[command(trust = always)]
pub async fn vcs_commit_push_target(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    request: RequestId,
    revision: String,
) -> IdeResult<CommitPushTarget> {
    let project = host.project(window)?;
    let cancel = host.begin_project_read_request(window, request);
    let result =
        blocking(move || project.with_repo_at(repo.as_deref(), |r| r.commit_push_target(&revision, &cancel))).await;
    host.end_request(request);
    result
}

/// Resolves the push source and the configured destination for each remote.
#[command(trust = always)]
pub async fn vcs_push_target_choices(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    request: RequestId,
    branch: Option<String>,
    revision: Option<String>,
) -> IdeResult<PushTargetChoices> {
    let project = host.project(window)?;
    let cancel = host.begin_project_read_request(window, request);
    let result = blocking(move || {
        project
            .with_repo_at(repo.as_deref(), |r| r.push_target_choices(branch.as_deref(), revision.as_deref(), &cancel))
    })
    .await;
    host.end_request(request);
    result
}

/// Reads the selected push target without prompting for remote credentials.
#[command(trust = trusted)]
pub async fn vcs_inspect_push(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    request: RequestId,
    selection: PushSelection,
    live: bool,
) -> IdeResult<PushInspection> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    let cancel = host.begin_project_request(window, request);
    let result =
        blocking(move || project.with_repo_at(repo.as_deref(), |r| r.inspect_push(&selection, live, &cancel))).await;
    host.end_request(request);
    result
}

/// Network operation; progress lines stream through `on_output`. Cancellable.
#[command(trust = always)]
pub async fn vcs_project_update_plan(
    host: &Host,
    window: &str,
    roots: Vec<Option<PathBuf>>,
) -> IdeResult<Vec<ProjectUpdateTarget>> {
    let project = host.project(window)?;
    blocking(move || {
        project.refresh_repositories();
        project.repos().project_update_plan(&roots)
    })
    .await
}

#[command(trust = trusted)]
pub async fn vcs_remote(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    request: RequestId,
    op: RemoteOp,
    on_output: Channel<String>,
    shelf_batch: Option<String>,
) -> IdeResult<Option<RemoteOpReport>> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    let tags_mode = project.settings.effective().vcs.git.fetch_tags_mode;
    let cancel = host.begin_project_request(window, request);
    let result = tokio::task::spawn_blocking(move || {
        let out = |line: String| {
            let _ = on_output.send(line);
        };
        let recorded = match op {
            RemoteOp::Pull { .. }
            | RemoteOp::PullFrom { .. }
            | RemoteOp::UpdateProjectBranch { .. }
            | RemoteOp::ResetToUpstream => Some("Git pull"),
            RemoteOp::UpdateSubmodule { .. } => Some("Git submodule update"),
            _ => None,
        };
        with_shelf_batch(&project, shelf_batch, || {
            project.with_repo_recorded(repo.as_deref(), recorded, |r| match op {
                RemoteOp::Fetch { background: true, report, skip_remotes } => {
                    let fetched = r.fetch_in_background(&skip_remotes, &cancel, &out)?;
                    if report {
                        Ok(Some(RemoteOpReport::Fetch(fetched)))
                    } else {
                        fetched.remotes.into_iter().find_map(|result| result.error).map_or(Ok(None), Err)
                    }
                }
                RemoteOp::Fetch { report: true, .. } => {
                    r.fetch_report(None, tags_mode, &cancel, &out).map(|report| Some(RemoteOpReport::Fetch(report)))
                }
                RemoteOp::FetchRemote { remote, report: true } => r
                    .fetch_report(Some(&remote), tags_mode, &cancel, &out)
                    .map(|report| Some(RemoteOpReport::Fetch(report))),
                RemoteOp::Fetch { .. } => r.fetch_with_tags(None, tags_mode, &cancel, &out).map(|()| None),
                RemoteOp::FetchRemote { remote, .. } => {
                    r.fetch_with_tags(Some(&remote), tags_mode, &cancel, &out).map(|()| None)
                }
                RemoteOp::FetchPushTarget { selection } => {
                    r.fetch_push_target(&selection, &cancel, &out).map(|()| None)
                }
                RemoteOp::Unshallow => r.unshallow_with_tags(tags_mode, &cancel, &out).map(|()| None),
                RemoteOp::Pull { rebase, expected_branch } => r
                    .pull_checked_branch_with_tags(rebase, expected_branch.as_deref(), tags_mode, &cancel, &out)
                    .map(|()| None),
                RemoteOp::UpdateProjectBranch { rebase } => {
                    r.pull_for_project_update(rebase, tags_mode, &cancel, &out).map(|()| None)
                }
                RemoteOp::UpdateSubmodule { parent } => project.with_repo_at(Some(&parent), |parent| {
                    r.update_from_superproject(parent, &cancel, &out).map(|()| None)
                }),
                RemoteOp::ResetToUpstream => r.reset_to_upstream_with_tags(tags_mode, &cancel, &out).map(|()| None),
                RemoteOp::Push { force_with_lease, set_upstream, tags, force, no_verify } => r
                    .push_with(PushOptions { force_with_lease, force, set_upstream, tags, no_verify }, &cancel, &out)
                    .map(|report| Some(RemoteOpReport::Push(report))),
                RemoteOp::PushSelected { selection, inspected, force_with_lease, set_upstream, tags, no_verify } => {
                    let options = PushOptions { force_with_lease, set_upstream, tags, no_verify, ..Default::default() };
                    r.push_selected(&selection, inspected.as_ref(), options, &cancel, &out)
                        .map(|report| Some(RemoteOpReport::Push(report)))
                }
                RemoteOp::ForcePushRejected { divergence, tags, no_verify } => r
                    .force_push_rejected(&divergence, tags, no_verify, &cancel, &out)
                    .map(|report| Some(RemoteOpReport::Push(report))),
                RemoteOp::DeleteBranch { branch } => r.delete_remote_branch(&branch, &cancel, &out).map(|()| None),
                RemoteOp::PushBranch {
                    branch,
                    revision,
                    force_with_lease,
                    target,
                    remote,
                    force,
                    set_upstream,
                    no_verify,
                } => r
                    .push_branch_to(
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
                    )
                    .map(|report| Some(RemoteOpReport::Push(report))),
                RemoteOp::PushTag { tag, remote } => {
                    r.push_tag(&tag, &remote, &cancel, &out).map(|report| Some(RemoteOpReport::Push(report)))
                }
                RemoteOp::DeleteRemoteTag { tag, remote } => {
                    r.delete_remote_tag(&tag, &remote, &cancel, &out).map(|()| None)
                }
                RemoteOp::DeleteTagOnRemotes { deleted } => {
                    r.delete_tag_on_remotes(&deleted, &cancel, &out).map(|()| None)
                }
                RemoteOp::PullFrom { remote, branches, rebase, options } => {
                    r.pull_from(&remote, &branches, rebase, &options, &cancel, &out).map(|()| None)
                }
            })
        })
    })
    .await;
    host.end_request(request);
    result.map_err(|e| ide_core::IdeError::internal(e.to_string()))?
}

/// Branches › Update Selected: fast-forwards local `branches` to their upstreams, one
/// fetch per remote; the result says what happened to each. Cancellable.
#[command(trust = trusted)]
pub async fn vcs_update_branches(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    request: RequestId,
    branches: Vec<String>,
    on_output: Channel<String>,
    shelf_batch: Option<String>,
) -> IdeResult<Vec<BranchUpdate>> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    let tags_mode = project.settings.effective().vcs.git.fetch_tags_mode;
    let cancel = host.begin_request(request);
    let result = tokio::task::spawn_blocking(move || {
        let out = |line: String| {
            let _ = on_output.send(line);
        };
        with_shelf_batch(&project, shelf_batch, || {
            project.with_repo_recorded(repo.as_deref(), Some("Git pull"), |r| {
                r.update_branches_with_tags(&branches, tags_mode, &cancel, &out)
            })
        })
    })
    .await
    .map_err(|e| ide_core::IdeError::internal(e.to_string()))?;
    host.end_request(request);
    result
}

/// The user's side is `ours` (sides swapped during a rebase, as in IDEA).
#[command(trust = always)]
pub async fn vcs_conflict_versions(host: &Host, window: &str, path: PathBuf) -> IdeResult<ide_vcs::MergeVersions> {
    let project = host.project(window)?;
    blocking(move || project.with_repo_of(&path, |r| r.merge_versions(&path, project.vcs_encoding(&path, Some(":2"))?)))
        .await
}

#[command(trust = trusted)]
pub async fn vcs_accept_conflict_side(
    host: &Host,
    window: &str,
    paths: Vec<PathBuf>,
    side: ide_vcs::ConflictSide,
) -> IdeResult<()> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    let label = match side {
        ide_vcs::ConflictSide::Ours => "Accept yours",
        ide_vcs::ConflictSide::Theirs => "Accept theirs",
    };
    blocking(move || per_repo(&project, &paths, Some(label), |repo, paths| repo.accept_conflict_side(paths, side)))
        .await
}

#[command(trust = trusted)]
pub async fn vcs_revert_resolved(host: &Host, window: &str, paths: Vec<PathBuf>) -> IdeResult<()> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    blocking(move || per_repo(&project, &paths, Some("Revert resolved conflicts"), Repo::revert_resolved_conflicts))
        .await
}

#[command(trust = always)]
pub async fn vcs_diff_text(host: &Host, window: &str, path: PathBuf, staged: bool) -> IdeResult<String> {
    let project = host.project(window)?;
    blocking(move || project.with_backend_of(&path, |r| r.diff_text(&path, staged, project.vcs_encoding(&path, None)?)))
        .await
}

/// Line hunks between two arbitrary texts (diff viewer, commit dialog).
#[command(trust = always)]
pub async fn vcs_diff_hunks(old_text: String, new_text: String) -> Vec<LineHunk> {
    // Off the main thread: diffing two large texts would freeze the window.
    tokio::task::spawn_blocking(move || ide_vcs::diff_hunks(&old_text, &new_text)).await.expect("line diff panicked")
}

/// Stages only the selected hunks of a file's working-tree changes.
/// Indices refer to `vcs_diff_hunks(index_text, worktree_text)`.
#[command(trust = trusted)]
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
#[command(trust = always)]
pub async fn vcs_clone(
    host: &Host,
    request: RequestId,
    url: String,
    dest: PathBuf,
    depth: Option<u32>,
    on_output: Channel<String>,
) -> IdeResult<()> {
    let settings = host.global_settings.effective();
    let recurse_submodules = settings.vcs.git.clone_submodules;
    let cancel = host.begin_request(request);
    let result = tokio::task::spawn_blocking(move || {
        ide_vcs::clone(&url, &dest, depth, recurse_submodules, &cancel, &|line| {
            let _ = on_output.send(line);
        })
    })
    .await
    .map_err(|e| ide_core::IdeError::internal(e.to_string()))?;
    host.end_request(request);
    result
}

/// `git init` in `dir` (VCS › Create Git Repository…): with the git of the window's project when
/// it is trusted, the default one in a window without a project.
#[command(trust = always)]
pub async fn vcs_init(host: &Host, window: &str, dir: PathBuf) -> IdeResult<()> {
    let git = host.project(window).ok().and_then(|p| p.git_executable());
    blocking(move || ide_vcs::with_git_executable(git.as_deref(), || ide_vcs::init(&dir))).await
}

/// Settings › Git › Test: runs `git --version` on `path`, or on the auto-detected
/// executable when `path` is empty.
#[command(trust = trusted)]
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
#[command(trust = always)]
pub fn vcs_detected_git() -> Option<String> {
    ide_vcs::detected_git_executable().map(|p| p.to_string_lossy().into_owned())
}

/// `git config --get <key>` in the project repository; `None` when unset.
#[command(trust = always)]
pub async fn vcs_config_get(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    key: String,
) -> IdeResult<Option<String>> {
    let project = LogAccess::new(host, window, repo.as_deref());
    blocking(move || project.with_log_repo_at(repo.as_deref(), |r| r.config_get(&key))).await
}

#[command(trust = always)]
pub async fn vcs_config_get_bool(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    key: String,
) -> IdeResult<Option<bool>> {
    let project = LogAccess::new(host, window, repo.as_deref());
    blocking(move || project.with_log_repo_at(repo.as_deref(), |r| r.config_get_bool(&key))).await
}

/// The effective signing settings for one registered Git repository.
#[command(trust = always)]
pub async fn vcs_signing_config(host: &Host, window: &str, repo: PathBuf) -> IdeResult<GitSigningConfig> {
    let project = host.project(window)?;
    blocking(move || project.with_repo_at(Some(&repo), Repo::signing_config)).await
}

/// Lists OpenPGP key metadata using the signer Git uses for this repository.
#[command(trust = trusted)]
pub async fn vcs_gpg_signing_keys(
    host: &Host,
    window: &str,
    repo: PathBuf,
    request: RequestId,
) -> IdeResult<Vec<GpgSigningKey>> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    let cancel = host.begin_project_request(window, request);
    let result = blocking(move || project.with_repo_at(Some(&repo), |repo| repo.gpg_signing_keys(&cancel))).await;
    host.end_request(request);
    result
}

/// Updates the selected repository's Git config.
#[command(trust = trusted)]
pub async fn vcs_edit_signing(host: &Host, window: &str, repo: PathBuf, edit: GitSigningEdit) -> IdeResult<()> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    blocking(move || {
        project.with_repo_at(Some(&repo), |repo| repo.edit_signing(edit))?;
        project.sink.emit(ide_core::IdeEvent::VcsChanged { root: project.root.clone().into() });
        Ok(())
    })
    .await
}

/// Streams Git's prepared commit message and template for the selected worktree.
#[command(trust = always)]
pub async fn vcs_watch_commit_messages(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    request: RequestId,
    on_messages: Channel<CommitMessages>,
) -> IdeResult<()> {
    let project = host.project(window)?;
    let cancel = host.begin_project_read_request(window, request);
    let result = watch_commit_messages(project, repo, cancel, on_messages).await;
    host.end_request(request);
    result
}

async fn watch_commit_messages(
    project: std::sync::Arc<Project>,
    repo: Option<PathBuf>,
    cancel: ide_core::CancellationToken,
    on_messages: Channel<CommitMessages>,
) -> IdeResult<()> {
    let (changed, mut events) = tokio::sync::mpsc::channel(1);
    let mut watch = {
        let project = project.clone();
        let repo = repo.clone();
        let cancel = cancel.clone();
        blocking(move || {
            project.with_repo_at(repo.as_deref(), |repo| {
                repo.watch_commit_messages(&cancel, move || {
                    let _ = changed.try_send(());
                })
            })
        })
        .await?
    };
    let mut last = None;
    loop {
        if cancel.is_cancelled() {
            return Ok(());
        }
        let (returned, message) = {
            let project = project.clone();
            let repo = repo.clone();
            let cancel = cancel.clone();
            blocking(move || {
                let message = project.with_repo_at(repo.as_deref(), |r| r.commit_messages(&mut watch, &cancel));
                Ok((watch, message))
            })
            .await?
        };
        watch = returned;
        if let Ok(message) = message
            && last.as_ref() != Some(&message)
        {
            on_messages.send(message.clone())?;
            last = Some(message);
        }
        tokio::select! {
            _ = cancel.cancelled() => return Ok(()),
            _ = events.recv() => {}
        }
        // Git and editors can emit several events for a single atomic save.
        tokio::select! {
            _ = cancel.cancelled() => return Ok(()),
            _ = tokio::time::sleep(std::time::Duration::from_millis(150)) => {}
        }
        let _ = events.try_recv();
    }
}

/// Git User Name Is Not Defined: sets `user.name` / `user.email` for commits in the
/// repository, or globally.
#[command(trust = trusted)]
pub async fn vcs_set_user_identity(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    name: String,
    email: String,
    global: bool,
) -> IdeResult<()> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.set_user_identity(&name, &email, global))).await
}

#[command(trust = always)]
pub async fn vcs_review_apply_commit(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    request: RequestId,
) -> IdeResult<Option<ApplyCommitReview>> {
    let project = host.project(window)?;
    let cancel = host.begin_project_read_request(window, request);
    let result = blocking(move || project.with_repo_at(repo.as_deref(), |r| r.review_apply_commit(&cancel))).await;
    host.end_request(request);
    result
}

#[command(trust = trusted)]
pub async fn vcs_format_apply_commit(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    checkpoint: String,
    edits: Vec<StagedTextEdit>,
    request: RequestId,
) -> IdeResult<ApplyCommitReview> {
    if edits.iter().any(|edit| edit.text.len() as u64 > ide_vfs::READ_ONLY_THRESHOLD) {
        return Err(ide_core::IdeError::invalid("File is too large"));
    }
    let project = host.project(window)?;
    let cancel = host.begin_project_read_request(window, request);
    let result = blocking(move || {
        project.with_repo_at(repo.as_deref(), |r| {
            r.format_reviewed_apply(&checkpoint, &edits, &cancel, |path, bytes| {
                project.staged_file_encoding(path, bytes)
            })
        })
    })
    .await;
    host.end_request(request);
    result
}

/// Local history operation that may take a while (hooks, large checkouts); git's
/// output streams through `on_output`. Cancellable.
#[command(trust = trusted)]
pub async fn vcs_operation(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    request: RequestId,
    op: GitOperation,
    on_output: Channel<String>,
) -> IdeResult<Option<GitOperationResult>> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    let empty_action = host.global_settings.effective().vcs.git.empty_cherry_pick;
    let cancel = host.begin_request(request);
    let result = tokio::task::spawn_blocking(move || {
        let out = |line: String| {
            let _ = on_output.send(line);
        };
        let empty_result = |count| {
            (count > 0)
                .then_some(GitOperationResult::EmptyCherryPicks { empty_cherry_picks: count, action: empty_action })
        };
        let shelf_batch = match &op {
            GitOperation::RebaseBranch { shelf_batch, .. } | GitOperation::CheckoutRebase { shelf_batch, .. } => {
                shelf_batch.clone()
            }
            _ => None,
        };
        let recorded = match &op {
            GitOperation::CherryPick { .. } => Some("Git cherry-pick"),
            GitOperation::Revert { .. } => Some("Git revert"),
            GitOperation::Reset { .. } => Some("Git reset"),
            GitOperation::InteractiveRebase { .. }
            | GitOperation::CheckoutRebase { .. }
            | GitOperation::RebaseBranch { .. } => Some("Git rebase"),
            GitOperation::DropCommitChanges { .. } => Some("Git drop selected changes"),
            _ => None,
        };
        with_shelf_batch(&project, shelf_batch, || {
            project.with_repo_recorded(repo.as_deref(), recorded, |r| {
                let result = match op {
                    GitOperation::Continue | GitOperation::StageAndContinue => {
                        let stage = matches!(op, GitOperation::StageAndContinue);
                        return r.continue_operation_with(stage, empty_action, &cancel, &out).map(empty_result);
                    }
                    GitOperation::ContinueReviewedApply { checkpoint, message, options } => {
                        return r
                            .continue_reviewed_apply(&checkpoint, &message, &options, empty_action, &cancel, &out)
                            .map(empty_result);
                    }
                    GitOperation::FinishMerge { branch, head, target } => {
                        r.finish_merge(branch.as_deref(), &head, &target, &cancel, &out)
                    }
                    GitOperation::Abort { expected, expected_rebase } => {
                        check_rebase_state(r, expected_rebase.as_ref())?;
                        r.abort_expected_operation(expected.as_deref(), &cancel, &out)
                    }
                    GitOperation::Skip => return r.skip_operation_with(empty_action, &cancel, &out).map(empty_result),
                    GitOperation::CherryPick { commits, record_origin, record_origin_for } => {
                        let options =
                            CherryPickOptions { record_origin, record_origin_for: &record_origin_for, empty_action };
                        return r.cherry_pick_with_options(&commits, options, &cancel, &out).map(empty_result);
                    }
                    GitOperation::Revert { commits } => r.revert(&commits, &cancel, &out),
                    GitOperation::Reset { commit, mode } => r.reset(&commit, mode, &cancel, &out),
                    GitOperation::InteractiveRebase { base, entries } => {
                        r.interactive_rebase(base.as_deref(), &entries, &cancel, &out)
                    }
                    GitOperation::CheckoutRebase { plan, .. } => {
                        return r
                            .checkout_rebase(&plan, &cancel, &out)
                            .map(|rebased| Some(GitOperationResult::Rebased { rebased }));
                    }
                    GitOperation::RebaseBranch { plan, .. } => {
                        return r
                            .rebase_branch(&plan, &cancel, &out)
                            .map(|rebased| Some(GitOperationResult::Rebased { rebased }));
                    }
                    GitOperation::DropCommitChanges { commit, expected_head, paths } => {
                        return r
                            .drop_commit_changes(&commit, &expected_head, &paths, &cancel, &out)
                            .map(|rewrite| Some(GitOperationResult::Rewritten(rewrite)));
                    }
                };
                result.map(|()| None)
            })
        })
    })
    .await
    .map_err(|e| ide_core::IdeError::internal(e.to_string()))?;
    host.end_request(request);
    result
}

#[command(trust = trusted)]
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

#[command(trust = always)]
pub async fn vcs_tags(host: &Host, window: &str, repo: Option<PathBuf>) -> IdeResult<Vec<String>> {
    let project = LogAccess::new(host, window, repo.as_deref());
    blocking(move || project.with_log_repo_at(repo.as_deref(), |r| r.tags())).await
}

/// Merge dialog: merges `branches` into the current branch.
#[command(trust = trusted)]
pub async fn vcs_merge_with(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    branches: Vec<String>,
    options: MergeOptions,
) -> IdeResult<MergeOutcome> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    blocking(move || {
        project.with_repo_recorded(repo.as_deref(), Some("Git merge"), |r| r.merge_attempt(&branches, &options, false))
    })
    .await
}

/// Rebase dialog: rebases a branch onto an upstream, or replays it from the root.
#[command(trust = trusted)]
pub async fn vcs_rebase_with(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    upstream: Option<String>,
    options: RebaseOptions,
) -> IdeResult<()> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    blocking(move || {
        project
            .with_repo_recorded(repo.as_deref(), Some("Git rebase"), |r| r.rebase_with(upstream.as_deref(), &options))
    })
    .await
}

#[allow(clippy::too_many_arguments)]
#[command(trust = trusted)]
pub async fn vcs_rebase_with_editor(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    operation: RebaseEditorOperation,
    request: RequestId,
    on_output: Channel<String>,
    on_edit: Channel<RebaseEditorPrompt>,
    expected_rebase: Option<RebaseState>,
) -> IdeResult<Option<HistoryTip>> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    let cancel = host.begin_project_request(window, request);
    let editors = host.rebase_editors.clone();
    let window = window.to_owned();
    let result = blocking(move || {
        let index = std::cell::Cell::new(0);
        let edit = |edit| {
            let next = index.get() + 1;
            index.set(next);
            editors.wait(&window, request, RebaseEditorPrompt { index: next, edit }, &on_edit, &cancel)
        };
        let out = |line| {
            let _ = on_output.send(line);
        };
        project.with_repo_recorded(repo.as_deref(), Some("Git rebase"), |r| {
            check_rebase_state(r, expected_rebase.as_ref())?;
            r.rebase_editor_operation(operation, &cancel, &out, &edit)?;
            if expected_rebase.is_none() || r.operation()?.is_some() {
                return Ok(None);
            }
            let (branch, tip) = r.head()?;
            Ok(tip.map(|commit| HistoryTip { branch, commit }))
        })
    })
    .await;
    host.end_request(request);
    result
}

fn check_rebase_state(repo: &Repo, expected: Option<&RebaseState>) -> IdeResult<()> {
    if let Some(expected) = expected
        && repo.branch_info()?.rebase.as_ref() != Some(expected)
    {
        return Err(ide_core::IdeError::invalid("The rebase changed before it could be resumed or aborted"));
    }
    Ok(())
}

#[command(trust = trusted)]
pub fn vcs_rebase_editor_reply(
    host: &Host,
    window: &str,
    request: RequestId,
    index: u32,
    reply: Option<RebaseEditorReply>,
) -> IdeResult<()> {
    host.require_trust(window)?;
    host.rebase_editors.reply(window, request, index, reply)
}

/// Whether a revision resolves to an existing Git commit.
#[command(trust = always)]
pub async fn vcs_has_commit(host: &Host, window: &str, repo: Option<PathBuf>, revision: String) -> IdeResult<bool> {
    let project = host.project(window)?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| Ok(r.has_commit(&revision)))).await
}

#[command(trust = always)]
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

#[command(trust = trusted)]
pub async fn vcs_edit_remote(host: &Host, window: &str, repo: Option<PathBuf>, edit: RemoteEdit) -> IdeResult<()> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    blocking(move || {
        project.with_repo_at(repo.as_deref(), |r| r.edit_remote(&edit))?;
        // A linked worktree may share config from outside the project's watched tree.
        project.sink.emit(ide_core::IdeEvent::VcsChanged { root: project.root.clone().into() });
        Ok(())
    })
    .await
}

#[command(trust = always)]
pub async fn vcs_worktrees(host: &Host, window: &str, repo: Option<PathBuf>) -> IdeResult<Vec<Worktree>> {
    let project = host.project(window)?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.worktrees())).await
}

#[derive(Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInclude {
    pub path: ide_core::IpcPath,
    pub exists: bool,
}

#[command(trust = always)]
pub async fn vcs_worktree_include(host: &Host, window: &str, repo: Option<PathBuf>) -> IdeResult<WorktreeInclude> {
    let project = host.project(window)?;
    blocking(move || {
        project.with_repo_at(repo.as_deref(), |r| {
            let (path, exists) = r.worktree_include()?;
            Ok(WorktreeInclude { path: path.into(), exists })
        })
    })
    .await
}

#[command(trust = trusted)]
pub async fn vcs_set_worktree_locked(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    path: PathBuf,
    locked: bool,
) -> IdeResult<()> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    blocking(move || project.with_repo_recorded(repo.as_deref(), None, |r| r.set_worktree_locked(&path, locked))).await
}

#[command(trust = trusted)]
pub async fn vcs_prune_worktrees(host: &Host, window: &str, repo: Option<PathBuf>) -> IdeResult<()> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    blocking(move || {
        let result = project.with_repo_recorded(repo.as_deref(), None, |r| r.prune_worktrees());
        project.refresh_repositories();
        result
    })
    .await
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeSetup {
    pub script: PathBuf,
    pub request: RequestId,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeCreation {
    pub copy_warning: Option<String>,
    pub setup_warning: Option<String>,
}

#[allow(clippy::too_many_arguments)]
#[command(trust = trusted)]
pub async fn vcs_add_worktree(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    path: PathBuf,
    commitish: String,
    new_branch: Option<String>,
    copy_config: Option<bool>,
    setup: Option<WorktreeSetup>,
) -> IdeResult<WorktreeCreation> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    let request = setup.as_ref().map(|setup| setup.request);
    let cancel = request.map(|id| host.begin_project_request(window, id));
    let outcome = blocking(move || {
        if let Some(setup) = &setup
            && (!setup.script.is_absolute() || !setup.script.is_file())
        {
            return Err(ide_core::IdeError::invalid("Choose an absolute path to an existing setup script"));
        }
        let result = project.with_repo_recorded(repo.as_deref(), None, |r| {
            r.add_worktree(&path, &commitish, new_branch.as_deref())?;
            // Setup warnings report partial success without offering to repeat checkout.
            let copy_warning = if copy_config == Some(true) {
                r.copy_worktree_config(&path).err().map(|error| error.to_string())
            } else {
                None
            };
            let setup_warning = setup
                .zip(cancel)
                .and_then(|(setup, cancel)| super::worktree_setup::run(&setup.script, &r.root().join(path), &cancel));
            Ok(WorktreeCreation { copy_warning, setup_warning })
        });
        // A worktree below the project is a new repository: rescan so its files
        // join the status and gutter queries (the watcher picks the gitfile up
        // too, but only as a debounced event later).
        project.refresh_repositories();
        result
    })
    .await;
    if let Some(request) = request {
        host.end_request(request);
    }
    outcome
}

#[command(trust = trusted)]
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

#[command(trust = trusted)]
pub async fn vcs_move_worktree(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    path: PathBuf,
    to: PathBuf,
) -> IdeResult<()> {
    // Move Worktree…: moves the linked worktree at `path` to `to`.
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

#[command(trust = always)]
pub async fn vcs_compare_scope(host: &Host, window: &str, paths: Vec<PathBuf>) -> IdeResult<CompareScope> {
    let project = host.project(window)?;
    blocking(move || Ok(project.repos().compare_scope(&paths))).await
}

#[command(trust = always)]
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
    let result =
        blocking(move || project.repos().compare_paths(&paths, &revision, repositories.as_deref(), &cancel)).await;
    host.end_request(request);
    result
}

/// Compare with Local: tracked files that differ between `rev` and the working tree.
#[command(trust = always)]
pub async fn vcs_diff_with_worktree(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    rev: String,
) -> IdeResult<Vec<ChangedFile>> {
    let project = LogAccess::new(host, window, repo.as_deref());
    blocking(move || project.with_log_backend_at(repo.as_deref(), |r| r.diff_with_worktree(&rev))).await
}

/// Files that differ between two revisions (the "N files updated" of Update Project).
#[command(trust = always)]
pub async fn vcs_diff_revisions(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    from: String,
    to: String,
) -> IdeResult<Vec<ChangedFile>> {
    let project = LogAccess::new(host, window, repo.as_deref());
    blocking(move || project.with_log_backend_at(repo.as_deref(), |r| r.diff_revisions(&from, &to))).await
}

/// Added and deleted lines between two revisions (Git Log › lines added and deleted).
/// `paths` limits the diff to those repository-relative paths; empty diffs every file.
#[command(trust = always)]
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
#[command(trust = always)]
pub async fn vcs_has_hook(host: &Host, window: &str, repo: Option<PathBuf>, name: String) -> IdeResult<bool> {
    let project = host.project(window)?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.has_hook(&name))).await
}

/// The best common ancestor of `a` and `b` (`git merge-base`), if any.
#[command(trust = always)]
pub async fn vcs_merge_base(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    a: String,
    b: String,
) -> IdeResult<Option<String>> {
    // The New Pull Request tab's three-dot diff.
    let project = host.project(window)?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.merge_base(&a, &b))).await
}

#[command(trust = trusted)]
pub async fn vcs_create_patch(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    source: PatchSource,
    base: Option<PathBuf>,
) -> IdeResult<String> {
    let project = host.project(window)?;
    blocking(move || {
        let base = base.map(|base| patch_export_base(&project, base)).transpose()?;
        let base = base.as_deref();
        match source {
            PatchSource::Changes { paths, reverse } => {
                let paths: Vec<PathBuf> = paths.into_iter().map(Into::into).collect();
                if repo.is_some() || base.is_none() {
                    return project.with_repo_at(repo.as_deref(), |r| {
                        export_patch(r.create_patch(&paths, reverse)?, r.root(), base)
                    });
                }
                let groups = project.repos().group(&paths);
                if groups.is_empty() || groups.iter().map(|(_, paths)| paths.len()).sum::<usize>() != paths.len() {
                    return Err(ide_core::IdeError::invalid("The selected files must belong to Git repositories"));
                }
                let mut patch = String::new();
                for (repo, paths) in groups {
                    patch.push_str(&project.with_repo_at(Some(repo.root()), |r| {
                        export_patch(r.create_patch(&paths, reverse)?, r.root(), base)
                    })?);
                }
                Ok(patch)
            }
            PatchSource::Staging { entries, reverse } => create_staging_patch(&project, entries, reverse, base),
            PatchSource::Commits { commits, reverse } => project.with_repo_at(repo.as_deref(), |r| {
                export_patch(r.create_commits_patch(&commits, reverse)?, r.root(), base)
            }),
            PatchSource::Revisions { before, after, paths } => project.with_repo_at(repo.as_deref(), |r| {
                export_patch(r.create_revisions_patch(&before, &after, &paths)?, r.root(), base)
            }),
        }
    })
    .await
}

#[command(trust = trusted)]
pub async fn vcs_pending_patch(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    options: CommitOptions,
) -> IdeResult<String> {
    // The changes a commit with `options` would make in `repo`, as one patch (what Commit
    // commits: the index with the selection applied, partial files' chosen hunks only).
    const MAX_PATCH: usize = 1 << 20;
    let project = host.project(window)?;
    blocking(move || {
        project.with_repo_at(repo.as_deref(), |r| {
            let changes = r.pending_changes(&options, MAX_PATCH, &|path| project.vcs_encoding(path, None))?;
            Ok(changes.into_iter().filter_map(|c| c.diff).collect())
        })
    })
    .await
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum PatchTarget {
    Project,
    Repository,
}

#[derive(Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PatchPreview {
    pub files: Vec<PatchFile>,
    pub base: Option<IpcPath>,
    pub placements: Option<Vec<PatchPlacement>>,
    pub directory_matches: Vec<PatchDirectoryMatches>,
    pub automatic_mappings: Vec<PatchPathMapping>,
}

fn mapped_patch(
    project: &Project,
    repo: Option<&Path>,
    base: Option<&Path>,
    patch: &str,
    paths: Option<&[String]>,
    mappings: &[PatchPathMapping],
) -> IdeResult<MappedPatch> {
    if base.is_some_and(|base| !base.is_absolute() || !project.root.starts_with(base)) {
        return Err(ide_core::IdeError::invalid("The patch base is outside the project"));
    }
    MappedPatch::new(&project.repos(), repo, base, patch, paths, mappings)
}

#[command(trust = trusted)]
pub async fn vcs_patch_preview(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    patch: String,
    target: Option<PatchTarget>,
    mappings: Option<Vec<PatchPathMapping>>,
) -> IdeResult<PatchPreview> {
    let project = host.project(window)?;
    blocking(move || {
        let repos = project.repos();
        let plan = if target != Some(PatchTarget::Repository) && (repos.all().len() > 1 || target.is_some()) {
            ProjectPatch::discover(&repos, &project.root, &patch, target.is_none())?
        } else {
            None
        };
        let base = plan
            .as_ref()
            .map(|plan| plan.base.as_path())
            .or_else(|| (target == Some(PatchTarget::Project)).then_some(project.root.as_path()));
        let default = match repo.as_deref() {
            Some(root) => repos.at_root(root),
            None => repos.primary(),
        }
        .ok_or_else(|| ide_core::IdeError::unavailable("The patch repository is not in the project"))?;
        let overrides = mappings.as_deref().unwrap_or(&[]);
        let (directory_matches, automatic_mappings) = discover_patch_directories(
            &repos,
            PatchDirectoryScope {
                repo: default,
                base,
                only_repository: target == Some(PatchTarget::Repository),
                automatic: target.is_none() && !project.index.status().indexing,
            },
            &patch,
            overrides,
            |names| project.index.files_with_names(names),
            |names| project.index.directories_with_names(names),
        )?;
        if mappings.is_some() || !automatic_mappings.is_empty() || (plan.is_none() && base.is_some()) {
            let effective: Vec<_> = overrides.iter().chain(&automatic_mappings).cloned().collect();
            let mut mapped = mapped_patch(&project, repo.as_deref(), base, &patch, None, &effective)?;
            for group in &mapped.groups {
                project.with_repo_at(Some(&group.group.root), |r| group.preview(r, &mut mapped.files))?;
            }
            return Ok(PatchPreview {
                files: mapped.files,
                base: base.map(Into::into),
                placements: Some(mapped.placements),
                directory_matches,
                automatic_mappings,
            });
        }
        if let Some(plan) = plan {
            let mut files = Vec::new();
            for group in plan.groups {
                files.extend(project.with_repo_at(Some(&group.root), |r| group.preview(r))?);
            }
            return Ok(PatchPreview {
                files,
                base: Some(plan.base.into()),
                placements: None,
                directory_matches,
                automatic_mappings,
            });
        }
        let files = project.with_repo_at(repo.as_deref(), |r| r.patch_preview(&patch))?;
        Ok(PatchPreview { files, base: None, placements: None, directory_matches, automatic_mappings })
    })
    .await
}

#[command(trust = trusted)]
pub async fn vcs_patch_file_diff(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    base: Option<PathBuf>,
    patch: String,
    path: String,
    mappings: Option<Vec<PatchPathMapping>>,
) -> IdeResult<PatchFileDiff> {
    let project = host.project(window)?;
    blocking(move || {
        let encoding = |path: &Path, bytes: &[u8]| project.staged_file_encoding(path, bytes);
        if let Some(mappings) = mappings {
            let plan = mapped_patch(
                &project,
                repo.as_deref(),
                base.as_deref(),
                &patch,
                Some(std::slice::from_ref(&path)),
                &mappings,
            )?;
            plan.require_destinations()?;
            let group =
                plan.groups.first().ok_or_else(|| ide_core::IdeError::invalid("The patch file has no repository"))?;
            return project.with_repo_at(Some(&group.group.root), |r| group.file_diff(r, &encoding));
        }
        if let Some(base) = base {
            let plan = ProjectPatch::at_base(
                &project.repos(),
                &project.root,
                &base,
                &patch,
                Some(std::slice::from_ref(&path)),
            )?;
            let group =
                plan.groups.first().ok_or_else(|| ide_core::IdeError::invalid("The patch file has no repository"))?;
            return project.with_repo_at(Some(&group.root), |r| group.file_diff(r, &path, &encoding));
        }
        project.with_repo_at(repo.as_deref(), |r| r.patch_file_diff(&patch, &path, &encoding))
    })
    .await
}

#[command(trust = trusted)]
pub async fn vcs_apply_patch(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    patch: String,
    paths: Option<Vec<String>>,
) -> IdeResult<ApplyOutcome> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    blocking(move || {
        project.with_repo_recorded(repo.as_deref(), None, |r| match paths {
            Some(paths) => r.apply_selected_patch(&patch, &paths),
            None => r.apply_patch(&patch),
        })
    })
    .await
}

#[derive(Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectPatchFailure {
    pub root: IpcPath,
    pub error: ide_core::IdeError,
}

#[derive(Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectPatchOutcome {
    pub outcome: ApplyOutcome,
    pub conflicted_repositories: Vec<IpcPath>,
    pub failures: Vec<ProjectPatchFailure>,
}

fn apply_patch_groups<T>(
    project: &Project,
    groups: Vec<T>,
    root: impl Fn(&T) -> &Path,
    apply: impl Fn(&T, &Repo) -> IdeResult<ApplyOutcome>,
) -> IdeResult<ProjectPatchOutcome> {
    project.with_disk_sync(|| {
        let mut outcome = ApplyOutcome::default();
        let mut conflicted_repositories = Vec::new();
        let mut failures = Vec::new();
        for group in groups {
            let root = root(&group);
            match project.with_repo_at(Some(root), |repo| apply(&group, repo)) {
                Ok(result) => {
                    if !result.conflicts.is_empty() {
                        conflicted_repositories.push(root.into());
                    }
                    outcome.applied.extend(result.applied);
                    outcome.conflicts.extend(result.conflicts);
                }
                Err(error) => failures.push(ProjectPatchFailure { root: root.into(), error }),
            }
        }
        Ok(ProjectPatchOutcome { outcome, conflicted_repositories, failures })
    })
}

#[command(trust = trusted)]
pub async fn vcs_apply_project_patch(
    host: &Host,
    window: &str,
    base: PathBuf,
    patch: String,
    paths: Option<Vec<String>>,
) -> IdeResult<ProjectPatchOutcome> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    blocking(move || {
        let plan = ProjectPatch::at_base(&project.repos(), &project.root, &base, &patch, paths.as_deref())?;
        apply_patch_groups(&project, plan.groups, |group| &group.root, |group, repo| group.apply(repo))
    })
    .await
}

#[command(trust = trusted)]
pub async fn vcs_apply_mapped_patch(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    base: Option<PathBuf>,
    patch: String,
    paths: Option<Vec<String>>,
    mappings: Vec<PatchPathMapping>,
) -> IdeResult<ProjectPatchOutcome> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    blocking(move || {
        let plan = mapped_patch(&project, repo.as_deref(), base.as_deref(), &patch, paths.as_deref(), &mappings)?;
        plan.require_destinations()?;
        apply_patch_groups(&project, plan.groups, |group| &group.group.root, |group, repo| group.apply(repo))
    })
    .await
}

/// Shelve Changes: saves the changes of `paths` as a patch on the shelf and reverts them.
#[command(trust = trusted)]
pub async fn vcs_shelve(host: &Host, window: &str, name: String, paths: Vec<PathBuf>) -> IdeResult<ShelvedChangeList> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    blocking(move || {
        let groups = project.repos().group(&paths);
        if groups.is_empty() || groups.iter().map(|(_, selected)| selected.len()).sum::<usize>() != paths.len() {
            return Err(ide_core::IdeError::invalid("select files in a git repository to shelve"));
        }
        let shelf = shelf_dir(&project.root);
        if let [(repo, selected)] = groups.as_slice() {
            keep_private(&project.root);
            return project
                .with_repo_recorded(Some(repo.root()), Some("Shelve"), |r| r.shelve(&shelf, &name, selected));
        }
        let base = project
            .root
            .ancestors()
            .find(|base| groups.iter().all(|(repo, _)| repo.root().starts_with(base)))
            .ok_or_else(|| ide_core::IdeError::invalid("The shelf repositories have no common directory"))?;
        let captures = groups
            .iter()
            .map(|(repo, selected)| {
                project.with_repo_at(Some(repo.root()), |r| ide_vcs::shelf::ShelfCapture::capture(r, base, selected))
            })
            .collect::<IdeResult<Vec<_>>>()?;
        let entry = ide_vcs::shelf::save_combined(&shelf, base, &name, &captures)?;
        for capture in &captures {
            project.with_repo_recorded(Some(capture.repository()), Some("Shelve"), |r| capture.revert(r))?;
        }
        Ok(entry)
    })
    .await
}

#[command(trust = always)]
pub async fn vcs_shelves(host: &Host, window: &str) -> IdeResult<Vec<ShelvedChangeList>> {
    let project = host.project(window)?;
    blocking(move || {
        let mut shelves = ide_vcs::shelf::list(&shelf_dir(&project.root))?;
        let primary = project.repos().primary().map(|r| ide_core::IpcPath::from(r.root().to_path_buf()));
        for entry in &mut shelves {
            if entry.repo.is_none() {
                entry.repo = primary.clone();
            }
        }
        Ok(shelves)
    })
    .await
}

/// Unshelve: applies the shelved patch (3-way merging; conflicts are left for the
/// merge UI); with `remove`, deletes it from the shelf.
#[command(trust = trusted)]
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
        let shelf = shelf_dir(&project.root);
        let selections = ide_vcs::shelf::selections(&shelf, &id, path.as_deref())?;
        for selection in &selections {
            project.with_repo_at(selection.repo.as_deref(), |_| Ok(()))?;
        }
        let mut result = ApplyOutcome { applied: Vec::new(), conflicts: Vec::new() };
        for selection in &selections {
            let outcome =
                project.with_repo_recorded(selection.repo.as_deref(), Some("Unshelve"), |r| selection.apply(r))?;
            if remove && outcome.conflicts.is_empty() {
                ide_vcs::shelf::delete_paths(&shelf, &id, &outcome.applied)?;
            }
            result.applied.extend(outcome.applied);
            result.conflicts.extend(outcome.conflicts);
        }
        Ok(result)
    })
    .await
}

#[command(trust = trusted)]
pub async fn vcs_shelf_delete(host: &Host, window: &str, id: String, path: Option<String>) -> IdeResult<()> {
    let project = host.project(window)?;
    blocking(move || ide_vcs::shelf::delete_path(&shelf_dir(&project.root), &id, path.as_deref())).await
}

#[command(trust = trusted)]
pub async fn vcs_shelf_rename(host: &Host, window: &str, id: String, name: String) -> IdeResult<()> {
    let project = host.project(window)?;
    blocking(move || ide_vcs::shelf::rename(&shelf_dir(&project.root), &id, &name)).await
}

#[command(trust = always)]
pub async fn vcs_shelf_patch(
    host: &Host,
    window: &str,
    id: String,
    path: Option<String>,
    base: Option<PathBuf>,
) -> IdeResult<String> {
    let project = host.project(window)?;
    blocking(move || {
        let shelf = shelf_dir(&project.root);
        let Some(base) = base else { return ide_vcs::shelf::selected_patch(&shelf, &id, path.as_deref()) };
        let base = patch_export_base(&project, base)?;
        let repos = project.repos();
        let fallback = repos.primary().map_or(project.root.as_path(), |repo| repo.root());
        let mut patch = String::new();
        for selection in ide_vcs::shelf::selections(&shelf, &id, path.as_deref())? {
            patch.push_str(&selection.export(fallback, &base)?);
        }
        Ok(patch)
    })
    .await
}

#[command(trust = trusted)]
pub async fn vcs_shelf_diff(host: &Host, window: &str, id: String) -> IdeResult<Vec<ide_vcs::shelf::ShelfDiffFile>> {
    let project = host.project(window)?;
    blocking(move || {
        let shelf = shelf_dir(&project.root);
        let mut files = Vec::new();
        for selection in ide_vcs::shelf::selections(&shelf, &id, None)? {
            files.extend(project.with_repo_at(selection.repo.as_deref(), |r| selection.diff_files(r))?);
        }
        Ok(files)
    })
    .await
}

#[command(trust = trusted)]
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

#[command(trust = always)]
pub async fn vcs_changelists_load(host: &Host, window: &str) -> IdeResult<ChangelistState> {
    let project = host.project(window)?;
    blocking(move || Ok(ide_vcs::changelists::load(&ide_core::project_dir::path(&project.root, "changelists.json"))))
        .await
}

// Synchronous on purpose: the UI saves without waiting (debounced), and on the main thread
// the saves land in order, so an older state can't overwrite a newer one.
#[command(trust = trusted)]
pub fn vcs_changelists_save(host: &Host, window: &str, changelists: ChangelistState) -> IdeResult<()> {
    let project = host.project(window)?;
    keep_private(&project.root);
    ide_vcs::changelists::save(&ide_core::project_dir::path(&project.root, "changelists.json"), &changelists)
}

/// Create Patch › Save to file.
#[command(trust = always)]
pub async fn vcs_write_patch(
    host: &Host,
    window: &str,
    path: PathBuf,
    patch: String,
    encoding: Option<String>,
) -> IdeResult<()> {
    let project = host.project(window).ok();
    blocking(move || {
        let write = || {
            let bytes = match encoding.as_deref() {
                Some(encoding) => ide_vfs::encode(
                    &patch,
                    encoding,
                    matches!(encoding.trim().to_ascii_lowercase().as_str(), "utf-16" | "utf-16le" | "utf-16be"),
                )?,
                None => patch.into_bytes(),
            };
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir)?;
            }
            ide_vfs::write_atomic_strict(&path, &bytes)?;
            Ok(())
        };
        match project {
            Some(project) => project.with_disk_sync(write),
            None => write(),
        }
    })
    .await
}

/// Reads a patch without normalizing its hunk line endings.
#[command(trust = always)]
pub async fn vcs_read_patch(host: &Host, window: &str, path: PathBuf) -> IdeResult<String> {
    let project = host.project(window).ok();
    blocking(move || {
        if let Some(project) = project {
            if let Some(doc) = project.documents.by_path(&path)
                && project.documents.is_dirty(doc)?
            {
                return Ok(project.documents.text_snapshot(doc)?.text);
            }
            return Ok(project.documents.load_file(&path)?.text);
        }
        Ok(ide_vfs::load_text(&path)?.text)
    })
    .await
}

ide_command::domain!(
    vcs_commands:
    vcs_add_to_ignore,
    vcs_add_worktree,
    vcs_apply_patch,
    vcs_apply_project_patch,
    vcs_apply_mapped_patch,
    vcs_blame,
    vcs_block_history,
    vcs_branch_info,
    vcs_check_incoming,
    vcs_branches,
    vcs_changelists_load,
    vcs_changelists_save,
    vcs_checkout,
    vcs_checkout_affected_files,
    vcs_clone,
    vcs_commit,
    vcs_keep_amend_commit,
    vcs_commit_crlf_paths,
    vcs_commit_files,
    vcs_commit_large_files,
    vcs_preview_partial_commit,
    vcs_commits_changes,
    vcs_commit_selection_changes,
    vcs_compare_paths,
    vcs_compare_scope,
    vcs_config_get,
    vcs_config_get_bool,
    vcs_signing_config,
    vcs_gpg_signing_keys,
    vcs_edit_signing,
    vcs_watch_commit_messages,
    vcs_set_user_identity,
    vcs_conflict_versions,
    vcs_accept_conflict_side,
    vcs_revert_resolved,
    vcs_create_branch,
    vcs_undo_branch_creation,
    vcs_create_patch,
    vcs_create_tag,
    vcs_delete_branch,
    vcs_delete_tracking_branch,
    vcs_delete_merged_branch,
    vcs_delete_tag,
    vcs_detected_git,
    vcs_diff_hunks,
    vcs_diff_numstat,
    vcs_diff_revisions,
    vcs_diff_text,
    vcs_diff_with_worktree,
    vcs_finish_shelf_batch,
    vcs_discard,
    vcs_edit_remote,
    vcs_file_at,
    vcs_file_mode,
    vcs_diff_entries,
    vcs_git_version,
    vcs_has_hook,
    vcs_ignore_blame_revision,
    vcs_init,
    vcs_line_hunks,
    vcs_staging_line_hunks,
    vcs_log,
    vcs_log_details,
    vcs_log_details_batch,
    vcs_invalidate_log_signatures,
    vcs_log_refs,
    vcs_log_users,
    vcs_merge,
    vcs_merge_affected_files,
    vcs_merge_base,
    vcs_merge_with,
    vcs_move_worktree,
    vcs_not_cherry_picked,
    vcs_open_external_log,
    vcs_review_apply_commit,
    vcs_format_apply_commit,
    vcs_operation,
    vcs_patch_preview,
    vcs_patch_file_diff,
    vcs_pending_patch,
    vcs_rebase,
    vcs_rebase_with,
    vcs_rebase_with_editor,
    vcs_rebase_editor_reply,
    vcs_has_commit,
    vcs_remote,
    vcs_default_push_target,
    vcs_commit_push_target,
    vcs_project_update_plan,
    vcs_push_target_choices,
    vcs_inspect_push,
    vcs_update_branches,
    vcs_remotes,
    vcs_remove_worktree,
    vcs_rename_branch,
    vcs_restore_branch,
    vcs_restore_head,
    vcs_restore_tag,
    vcs_revision_children,
    vcs_revision_files,
    vcs_reword,
    vcs_extract_commit_changes,
    vcs_roots,
    vcs_detected_roots,
    vcs_shelf_delete,
    vcs_shelf_diff,
    vcs_shelf_import,
    vcs_shelf_patch,
    vcs_shelf_rename,
    vcs_shelve,
    vcs_shelves,
    vcs_stage,
    vcs_stage_without_content,
    vcs_stage_formatted_text,
    vcs_staged_text,
    vcs_save_staged_text,
    vcs_stage_hunks,
    vcs_stage_patch,
    vcs_stash_apply,
    vcs_stash_drop,
    vcs_stash_clear,
    vcs_stash_push,
    vcs_stashes,
    vcs_tags,
    vcs_undo_commit,
    vcs_unshelve,
    vcs_unstage,
    vcs_restore_unstaged,
    vcs_rollback_submodules,
    vcs_worktree_include,
    vcs_worktrees,
    vcs_set_worktree_locked,
    vcs_prune_worktrees,
    vcs_write_patch,
    vcs_read_patch,
);
