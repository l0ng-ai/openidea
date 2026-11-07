use super::PluginHost;
use ide_core::{IdeError, IdeResult};
use ide_plugin::Invocation;
use std::{path::PathBuf, sync::Arc};
#[derive(serde::Serialize, specta::Type)]
pub struct NavigationFiles {
    pub paths: Vec<ide_core::IpcPath>,
    pub indexing: bool,
    pub extensions: Vec<String>,
}

/// File discovery is separate from clicking: the UI schedules small background
/// batches after initial index completion and updates only changed files later.
pub async fn plugin_navigation_files(
    host: &crate::Host,
    plugins: Arc<PluginHost>,
    window: &str,
) -> IdeResult<NavigationFiles> {
    let project = host.project(window)?;
    blocking(move || {
        let extensions = plugins.navigation_extensions(&project.root);
        if extensions.is_empty() {
            return Ok(NavigationFiles { paths: vec![], indexing: false, extensions: vec![] });
        }
        let indexing = project.index.status().indexing;
        let files = project.index.files_with_extensions(&extensions, 20_001);
        if files.len() > 20_000 {
            return Err(IdeError::unavailable("plugin navigation supports up to 20,000 matching files"));
        }
        Ok(NavigationFiles {
            paths: files.into_iter().filter(|p| p.starts_with(&project.root)).map(Into::into).collect(),
            indexing,
            extensions,
        })
    })
    .await
}

pub fn plugin_navigation_invalidate(
    host: &crate::Host,
    plugins: Arc<PluginHost>,
    window: &str,
    paths: Option<Vec<PathBuf>>,
) -> IdeResult<()> {
    let project = host.project(window)?;
    plugins.invalidate_client_navigation(&project.root, Some(window), paths.as_deref());
    Ok(())
}

pub async fn plugin_navigation_index(
    host: &crate::Host,
    plugins: Arc<PluginHost>,
    window: &str,
    paths: Vec<PathBuf>,
    request: ide_core::RequestId,
) -> IdeResult<()> {
    if paths.len() > 16 {
        return Err(IdeError::invalid("navigation batches are limited to 16 files"));
    }
    let project = host.project(window)?;
    let cancel = host.begin_project_request(window, request);
    let client = window.to_owned();
    let result = blocking(move || {
        if !project.is_trusted() {
            return Err(IdeError::unavailable("project is not trusted"));
        }
        for path in paths {
            if cancel.is_cancelled() {
                return Err(IdeError::cancelled());
            }
            let Ok(path) = ide_plugin::resolve_in_root(&project.root, &path.to_string_lossy()) else {
                continue;
            };
            let extensions = plugins.navigation_extensions(&project.root);
            if !path.extension().and_then(|e| e.to_str()).is_some_and(|e| extensions.iter().any(|x| x == e)) {
                continue;
            }
            let document = project.documents.by_path(&path);
            let (text, version, language) = if let Some(id) = document {
                let snapshot = project.documents.text_snapshot(id)?;
                if snapshot.large {
                    continue;
                }
                (snapshot.text, Some(snapshot.version), snapshot.language)
            } else {
                let Ok(loaded) = project.documents.load_file_bounded(&path, super::navigation::MAX_DOCUMENT_BYTES)
                else {
                    continue;
                };
                if loaded.binary || loaded.large {
                    continue;
                }
                let text = loaded.text;
                let language = project.languages.detect(&path, text.lines().next());
                (text, None, language)
            };
            if text.len() > crate::plugins::navigation::MAX_DOCUMENT_BYTES {
                continue;
            }
            let symbols = project
                .index
                .symbols_for_text(&path, &text)
                .unwrap_or_else(|| project.syntax.syntax().tags(&language, &text));
            let roots = project.roots();
            let scope = roots
                .roots
                .iter()
                .filter(|r| path.starts_with(project.root.join(&r.path)))
                .max_by_key(|r| r.path.len())
                .and_then(|r| r.detected_from.as_deref())
                .unwrap_or("");
            plugins.index_navigation(
                &project.root,
                crate::plugins::navigation::Snapshot { path: &path, version, text: &text, symbols: &symbols, scope },
                Invocation {
                    client: Some(client.clone()),
                    workspace_root: Some(project.root.clone()),
                    editor: None,
                    selected_paths: Vec::new(),
                },
            )?;
            // A document edit while WASM was executing must not publish stale ranges.
            if cancel.is_cancelled() || document.is_some_and(|id| project.documents.version(id).ok() != version) {
                plugins.invalidate_client_navigation(&project.root, Some(&client), Some(&[path]));
            }
        }
        Ok(())
    })
    .await;
    host.end_request(request);
    result
}

/// The HTTP routes `plugin_id` reports for this window's project.
pub async fn plugin_endpoints(
    host: &crate::Host,
    plugins: Arc<PluginHost>,
    window: &str,
    plugin_id: String,
) -> IdeResult<Vec<crate::plugins::endpoints::PluginEndpoint>> {
    let project = host.project(window)?;
    blocking(move || Ok(plugins.endpoints(&plugin_id, &project.root)?.as_ref().clone())).await
}

pub async fn plugin_navigation_goto(
    host: &crate::Host,
    plugins: Arc<PluginHost>,
    window: &str,
    doc: ide_core::DocId,
    pos: ide_core::Pos,
) -> IdeResult<Option<crate::plugins::navigation::NavigationResult>> {
    let project = host.project(window)?;
    let client = window.to_owned();
    blocking(move || {
        let (path, version) = project.documents.identity(doc)?;
        Ok(plugins.navigation_at(&project.root, &path, version, pos, Some(&client), |p| {
            project.documents.by_path(p).and_then(|id| project.documents.version(id).ok())
        }))
    })
    .await
}

pub async fn plugin_navigation_markers(
    host: &crate::Host,
    plugins: Arc<PluginHost>,
    window: &str,
    paths: Vec<PathBuf>,
) -> IdeResult<Vec<crate::plugins::navigation::FileMarkers>> {
    if paths.len() > 64 {
        return Err(IdeError::invalid("marker batches are limited to 64 files"));
    }
    let project = host.project(window)?;
    let client = window.to_owned();
    blocking(move || {
        Ok(plugins.navigation_markers(&project.root, &paths, Some(&client), |p| {
            project.documents.by_path(p).and_then(|id| project.documents.version(id).ok())
        }))
    })
    .await
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> IdeResult<T> + Send + 'static) -> IdeResult<T> {
    tokio::task::spawn_blocking(f).await.map_err(|e| IdeError::internal(e.to_string()))?
}
