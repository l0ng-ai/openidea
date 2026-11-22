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
        if repos.is_empty() {
            return Err(ide_core::IdeError::unavailable("project is not a git repository"));
        }
        for r in repos.all() {
            r.set_ignored_names(settings.ignored_names());
            r.set_cli_status(settings.vcs.git.cli_status);
        }
        repos.status()
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
        if repos.is_empty() {
            return Err(ide_core::IdeError::unavailable("project is not a git repository"));
        }
        for r in repos.all() {
            r.set_ignored_names(settings.ignored_names());
            r.set_cli_status(settings.vcs.git.cli_status);
        }
        repos.status_paths(&paths)
    })
    .await
}

pub mod commands;
mod rebase_editor;
mod worktree_setup;
pub use commands::*;
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
