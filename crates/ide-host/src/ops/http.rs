//! HTTP Client commands shared by the desktop shell's IPC commands and the remote server: a remote
//! window sends its requests from the project host and keeps their history there.
use crate::Host;
use ide_command::command;
use ide_core::{IdeResult, IpcPath, Location, RequestId};
use ide_http::{HistoryEntry, HttpExchange};
use std::path::PathBuf;

use super::blocking;

/// The root of the window's project, when one is open.
fn root(host: &Host, window: &str) -> Option<PathBuf> {
    host.project(window).ok().map(|p| p.root.clone())
}

/// Environment names from the `http-client(.private).env.json` files that apply to `path`.
#[command(trust = trusted)]
pub async fn http_environments(host: &Host, window: &str, path: Option<IpcPath>) -> IdeResult<Vec<String>> {
    let root = root(host, window);
    blocking(move || ide_http::environments(path.as_deref(), root.as_deref())).await
}

/// Sends request `index` of `text` (the editor buffer of `path`) and records
/// the exchange in the response history. Cancel with `cancel_request(request)`.
#[command(trust = trusted)]
pub async fn http_execute(
    host: &Host,
    window: &str,
    request: RequestId,
    path: Option<IpcPath>,
    text: String,
    index: u32,
    env: Option<String>,
) -> IdeResult<HttpExchange> {
    let project = host.project(window)?;
    let cancel = host.begin_request(request);
    let input = ide_http::RunInput {
        text: &text,
        index,
        file: path.as_deref(),
        root: Some(&project.root),
        env: env.as_deref(),
    };
    let result = ide_http::run(input, &cancel).await;
    host.end_request(request);
    let exchange = result?;
    let history = project.http_history.clone();
    let saved = exchange.clone();
    tokio::task::spawn_blocking(move || {
        if let Err(e) = history.add(&saved) {
            tracing::warn!("http history: {}", e.message);
        }
    });
    Ok(exchange)
}

#[command(trust = trusted)]
pub fn http_history(host: &Host, window: &str) -> IdeResult<Vec<HistoryEntry>> {
    Ok(host.project(window)?.http_history.list())
}

#[command(trust = trusted)]
pub fn http_history_get(host: &Host, window: &str, id: String) -> IdeResult<HttpExchange> {
    host.project(window)?.http_history.get(&id)
}

#[command(trust = trusted)]
pub fn http_history_clear(host: &Host, window: &str) -> IdeResult<()> {
    host.project(window)?.http_history.clear()
}

/// Convert to cURL and Copy: request `index` of `text` (the editor buffer of `path`), with
/// the variables of `env` substituted, as a cURL command.
#[command(trust = trusted)]
pub async fn http_curl(
    host: &Host,
    window: &str,
    path: Option<IpcPath>,
    text: String,
    index: u32,
    env: Option<String>,
) -> IdeResult<String> {
    let root = root(host, window);
    blocking(move || {
        ide_http::curl(&ide_http::RunInput {
            text: &text,
            index,
            file: path.as_deref(),
            root: root.as_deref(),
            env: env.as_deref(),
        })
    })
    .await
}

/// The environment file for the request file `path` (`is_private`: the private one): the nearest
/// existing one, else a new one next to it.
#[command(trust = trusted)]
pub async fn http_environment_file(host: &Host, window: &str, path: IpcPath, is_private: bool) -> IdeResult<IpcPath> {
    let root = root(host, window);
    blocking(move || ide_http::env::environment_file(&path, root.as_deref(), is_private).map(IpcPath::from)).await
}

/// Where `{{name}}` is defined in the environment files that apply to request file `path`
/// (Navigate › Declaration on a variable), private file first.
#[command(trust = trusted)]
pub async fn http_variable_definitions(
    host: &Host,
    window: &str,
    path: IpcPath,
    name: String,
) -> IdeResult<Vec<Location>> {
    let root = root(host, window);
    blocking(move || Ok(ide_http::env::variable_definitions(&path, root.as_deref(), &name))).await
}

ide_command::domain!(
    http: http_curl,
    http_environment_file,
    http_environments,
    http_execute,
    http_history,
    http_history_clear,
    http_history_get,
    http_variable_definitions,
);
