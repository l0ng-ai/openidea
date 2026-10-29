//! The shim against recorded Claude Code sessions, and its pure translations.
//!
//! Fixtures under `tests/fixtures/claude/` hold what went over the CLI's stdio in a real
//! session driven through the shim: `{"launch": [args]}` starts a process, then
//! `{"from": "shim"|"cli", "msg": …}` frames in order. Replaying plays the CLI's side
//! back, waiting for each frame the shim sends before it sends what followed it.
//! Re-record with `cargo test -p ide-agent record_claude_fixtures -- --ignored` (needs a
//! signed-in `claude`; uses Haiku).

use super::*;
use std::collections::VecDeque;
use std::future::Future;
use std::pin::Pin;
use tokio::io::AsyncBufReadExt;

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/claude");
const WAIT: Duration = Duration::from_secs(20);

// ---------- the client side ----------

#[derive(Default)]
struct Seen {
    /// `(sessionId, update)`.
    updates: Vec<(String, Value)>,
    /// `session/request_permission` params.
    asked: Vec<Value>,
}

struct TestClient {
    seen: Arc<Mutex<Seen>>,
    /// Option ids to choose, in order (`None`: cancel).
    answers: Arc<Mutex<VecDeque<Option<&'static str>>>>,
}

impl Handler for TestClient {
    fn on_notification(&self, method: &str, params: Value) {
        if method == "session/update" {
            let session = params["sessionId"].as_str().unwrap_or_default().to_owned();
            self.seen.lock().updates.push((session, params["update"].clone()));
        }
    }

    fn on_request(&self, method: &str, params: Value) -> Result<Value, (i64, String)> {
        assert_eq!(method, "session/request_permission");
        self.seen.lock().asked.push(params);
        Ok(match self.answers.lock().pop_front().flatten() {
            Some(id) => json!({ "outcome": { "outcome": "selected", "optionId": id } }),
            None => json!({ "outcome": { "outcome": "cancelled" } }),
        })
    }
}

struct Harness {
    cli: Arc<dyn Cli>,
    config_dir: PathBuf,
    pending_dir: PathBuf,
    cwd: PathBuf,
    args: Vec<String>,
    client: Peer,
    seen: Arc<Mutex<Seen>>,
    answers: Arc<Mutex<VecDeque<Option<&'static str>>>>,
    /// Against the real CLI.
    recording: bool,
}

impl Harness {
    async fn connect(
        cli: Arc<dyn Cli>,
        config_dir: PathBuf,
        pending_dir: PathBuf,
        cwd: PathBuf,
        args: Vec<String>,
    ) -> Self {
        let seen = Arc::new(Mutex::new(Seen::default()));
        let answers = Arc::new(Mutex::new(VecDeque::new()));
        let config = Config {
            program: "claude".into(),
            args: args.clone(),
            env: Vec::new(),
            config_dir: Some(config_dir.clone()),
            pending_dir: pending_dir.clone(),
            cwd: cwd.clone(),
        };
        let shim = Shim::new(config, cli.clone(), Arc::new(|line| eprintln!("[claude] {line}")));
        let client = super::super::serve(shim, Arc::new(TestClient { seen: seen.clone(), answers: answers.clone() }));
        let init: Value = client
            .request("initialize", json!({ "protocolVersion": 1, "clientCapabilities": { "subagents": {} } }), None)
            .await
            .unwrap();
        assert_eq!(init["agentCapabilities"]["loadSession"], true);
        Self { cli, config_dir, pending_dir, cwd, args, client, seen, answers, recording: false }
    }

    /// A new connection to the same CLI and directories (the app restarted).
    async fn reconnect(&self) -> Self {
        self.client.kill();
        let h = Self::connect(
            self.cli.clone(),
            self.config_dir.clone(),
            self.pending_dir.clone(),
            self.cwd.clone(),
            self.args.clone(),
        )
        .await;
        Self { recording: self.recording, ..h }
    }

    async fn request(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        tokio::time::timeout(Duration::from_secs(180), self.client.request(method, params, None))
            .await
            .unwrap_or(Err(RpcError::Timeout))
    }

    async fn new_session(&self) -> String {
        let r = self.request("session/new", json!({ "cwd": self.cwd, "mcpServers": [] })).await.unwrap();
        r["sessionId"].as_str().unwrap().to_owned()
    }

    async fn prompt(&self, session: &str, text: &str) -> Result<Value, RpcError> {
        self.request("session/prompt", json!({ "sessionId": session, "prompt": [{ "type": "text", "text": text }] }))
            .await
    }

    fn answer(&self, answers: &[Option<&'static str>]) {
        self.answers.lock().extend(answers.iter().copied());
    }

    /// Waits for the trailing updates of a turn (they are delivered on their own thread).
    async fn settle(&self) {
        tokio::time::sleep(Duration::from_millis(150)).await;
    }

    fn updates(&self, session: &str, kind: &str) -> Vec<Value> {
        self.seen
            .lock()
            .updates
            .iter()
            .filter(|(s, u)| s == session && u["sessionUpdate"] == kind)
            .map(|(_, u)| u.clone())
            .collect()
    }

    fn text(&self, session: &str, kind: &str) -> String {
        self.updates(session, kind).iter().filter_map(|u| u["content"]["text"].as_str()).collect()
    }
}

// ---------- scenarios: recorded against the real CLI, replayed in tests ----------

type Outcome = Vec<(String, Result<Value, String>)>;

fn outcome(label: &str, r: Result<Value, RpcError>) -> (String, Result<Value, String>) {
    let r = r.map_err(|e| match e {
        RpcError::Server { message, data, .. } => format!("{message} {}", data.unwrap_or_default()),
        e => e.to_string(),
    });
    (label.to_owned(), r)
}

async fn simple(h: &Harness) -> (Outcome, String) {
    let s = h.new_session().await;
    let r = h.prompt(&s, "Reply with exactly: hello there").await;
    (vec![outcome("prompt", r)], s)
}

async fn multi_turn(h: &Harness) -> (Outcome, String) {
    let s = h.new_session().await;
    let a = h.prompt(&s, "Remember the word PEACH. Reply with just OK.").await;
    let b = h.prompt(&s, "Which word did I ask you to remember? Reply with just the word.").await;
    (vec![outcome("first", a), outcome("second", b)], s)
}

async fn tool_approval(h: &Harness) -> (Outcome, String) {
    let s = h.new_session().await;
    h.answer(&[Some("allow"), Some("reject")]);
    let r = h
        .prompt(
            &s,
            "Use the Write tool to create notes.txt containing exactly 'one'. Then use the Edit tool to \
             replace 'one' with 'two' in it. One tool at a time, no other tools. If a tool is refused, stop \
             and say so in one sentence.",
        )
        .await;
    (vec![outcome("prompt", r)], s)
}

async fn interrupt(h: &Harness) -> (Outcome, String) {
    let s = h.new_session().await;
    let prompt = h.prompt(&s, "Count from 1 to 300, one number per line.");
    let cancel = async {
        tokio::time::sleep(Duration::from_millis(30)).await;
        h.client.notify("session/cancel", json!({ "sessionId": s })).unwrap();
    };
    let (r, ()) = tokio::join!(prompt, cancel);
    // The session still works.
    let again = h.prompt(&s, "Reply with exactly: still here").await;
    (vec![outcome("cancelled", r), outcome("again", again)], s)
}

async fn steer(h: &Harness) -> (Outcome, String) {
    let s = h.new_session().await;
    let prompt = h.prompt(&s, "Run the Bash command `sleep 3 && echo done`, then tell me its output in one line.");
    let steer = async {
        tokio::time::sleep(Duration::from_millis(2500)).await;
        h.request(
            "_openidea/steer",
            json!({ "sessionId": s, "prompt": [{ "type": "text", "text": "Also end your answer with the word BANANA." }] }),
        )
        .await
    };
    let (r, steered) = tokio::join!(prompt, steer);
    (vec![outcome("prompt", r), outcome("steer", steered)], s)
}

async fn subagent(h: &Harness) -> (Outcome, String) {
    let s = h.new_session().await;
    h.answer(&[Some("allow"), Some("allow")]);
    let r = h
        .prompt(
            &s,
            "Use the Agent tool exactly once (subagent_type general-purpose, model haiku, run_in_background false) \
             with the prompt: 'Run the Bash command `echo sub` and reply with its output only.' Then tell me \
             what it said.",
        )
        .await;
    if h.recording {
        // A background subagent reports after the turn.
        tokio::time::sleep(Duration::from_secs(8)).await;
    }
    (vec![outcome("prompt", r)], s)
}

/// Prompts, then loads the session in a new connection and prompts again.
async fn resume(h: &Harness) -> (Outcome, String) {
    let s = h.new_session().await;
    let a = h.prompt(&s, "Remember the word MANGO. Reply with just OK.").await;
    h.settle().await;
    let h2 = h.reconnect().await;
    on_reload(&h2, &s);
    let loaded = h2.request("session/load", json!({ "sessionId": s, "cwd": h2.cwd, "mcpServers": [] })).await;
    let b = h2.prompt(&s, "Which word did I ask you to remember? Reply with just the word.").await;
    h2.settle().await;
    // The second connection's updates, for the assertions.
    *h.seen.lock() = std::mem::take(&mut *h2.seen.lock());
    (vec![outcome("first", a), outcome("load", loaded), outcome("second", b)], s)
}

type ScenarioFn = for<'a> fn(&'a Harness) -> Pin<Box<dyn Future<Output = (Outcome, String)> + Send + 'a>>;

const SCENARIOS: &[(&str, ScenarioFn)] = &[
    ("simple", |h| Box::pin(simple(h))),
    ("multi_turn", |h| Box::pin(multi_turn(h))),
    ("tool_approval", |h| Box::pin(tool_approval(h))),
    ("interrupt", |h| Box::pin(interrupt(h))),
    ("steer", |h| Box::pin(steer(h))),
    ("subagent", |h| Box::pin(subagent(h))),
    ("resume", |h| Box::pin(resume(h))),
];

fn scenario(name: &str) -> ScenarioFn {
    SCENARIOS.iter().find(|(n, _)| *n == name).unwrap().1
}

/// Before a reload in a replay: the session's transcript, as it was recorded.
fn on_reload(h: &Harness, session: &str) {
    let fixture = Path::new(FIXTURES).join("resume.transcript.jsonl");
    if !h.recording && fixture.exists() {
        let dir = h.config_dir.join("projects").join(history::escape(&h.cwd));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::copy(fixture, dir.join(format!("{session}.jsonl"))).unwrap();
    }
}

// ---------- replaying ----------

#[derive(Clone)]
enum Frame {
    Launch(Vec<String>),
    Shim(Value),
    Cli(Value),
}

fn load_fixture(name: &str) -> Vec<Vec<Frame>> {
    let path = Path::new(FIXTURES).join(format!("{name}.jsonl"));
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    let mut out: Vec<Vec<Frame>> = Vec::new();
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        let v: Value = serde_json::from_str(line).unwrap();
        if let Some(args) = v.get("launch") {
            out.push(vec![Frame::Launch(strings(Some(args)))]);
        } else if let Some(last) = out.last_mut() {
            last.push(match v["from"].as_str() {
                Some("shim") => Frame::Shim(v["msg"].clone()),
                _ => Frame::Cli(v["msg"].clone()),
            });
        }
    }
    out
}

/// What a frame is, for matching the shim's frames to the recorded ones.
fn frame_kind(m: &Value) -> String {
    let sub = m.pointer("/request/subtype").and_then(Value::as_str).unwrap_or_default();
    format!("{}/{sub}", m["type"].as_str().unwrap_or_default())
}

/// Plays the CLI's side of recorded processes.
struct Replay {
    processes: Mutex<VecDeque<Vec<Frame>>>,
    /// What the shim sent, per process.
    sent: Arc<Mutex<Vec<Vec<Value>>>>,
    launched: Mutex<Vec<Vec<String>>>,
    errors: Arc<Mutex<Vec<String>>>,
}

impl Cli for Replay {
    fn launch(&self, launch: &Launch, _: OnStderr) -> std::io::Result<cli::CliIo> {
        let mut frames =
            self.processes.lock().pop_front().ok_or_else(|| std::io::Error::other("no more recorded processes"))?;
        if let Some(Frame::Launch(recorded)) = frames.first() {
            // The same flags (the recording passed `--model haiku`; ids differ).
            let flags = |args: &[String]| {
                args.iter().filter(|a| a.starts_with("--") && *a != "--model").cloned().collect::<Vec<_>>()
            };
            if flags(recorded) != flags(&launch.args) {
                self.errors.lock().push(format!("launched with {:?}, recorded {recorded:?}", launch.args));
            }
            frames.remove(0);
        }
        self.launched.lock().push(launch.args.clone());
        let (shim_in, cli_in) = tokio::io::duplex(1 << 20);
        let (mut cli_out, shim_out) = tokio::io::duplex(1 << 20);
        let kill = CancellationToken::new();
        let (sent, errors, token) = (self.sent.clone(), self.errors.clone(), kill.clone());
        sent.lock().push(Vec::new());
        tokio::spawn(async move {
            let mut lines = BufReader::new(cli_in).lines();
            let mut subs: Vec<(String, String)> = Vec::new();
            for frame in frames {
                match frame {
                    Frame::Launch(_) => {}
                    Frame::Cli(msg) => {
                        let mut line = msg.to_string();
                        for (from, to) in &subs {
                            line = line.replace(from.as_str(), to);
                        }
                        if cli_out.write_all(format!("{line}\n").as_bytes()).await.is_err() {
                            return;
                        }
                    }
                    Frame::Shim(expected) => {
                        let got = tokio::select! {
                            l = tokio::time::timeout(WAIT, lines.next_line()) => l,
                            _ = token.cancelled() => return,
                        };
                        let Ok(Ok(Some(line))) = got else {
                            errors.lock().push(format!("the shim never sent {}", frame_kind(&expected)));
                            return;
                        };
                        let got: Value = serde_json::from_str(&line).unwrap();
                        if frame_kind(&got) != frame_kind(&expected) {
                            errors.lock().push(format!("expected {}, the shim sent {line}", frame_kind(&expected)));
                        }
                        for key in ["/request_id", "/uuid"] {
                            if let (Some(from), Some(to)) = (
                                expected.pointer(key).and_then(Value::as_str),
                                got.pointer(key).and_then(Value::as_str),
                            ) && from != to
                            {
                                subs.push((from.to_owned(), to.to_owned()));
                            }
                        }
                        sent.lock().last_mut().unwrap().push(got);
                    }
                }
            }
            // The recorded process lived on until it was stopped.
            loop {
                tokio::select! {
                    l = lines.next_line() => match l {
                        Ok(Some(line)) => {
                            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                                sent.lock().last_mut().unwrap().push(v);
                            }
                        }
                        _ => break,
                    },
                    _ = token.cancelled() => break,
                }
            }
            token.cancelled().await;
            drop(cli_out);
        });
        Ok(cli::CliIo { stdin: Box::pin(shim_in), stdout: Box::pin(shim_out), kill })
    }
}

struct Replayed {
    h: Harness,
    outcome: Outcome,
    session: String,
    cli: Arc<Replay>,
    _dirs: (tempfile::TempDir, tempfile::TempDir),
}

impl Replayed {
    fn result(&self, label: &str) -> &Result<Value, String> {
        &self.outcome.iter().find(|(l, _)| l == label).unwrap().1
    }

    fn stop(&self, label: &str) -> String {
        match self.result(label) {
            Ok(v) => v["stopReason"].as_str().unwrap_or_default().to_owned(),
            Err(e) => panic!("{label} failed: {e}"),
        }
    }

    /// The frames the shim sent to process `n`.
    fn sent(&self, n: usize) -> Vec<Value> {
        self.cli.sent.lock()[n].clone()
    }
}

async fn replay(name: &str) -> Replayed {
    let processes = load_fixture(name);
    let cli = Arc::new(Replay {
        processes: Mutex::new(processes.into()),
        sent: Arc::default(),
        launched: Mutex::default(),
        errors: Arc::default(),
    });
    let (config, cwd) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let cwd_path = std::fs::canonicalize(cwd.path()).unwrap();
    let h =
        Harness::connect(cli.clone(), config.path().into(), config.path().join("pending"), cwd_path, Vec::new()).await;
    let (outcome, session) = scenario(name)(&h).await;
    h.settle().await;
    assert!(cli.errors.lock().is_empty(), "{name}: {:?}", cli.errors.lock());
    Replayed { h, outcome, session, cli, _dirs: (config, cwd) }
}

#[tokio::test(flavor = "multi_thread")]
async fn replay_simple() {
    let r = replay("simple").await;
    assert_eq!(r.stop("prompt"), "end_turn");
    assert!(r.h.text(&r.session, "agent_message_chunk").to_lowercase().contains("hello there"));
    // Streamed as it came, and not again from the whole message.
    assert!(
        r.h.updates(&r.session, "agent_message_chunk").len() > 1
            || r.h.text(&r.session, "agent_message_chunk").len() < 20
    );
    let usage = r.h.updates(&r.session, "usage_update");
    assert!(usage.last().is_some_and(|u| u["used"].as_u64() > Some(0) && u["size"].as_u64() > Some(0)), "{usage:?}");
    let commands = r.h.updates(&r.session, "available_commands_update");
    assert!(commands.iter().any(|c| c["availableCommands"].as_array().is_some_and(|a| !a.is_empty())));
    // The process ran as the Agent SDK runs it, with the session's id.
    let args = r.cli.launched.lock()[0].clone();
    assert!(args.windows(2).any(|w| w == ["--session-id", r.session.as_str()]), "{args:?}");
    assert!(args.contains(&"--permission-prompt-tool".to_owned()));
    let user = r.sent(0).into_iter().find(|m| m["type"] == "user").unwrap();
    assert_eq!(user["message"]["content"][0]["text"], "Reply with exactly: hello there");
}

#[tokio::test(flavor = "multi_thread")]
async fn replay_multi_turn() {
    let r = replay("multi_turn").await;
    assert_eq!((r.stop("first"), r.stop("second")), ("end_turn".into(), "end_turn".into()));
    assert!(r.h.text(&r.session, "agent_message_chunk").contains("PEACH"));
}

#[tokio::test(flavor = "multi_thread")]
async fn replay_tool_approval() {
    let r = replay("tool_approval").await;
    assert_eq!(r.stop("prompt"), "end_turn");
    let asked = r.h.seen.lock().asked.clone();
    assert_eq!(asked.len(), 2, "{asked:?}");
    assert_eq!(asked[0]["toolCall"]["kind"], "edit");
    assert!(asked[0]["toolCall"]["title"].as_str().unwrap().starts_with("Write"));
    let kinds: Vec<&str> =
        asked[0]["options"].as_array().unwrap().iter().map(|o| o["kind"].as_str().unwrap()).collect();
    assert_eq!(kinds, ["allow_once", "allow_always", "reject_once"]);
    let calls = r.h.updates(&r.session, "tool_call");
    let write = calls.iter().find(|c| c["title"].as_str().is_some_and(|t| t.starts_with("Write"))).unwrap();
    let id = write["toolCallId"].as_str().unwrap();
    let done: Vec<Value> =
        r.h.updates(&r.session, "tool_call_update").into_iter().filter(|u| u["toolCallId"] == id).collect();
    assert!(done.iter().any(|u| u["status"] == "completed"
        && u["content"][0]["type"] == "diff"
        && u["content"][0]["newText"] == "one"));
    let edit =
        r.h.updates(&r.session, "tool_call_update")
            .into_iter()
            .find(|u| u["status"] == "failed" && u["toolCallId"] != id);
    assert!(edit.is_some(), "the refused edit failed");
    // The CLI got an allow, then a deny.
    let answers: Vec<Value> = r
        .sent(0)
        .into_iter()
        .filter(|m| m["type"] == "control_response")
        .map(|m| m["response"]["response"]["behavior"].clone())
        .collect();
    assert_eq!(answers, [json!("allow"), json!("deny")]);
}

#[tokio::test(flavor = "multi_thread")]
async fn replay_interrupt() {
    let r = replay("interrupt").await;
    assert_eq!(r.stop("cancelled"), "cancelled");
    assert_eq!(r.stop("again"), "end_turn");
    assert!(r.sent(0).iter().any(|m| m["request"]["subtype"] == "interrupt"));
}

#[tokio::test(flavor = "multi_thread")]
async fn replay_steer() {
    let r = replay("steer").await;
    assert!(r.result("steer").is_ok(), "{:?}", r.result("steer"));
    assert_eq!(r.stop("prompt"), "end_turn");
    assert!(r.h.text(&r.session, "agent_message_chunk").contains("BANANA"));
    let steer = r.sent(0).into_iter().filter(|m| m["type"] == "user").nth(1).unwrap();
    assert_eq!(steer["priority"], "now");
    assert!(steer["uuid"].as_str().unwrap().ends_with(history::STEER_MARK));
}

#[tokio::test(flavor = "multi_thread")]
async fn replay_subagent() {
    let r = replay("subagent").await;
    assert_eq!(r.stop("prompt"), "end_turn");
    let subs = r.h.updates(&r.session, "subagent_update");
    let child = subs.first().expect("a subagent")["sessionId"].as_str().unwrap().to_owned();
    assert_eq!(subs[0]["state"]["state"], "running");
    assert!(subs.iter().any(|u| u["state"]["state"] == "idle" && u["state"]["stopReason"] == "end_turn"), "{subs:?}");
    let messages = r.h.updates(&r.session, "session_message");
    assert!(messages.iter().any(|m| m["recipientSessionId"] == child));
    let answer = messages.iter().find(|m| m["senderSessionId"] == child).expect("the answer");
    assert_eq!(answer["content"][0]["text"], "sub");
    // Its own work is in its own session.
    assert!(!r.h.updates(&child, "tool_call").is_empty() || !r.h.updates(&child, "agent_message_chunk").is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn replay_resume() {
    let r = replay("resume").await;
    assert_eq!(r.stop("first"), "end_turn");
    assert!(r.result("load").is_ok(), "{:?}", r.result("load"));
    assert_eq!(r.stop("second"), "end_turn");
    // History came back before the load answered, the prompt included.
    assert!(r.h.text(&r.session, "user_message_chunk").contains("MANGO"));
    assert!(r.h.text(&r.session, "agent_message_chunk").contains("MANGO"));
    let args = r.cli.launched.lock()[1].clone();
    assert!(args.windows(2).any(|w| w == ["--resume", r.session.as_str()]), "{args:?}");
}

// ---------- recording ----------

/// Passes the real CLI's stdio through, keeping what went over it.
struct Recorder {
    log: Arc<Mutex<Vec<Value>>>,
}

impl Cli for Recorder {
    fn launch(&self, launch: &Launch, on_stderr: OnStderr) -> std::io::Result<cli::CliIo> {
        let real = cli::Process.launch(launch, on_stderr)?;
        self.log.lock().push(json!({ "launch": launch.args }));
        let (shim_in, from_shim) = tokio::io::duplex(1 << 20);
        let (mut to_shim, shim_out) = tokio::io::duplex(1 << 20);
        let (log, mut stdin) = (self.log.clone(), real.stdin);
        tokio::spawn(async move {
            let mut lines = BufReader::new(from_shim).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if let Ok(v) = serde_json::from_str::<Value>(&line) {
                    log.lock().push(json!({ "from": "shim", "msg": v }));
                }
                if stdin.write_all(format!("{line}\n").as_bytes()).await.is_err() {
                    break;
                }
                let _ = stdin.flush().await;
            }
        });
        let log = self.log.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(real.stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if let Ok(v) = serde_json::from_str::<Value>(&line) {
                    log.lock().push(json!({ "from": "cli", "msg": v }));
                }
                if to_shim.write_all(format!("{line}\n").as_bytes()).await.is_err() {
                    break;
                }
            }
        });
        Ok(cli::CliIo { stdin: Box::pin(shim_in), stdout: Box::pin(shim_out), kill: real.kill })
    }
}

/// Drops what is private or only noise: the account, settings, hooks, the user's skills.
fn scrub(frame: &mut Value) -> bool {
    let Some(msg) = frame.get_mut("msg") else { return true };
    let sub = msg.get("subtype").and_then(Value::as_str).unwrap_or_default().to_owned();
    if msg["type"] == "system" && sub.starts_with("hook_") {
        return false;
    }
    if msg["type"] == "system" && sub == "init" {
        for k in ["tools", "mcp_servers", "slash_commands", "skills", "plugins", "agents", "messaging_socket_path"] {
            if let Some(o) = msg.as_object_mut() {
                o.remove(k);
            }
        }
    }
    if msg["type"] == "system" && sub == "commands_changed" {
        msg["commands"] = json!([{ "name": "review", "description": "Review a pull request", "argumentHint": "" }]);
    }
    if let Some(r) = msg.pointer_mut("/response/response")
        && let Some(o) = r.as_object_mut()
    {
        if o.contains_key("commands") {
            o.insert(
                "commands".into(),
                json!([{ "name": "review", "description": "Review a pull request", "argumentHint": "" },
                       { "name": "init", "description": "Write a CLAUDE.md", "argumentHint": "" }]),
            );
            for k in ["agents", "account", "available_output_styles", "user_output_styles_dir", "output_style"] {
                o.remove(k);
            }
        }
        if let Some(applied) = o.get("applied").cloned() {
            let model = o.get("effective").and_then(|e| e.get("model")).cloned();
            o.clear();
            o.insert("applied".into(), applied);
            o.insert("effective".into(), json!({ "model": model }));
        }
    }
    strip(msg);
    true
}

/// Signatures, request ids and the like.
fn strip(v: &mut Value) {
    match v {
        Value::Object(o) => {
            o.remove("signature");
            for (_, x) in o.iter_mut() {
                strip(x);
            }
        }
        Value::Array(a) => a.iter_mut().for_each(strip),
        Value::String(s) => {
            if let Some(home) = std::env::var_os("HOME").map(|h| h.to_string_lossy().into_owned())
                && s.contains(&home)
            {
                *s = s.replace(&home, "/home/user");
            }
        }
        _ => {}
    }
}

fn scrub_transcript(path: &Path) -> String {
    let entries = history::read(path).unwrap();
    let mut out = String::new();
    for mut e in entries {
        if !matches!(e["type"].as_str(), Some("user" | "assistant" | "ai-title")) {
            // The chain still needs every link.
            let Some(o) = e.as_object() else { continue };
            if !o.contains_key("uuid") {
                continue;
            }
            e = json!({ "type": e["type"], "uuid": e["uuid"], "parentUuid": e["parentUuid"], "isSidechain": e["isSidechain"] });
        }
        strip(&mut e);
        out.push_str(&e.to_string());
        out.push('\n');
    }
    out
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "drives the real claude CLI (signed in); rewrites the fixtures"]
async fn record_claude_fixtures() {
    let only = std::env::var("CLAUDE_SCENARIO").ok();
    std::fs::create_dir_all(FIXTURES).unwrap();
    for (name, run) in SCENARIOS {
        if only.as_deref().is_some_and(|o| o != *name) {
            continue;
        }
        let log = Arc::new(Mutex::new(Vec::new()));
        let cwd = tempfile::tempdir().unwrap();
        let pending = tempfile::tempdir().unwrap();
        let cwd_path = std::fs::canonicalize(cwd.path()).unwrap();
        let config_dir = cli::config_dir(&[]).unwrap();
        let h = Harness::connect(
            Arc::new(Recorder { log: log.clone() }),
            config_dir.clone(),
            pending.path().into(),
            cwd_path.clone(),
            vec!["--model".into(), "haiku".into()],
        )
        .await;
        let h = Harness { recording: true, ..h };
        let (outcome, session) = run(&h).await;
        h.settle().await;
        h.client.kill();
        tokio::time::sleep(Duration::from_millis(500)).await;
        eprintln!("{name}: {outcome:?}");
        let mut text = String::new();
        for mut frame in log.lock().clone() {
            if scrub(&mut frame) {
                text.push_str(&frame.to_string());
                text.push('\n');
            }
        }
        std::fs::write(Path::new(FIXTURES).join(format!("{name}.jsonl")), text).unwrap();
        if *name == "resume" {
            let path = history::transcript(&config_dir, &cwd_path, &session);
            std::fs::write(Path::new(FIXTURES).join("resume.transcript.jsonl"), scrub_transcript(&path)).unwrap();
        }
    }
}

/// A stop that reaches the shim before its prompt (they race) still stops the turn.
#[tokio::test(flavor = "multi_thread")]
async fn a_stop_ahead_of_its_prompt_cancels_it() {
    // The recorded start of a session, and nothing more.
    let mut process = load_fixture("simple").remove(0);
    process.truncate(5);
    let cli = Arc::new(Replay {
        processes: Mutex::new(VecDeque::from([process])),
        sent: Arc::default(),
        launched: Mutex::default(),
        errors: Arc::default(),
    });
    let (dir, cwd) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let h = Harness::connect(cli.clone(), dir.path().into(), dir.path().join("p"), cwd.path().into(), Vec::new()).await;
    let s = h.new_session().await;
    h.client.notify("session/cancel", json!({ "sessionId": s })).unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    let r = h.prompt(&s, "hi").await.unwrap();
    assert_eq!(r["stopReason"], "cancelled");
    assert!(cli.sent.lock()[0].iter().all(|m| m["type"] != "user"), "nothing was sent");
}

/// Fork and undo against the real CLI, across connections, in a symlinked directory
/// (macOS `/tmp`).
#[tokio::test(flavor = "multi_thread")]
#[ignore = "drives the real claude CLI (signed in)"]
async fn live_fork_and_rollback() {
    let base = tempfile::Builder::new().prefix("openidea-claude-").tempdir_in("/tmp").unwrap();
    let cwd = base.path().to_path_buf(); // /tmp/…: a symlink on macOS
    let pending = tempfile::tempdir().unwrap();
    let config_dir = cli::config_dir(&[]).unwrap();
    let args = vec!["--model".to_owned(), "haiku".to_owned()];
    let connect = || {
        Harness::connect(Arc::new(cli::Process), config_dir.clone(), pending.path().into(), cwd.clone(), args.clone())
    };
    let words = "List every word I asked you to remember, comma separated, uppercase, nothing else.";
    let last = |h: &Harness, s: &str| h.text(s, "agent_message_chunk");

    let h = connect().await;
    let s = h.new_session().await;
    h.prompt(&s, "Remember the word APPLE. Reply with just OK.").await.unwrap();
    h.prompt(&s, "Remember the word BOAT. Reply with just OK.").await.unwrap();
    let fork: Value = h.request("session/fork", json!({ "sessionId": s, "cwd": cwd, "mcpServers": [] })).await.unwrap();
    let f = fork["sessionId"].as_str().unwrap().to_owned();
    assert_ne!(f, s);

    // The copy, loaded by a fresh connection, its last turn dropped.
    let h2 = connect().await;
    h2.request("session/load", json!({ "sessionId": f, "cwd": cwd, "mcpServers": [] })).await.unwrap();
    assert!(h2.text(&f, "user_message_chunk").contains("BOAT"), "history replayed");
    h2.request("_openidea/rollback", json!({ "sessionId": f, "turns": 1 })).await.unwrap();
    h2.prompt(&f, words).await.unwrap();
    h2.settle().await;
    let answer = last(&h2, &f);
    assert!(answer.contains("APPLE") && !answer.contains("BOAT"), "fork: {answer}");

    // The original still has both.
    h.prompt(&s, words).await.unwrap();
    h.settle().await;
    assert!(last(&h, &s).contains("BOAT"), "original: {}", last(&h, &s));

    // Undo in the original, then reload it elsewhere before prompting: the undo holds.
    h.request("_openidea/rollback", json!({ "sessionId": s, "turns": 2 })).await.unwrap();
    let h3 = connect().await;
    h3.request("session/load", json!({ "sessionId": s, "cwd": cwd, "mcpServers": [] })).await.unwrap();
    assert!(!h3.text(&s, "user_message_chunk").contains("List every"), "the undone turns are gone");
    h3.prompt(&s, words).await.unwrap();
    h3.settle().await;
    let answer = last(&h3, &s);
    assert!(answer.contains("APPLE") && !answer.contains("BOAT"), "rolled back: {answer}");
}

// ---------- pure translations ----------

#[test]
fn prompts_become_user_messages() {
    let m = user_message(
        &json!([
            {"type": "text", "text": "look"},
            {"type": "resource", "resource": {"uri": "file:///p/a.rs", "text": "fn a() {}"}},
            {"type": "resource_link", "uri": "file:///p/b.rs", "name": "b.rs"},
            {"type": "image", "mimeType": "image/png", "data": "AAA"}
        ]),
        "u1",
        false,
    );
    assert_eq!(m["uuid"], "u1");
    assert_eq!(m["origin"], json!({"kind": "human"}));
    assert_eq!(
        m["message"]["content"],
        json!([
            {"type": "text", "text": "look"},
            {"type": "text", "text": "[@a.rs](file:///p/a.rs)"},
            {"type": "text", "text": "[@b.rs](file:///p/b.rs)"},
            {"type": "image", "source": {"type": "base64", "data": "AAA", "media_type": "image/png"}},
            {"type": "text", "text": "\n<context ref=\"file:///p/a.rs\">\nfn a() {}\n</context>"}
        ])
    );
    assert!(new_uuid(true).ends_with(history::STEER_MARK));
    assert!(!new_uuid(false).ends_with(history::STEER_MARK));
}

fn turn(uuids: &[&str], cancelled: bool) -> Turn {
    Turn { uuids: uuids.iter().map(|u| (*u).to_owned()).collect(), done: None, cancelled, failure: None }
}

#[test]
fn which_result_ends_a_turn() {
    let t = turn(&["a", "b"], false);
    assert!(belongs(&t, &json!({"user_message_uuids": ["b"]})));
    assert!(!belongs(&t, &json!({"user_message_uuids": ["a"]})), "a steer superseded it");
    assert!(belongs(&t, &json!({"subtype": "error_during_execution"})), "names no message");
    assert!(!belongs(&t, &json!({"origin": {"kind": "task-notification"}})), "Claude Code's own turn");
    assert!(belongs(&turn(&["a", "b"], true), &json!({"user_message_uuids": ["a"]})));
}

#[test]
fn how_results_end_turns() {
    let t = turn(&["a"], false);
    let end = |r: Value| turn_end(&t, &r, Some(1.5e12));
    assert_eq!(end(json!({"subtype": "success", "stop_reason": "end_turn"})), TurnEnd::Stop("end_turn"));
    assert_eq!(end(json!({"subtype": "success", "stop_reason": "max_tokens"})), TurnEnd::Stop("max_tokens"));
    assert_eq!(
        end(json!({"subtype": "error_during_execution", "is_error": true, "terminal_reason": "aborted_streaming"})),
        TurnEnd::Stop("cancelled")
    );
    assert_eq!(turn_end(&turn(&["a"], true), &json!({"subtype": "success"}), None), TurnEnd::Stop("cancelled"));
    assert_eq!(
        end(
            json!({"subtype": "success", "is_error": true, "api_error_status": 429, "result": "You've hit your limit · resets 3pm"})
        ),
        TurnEnd::Fail {
            message: "You've hit your limit · resets 3pm".into(),
            data: Some(json!({"openidea": {"usageLimit": {"resetsAtMs": 1.5e12}}})),
        }
    );
    let TurnEnd::Fail { message, .. } =
        end(json!({"is_error": true, "api_error_status": 403, "result": "API Error: 403"}))
    else {
        panic!()
    };
    assert!(message.contains("authentication"));
    let TurnEnd::Fail { message, .. } =
        end(json!({"subtype": "error_during_execution", "is_error": true, "errors": ["[ede_diagnostic] x", "boom"]}))
    else {
        panic!()
    };
    assert_eq!(message, "boom");
}

#[test]
fn failures_reported_as_assistant_messages() {
    let synthetic = |text: &str, error: Option<&str>| json!({"type": "assistant", "error": error, "message": {"model": "<synthetic>", "content": [{"type": "text", "text": text}]}});
    let limit = failure_of(&synthetic("You've hit your limit · resets 5pm", Some("rate_limit")), Some(7.0)).unwrap();
    assert_eq!(
        limit,
        TurnEnd::Fail {
            message: "You've hit your limit · resets 5pm".into(),
            data: Some(json!({"openidea": {"usageLimit": {"resetsAtMs": 7.0}}})),
        }
    );
    let TurnEnd::Fail { message, data: None } =
        failure_of(&synthetic("Invalid API key · Please run /login", Some("authentication_failed")), None).unwrap()
    else {
        panic!()
    };
    assert!(message.contains("auth"));
    let real = json!({"type": "assistant", "message": {"model": "claude-haiku-5-5", "content": [{"type": "text", "text": "You've hit your stride"}]}});
    assert_eq!(failure_of(&real, None), None);
}

#[test]
fn permission_answers() {
    let input = json!({"command": "ls"});
    let suggestions = json!([{"type": "addRules", "rules": [{"toolName": "Bash", "ruleContent": "ls"}], "behavior": "allow", "destination": "localSettings"}]);
    let always = permission_result("Bash", &input, "t", Some(&suggestions), Some("allow-always"));
    assert_eq!(always["behavior"], "allow");
    assert_eq!(always["updatedPermissions"][0]["destination"], "session");
    assert_eq!(always["updatedInput"], input);
    let fallback = permission_result("Bash", &input, "t", None, Some("allow-always"));
    assert_eq!(fallback["updatedPermissions"][0]["rules"][0]["toolName"], "Bash");
    assert_eq!(permission_result("Bash", &input, "t", None, Some("reject"))["behavior"], "deny");
    assert_eq!(permission_result("Bash", &input, "t", None, None)["behavior"], "deny");
    let plan = permission_result("ExitPlanMode", &json!({"plan": "p"}), "t", None, Some("plan-accept-edits"));
    assert_eq!(
        plan["updatedPermissions"][0],
        json!({"type": "setMode", "mode": "acceptEdits", "destination": "session"})
    );
}

#[test]
fn pending_starts_round_trip() {
    for s in [
        Start::New { id: "a".into() },
        Start::Resume { id: "a".into(), at: Some("u".into()) },
        Start::Fork { from: "a".into(), id: "b".into(), at: None },
    ] {
        assert_eq!(start_from_json(&start_json(&s)), Some(s));
    }
}

#[test]
fn api_retries_are_announced() {
    let mut t = Translator::new("s", PathBuf::from("/w"), true);
    let out = t.on_message(&json!({"type": "system", "subtype": "api_retry", "attempt": 3, "max_retries": 10,
        "retry_delay_ms": 4000, "error_status": null, "error": "Connection error."}));
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].session, "s");
    assert_eq!(
        out[0].update,
        json!({"sessionUpdate": crate::RETRY_UPDATE, "attempt": 3, "maxRetries": 10, "retryDelayMs": 4000,
            "error": "Connection error."})
    );
}

#[test]
fn streamed_text_is_not_sent_twice() {
    let mut t = Translator::new("s", PathBuf::from("/w"), true);
    let se = |event: Value| json!({"type": "stream_event", "parent_tool_use_id": null, "event": event});
    let mut out = Vec::new();
    out.extend(t.on_message(&se(
        json!({"type": "message_start", "message": {"id": "m1", "model": "x", "usage": {"input_tokens": 10}}}),
    )));
    out.extend(t.on_message(&se(
        json!({"type": "content_block_start", "index": 0, "content_block": {"type": "thinking", "thinking": ""}}),
    )));
    out.extend(t.on_message(&se(
        json!({"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "hm"}}),
    )));
    out.extend(t.on_message(&se(
        json!({"type": "content_block_start", "index": 1, "content_block": {"type": "text", "text": ""}}),
    )));
    out.extend(t.on_message(&se(
        json!({"type": "content_block_delta", "index": 1, "delta": {"type": "text_delta", "text": "Hel"}}),
    )));
    // The whole message: its thinking, then its text (one more piece than streamed).
    let whole = |content: Value| {
        json!({"type": "assistant", "parent_tool_use_id": null,
        "message": {"id": "m1", "model": "x", "content": content, "usage": {"input_tokens": 10, "output_tokens": 5}}})
    };
    out.extend(t.on_message(&whole(json!([{"type": "thinking", "thinking": "hm"}]))));
    out.extend(t.on_message(&whole(json!([{"type": "text", "text": "Hello"}]))));
    let texts: Vec<(&str, &str)> = out
        .iter()
        .filter_map(|u| Some((u.update["sessionUpdate"].as_str()?, u.update["content"]["text"].as_str()?)))
        .collect();
    assert_eq!(texts, [("agent_thought_chunk", "hm"), ("agent_message_chunk", "Hel"), ("agent_message_chunk", "lo")]);
    // Usage needs the window, which a result reports.
    let usage = t.on_result(&json!({"modelUsage": {"x": {"contextWindow": 1000}}}));
    assert_eq!(usage[0].update, json!({"sessionUpdate": "usage_update", "used": 15, "size": 1000}));
}

#[test]
fn tool_calls_plans_and_subagents() {
    let mut t = Translator::new("s", PathBuf::from("/w"), true);
    let assistant = |parent: Value, content: Value| json!({"type": "assistant", "parent_tool_use_id": parent, "message": {"id": "m", "model": "x", "content": content}});
    let user = |parent: Value, content: Value, structured: Value| json!({"type": "user", "parent_tool_use_id": parent, "message": {"role": "user", "content": content}, "tool_use_result": structured});
    let todo = t.on_message(&assistant(
        Value::Null,
        json!([{"type": "tool_use", "id": "td", "name": "TodoWrite", "input": {"todos": [{"content": "a", "status": "pending"}]}}]),
    ));
    assert_eq!(todo[0].update["sessionUpdate"], "plan");
    let launch = t.on_message(&assistant(
        Value::Null,
        json!([{"type": "tool_use", "id": "ag", "name": "Agent", "input": {"description": "Look", "subagent_type": "Explore", "prompt": "find it"}}]),
    ));
    let kinds: Vec<(&str, &str)> =
        launch.iter().map(|u| (u.session.as_str(), u.update["sessionUpdate"].as_str().unwrap())).collect();
    assert_eq!(kinds, [("s", "subagent_update"), ("s", "session_message"), ("ag", "session_message")]);
    t.on_message(&json!({"type": "system", "subtype": "task_started", "task_id": "a1", "tool_use_id": "ag", "task_type": "local_agent"}));
    assert_eq!(t.session_of_agent(Some("a1")), "ag");
    assert_eq!(t.agent_of("ag").as_deref(), Some("a1"));
    // The subagent's own tool call goes to its session.
    let inner = t.on_message(&assistant(
        json!("ag"),
        json!([{"type": "tool_use", "id": "b1", "name": "Bash", "input": {"command": "ls"}}]),
    ));
    assert_eq!((inner[0].session.as_str(), inner[0].update["sessionUpdate"].as_str()), ("ag", Some("tool_call")));
    let done = t.on_message(&user(
        json!("ag"),
        json!([{"type": "tool_result", "tool_use_id": "b1", "content": "x"}]),
        json!({"stdout": "x", "stderr": ""}),
    ));
    assert_eq!(done[0].update["status"], "completed");
    t.on_message(&assistant(json!("ag"), json!([{"type": "text", "text": "It is x"}])));
    // Launched in the background: it reports in a task notification.
    let launched = t.on_message(&user(
        Value::Null,
        json!([{"type": "tool_result", "tool_use_id": "ag", "content": "Async agent launched"}]),
        json!({"status": "async_launched"}),
    ));
    assert!(launched.is_empty());
    let finished = t.on_message(
        &json!({"type": "system", "subtype": "task_notification", "tool_use_id": "ag", "status": "completed"}),
    );
    assert_eq!(finished[0].update["state"], json!({"state": "idle", "stopReason": "end_turn"}));
    assert_eq!(finished[1].update["content"][0]["text"], "It is x");
    assert_eq!(finished[1].update["senderSessionId"], "ag");
}
