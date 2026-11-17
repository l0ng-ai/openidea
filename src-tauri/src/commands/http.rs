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

/// Convert to cURL and Copy: request `index` of `text` (the editor buffer of `path`), with
/// the variables of `env` substituted, as a cURL command.
#[tauri::command]
#[specta::specta]
pub async fn http_curl(
    window: Window,
    state: State<'_, AppState>,
    path: Option<IpcPath>,
    text: String,
    index: u32,
    env: Option<String>,
) -> IdeResult<String> {
    let root = state.project(window.label()).ok().map(|p| p.root.clone());
    tauri::async_runtime::spawn_blocking(move || {
        ide_http::curl(&ide_http::RunInput {
            text: &text,
            index,
            file: path.as_deref(),
            root: root.as_deref(),
            env: env.as_deref(),
        })
    })
    .await
    .map_err(|e| IdeError::internal(e.to_string()))?
}

/// A pasted `curl …` command as `.http` request text; `None` when it isn't one.
#[tauri::command]
#[specta::specta]
pub fn http_from_curl(command: String) -> Option<String> {
    ide_http::curl::from_curl(&command)
}

/// The environment file for the request file `path` (`is_private`: the private one): the nearest
/// existing one, else a new one next to it.
#[tauri::command]
#[specta::specta]
pub async fn http_environment_file(
    window: Window,
    state: State<'_, AppState>,
    path: IpcPath,
    is_private: bool,
) -> IdeResult<IpcPath> {
    let root = state.project(window.label()).ok().map(|p| p.root.clone());
    tauri::async_runtime::spawn_blocking(move || {
        ide_http::env::environment_file(&path, root.as_deref(), is_private).map(IpcPath::from)
    })
    .await
    .map_err(|e| IdeError::internal(e.to_string()))?
}

/// Where `{{name}}` is defined in the environment files that apply to request file `path`
/// (Navigate › Declaration on a variable), private file first.
#[tauri::command]
#[specta::specta]
pub async fn http_variable_definitions(
    window: Window,
    state: State<'_, AppState>,
    path: IpcPath,
    name: String,
) -> IdeResult<Vec<ide_core::Location>> {
    let root = state.project(window.label()).ok().map(|p| p.root.clone());
    tauri::async_runtime::spawn_blocking(move || ide_http::env::variable_definitions(&path, root.as_deref(), &name))
        .await
        .map_err(|e| IdeError::internal(e.to_string()))
}
