//! The Commit view's side of the `commit` API, as the window commands
//! `plugin_answer_commit` / `plugin_commit_checks` serve it — the desktop for
//! local projects, `openidea-server` for remote ones.

use super::{CommitSelection, PluginCommitCheckRef, PluginCommitCheckResult, PluginHost};
use ide_command::command;
use ide_core::{IdeError, IdeResult, RequestId};
use std::sync::Arc;

/// Runs plugins' before-commit checks on what `selection` commits, until
/// `request` is cancelled.
#[command(trust = trusted)]
pub async fn plugin_commit_checks(
    host: &crate::Host,
    plugins: &Arc<PluginHost>,
    window: &str,
    selection: CommitSelection,
    checks: Vec<PluginCommitCheckRef>,
    request: RequestId,
) -> IdeResult<Vec<PluginCommitCheckResult>> {
    host.require_trust(window)?;
    let plugins = plugins.clone();
    let invocation = super::views::view_invocation(host, window, None, None)?;
    let cancel = host.begin_project_read_request(window, request);
    let result = tokio::task::spawn_blocking(move || plugins.commit_checks(invocation, selection, checks, &cancel))
        .await
        .map_err(|e| IdeError::internal(e.to_string()))
        .and_then(|r| r);
    host.end_request(request);
    result
}

ide_command::domain!(plugins_commit: plugin_commit_checks);
