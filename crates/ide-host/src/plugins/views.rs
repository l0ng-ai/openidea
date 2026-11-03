//! Declarative views and custom editors (docs/plugin_plan.md P7) as the
//! window commands `plugin_view_render` / `plugin_view_event` serve them —
//! the desktop for local projects, `openidea-server` for remote ones.

use super::PluginHost;
use ide_core::{DocId, IdeError, IdeResult};
use ide_plugin::{EditorContext, Invocation, View, ViewEvent, Viewport};
use std::sync::Arc;

/// The window's project, plus the document a custom editor shows.
pub fn view_invocation(host: &crate::Host, window: &str, doc: Option<DocId>) -> IdeResult<Invocation> {
    let project = host.project(window).ok();
    let editor = match doc {
        None => None,
        Some(doc) => {
            let project = project.as_ref().ok_or_else(|| IdeError::not_found("no project is open in this window"))?;
            let info = project.documents.snapshot(doc)?;
            Some(EditorContext { path: info.path.0, language: info.language.0, selections: Vec::new() })
        }
    };
    Ok(Invocation { client: Some(window.to_owned()), workspace_root: project.as_ref().map(|p| p.root.clone()), editor })
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> IdeResult<T> + Send + 'static) -> IdeResult<T> {
    tokio::task::spawn_blocking(f).await.map_err(|e| IdeError::internal(e.to_string()))?
}

#[allow(clippy::too_many_arguments)]
pub async fn render(
    host: &crate::Host,
    plugins: Arc<PluginHost>,
    window: &str,
    plugin_id: String,
    view: String,
    viewport: Option<Viewport>,
    doc: Option<DocId>,
) -> IdeResult<View> {
    let invocation = view_invocation(host, window, doc)?;
    blocking(move || plugins.render_view(&plugin_id, &view, viewport, invocation)).await
}

pub async fn event(
    host: &crate::Host,
    plugins: Arc<PluginHost>,
    window: &str,
    plugin_id: String,
    view: String,
    event: ViewEvent,
    doc: Option<DocId>,
) -> IdeResult<()> {
    let invocation = view_invocation(host, window, doc)?;
    blocking(move || plugins.view_event(&plugin_id, &view, event, invocation)).await
}
