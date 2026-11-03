//! Recorded agent transcripts, replayed through the real task machinery.
//!
//! A fixture is a JSONL file of the frames one agent connection carried, in order:
//! `{"from":"client"|"agent","msg":{…}}`. Recording runs a scenario against the real
//! agent and saves what went over its stdio; replaying plays the agent's side back,
//! waiting for each client frame before it sends what followed it. Client frames are
//! matched by kind and method, not content (prompts carry temp paths and timestamps), and
//! may arrive out of their recorded order when they race (a stop and an answer).

use crate::Connector;
use ide_jsonrpc::{Framing, Peer};
use parking_lot::Mutex;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

/// How long a replay waits for a client frame before giving up.
const CLIENT_WAIT: Duration = Duration::from_secs(10);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum From {
    Client,
    Agent,
}

#[derive(Clone, Debug)]
pub(crate) struct Frame {
    pub from: From,
    pub msg: Value,
}

pub(crate) fn load(path: &Path) -> Vec<Vec<Frame>> {
    let text = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    let mut connections: Vec<Vec<Frame>> = Vec::new();
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        let v: Value = serde_json::from_str(line).unwrap();
        // `{"connection": n}` starts the frames of the n-th agent process.
        if v.get("connection").is_some() {
            connections.push(Vec::new());
            continue;
        }
        let from = match v["from"].as_str() {
            Some("client") => From::Client,
            _ => From::Agent,
        };
        if connections.is_empty() {
            connections.push(Vec::new());
        }
        connections.last_mut().unwrap().push(Frame { from, msg: v["msg"].clone() });
    }
    connections
}

fn kind(msg: &Value) -> (&'static str, String) {
    let method = msg.get("method").and_then(Value::as_str).unwrap_or_default().to_owned();
    match (msg.get("id").is_some(), msg.get("method").is_some()) {
        (true, true) => ("request", method),
        (false, true) => ("notification", method),
        _ => ("response", String::new()),
    }
}

/// What went wrong in a replay, for the test to assert on.
#[derive(Default)]
pub(crate) struct Report {
    pub problems: Vec<String>,
    /// Client methods the replay saw, in order.
    pub calls: Vec<String>,
}

/// Plays one recorded connection's agent side over `stream`.
async fn play(frames: Vec<Frame>, stream: tokio::io::DuplexStream, report: Arc<Mutex<Report>>) {
    let (read, mut write) = tokio::io::split(stream);
    let mut lines = BufReader::new(read).lines();
    // Recorded request id → the id the client used this time.
    let mut ids: HashMap<String, Value> = HashMap::new();
    let mut early: Vec<Value> = Vec::new();
    for frame in frames {
        match frame.from {
            From::Agent => {
                let mut msg = frame.msg;
                if kind(&msg).0 == "response"
                    && let Some(actual) = msg.get("id").and_then(|id| ids.get(&id.to_string()))
                {
                    msg["id"] = actual.clone();
                }
                let mut line = msg.to_string();
                line.push('\n');
                if write.write_all(line.as_bytes()).await.is_err() {
                    return;
                }
            }
            From::Client => {
                let want = kind(&frame.msg);
                let found = match early.iter().position(|m| kind(m) == want) {
                    Some(i) => Some(early.remove(i)),
                    None => loop {
                        let next = tokio::time::timeout(CLIENT_WAIT, lines.next_line()).await;
                        let Ok(Ok(Some(line))) = next else { break None };
                        let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
                        if msg.get("method").and_then(Value::as_str) == Some("$/cancelRequest") {
                            continue;
                        }
                        report.lock().calls.push(kind(&msg).1);
                        if kind(&msg) == want {
                            break Some(msg);
                        }
                        early.push(msg);
                    },
                };
                let Some(msg) = found else {
                    report.lock().problems.push(format!("the client never sent {want:?}"));
                    return;
                };
                if let (Some(recorded), Some(actual)) = (frame.msg.get("id"), msg.get("id"))
                    && want.0 == "request"
                {
                    ids.insert(recorded.to_string(), actual.clone());
                }
            }
        }
    }
    // The transcript is over: requests beyond it are a client behaving differently.
    let leftovers = early.into_iter().filter(|m| kind(m).0 == "request");
    report.lock().problems.extend(leftovers.map(|m| format!("unexpected {}", kind(&m).1)));
    while let Ok(Some(line)) = lines.next_line().await {
        if let Ok(msg) = serde_json::from_str::<Value>(&line) {
            let (k, method) = kind(&msg);
            if k != "response" && method != "$/cancelRequest" {
                report.lock().calls.push(method.clone());
            }
            if k == "request" {
                report.lock().problems.push(format!("unexpected {method}"));
                let reply = json!({ "jsonrpc": "2.0", "id": msg["id"], "error": { "code": -32601, "message": "not recorded" } });
                let _ = write.write_all(format!("{reply}\n").as_bytes()).await;
            }
        }
    }
}

/// Serves the fixture's connections in order, one per agent start.
pub(crate) fn replayer(path: &Path) -> (Connector, Arc<Mutex<Report>>) {
    let connections = Arc::new(Mutex::new(load(path).into_iter()));
    let report = Arc::new(Mutex::new(Report::default()));
    let rep = report.clone();
    let connector: Connector = Arc::new(move |_spec, _cwd, client, _stderr| {
        let frames = connections.lock().next().ok_or_else(|| std::io::Error::other("no more recorded connections"))?;
        let (ours, theirs) = tokio::io::duplex(1 << 20);
        tokio::spawn(play(frames, theirs, rep.clone()));
        let (r, w) = tokio::io::split(ours);
        Ok(Peer::connect_framed(r, w, client, Framing::Lines))
    });
    (connector, report)
}

/// Removes who the user is (account e-mail, organisation) from a recorded frame.
fn scrub(v: &mut Value) {
    match v {
        Value::Object(map) => {
            for (k, v) in map.iter_mut() {
                if matches!(k.as_str(), "email" | "organization" | "organizationName" | "accountUuid" | "account_id") {
                    *v = json!("redacted");
                } else if k == "availableCommands"
                    && let Some(list) = v.as_array_mut()
                {
                    // The user's own skills and plugins: a few are enough.
                    list.truncate(3);
                    list.iter_mut().for_each(scrub);
                } else {
                    scrub(v);
                }
            }
        }
        Value::Array(items) => items.iter_mut().for_each(scrub),
        Value::String(s) if s.contains('@') && s.contains('.') && !s.contains(' ') => *s = "redacted".into(),
        _ => {}
    }
}

/// Runs the real agent, saving every frame of every connection to `out`.
pub(crate) fn recorder(out: PathBuf) -> Connector {
    let file = Arc::new(Mutex::new(String::new()));
    let connections = Arc::new(Mutex::new(0u32));
    Arc::new(move |spec, cwd, client, on_stderr| {
        let program = {
            let path = Path::new(&spec.command);
            if path.components().count() > 1 || path.is_absolute() {
                path.to_path_buf()
            } else {
                let search = spec
                    .env
                    .iter()
                    .find(|(k, _)| k.eq_ignore_ascii_case("PATH"))
                    .map(|(_, v)| std::ffi::OsString::from(v))
                    .or_else(|| ide_core::process::shell_env().find(|(k, _)| k == "PATH").map(|(_, v)| v))
                    .or_else(|| ide_core::process::host_var_os("PATH"))
                    .unwrap_or_default();
                ide_core::process::find_executable(&spec.command, &search).unwrap_or_else(|| path.to_path_buf())
            }
        };
        let mut cmd = tokio::process::Command::new(&program);
        ide_core::process::prepare(cmd.as_std_mut());
        let mut child = cmd
            .args(&spec.args)
            .current_dir(cwd)
            .envs(ide_core::process::shell_env())
            .envs(spec.env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()?;
        let (stdin, stdout, stderr) = (child.stdin.take().unwrap(), child.stdout.take().unwrap(), child.stderr.take());
        let n = {
            let mut c = connections.lock();
            *c += 1;
            *c
        };
        let save = {
            let (file, out) = (file.clone(), out.clone());
            move |from: &str, mut msg: Value| {
                scrub(&mut msg);
                let line = json!({ "from": from, "msg": msg }).to_string();
                let mut f = file.lock();
                f.push_str(&line);
                f.push('\n');
                if let Some(dir) = out.parent() {
                    let _ = std::fs::create_dir_all(dir);
                }
                let _ = std::fs::write(&out, f.as_bytes());
            }
        };
        {
            let mut f = file.lock();
            f.push_str(&format!("{}\n", json!({ "connection": n })));
        }
        let (ours, theirs) = tokio::io::duplex(1 << 20);
        let (tr, mut tw) = tokio::io::split(theirs);
        let to_agent = save.clone();
        tokio::spawn(async move {
            let mut stdin = stdin;
            let mut lines = BufReader::new(tr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if let Ok(msg) = serde_json::from_str::<Value>(&line) {
                    to_agent("client", msg);
                }
                if stdin.write_all(format!("{line}\n").as_bytes()).await.is_err() {
                    break;
                }
            }
            drop(stdin);
            let _ = child.kill().await;
        });
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
                save("agent", msg);
                if tw.write_all(format!("{line}\n").as_bytes()).await.is_err() {
                    break;
                }
            }
        });
        if let Some(stderr) = stderr {
            tokio::spawn(ide_jsonrpc::output::read_lines(stderr, on_stderr));
        }
        let (r, w) = tokio::io::split(ours);
        Ok(Peer::connect_framed(r, w, client, Framing::Lines))
    })
}
