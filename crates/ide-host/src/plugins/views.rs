//! Declarative views and custom editors as the
//! window commands `plugin_view_render` / `plugin_view_event` (and, for services views,
//! `plugin_service_detail` / `plugin_service_log`) serve them —
//! the desktop for local projects, `openidea-server` for remote ones.

use super::{PluginEditor, PluginHost, PluginOutputLine};
use ide_command::command;
use ide_core::{DocId, IdeError, IdeResult};
use ide_plugin::{EditorContext, Invocation, ServiceTab, View, ViewEvent, Viewport};
use std::sync::Arc;

/// The window's project, plus the editor the call is about: the document a
/// custom editor shows, else (a tool window) the window's active editor, as
/// a command gets it, so a view's buttons can act on what the user is editing.
pub fn view_invocation(
    host: &crate::Host,
    window: &str,
    doc: Option<DocId>,
    editor: Option<PluginEditor>,
) -> IdeResult<Invocation> {
    let project = host.project(window).ok();
    let editor = match doc {
        None => editor.map(PluginEditor::context),
        Some(doc) => {
            let project = project.as_ref().ok_or_else(|| IdeError::not_found("no project is open in this window"))?;
            let info = project.documents.snapshot(doc)?;
            Some(EditorContext { path: info.path.0, language: info.language.0, selections: Vec::new() })
        }
    };
    Ok(Invocation {
        client: Some(window.to_owned()),
        workspace_root: project.as_ref().map(|p| p.root.clone()),
        editor,
        ..Invocation::default()
    })
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> IdeResult<T> + Send + 'static) -> IdeResult<T> {
    tokio::task::spawn_blocking(f).await.map_err(|e| IdeError::internal(e.to_string()))?
}

/// Content of a plugin view (`doc`: the document of a custom editor; `editor`: for
/// a tool window, the window's active editor, as commands get it).
#[allow(clippy::too_many_arguments)]
#[command(trust = trusted)]
pub async fn plugin_view_render(
    host: &crate::Host,
    plugins: &Arc<PluginHost>,
    window: &str,
    plugin_id: String,
    view: String,
    viewport: Option<Viewport>,
    doc: Option<DocId>,
    editor: Option<PluginEditor>,
) -> IdeResult<View> {
    let plugins = plugins.clone();
    let invocation = view_invocation(host, window, doc, editor)?;
    blocking(move || plugins.render_view(&plugin_id, &view, viewport, invocation)).await
}

/// A user action in a plugin view or custom editor (`doc`, `editor`: as for rendering).
#[allow(clippy::too_many_arguments)]
#[command(trust = trusted)]
pub async fn plugin_view_event(
    host: &crate::Host,
    plugins: &Arc<PluginHost>,
    window: &str,
    plugin_id: String,
    view: String,
    event: ViewEvent,
    doc: Option<DocId>,
    editor: Option<PluginEditor>,
) -> IdeResult<()> {
    let plugins = plugins.clone();
    let invocation = view_invocation(host, window, doc, editor)?;
    blocking(move || plugins.view_event(&plugin_id, &view, event, invocation)).await
}

/// The Services pane of node `key` of a plugin's `location = "services"` view.
#[command(trust = trusted)]
pub async fn plugin_service_detail(
    host: &crate::Host,
    plugins: &Arc<PluginHost>,
    window: &str,
    plugin_id: String,
    view: String,
    key: String,
) -> IdeResult<Vec<ServiceTab>> {
    let plugins = plugins.clone();
    let invocation = view_invocation(host, window, None, None)?;
    blocking(move || plugins.service_detail(&plugin_id, &view, &key, invocation)).await
}

/// Runs the program of the log tab `tab` of node `key`'s Services pane (with
/// the toggles in `on`), streaming its output until it exits or `request` is
/// cancelled; returns the exit code.
#[allow(clippy::too_many_arguments)]
#[command(trust = trusted)]
pub async fn plugin_service_log(
    host: &crate::Host,
    plugins: &Arc<PluginHost>,
    window: &str,
    request: ide_core::RequestId,
    plugin_id: String,
    view: String,
    key: String,
    tab: String,
    on: Vec<String>,
    on_line: crate::ops::Channel<PluginOutputLine>,
) -> IdeResult<Option<i32>> {
    // Runs in the window's project root.
    let plugins = plugins.clone();
    let invocation = view_invocation(host, window, None, None)?;
    let cancel = host.begin_project_read_request(window, request);
    let result = blocking(move || {
        plugins.stream_service_log(&plugin_id, &view, &key, &tab, &on, invocation, &cancel, &|line| {
            let _ = on_line.send(line);
        })
    })
    .await;
    host.end_request(request);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Host, HostConfig};

    #[tokio::test]
    async fn a_tool_window_call_carries_the_active_editor() {
        let tmp = tempfile::tempdir().unwrap();
        let host = Host::new(HostConfig {
            config_dir: tmp.path().join("config"),
            data_dir: tmp.path().join("data"),
            local_data_dir: tmp.path().join("data"),
            languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
            syntax: Arc::default(),
            sink_for: Box::new(|_| Arc::new(ide_core::NullSink)),
            owner: |w| w,
            runtime: tokio::runtime::Handle::current(),
            project_environment: false,
        });
        let range = ide_core::Range::new(ide_core::Pos::new(1, 0), ide_core::Pos::new(1, 4));
        let active = PluginEditor { path: "/p/a.rs".into(), language: "rust".into(), selections: vec![range] };
        let inv = view_invocation(&host, "main", None, Some(active)).unwrap();
        let editor = inv.editor.expect("the active editor");
        assert_eq!((editor.path.to_string_lossy().as_ref(), editor.selections.as_slice()), ("/p/a.rs", &[range][..]));
        assert_eq!(inv.client.as_deref(), Some("main"));
        assert!(view_invocation(&host, "main", None, None).unwrap().editor.is_none());
    }
}

ide_command::domain!(
    plugins_views:
    plugin_service_detail,
    plugin_service_log,
    plugin_view_event,
    plugin_view_render,
);
