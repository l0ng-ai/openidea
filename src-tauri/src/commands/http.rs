use crate::state::AppState;
use ide_core::{IdeError, IdeResult, IpcPath, RequestId};
use ide_http::{HistoryEntry, HttpExchange, HttpRequestBlock};
use tauri::{State, Window};

/// The requests of an `.http` file (gutter run icons, Run All).
#[tauri::command]
#[specta::specta]
pub fn http_requests(text: String) -> Vec<HttpRequestBlock> {
    ide_http::parse::requests(&text)
}

/// Environment names from the `http-client(.private).env.json` files that apply to `path`.
#[tauri::command]
#[specta::specta]
pub async fn http_environments(
    window: Window,
    state: State<'_, AppState>,
    path: Option<IpcPath>,
) -> IdeResult<Vec<String>> {
    let root = state.project(window.label()).ok().map(|p| p.root.clone());
    tauri::async_runtime::spawn_blocking(move || ide_http::environments(path.as_deref(), root.as_deref()))
        .await
        .map_err(|e| IdeError::internal(e.to_string()))?
}

/// Sends request `index` of `text` (the editor buffer of `path`) and records
/// the exchange in the response history. Cancel with `cancel_request(request)`.
#[tauri::command]
#[specta::specta]
pub async fn http_execute(
    window: Window,
    state: State<'_, AppState>,
    request: RequestId,
    path: Option<IpcPath>,
    text: String,
    index: u32,
    env: Option<String>,
) -> IdeResult<HttpExchange> {
    let project = state.project(window.label())?;
    let cancel = state.begin_request(request);
    let input = ide_http::RunInput {
        text: &text,
        index,
        file: path.as_deref(),
        root: Some(&project.root),
        env: env.as_deref(),
    };
    let result = ide_http::run(input, &cancel).await;
    state.end_request(request);
    let exchange = result?;
    let history = project.http_history.clone();
    let saved = exchange.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(e) = history.add(&saved) {
            tracing::warn!("http history: {}", e.message);
        }
    });
    Ok(exchange)
}

#[tauri::command]
#[specta::specta]
pub fn http_history(window: Window, state: State<'_, AppState>) -> IdeResult<Vec<HistoryEntry>> {
    Ok(state.project(window.label())?.http_history.list())
}

#[tauri::command]
#[specta::specta]
pub fn http_history_get(window: Window, state: State<'_, AppState>, id: String) -> IdeResult<HttpExchange> {
    state.project(window.label())?.http_history.get(&id)
}

#[tauri::command]
#[specta::specta]
pub fn http_history_clear(window: Window, state: State<'_, AppState>) -> IdeResult<()> {
    state.project(window.label())?.http_history.clear()
}

/// System Settings › HTTP Proxy › Check connection: GETs `url` through `proxy` as
/// edited (not yet applied); the response status, or why there was none.
#[tauri::command]
#[specta::specta]
pub async fn proxy_check_connection(proxy: ide_core::settings::ProxySettings, url: String) -> IdeResult<String> {
    ide_http::client::check_connection(&proxy, &url, &ide_core::CancellationToken::new()).await
}
