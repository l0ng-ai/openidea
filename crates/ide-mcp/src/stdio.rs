//! The stdio bridge: `<app exe> --mcp-stdio [--project <path>]`. MCP clients
//! that start servers as processes (and configurations that must not hold a
//! token) talk newline-delimited JSON-RPC to it; it relays each message to the
//! running IDE's server, found through the discovery file.

use crate::discovery::Discovery;
use crate::protocol::{NOT_OPEN, error_response};
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::{Request, StatusCode, header};
use serde_json::Value;
use std::path::{Path, PathBuf};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt};

/// Runs the bridge on this process's stdin and stdout until stdin closes.
/// `project` defaults to the current directory. Returns the exit code.
pub fn run(discovery: &Path, project: Option<PathBuf>) -> i32 {
    let cwd = std::env::current_dir().unwrap_or_default();
    let project = project.map_or_else(|| cwd.clone(), |p| if p.is_absolute() { p } else { cwd.join(p) });
    let runtime = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("openidea --mcp-stdio: {e}");
            return 1;
        }
    };
    let stdin = tokio::io::BufReader::new(tokio::io::stdin());
    match runtime.block_on(bridge(discovery, &project, stdin, tokio::io::stdout())) {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("openidea --mcp-stdio: {e}");
            1
        }
    }
}

/// Relays each line of `input` (a JSON-RPC message or batch) to the IDE and
/// writes its answer, if any, as one line to `output`.
pub async fn bridge<R, W>(discovery: &Path, project: &Path, input: R, mut output: W) -> std::io::Result<()>
where
    R: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let scope = crate::server::new_token()?;
    let mut lines = input.lines();
    let mut pending = tokio::task::JoinSet::new();
    let mut eof = false;
    loop {
        let reply = tokio::select! {
            line = lines.next_line(), if !eof => {
                let Some(line) = line? else { eof = true; continue };
                if line.trim().is_empty() { continue; }
                match serde_json::from_str::<Value>(&line) {
                    Ok(message) => {
                        let (discovery, project, scope) = (discovery.to_owned(), project.to_owned(), scope.clone());
                        pending.spawn(async move { relay(&discovery, &project, &message, &scope).await });
                        continue;
                    }
                    Err(e) => Some(error_response(Value::Null, -32700, &format!("not JSON: {e}"))),
                }
            }
            reply = pending.join_next(), if !pending.is_empty() => match reply { Some(reply) => reply.map_err(std::io::Error::other)?, None => None },
            else => break,
        };
        if let Some(reply) = reply {
            output.write_all(reply.to_string().as_bytes()).await?;
            output.write_all(b"\n").await?;
            output.flush().await?;
        }
    }
    Ok(())
}

/// The IDE's answer to `message`, or an error response for each request in
/// it when the IDE can't be reached.
async fn relay(discovery: &Path, project: &Path, message: &Value, scope: &str) -> Option<Value> {
    let failure = match post(discovery, project, message, scope).await {
        Ok((StatusCode::ACCEPTED, _)) => return None,
        Ok((_, body)) if !body.is_empty() => match serde_json::from_slice::<Value>(&body) {
            Ok(reply) => return Some(reply),
            Err(_) => String::from_utf8_lossy(&body).trim().to_owned(),
        },
        Ok((status, _)) => format!("OpenIDEA answered {status}"),
        Err(e) => e,
    };
    let errors: Vec<Value> = requests(message).into_iter().map(|id| error_response(id, NOT_OPEN, &failure)).collect();
    match (message, errors.len()) {
        (_, 0) => None,
        (Value::Array(_), _) => Some(Value::Array(errors)),
        (_, _) => errors.into_iter().next(),
    }
}

/// Ids of the requests in a message or batch (notifications have none).
fn requests(message: &Value) -> Vec<Value> {
    let ids = |m: &Value| m.get("method").is_some().then(|| m.get("id").cloned()).flatten();
    match message {
        Value::Array(batch) => batch.iter().filter_map(ids).collect(),
        m => ids(m).into_iter().collect(),
    }
}

/// POSTs `message` to the server in the discovery file; a message for the
/// user when that fails.
async fn post(discovery: &Path, project: &Path, message: &Value, scope: &str) -> Result<(StatusCode, Bytes), String> {
    let not_running = || {
        format!(
            "OpenIDEA's MCP server is not running. Start OpenIDEA, open {} in it, and turn on Settings › Agents › MCP Server",
            project.display()
        )
    };
    let info = Discovery::read(discovery).map_err(|_| not_running())?;
    let stream = tokio::net::TcpStream::connect(("127.0.0.1", info.port)).await.map_err(|_| not_running())?;
    let (mut sender, conn) = hyper::client::conn::http1::handshake(hyper_util::rt::TokioIo::new(stream))
        .await
        .map_err(|e| format!("cannot reach OpenIDEA: {e}"))?;
    tokio::spawn(conn);
    let request = Request::post(format!("/mcp?project={}", crate::encode_query(&project.to_string_lossy())))
        .header(header::HOST, format!("127.0.0.1:{}", info.port))
        .header(header::AUTHORIZATION, format!("Bearer {}", info.token))
        .header("mcp-session-id", scope)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::ACCEPT, "application/json, text/event-stream")
        .body(Full::new(Bytes::from(message.to_string())))
        .map_err(|e| e.to_string())?;
    let response = sender.send_request(request).await.map_err(|e| format!("cannot reach OpenIDEA: {e}"))?;
    let status = response.status();
    let body = response.into_body().collect().await.map_err(|e| format!("OpenIDEA's answer: {e}"))?.to_bytes();
    Ok((status, body))
}
