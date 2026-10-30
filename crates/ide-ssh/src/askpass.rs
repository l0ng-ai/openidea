//! Credential prompts of child processes (`ssh`, `git`) answered by the UI.
//!
//! The app's own executable doubles as the `SSH_ASKPASS` / `GIT_ASKPASS`
//! program: started with [`PORT_ENV`] set, it sends the prompt to the
//! [`AskpassServer`] on 127.0.0.1 and prints the answer ([`run_helper`]).

use ide_core::{IdeError, IdeResult};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::time::Duration;

pub const PORT_ENV: &str = "OPENIDEA_ASKPASS_PORT";
pub const COMMAND_ENV: &str = "OPENIDEA_GIT_COMMAND_ID";
pub const TOKEN_ENV: &str = "OPENIDEA_ASKPASS_TOKEN";
/// An unanswered prompt fails after this long.
const ANSWER_TIMEOUT: Duration = Duration::from_secs(300);

pub use ide_core::event::AskpassKind;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AskpassPrompt {
    pub id: u64,
    pub prompt: String,
    pub kind: AskpassKind,
}

pub fn classify(prompt: &str) -> AskpassKind {
    let p = prompt.to_ascii_lowercase();
    if p.contains("(yes/no") || p.contains("continue connecting") {
        AskpassKind::Confirm
    } else if p.starts_with("username") {
        AskpassKind::Text
    } else {
        AskpassKind::Secret
    }
}

/// Whether the UI's credential dialog should offer to remember the answer:
/// git's HTTPS password prompts only (the user name travels inside them).
pub fn remembers(prompt: &str) -> bool {
    crate::git_creds::prompt_key(prompt).is_some() && classify(prompt) == AskpassKind::Secret
}

#[derive(Serialize, Deserialize)]
struct Request {
    #[serde(default)]
    command_id: Option<u64>,
    token: String,
    prompt: String,
}

#[derive(Serialize, Deserialize)]
struct Response {
    answer: Option<String>,
}

type Pending = Arc<Mutex<HashMap<u64, PendingPrompt>>>;

struct PendingPrompt {
    command_id: Option<u64>,
    prompt: String,
    tx: mpsc::Sender<Option<String>>,
}

/// Serves prompts to `on_prompt`; answers come back through [`AskpassServer::answer`].
pub struct AskpassServer {
    port: u16,
    token: String,
    exe: std::path::PathBuf,
    pending: Pending,
}

impl AskpassServer {
    /// Listens on a free local port. `exe` is the helper program (the app itself).
    pub fn start(exe: std::path::PathBuf, on_prompt: Arc<dyn Fn(AskpassPrompt) + Send + Sync>) -> IdeResult<Self> {
        let listener = TcpListener::bind(("127.0.0.1", 0))?;
        let port = listener.local_addr()?.port();
        let token = random_token();
        let pending: Pending = Arc::default();
        let (t, p) = (token.clone(), pending.clone());
        std::thread::Builder::new()
            .name("askpass".into())
            .spawn(move || {
                let next = AtomicU64::new(1);
                for stream in listener.incoming().flatten() {
                    let id = next.fetch_add(1, Ordering::Relaxed);
                    let (t, p, on_prompt) = (t.clone(), p.clone(), on_prompt.clone());
                    let _ = std::thread::Builder::new()
                        .name("askpass-prompt".into())
                        .spawn(move || serve(stream, id, &t, &p, on_prompt.as_ref()));
                }
            })
            .map_err(|e| IdeError::internal(format!("askpass: {e}")))?;
        Ok(Self { port, token, exe, pending })
    }

    /// Answers prompt `id` (`None`: cancelled). `remember` asks the git
    /// credential store to keep the answer once the command succeeds.
    pub fn answer(&self, id: u64, answer: Option<String>, remember: bool) {
        if let Some(p) = self.pending.lock().remove(&id) {
            if let Some(a) = answer.as_deref()
                && let Some(command_id) = p.command_id
                && let Some(store) = crate::git_creds::get()
            {
                store.answered(command_id, &p.prompt, a, remember);
            }
            let _ = p.tx.send(answer);
        }
    }

    /// Environment that routes `ssh` / `git` prompts here.
    pub fn env(&self) -> Vec<(String, String)> {
        let exe = self.exe.to_string_lossy().into_owned();
        vec![
            (PORT_ENV.into(), self.port.to_string()),
            (TOKEN_ENV.into(), self.token.clone()),
            ("SSH_ASKPASS".into(), exe.clone()),
            ("SSH_ASKPASS_REQUIRE".into(), "force".into()),
            ("GIT_ASKPASS".into(), exe),
        ]
    }
}

fn serve(
    stream: TcpStream,
    id: u64,
    token: &str,
    pending: &Pending,
    on_prompt: &(dyn Fn(AskpassPrompt) + Send + Sync),
) {
    let mut line = String::new();
    // The helper writes its request at once: an idle connection must not hold a thread.
    let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(10)));
    let Ok(mut reader) = stream.try_clone().map(BufReader::new) else { return };
    if reader.read_line(&mut line).is_err() {
        return;
    }
    let Ok(req) = serde_json::from_str::<Request>(&line) else { return };
    let answer = if req.token != token {
        None
    } else {
        let prompt = req.prompt.trim().to_owned();
        // A saved git HTTPS credential answers silently; a rejected one is
        // forgotten by `git_creds::command_finished`, not here (the command
        // may still be running and could retry).
        if let Some(command_id) = req.command_id
            && let Some(store) = crate::git_creds::get()
            && let Some(answer) = store.answer_saved(command_id, &prompt)
        {
            let mut out = stream;
            let _ = writeln!(out, "{}", serde_json::to_string(&Response { answer: Some(answer) }).unwrap_or_default());
            return;
        }
        let (tx, rx) = mpsc::channel();
        pending.lock().insert(id, PendingPrompt { command_id: req.command_id, prompt: prompt.clone(), tx });
        on_prompt(AskpassPrompt { id, kind: classify(&prompt), prompt });
        let answer = rx.recv_timeout(ANSWER_TIMEOUT).ok().flatten();
        pending.lock().remove(&id);
        answer
    };
    let mut out = stream;
    let _ = writeln!(out, "{}", serde_json::to_string(&Response { answer }).unwrap_or_default());
}

fn random_token() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    // Two independently seeded SipHash keys: unpredictable to other local users.
    (0..2)
        .map(|_| {
            let mut h = RandomState::new().build_hasher();
            h.write_u128(
                std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos(),
            );
            format!("{:016x}", h.finish())
        })
        .collect()
}

/// When started as the askpass helper (by `ssh` / `git`), forwards the prompt
/// (the first argument) and returns the exit code; `None` otherwise.
pub fn run_helper() -> Option<i32> {
    let port: u16 = std::env::var(PORT_ENV).ok()?.parse().ok()?;
    let token = std::env::var(TOKEN_ENV).unwrap_or_default();
    let prompt = std::env::args().nth(1).unwrap_or_else(|| "Password:".into());
    let command_id = std::env::var(COMMAND_ENV).ok().and_then(|id| id.parse().ok());
    let ask = || -> std::io::Result<Option<String>> {
        let mut stream = TcpStream::connect(("127.0.0.1", port))?;
        writeln!(stream, "{}", serde_json::to_string(&Request { command_id, token, prompt }).unwrap_or_default())?;
        let mut line = String::new();
        BufReader::new(stream).read_line(&mut line)?;
        Ok(serde_json::from_str::<Response>(&line).ok().and_then(|r| r.answer))
    };
    match ask() {
        Ok(Some(answer)) => {
            println!("{answer}");
            Some(0)
        }
        _ => Some(1),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_prompts() {
        assert_eq!(classify("Enter passphrase for key '/u/.ssh/id_ed25519': "), AskpassKind::Secret);
        assert_eq!(classify("git@github.com's password: "), AskpassKind::Secret);
        assert_eq!(classify("Username for 'https://github.com': "), AskpassKind::Text);
        assert_eq!(
            classify("Are you sure you want to continue connecting (yes/no/[fingerprint])? "),
            AskpassKind::Confirm
        );
    }

    #[test]
    fn round_trips_a_prompt() {
        let seen: Arc<Mutex<Option<AskpassPrompt>>> = Arc::default();
        let s = seen.clone();
        let server = Arc::new(AskpassServer::start("helper".into(), Arc::new(move |p| *s.lock() = Some(p))).unwrap());
        let port = server.port;
        let token = server.token.clone();
        let client = std::thread::spawn(move || {
            let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
            writeln!(
                stream,
                "{}",
                serde_json::to_string(&Request { command_id: Some(42), token, prompt: "Password: ".into() }).unwrap()
            )
            .unwrap();
            let mut line = String::new();
            BufReader::new(stream).read_line(&mut line).unwrap();
            serde_json::from_str::<Response>(&line).unwrap().answer
        });
        let id = loop {
            if let Some(p) = seen.lock().clone() {
                assert_eq!((p.prompt.as_str(), p.kind), ("Password:", AskpassKind::Secret));
                break p.id;
            }
            std::thread::sleep(Duration::from_millis(5));
        };
        assert_eq!(server.pending.lock().get(&id).unwrap().command_id, Some(42));
        server.answer(id, Some("hunter2".into()), false);
        assert_eq!(client.join().unwrap().as_deref(), Some("hunter2"));
        assert!(server.env().iter().any(|(k, v)| k == "SSH_ASKPASS" && v == "helper"));
    }
}
