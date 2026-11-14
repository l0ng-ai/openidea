//! HTTP Client: IntelliJ-style `.http` request files.
//!
//! [`parse`] splits a file into requests, [`env`] resolves `{{variables}}` from
//! `http-client(.private).env.json`, [`exec`] sends a request (cancellable,
//! timed) and [`history`] keeps the responses. [`client`] builds every HTTP client
//! of the backend, with the proxy of System Settings › HTTP Proxy.

pub mod client;
pub mod curl;
pub mod env;
pub mod exec;
pub mod history;
pub mod parse;

pub use env::Environments;
pub use exec::{HttpResponse, PreparedRequest};
pub use history::{History, HistoryEntry, HttpExchange};
pub use parse::HttpRequestBlock;

use ide_core::{CancellationToken, IdeError, IdeResult, IpcPath};
use std::path::Path;

/// Where a request comes from and how to resolve it.
pub struct RunInput<'a> {
    pub text: &'a str,
    pub index: u32,
    /// The request file (`None` for an unsaved buffer).
    pub file: Option<&'a Path>,
    pub root: Option<&'a Path>,
    pub env: Option<&'a str>,
}

/// Prepares and sends request `index` of `text`. Preparation errors (bad
/// variables, missing includes) fail; transport errors are part of the exchange.
pub async fn run(input: RunInput<'_>, cancel: &CancellationToken) -> IdeResult<HttpExchange> {
    let request = prepare(&input)?;
    let time_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or_default();
    let result = exec::execute(&request, cancel).await;
    if let Err(e) = &result
        && e.kind == ide_core::error::ErrorKind::Cancelled
    {
        return Err(e.clone());
    }
    let (response, error) = match result {
        Ok(r) => (Some(r), None),
        Err(e) => (None, Some(e.message)),
    };
    Ok(HttpExchange {
        entry: HistoryEntry {
            id: uuid::Uuid::new_v4().simple().to_string(),
            time_ms,
            name: request.name.clone(),
            method: request.method.clone(),
            url: request.url.clone(),
            status: response.as_ref().map(|r| r.status),
            total_ms: response.as_ref().map(|r| r.total_ms),
            file: input.file.map(IpcPath::from),
            error,
        },
        request,
        response,
    })
}

/// Request `index` of `text` with its variables substituted and includes read.
pub fn prepare(input: &RunInput<'_>) -> IdeResult<PreparedRequest> {
    let parsed = parse::parse(input.text);
    let raw = parsed
        .requests
        .get(input.index as usize)
        .ok_or_else(|| IdeError::not_found(format!("no request #{}", input.index + 1)))?;
    let envs = Environments::load(input.file, input.root)?;
    exec::prepare(raw, &parsed.variables, &envs, input.env, input.file.and_then(Path::parent))
}

/// Convert to cURL and Copy: request `index` of `text`, resolved, as a cURL command.
pub fn curl(input: &RunInput<'_>) -> IdeResult<String> {
    prepare(input).map(|r| curl::to_curl(&r))
}

/// Environment names available to `file`.
pub fn environments(file: Option<&Path>, root: Option<&Path>) -> IdeResult<Vec<String>> {
    Ok(Environments::load(file, root)?.names())
}
