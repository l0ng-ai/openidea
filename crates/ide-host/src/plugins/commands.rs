//! Plugin command requests shared by local IPC and remote RPC.

use super::PluginHost;
use ide_core::{IdeResult, RequestId};
use ide_plugin::Invocation;
use std::sync::Arc;

pub async fn run_command(
    host: &crate::Host,
    plugins: Arc<PluginHost>,
    plugin_id: String,
    command_id: String,
    arg: Option<String>,
    invocation: Invocation,
    request: Option<RequestId>,
) -> IdeResult<Option<String>> {
    let cancel = request.map(|id| match invocation.client.as_deref() {
        Some(window) => host.begin_project_read_request(window, id),
        None => host.begin_request(id),
    });
    let result = host
        .blocking(move || {
            plugins.run_command_with_cancel(&plugin_id, &command_id, arg.as_deref(), invocation, cancel.as_ref())
        })
        .await;
    if let Some(request) = request {
        host.end_request(request);
    }
    result
}
