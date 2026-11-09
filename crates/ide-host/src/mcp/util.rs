// Ported from JetBrains intellij-community plugins/mcp-server (src/com/intellij/mcpserver/util/fs.util.kt,
// util/text.util.kt, toolsets/Constants.kt), Apache-2.0.
//! Helpers shared by the tools: the strings and timeouts of JetBrains' `Constants`,
//! resolving the paths `read_file` accepts, and text truncation.

use crate::mcp::tool::Call;
use ide_core::{IdeError, IdeResult};
use std::path::PathBuf;
use std::time::Duration;

pub const RELATIVE_PATH_IN_PROJECT_DESCRIPTION: &str = "Path relative to the project root";
pub const FILE_PATH_DESCRIPTION: &str = "Path to the file. Supports project-relative paths, paths with '..', \
absolute paths, archive entries like '/path/lib.jar!/pkg/Foo.java', and URLs such as 'file://' and 'jar://'. \
Any path returned from the other tools can be passed as is (e.g. paths from 'search_*' tools).";
pub const TIMEOUT_MILLISECONDS_DESCRIPTION: &str = "Timeout in milliseconds";
pub const TIMED_OUT_DESCRIPTION: &str = "Indicates whether the operation was timed out. 'true' value may mean that \
the results may be incomplete or partial. 'false', 'null' or missing value means that the operation has not been \
timed out.";
pub const MEDIUM_TIMEOUT: Duration = Duration::from_secs(10);
pub const INDEXING_PARTIAL_RESULT_REASON: &str =
    "Project indexing was in progress; results may be incomplete — retry once indexing completes.";

/// Whether `path` starts with a URL scheme (`file://`, `jar://`, `jrt://` …).
pub fn looks_like_vfs_url(path: &str) -> bool {
    path.find("://")
        .is_some_and(|i| i > 0 && path[..i].chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.')))
}

/// Resolves `read_file`'s `file_path`: project-relative or absolute paths, archive entries
/// (`/lib.jar!/pkg/Foo.java`) and `file://` / `jar://` URLs, within known content or library roots.
pub async fn resolve_read_file(call: &Call, file_path: &str) -> IdeResult<PathBuf> {
    let normalized = file_path.trim().replace('\\', "/");
    if normalized.is_empty() {
        return Err(IdeError::invalid("file_path is empty"));
    }
    let missing = || IdeError::not_found(format!("File {file_path} doesn't exist or can't be opened"));
    let local = if looks_like_vfs_url(&normalized) {
        let (scheme, rest) = normalized.split_once("://").unwrap_or_default();
        match scheme.to_ascii_lowercase().as_str() {
            // `file://` URLs are percent-decoded by `resolve`.
            "file" => normalized.clone(),
            "jar" => rest.to_owned(),
            "jrt" => {
                return Err(IdeError::invalid(format!(
                    "File {file_path} can't be opened: OpenIDEA does not read jrt:// (Java runtime image) entries"
                )));
            }
            _ => return Err(missing()),
        }
    } else {
        normalized
    };
    let path = call.resolve_readable(&local).await?;
    match ide_vfs::split_archive_path(&path) {
        Some((archive, entry)) => {
            if !archive.is_file() {
                return Err(missing());
            }
            if entry.is_empty() || ide_vfs::read_archive_dir(&archive, &entry).is_ok() {
                return Err(IdeError::invalid(format!("File {file_path} is a directory")));
            }
            ide_vfs::probe(&path).map_err(|_| missing())?;
        }
        None if path.is_dir() => return Err(IdeError::invalid(format!("File {file_path} is a directory"))),
        None if !path.is_file() && call.project().documents.by_path(&path).is_none() => return Err(missing()),
        None => {}
    }
    Ok(path)
}
