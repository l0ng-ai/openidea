//! The Commit view's side of the `commit` API, as the window commands
//! `plugin_answer_commit` / `plugin_commit_checks` serve it — the desktop for
//! local projects, `openidea-server` for remote ones.

use super::{CommitSelection, PluginCommitCheckRef, PluginCommitCheckResult, PluginHost};
use ide_core::{IdeError, IdeResult, RequestId};
use std::sync::Arc;

/// Runs the plugins' before-commit checks `checks` on what `selection` commits,
/// until request `request` is cancelled.
pub async fn commit_checks(
    host: &crate::Host,
    plugins: Arc<PluginHost>,
    window: &str,
    selection: CommitSelection,
    checks: Vec<PluginCommitCheckRef>,
    request: RequestId,
) -> IdeResult<Vec<PluginCommitCheckResult>> {
    host.require_trust(window)?;
    let invocation = super::views::view_invocation(host, window, None, None)?;
    let cancel = host.begin_project_read_request(window, request);
    let result = tokio::task::spawn_blocking(move || plugins.commit_checks(invocation, selection, checks, &cancel))
        .await
        .map_err(|e| IdeError::internal(e.to_string()))
        .and_then(|r| r);
    host.end_request(request);
    result
}
