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
use std::collections::HashSet;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt};

#[derive(Default)]
struct BridgeState {
    preferred: Option<SocketAddr>,
    init_message: Option<Value>,
    initialized_on: HashSet<SocketAddr>,
}

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
/// writes what it answers, if anything, one message per line to `output`: the
/// answer, and before it the progress notifications of a long call.
pub async fn bridge<R, W>(discovery: &Path, project: &Path, input: R, mut output: W) -> std::io::Result<()>
where
    R: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let scope = crate::server::new_token()?;
    let state = Arc::new(Mutex::new(BridgeState::default()));
    let mut lines = input.lines();
    let mut pending = tokio::task::JoinSet::new();
    let (sent, mut received) = tokio::sync::mpsc::unbounded_channel::<Value>();
    let mut eof = false;
    loop {
        if eof && pending.is_empty() && received.is_empty() {
            break;
        }
        let reply = tokio::select! {
            line = lines.next_line(), if !eof => {
                let Some(line) = line? else { eof = true; continue };
                if line.trim().is_empty() { continue; }
                match serde_json::from_str::<Value>(&line) {
                    Ok(message) => {
                        if is_initialize(&message) {
                            state.lock().unwrap().init_message = Some(message.clone());
                        }
                        let (discovery, project, scope, sent, state) =
                            (discovery.to_owned(), project.to_owned(), scope.clone(), sent.clone(), state.clone());
                        pending.spawn(async move {
                            if let Some(reply) = relay(&discovery, &project, &message, &scope, &sent, &state).await {
                                let _ = sent.send(reply);
                            }
                        });
                        continue;
                    }
                    Err(e) => Some(error_response(Value::Null, -32700, &format!("not JSON: {e}"))),
                }
            }
            Some(message) = received.recv() => Some(message),
            done = pending.join_next(), if !pending.is_empty() => {
                if let Some(Err(e)) = done {
                    return Err(std::io::Error::other(e));
                }
                continue;
            }
        };
        if let Some(reply) = reply {
            output.write_all(reply.to_string().as_bytes()).await?;
            output.write_all(b"\n").await?;
            output.flush().await?;
        }
    }
    Ok(())
}

fn is_initialize(message: &Value) -> bool {
    message.get("method").and_then(Value::as_str) == Some("initialize")
}

/// The IDE's answer to `message`, or an error response for each request in
/// it when the IDE can't be reached. An answer on an event stream goes to `sent`
/// with the messages before it.
async fn relay(
    discovery: &Path,
    project: &Path,
    message: &Value,
    scope: &str,
    sent: &tokio::sync::mpsc::UnboundedSender<Value>,
    state: &Mutex<BridgeState>,
) -> Option<Value> {
    let failure = match post(discovery, project, message, scope, sent, state).await {
        Ok(Answer::Streamed { answered: true }) => return None,
        Ok(Answer::Streamed { answered: false }) => "OpenIDEA's answer ended early".to_owned(),
        Ok(Answer::Body(StatusCode::ACCEPTED, _)) => return None,
        Ok(Answer::Body(_, body)) if !body.is_empty() => match serde_json::from_slice::<Value>(&body) {
            Ok(reply) => return Some(reply),
            Err(_) => String::from_utf8_lossy(&body).trim().to_owned(),
        },
        Ok(Answer::Body(status, _)) => format!("OpenIDEA answered {status}"),
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

enum Answer {
    Body(StatusCode, Bytes),
    /// The messages of an event stream went to the channel; `answered`: one was a response.
    Streamed {
        answered: bool,
    },
}

/// POSTs `message` to the server in the discovery file; when several servers share a data
/// directory (multiple remote windows on one host), picks the one where `project` is open.
async fn post(
    discovery: &Path,
    project: &Path,
    message: &Value,
    scope: &str,
    sent: &tokio::sync::mpsc::UnboundedSender<Value>,
    state: &Mutex<BridgeState>,
) -> Result<Answer, String> {
    let not_running = || {
        format!(
            "OpenIDEA's MCP server is not running. Start OpenIDEA, open {} in it, and turn on Settings › Agents › MCP Server",
            project.display()
        )
    };
    let mut candidates = Discovery::candidates(discovery);
    if candidates.is_empty() {
        return Err(not_running());
    }
    if let Some(preferred) = state.lock().unwrap().preferred
        && let Some(pos) = candidates.iter().position(|c| SocketAddr::new(c.address, c.port) == preferred)
    {
        let chosen = candidates.remove(pos);
        candidates.insert(0, chosen);
    }
    let initializing = is_initialize(message);
    let mut fallback: Option<(SocketAddr, Answer)> = None;
    let mut last_error: Option<String> = None;
    let total = candidates.len();
    for (idx, info) in candidates.into_iter().enumerate() {
        let at = SocketAddr::new(info.address, info.port);
        if !initializing {
            let init = {
                let guard = state.lock().unwrap();
                (!guard.initialized_on.contains(&at)).then(|| guard.init_message.clone()).flatten()
            };
            if let Some(mut init_msg) = init {
                if let Some(obj) = init_msg.as_object_mut() {
                    obj.insert("id".into(), Value::String(format!("__openidea_init_{idx}__")));
                }
                if post_one(&info, project, &init_msg, scope, sent).await.is_ok() {
                    state.lock().unwrap().initialized_on.insert(at);
                }
            }
        }
        match post_one(&info, project, message, scope, sent).await {
            Ok(answer) => {
                if initializing {
                    state.lock().unwrap().initialized_on.insert(at);
                    if total > 1 && !serves_project(&info, project, scope).await {
                        fallback.get_or_insert((at, answer));
                        continue;
                    }
                } else if idx + 1 < total && is_not_open_reply(&answer) {
                    fallback = Some((at, answer));
                    continue;
                }
                state.lock().unwrap().preferred = Some(at);
                return Ok(answer);
            }
            Err(err) => last_error = Some(err),
        }
    }
    if let Some((at, answer)) = fallback {
        state.lock().unwrap().preferred = Some(at);
        return Ok(answer);
    }
    Err(last_error.unwrap_or_else(not_running))
}

/// Whether the server of `info` has `project` open: its `tools/list` doesn't answer "not open".
async fn serves_project(info: &Discovery, project: &Path, scope: &str) -> bool {
    let probe = serde_json::json!({ "jsonrpc": "2.0", "id": "__openidea_probe__", "method": "tools/list" });
    let (discard, _) = tokio::sync::mpsc::unbounded_channel();
    match post_one(info, project, &probe, scope, &discard).await {
        Ok(answer @ Answer::Body(StatusCode::OK, _)) => !is_not_open_reply(&answer),
        _ => false,
    }
}

fn is_not_open_reply(answer: &Answer) -> bool {
    let Answer::Body(StatusCode::OK, body) = answer else { return false };
    serde_json::from_slice::<Value>(body)
        .ok()
        .and_then(|v| v.pointer("/error/code").and_then(Value::as_i64))
        .is_some_and(|code| code == NOT_OPEN)
}

async fn post_one(
    info: &Discovery,
    project: &Path,
    message: &Value,
    scope: &str,
    sent: &tokio::sync::mpsc::UnboundedSender<Value>,
) -> Result<Answer, String> {
    let not_running = || {
        format!(
            "OpenIDEA's MCP server is not running. Start OpenIDEA, open {} in it, and turn on Settings › Agents › MCP Server",
            project.display()
        )
    };
    let at = SocketAddr::new(info.address, info.port);
    let stream = tokio::net::TcpStream::connect(at).await.map_err(|_| not_running())?;
    let (mut sender, conn) = hyper::client::conn::http1::handshake(hyper_util::rt::TokioIo::new(stream))
        .await
        .map_err(|e| format!("cannot reach OpenIDEA: {e}"))?;
    tokio::spawn(conn);
    let request = Request::post(format!("/mcp?project={}", crate::encode_query(&project.to_string_lossy())))
        .header(header::HOST, at.to_string())
        .header(header::AUTHORIZATION, format!("Bearer {}", info.token))
        .header("mcp-session-id", scope)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::ACCEPT, "application/json, text/event-stream")
        .body(Full::new(Bytes::from(message.to_string())))
        .map_err(|e| e.to_string())?;
    let response = sender.send_request(request).await.map_err(|e| format!("cannot reach OpenIDEA: {e}"))?;
    let status = response.status();
    let streamed = response
        .headers()
        .get(header::CONTENT_TYPE)
        .is_some_and(|v| v.to_str().is_ok_and(|v| v.starts_with("text/event-stream")));
    let mut body = response.into_body();
    if !streamed {
        let body = body.collect().await.map_err(|e| format!("OpenIDEA's answer: {e}"))?.to_bytes();
        return Ok(Answer::Body(status, body));
    }
    let (mut buffer, mut answered) = (Vec::new(), false);
    while let Some(frame) = body.frame().await {
        let frame = frame.map_err(|e| format!("OpenIDEA's answer: {e}"))?;
        let Ok(data) = frame.into_data() else { continue };
        buffer.extend_from_slice(&data);
        for data in take_events(&mut buffer) {
            if let Ok(message) = serde_json::from_str::<Value>(&data) {
                answered |= message.get("method").is_none();
                let _ = sent.send(message);
            }
        }
    }
    Ok(Answer::Streamed { answered })
}

/// The `data` of each complete server-sent event at the start of `buffer`, which keeps
/// the rest. Comments and other fields are skipped.
fn take_events(buffer: &mut Vec<u8>) -> Vec<String> {
    let mut events = Vec::new();
    while let Some(end) = buffer.windows(2).position(|w| w == b"\n\n") {
        let block: Vec<u8> = buffer.drain(..end + 2).collect();
        let block = String::from_utf8_lossy(&block).replace("\r\n", "\n");
        let data: Vec<&str> = block
            .lines()
            .filter_map(|line| line.strip_prefix("data:"))
            .map(|d| d.strip_prefix(' ').unwrap_or(d))
            .collect();
        if !data.is_empty() {
            events.push(data.join("\n"));
        }
    }
    events
}

#[cfg(test)]
mod tests {
    use super::take_events;

    #[test]
    fn events_are_taken_whole_and_comments_skipped() {
        let mut buffer = b": running\n\nevent: message\ndata: {\"a\":1}\n\nevent: message\ndata: {\"b\"".to_vec();
        assert_eq!(take_events(&mut buffer), ["{\"a\":1}"]);
        assert_eq!(buffer, b"event: message\ndata: {\"b\"");
        buffer.extend_from_slice(b":2}\n\n");
        assert_eq!(take_events(&mut buffer), ["{\"b\":2}"]);
        assert!(buffer.is_empty());
    }
}
