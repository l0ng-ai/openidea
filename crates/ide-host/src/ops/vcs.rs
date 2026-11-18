use crate::Host;
use ide_command::command;
use ide_core::IdeResult;
use ide_vcs::FileStatus;

/// Changes of every repository of the project.
#[command(trust = always)]
pub async fn vcs_status(host: &Host, window: &str) -> IdeResult<Vec<FileStatus>> {
    let project = host.project(window)?;
    host.blocking(move || {
        let settings = project.settings.effective();
        let repos = project.repos();
        let workspaces = project.p4_workspaces();
        if repos.is_empty() && workspaces.is_empty() {
            return Err(ide_core::IdeError::unavailable("project is not under version control"));
        }
        for r in repos.all() {
            r.set_ignored_names(settings.ignored_names());
            r.set_cli_status(settings.vcs.git.cli_status);
        }
        let mut status = if repos.is_empty() { Vec::new() } else { repos.status()? };
        for workspace in &workspaces {
            match p4_status(&project, workspace, None) {
                Ok(opened) => status.extend(opened),
                // An unreachable server must not hide the Git changes of the same project.
                Err(e) if !repos.is_empty() => tracing::warn!("p4 status of {}: {e}", workspace.root().display()),
                Err(e) => return Err(e),
            }
        }
        Ok(status)
    })
    .await
}

#[command(trust = always)]
pub async fn vcs_ignored_files(host: &Host, window: &str) -> IdeResult<Vec<FileStatus>> {
    let project = host.project(window)?;
    host.blocking(move || {
        let settings = project.settings.effective();
        let repos = project.repos();
        let ignored = settings.ignored_names();
        for repo in repos.all() {
            repo.set_ignored_names(ignored.clone());
        }
        repos.ignored_files()
    })
    .await
}

/// Changes of `paths` only: the dirty-scope refresh after a watcher batch.
#[command(trust = always)]
pub async fn vcs_status_paths(host: &Host, window: &str, paths: Vec<std::path::PathBuf>) -> IdeResult<Vec<FileStatus>> {
    // `paths` that belong to no repository are ignored, and an empty list is the full status.
    let project = host.project(window)?;
    host.blocking(move || {
        let settings = project.settings.effective();
        let repos = project.repos();
        let workspaces = project.p4_workspaces();
        if repos.is_empty() && workspaces.is_empty() {
            return Err(ide_core::IdeError::unavailable("project is not under version control"));
        }
        for r in repos.all() {
            r.set_ignored_names(settings.ignored_names());
            r.set_cli_status(settings.vcs.git.cli_status);
        }
        let mut status = if repos.is_empty() { Vec::new() } else { repos.status_paths(&paths)? };
        for workspace in &workspaces {
            match p4_status(&project, workspace, Some(&paths)) {
                Ok(opened) => status.extend(opened),
                // An unreachable server must not hide the Git changes of the same project.
                Err(e) if !repos.is_empty() => tracing::warn!("p4 status of {}: {e}", workspace.root().display()),
                Err(e) => return Err(e),
            }
        }
        Ok(status)
    })
    .await
}

/// Opened files of a Perforce workspace (those among `paths`, when given) that no Git
/// repository nested in it reports itself.
fn p4_status(
    project: &crate::Project,
    workspace: &ide_p4::Workspace,
    paths: Option<&[std::path::PathBuf]>,
) -> IdeResult<Vec<FileStatus>> {
    use ide_vcs::Backend;
    let status = match paths {
        Some(paths) => {
            let mine: Vec<std::path::PathBuf> =
                paths.iter().filter(|p| p.starts_with(workspace.root())).cloned().collect();
            if mine.is_empty() {
                return Ok(Vec::new());
            }
            workspace.status_paths(&mine)?
        }
        None => workspace.status()?,
    };
    Ok(status.into_iter().filter(|f| project.p4_workspace_of(&f.path.0).is_some()).collect())
}

pub mod commands;
mod rebase_editor;
mod worktree_setup;
pub use commands::*;
pub mod p4;
pub(crate) use rebase_editor::RebaseEditors;

/// Refuses (with `refusal`) to remove or move the worktree that holds the open project.
fn check_worktree_away_from_project(
    project_root: &std::path::Path,
    path: &std::path::Path,
    refusal: &str,
) -> IdeResult<()> {
    fn canonical_path(path: &std::path::Path) -> std::io::Result<std::path::PathBuf> {
        let mut existing = path.to_path_buf();
        let mut tail = Vec::new();
        let mut real = loop {
            match dunce::canonicalize(&existing) {
                Ok(real) => break real,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    let Some(part) = existing.components().next_back() else { return Err(e) };
                    tail.push(part.as_os_str().to_owned());
                    if !existing.pop() {
                        return Err(e);
                    }
                }
                Err(e) => return Err(e),
            }
        };
        // The project or worktree may already be gone; resolve its missing tail too.
        for part in tail.into_iter().rev() {
            if part == ".." {
                real.pop();
            } else if part != "." {
                real.push(part);
            }
        }
        Ok(real)
    }

    if canonical_path(project_root)?.starts_with(canonical_path(path)?) {
        return Err(ide_core::IdeError::invalid(refusal));
    }
    Ok(())
}

ide_command::domain!(vcs: vcs_status, vcs_status_paths, vcs_ignored_files);
