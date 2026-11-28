//! Git LFS: tracked files still checked out as pointer files, and pulling their content.

use crate::{Repo, cli};
use ide_core::{CancellationToken, IdeError, IdeResult};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::io::Read;
use std::path::Path;

const POINTER: &[u8] = b"version https://git-lfs.github.com/spec/v1";
/// LFS pointer files are a few hundred bytes at most.
const MAX_POINTER: u64 = 1024;

#[derive(Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LfsStatus {
    /// `git lfs` runs.
    pub installed: bool,
    /// LFS-tracked files (repository-relative) whose checkout is still a pointer file.
    pub pointers: Vec<String>,
}

impl Repo {
    /// The repository's root `.gitattributes` assigns the LFS filter to some paths.
    pub fn uses_lfs(&self) -> bool {
        std::fs::read_to_string(self.root().join(".gitattributes")).is_ok_and(|text| text.contains("filter=lfs"))
    }

    pub fn lfs_status(&self, cancel: &CancellationToken) -> IdeResult<LfsStatus> {
        let _scope = self.execution_scope();
        if !crate::execution_allowed() {
            return Err(IdeError::unavailable("Git LFS requires a trusted project"));
        }
        let args = ["-c", "core.quotepath=false", "ls-files", "-z", "--", ":(attr:filter=lfs)"];
        let listed = cli::run_cancellable(self.root(), &args, cancel)?;
        let pointers = listed
            .stdout
            .split(|&byte| byte == 0)
            .filter_map(|path| std::str::from_utf8(path).ok())
            .filter(|path| !path.is_empty() && is_pointer(&self.root().join(path)))
            .map(str::to_owned)
            .collect();
        let installed = cli::run_cancellable_raw(self.root(), &["lfs", "version"], cancel)?.code == Some(0);
        Ok(LfsStatus { installed, pointers })
    }

    /// Downloads the LFS objects of the checked-out commit and replaces the pointer files,
    /// first setting up the repository's LFS filters and hooks when no Git config has them.
    pub fn pull_lfs(&self, cancel: &CancellationToken, on_output: &dyn Fn(String)) -> IdeResult<()> {
        let _scope = self.execution_scope();
        if !crate::execution_allowed() {
            return Err(IdeError::unavailable("Git LFS requires a trusted project"));
        }
        if self.config_get("filter.lfs.process")?.is_none() {
            cli::run_streaming(self.root(), &["lfs", "install", "--local"], cancel, on_output)?;
        }
        cli::run_streaming(self.root(), &["lfs", "pull"], cancel, on_output)
    }
}

fn is_pointer(path: &Path) -> bool {
    let mut head = [0; POINTER.len()];
    std::fs::metadata(path).is_ok_and(|meta| meta.is_file() && meta.len() <= MAX_POINTER)
        && std::fs::File::open(path).and_then(|mut file| file.read_exact(&mut head)).is_ok()
        && head == POINTER
}
