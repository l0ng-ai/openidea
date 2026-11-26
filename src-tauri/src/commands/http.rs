use ide_command::desktop_command;
use ide_core::IdeResult;
use ide_http::HttpRequestBlock;

/// The requests of an `.http` file (gutter run icons, Run All).
#[desktop_command(trust = trusted)]
#[tauri::command]
#[specta::specta]
pub fn http_requests(text: String) -> Vec<HttpRequestBlock> {
    ide_http::parse::requests(&text)
}

/// System Settings › HTTP Proxy › Check connection: GETs `url` through `proxy` as
/// edited (not yet applied); the response status, or why there was none.
#[desktop_command(trust = always)]
#[tauri::command]
#[specta::specta]
pub async fn proxy_check_connection(proxy: ide_core::settings::ProxySettings, url: String) -> IdeResult<String> {
    ide_http::client::check_connection(&proxy, &url, &ide_core::CancellationToken::new()).await
}

/// A pasted `curl …` command as `.http` request text; `None` when it isn't one.
#[desktop_command(trust = trusted)]
#[tauri::command]
#[specta::specta]
pub fn http_from_curl(command: String) -> Option<String> {
    ide_http::curl::from_curl(&command)
}

ide_command::desktop_domain!(http_from_curl, http_requests, proxy_check_connection);
