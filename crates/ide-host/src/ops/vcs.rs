use crate::{Host, apply_git_executable};
use ide_core::IdeResult;
use ide_vcs::FileStatus;

/// Changes of every repository of the project.
pub async fn status(host: &Host, window: &str) -> IdeResult<Vec<FileStatus>> {
    let project = host.project(window)?;
    host.blocking(move || {
        let settings = project.settings.effective();
        apply_git_executable(&settings);
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
