//! Perforce commands: what a workspace offers beyond the Changes-view surface
//! shared with Git (`vcs_status`, `vcs_commit`, `vcs_discard`, diff, log and
//! annotate reach Perforce through `ide_vcs::Backend`).

use crate::{Host, Project};
use ide_command::command;
use ide_core::{IdeError, IdeResult};
use ide_p4::{
    Connection, IntegrateKind, Job, LoginStatus, OperationResult, PendingChangelist, ResolveMode, ResolveSides,
    ShelvedFile, UnresolvedFile, Workspace,
};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// A Perforce workspace of the project.
#[derive(Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct P4WorkspaceInfo {
    pub root: ide_core::IpcPath,
    pub connection: Connection,
}

/// The `p4` executable in use.
#[derive(Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct P4Executable {
    pub path: Option<ide_core::IpcPath>,
    pub version: Option<String>,
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> IdeResult<T> + Send + 'static) -> IdeResult<T> {
    tokio::task::spawn_blocking(f).await.map_err(|e| IdeError::internal(e.to_string()))?
}

/// The workspace rooted at `root`, else the one holding all of `paths`, else the project's own.
fn workspace(project: &Project, root: Option<&Path>, paths: &[PathBuf]) -> IdeResult<Arc<Workspace>> {
    project.require_trust()?;
    if let Some(root) = root {
        return project.p4_workspaces().into_iter().find(|w| w.root() == root).ok_or_else(|| {
            IdeError::unavailable(format!("{} is not a Perforce workspace of the project", root.display()))
        });
    }
    let Some(first) = paths.first() else {
        return project
            .p4_workspaces()
            .into_iter()
            .next()
            .ok_or_else(|| IdeError::unavailable("project is not in a Perforce workspace"));
    };
    let found = project
        .p4_workspace_of(first)
        .ok_or_else(|| IdeError::unavailable(format!("{} is not in a Perforce workspace", first.display())))?;
    if paths.iter().any(|p| !p.starts_with(found.root())) {
        return Err(IdeError::invalid("select files of a single Perforce workspace"));
    }
    Ok(found)
}

/// Runs a command that changes what is opened, then tells the UI to read the changes again.
async fn mutate<T: Send + 'static>(
    host: &Host,
    window: &str,
    root: Option<PathBuf>,
    paths: Vec<PathBuf>,
    recorded: Option<&'static str>,
    f: impl FnOnce(&Workspace, &[PathBuf]) -> IdeResult<T> + Send + 'static,
) -> IdeResult<T> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    blocking(move || {
        let workspace = workspace(&project, root.as_deref(), &paths)?;
        let result = match recorded {
            Some(name) => project.with_p4_recorded(&workspace, Some(name), |w| f(w, &paths)),
            None => f(&workspace, &paths),
        };
        project.vcs_changed();
        result
    })
    .await
}

async fn read<T: Send + 'static>(
    host: &Host,
    window: &str,
    root: Option<PathBuf>,
    paths: Vec<PathBuf>,
    f: impl FnOnce(&Workspace, &[PathBuf]) -> IdeResult<T> + Send + 'static,
) -> IdeResult<T> {
    let project = host.project(window)?;
    blocking(move || f(workspace(&project, root.as_deref(), &paths)?.as_ref(), &paths)).await
}

/// The Perforce workspaces of the project.
#[command(trust = trusted)]
pub fn p4_workspaces(host: &Host, window: &str) -> IdeResult<Vec<P4WorkspaceInfo>> {
    let project = host.project(window)?;
    Ok(project
        .p4_workspaces()
        .iter()
        .map(|w| P4WorkspaceInfo { root: w.root().to_path_buf().into(), connection: w.connection().clone() })
        .collect())
}

/// The `p4` found on this machine and its version, for Settings › Version Control › Perforce.
#[command(trust = trusted)]
pub async fn p4_executable(_host: &Host) -> IdeResult<P4Executable> {
    blocking(|| {
        Ok(P4Executable { path: ide_p4::detected_executable().map(Into::into), version: ide_p4::version().ok() })
    })
    .await
}

#[command(trust = trusted)]
pub async fn p4_login_status(host: &Host, window: &str, root: Option<PathBuf>) -> IdeResult<LoginStatus> {
    read(host, window, root, Vec::new(), |w, _| w.login_status()).await
}

#[command(trust = trusted)]
pub async fn p4_login(host: &Host, window: &str, root: Option<PathBuf>, password: String) -> IdeResult<LoginStatus> {
    mutate(host, window, root, Vec::new(), None, move |w, _| w.login(&password)).await
}

#[command(trust = trusted)]
pub async fn p4_logout(host: &Host, window: &str, root: Option<PathBuf>) -> IdeResult<()> {
    mutate(host, window, root, Vec::new(), None, |w, _| w.logout()).await
}

/// The default changelist and the numbered pending ones, with their files.
#[command(trust = trusted)]
pub async fn p4_changelists(host: &Host, window: &str, root: Option<PathBuf>) -> IdeResult<Vec<PendingChangelist>> {
    read(host, window, root, Vec::new(), |w, _| w.changelists()).await
}

/// Makes a pending changelist holding `paths` (opened files); returns its number.
#[command(trust = trusted)]
pub async fn p4_changelist_create(
    host: &Host,
    window: &str,
    root: Option<PathBuf>,
    description: String,
    paths: Vec<PathBuf>,
) -> IdeResult<u32> {
    mutate(host, window, root, paths, None, move |w, paths| w.create_changelist(&description, paths)).await
}

#[command(trust = trusted)]
pub async fn p4_changelist_update(
    host: &Host,
    window: &str,
    root: Option<PathBuf>,
    change: u32,
    description: String,
) -> IdeResult<()> {
    mutate(host, window, root, Vec::new(), None, move |w, _| w.update_changelist(change, &description)).await
}

#[command(trust = trusted)]
pub async fn p4_changelist_delete(host: &Host, window: &str, root: Option<PathBuf>, change: u32) -> IdeResult<()> {
    mutate(host, window, root, Vec::new(), None, move |w, _| w.delete_changelist(change)).await
}

/// Moves opened files to another changelist (0 = default).
#[command(trust = trusted)]
pub async fn p4_reopen(host: &Host, window: &str, paths: Vec<PathBuf>, change: u32) -> IdeResult<()> {
    mutate(host, window, None, paths, None, move |w, paths| w.reopen(paths, change)).await
}

/// Opens files for edit (new files for add) in `change`.
#[command(trust = trusted)]
pub async fn p4_edit(
    host: &Host,
    window: &str,
    paths: Vec<PathBuf>,
    change: Option<u32>,
) -> IdeResult<OperationResult> {
    mutate(host, window, None, paths, None, move |w, paths| w.open_for_edit(paths, change)).await
}

#[command(trust = trusted)]
pub async fn p4_add(host: &Host, window: &str, paths: Vec<PathBuf>, change: Option<u32>) -> IdeResult<OperationResult> {
    mutate(host, window, None, paths, None, move |w, paths| w.add(paths, change)).await
}

/// Opens files for delete; they leave the workspace.
#[command(trust = trusted)]
pub async fn p4_delete(
    host: &Host,
    window: &str,
    paths: Vec<PathBuf>,
    change: Option<u32>,
) -> IdeResult<OperationResult> {
    mutate(host, window, None, paths, Some("Perforce Delete"), move |w, paths| w.delete(paths, change)).await
}

/// Reverts opened files that did not change, in one changelist or (`None`) everywhere.
#[command(trust = trusted)]
pub async fn p4_revert_unchanged(
    host: &Host,
    window: &str,
    root: Option<PathBuf>,
    change: Option<u32>,
) -> IdeResult<OperationResult> {
    mutate(host, window, root, Vec::new(), None, move |w, _| w.revert_unchanged(change)).await
}

/// Syncs `paths` (empty = the workspace) to `rev` (`None` = head). With `preview`, reports only.
#[command(trust = trusted)]
pub async fn p4_sync(
    host: &Host,
    window: &str,
    root: Option<PathBuf>,
    paths: Vec<PathBuf>,
    rev: Option<String>,
    force: bool,
    preview: bool,
) -> IdeResult<OperationResult> {
    let recorded = (!preview).then_some("Perforce Sync");
    mutate(host, window, root, paths, recorded, move |w, paths| w.sync(paths, rev.as_deref(), force, preview)).await
}

/// Finds files changed outside Perforce below `paths` (empty = the workspace) and, unless
/// `preview`, opens them.
#[command(trust = trusted)]
pub async fn p4_reconcile(
    host: &Host,
    window: &str,
    root: Option<PathBuf>,
    paths: Vec<PathBuf>,
    change: Option<u32>,
    preview: bool,
) -> IdeResult<OperationResult> {
    mutate(host, window, root, paths, None, move |w, paths| w.reconcile(paths, change, preview)).await
}

/// Submits a pending changelist (0 = default, which needs `description`); returns its final number.
#[command(trust = trusted)]
pub async fn p4_submit(
    host: &Host,
    window: &str,
    root: Option<PathBuf>,
    change: u32,
    description: Option<String>,
) -> IdeResult<u32> {
    mutate(host, window, root, Vec::new(), None, move |w, _| w.submit_change(change, description.as_deref())).await
}

/// Shelves files of a numbered changelist (`paths` empty = all of them).
#[command(trust = trusted)]
pub async fn p4_shelve(
    host: &Host,
    window: &str,
    root: Option<PathBuf>,
    change: u32,
    paths: Vec<PathBuf>,
) -> IdeResult<OperationResult> {
    mutate(host, window, root, paths, None, move |w, paths| w.shelve(change, paths)).await
}

#[command(trust = trusted)]
pub async fn p4_shelved_files(
    host: &Host,
    window: &str,
    root: Option<PathBuf>,
    change: u32,
) -> IdeResult<Vec<ShelvedFile>> {
    read(host, window, root, Vec::new(), move |w, _| w.shelved_files(change)).await
}

/// Restores shelved files of `source` into `target` (`None` = the changelist they were shelved from).
#[command(trust = trusted)]
pub async fn p4_unshelve(
    host: &Host,
    window: &str,
    root: Option<PathBuf>,
    source: u32,
    target: Option<u32>,
    depot_files: Vec<String>,
    force: bool,
) -> IdeResult<OperationResult> {
    mutate(host, window, root, Vec::new(), Some("Perforce Unshelve"), move |w, _| {
        w.unshelve(source, target, &depot_files, force)
    })
    .await
}

/// Deletes shelved files of a changelist (`depot_files` empty = its whole shelf).
#[command(trust = trusted)]
pub async fn p4_shelf_delete(
    host: &Host,
    window: &str,
    root: Option<PathBuf>,
    change: u32,
    depot_files: Vec<String>,
) -> IdeResult<()> {
    mutate(host, window, root, Vec::new(), None, move |w, _| w.delete_shelf(change, &depot_files)).await
}

/// Files waiting for a resolve.
#[command(trust = trusted)]
pub async fn p4_unresolved(host: &Host, window: &str, root: Option<PathBuf>) -> IdeResult<Vec<UnresolvedFile>> {
    read(host, window, root, Vec::new(), |w, _| w.unresolved(&[])).await
}

/// Resolves `paths` (empty = everything unresolved) the way `mode` says.
#[command(trust = trusted)]
pub async fn p4_resolve(
    host: &Host,
    window: &str,
    root: Option<PathBuf>,
    paths: Vec<PathBuf>,
    mode: ResolveMode,
) -> IdeResult<OperationResult> {
    mutate(host, window, root, paths, Some("Perforce Resolve"), move |w, paths| w.resolve(paths, mode)).await
}

/// The base, depot and workspace texts of a file's pending resolve, for the merge view.
#[command(trust = trusted)]
pub async fn p4_resolve_sides(host: &Host, window: &str, path: PathBuf) -> IdeResult<ResolveSides> {
    let project = host.project(window)?;
    blocking(move || {
        let encoding = project.vcs_encoding(&path, None)?;
        workspace(&project, None, std::slice::from_ref(&path))?.resolve_sides(&path, encoding)
    })
    .await
}

/// Finishes a resolve with the text merged in the IDE.
#[command(trust = trusted)]
pub async fn p4_resolve_with(host: &Host, window: &str, path: PathBuf, text: String) -> IdeResult<()> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    blocking(move || {
        let charset = project.vcs_encoding(&path, None)?.charset;
        let (bytes, _, unmappable) = charset.encode(&text);
        if unmappable {
            return Err(IdeError::invalid(format!("the merged text has characters {} cannot hold", charset.name())));
        }
        let workspace = workspace(&project, None, std::slice::from_ref(&path))?;
        let result = project.with_p4_recorded(&workspace, Some("Perforce Resolve"), |w| w.resolve_with(&path, &bytes));
        project.vcs_changed();
        result
    })
    .await
}

/// What `p4_integrate` does: `source` into `target` (depot or local file arguments).
#[derive(Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct P4Integration {
    pub kind: IntegrateKind,
    pub source: String,
    pub target: String,
    /// The changelist receiving the opened files (`None` = default).
    pub change: Option<u32>,
    /// Report what would be opened, without opening it.
    pub preview: bool,
}

/// Integrates, merges or copies between two paths (or, on a stream client, from the parent stream).
#[command(trust = trusted)]
pub async fn p4_integrate(
    host: &Host,
    window: &str,
    root: Option<PathBuf>,
    integration: P4Integration,
) -> IdeResult<OperationResult> {
    let recorded = (!integration.preview).then_some("Perforce Integrate");
    mutate(host, window, root, Vec::new(), recorded, move |w, _| {
        let P4Integration { kind, source, target, change, preview } = integration;
        w.integrate(kind, &source, &target, change, preview)
    })
    .await
}

#[command(trust = trusted)]
pub async fn p4_lock(host: &Host, window: &str, paths: Vec<PathBuf>, locked: bool) -> IdeResult<OperationResult> {
    mutate(host, window, None, paths, None, move |w, paths| w.lock(paths, locked)).await
}

#[command(trust = trusted)]
pub async fn p4_jobs(
    host: &Host,
    window: &str,
    root: Option<PathBuf>,
    query: Option<String>,
    limit: u32,
) -> IdeResult<Vec<Job>> {
    read(host, window, root, Vec::new(), move |w, _| w.jobs(query.as_deref(), limit)).await
}

/// The jobs a changelist fixes.
#[command(trust = trusted)]
pub async fn p4_fixes(host: &Host, window: &str, root: Option<PathBuf>, change: u32) -> IdeResult<Vec<String>> {
    read(host, window, root, Vec::new(), move |w, _| w.fixes(change)).await
}

/// Links (or with `remove`, unlinks) jobs and a changelist.
#[command(trust = trusted)]
pub async fn p4_fix(
    host: &Host,
    window: &str,
    root: Option<PathBuf>,
    change: u32,
    jobs: Vec<String>,
    remove: bool,
) -> IdeResult<()> {
    mutate(host, window, root, Vec::new(), None, move |w, _| w.fix(change, &jobs, remove)).await
}

ide_command::domain!(
    vcs_p4:
    p4_add,
    p4_changelist_create,
    p4_changelist_delete,
    p4_changelist_update,
    p4_changelists,
    p4_delete,
    p4_edit,
    p4_executable,
    p4_fix,
    p4_fixes,
    p4_integrate,
    p4_jobs,
    p4_lock,
    p4_login,
    p4_login_status,
    p4_logout,
    p4_reconcile,
    p4_reopen,
    p4_resolve,
    p4_resolve_sides,
    p4_resolve_with,
    p4_revert_unchanged,
    p4_shelf_delete,
    p4_shelve,
    p4_shelved_files,
    p4_submit,
    p4_sync,
    p4_unresolved,
    p4_unshelve,
    p4_workspaces,
);
