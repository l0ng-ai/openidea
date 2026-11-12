use crate::{Host, apply_git_executable};
use ide_core::IdeResult;
use ide_vcs::FileStatus;

/// Changes of every repository of the project.
pub async fn status(host: &Host, window: &str) -> IdeResult<Vec<FileStatus>> {
    let project = host.project(window)?;
    host.blocking(move || {
        let settings = project.settings.effective();
        if project.is_trusted() {
            apply_git_executable(&settings);
        }
        let repos = project.repos();
        if repos.is_empty() {
            return Err(ide_core::IdeError::unavailable("project is not a git repository"));
        }
        for r in repos.all() {
            r.set_ignored_names(settings.ignored_names());
        }
        repos.status()
    })
    .await
}

mod commands;
pub use commands::*;

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
