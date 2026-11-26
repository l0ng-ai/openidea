//! Resident javac processes (`java/java-build`, `ai.openidea.javac.Server`): one JVM per JDK
//! and JVM options, kept warm between builds, compiling one request at a time in process.
use super::*;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// A message of the server about one request.
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum Reply {
    Diagnostic {
        severity: String,
        path: Option<PathBuf>,
        /// 1-based.
        line: Option<u32>,
        /// 0-based UTF-16.
        column: Option<u32>,
        end_line: Option<u32>,
        end_column: Option<u32>,
        code: Option<String>,
        message: String,
    },
    /// A class (or resource) file javac wrote, and the source it came from.
    Output {
        path: PathBuf,
        source: Option<PathBuf>,
    },
    /// A source file an annotation processor wrote.
    Generated {
        path: PathBuf,
        source: Option<PathBuf>,
    },
    OutputText {
        text: String,
    },
    Done {
        success: bool,
        cancelled: bool,
    },
}

#[derive(Debug, Serialize)]
struct Request<'a> {
    id: u64,
    op: &'static str,
    options: &'a [String],
    sources: &'a [PathBuf],
    encoding: Option<&'a str>,
}

#[derive(Clone, Debug, Hash, PartialEq, Eq)]
pub struct ServerKey {
    pub java_home: PathBuf,
    /// Options of the compiler's JVM (`.mvn/jvm.config`: `--add-opens` for processors).
    pub jvm_args: Vec<String>,
}

type Pending = Arc<Mutex<HashMap<u64, mpsc::Sender<Reply>>>>;

pub struct JavacServer {
    child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
    pending: Pending,
    alive: Arc<AtomicBool>,
    next: AtomicU64,
    pub version: String,
}

impl JavacServer {
    fn start(jar: &Path, key: &ServerKey) -> IdeResult<Self> {
        let java = key.java_home.join("bin").join(if cfg!(windows) { "java.exe" } else { "java" });
        let mut cmd = Command::new(&java);
        cmd.args(&key.jvm_args)
            .args(["-XX:+UseSerialGC", "-XX:TieredStopAtLevel=1", "-Dfile.encoding=UTF-8", "-cp"])
            .arg(jar)
            .arg("ai.openidea.javac.Server")
            .env("JAVA_HOME", &key.java_home)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        ide_core::process::prepare(&mut cmd);
        ide_core::process::own_group(&mut cmd);
        let mut child =
            cmd.spawn().map_err(|e| IdeError::unavailable(format!("Cannot start javac ({}): {e}", java.display())))?;
        let stdin = child.stdin.take().expect("piped");
        let stdout = child.stdout.take().expect("piped");
        let pending: Pending = Arc::default();
        let alive = Arc::new(AtomicBool::new(true));
        let (ready_tx, ready_rx) = mpsc::channel::<Result<String, String>>();
        {
            let (pending, alive) = (pending.clone(), alive.clone());
            std::thread::Builder::new()
                .name("javac-server".into())
                .spawn(move || {
                    let mut ready = Some(ready_tx);
                    for line in BufReader::new(stdout).lines() {
                        let Ok(line) = line else { break };
                        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
                        match value.get("kind").and_then(|k| k.as_str()) {
                            Some("ready") => {
                                let version = value.get("version").and_then(|v| v.as_str()).unwrap_or("").to_owned();
                                if let Some(ready) = ready.take() {
                                    let _ = ready.send(Ok(version));
                                }
                                continue;
                            }
                            Some("fatal") => {
                                let message = value.get("message").and_then(|v| v.as_str()).unwrap_or("").to_owned();
                                if let Some(ready) = ready.take() {
                                    let _ = ready.send(Err(message));
                                }
                                continue;
                            }
                            _ => {}
                        }
                        let Some(id) = value.get("id").and_then(|v| v.as_u64()) else { continue };
                        let Ok(reply) = serde_json::from_value::<Reply>(value) else { continue };
                        let done = matches!(reply, Reply::Done { .. });
                        let mut pending = pending.lock().unwrap();
                        if let Some(tx) = pending.get(&id) {
                            let _ = tx.send(reply);
                        }
                        if done {
                            pending.remove(&id);
                        }
                    }
                    alive.store(false, Ordering::SeqCst);
                    // Requests still waiting learn that the server is gone.
                    for (_, tx) in pending.lock().unwrap().drain() {
                        let _ = tx.send(Reply::Diagnostic {
                            severity: "error".into(),
                            path: None,
                            line: None,
                            column: None,
                            end_line: None,
                            end_column: None,
                            code: None,
                            message: "The javac process exited".into(),
                        });
                        let _ = tx.send(Reply::Done { success: false, cancelled: false });
                    }
                    if let Some(ready) = ready.take() {
                        let _ = ready.send(Err("The javac process exited while starting".into()));
                    }
                })
                .map_err(|e| IdeError::internal(e.to_string()))?;
        }
        let version = match ready_rx.recv_timeout(Duration::from_secs(60)) {
            Ok(Ok(version)) => version,
            Ok(Err(message)) => {
                ide_core::process::kill_tree(&mut child);
                return Err(IdeError::unavailable(format!("Cannot start javac ({}): {message}", java.display())));
            }
            Err(_) => {
                ide_core::process::kill_tree(&mut child);
                return Err(IdeError::unavailable(format!("javac ({}) did not start", java.display())));
            }
        };
        Ok(JavacServer {
            child: Mutex::new(child),
            stdin: Mutex::new(stdin),
            pending,
            alive,
            next: AtomicU64::new(1),
            version,
        })
    }

    fn alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    fn send(&self, value: &impl Serialize) -> IdeResult<()> {
        let mut line = serde_json::to_vec(value).map_err(|e| IdeError::internal(e.to_string()))?;
        line.push(b'\n');
        let mut stdin = self.stdin.lock().unwrap();
        stdin.write_all(&line).and_then(|()| stdin.flush()).map_err(|e| IdeError::internal(format!("javac: {e}")))
    }

    /// Compiles `sources` with javac `options`, passing each reply to `on_reply`, until the
    /// compilation ends. Cancelling stops javac at its next phase.
    pub fn compile(
        &self,
        options: &[String],
        sources: &[PathBuf],
        encoding: Option<&str>,
        cancel: &CancellationToken,
        mut on_reply: impl FnMut(&Reply),
    ) -> IdeResult<bool> {
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = mpsc::channel();
        self.pending.lock().unwrap().insert(id, tx);
        if let Err(e) = self.send(&Request { id, op: "compile", options, sources, encoding }) {
            self.pending.lock().unwrap().remove(&id);
            return Err(e);
        }
        let mut cancelled = false;
        loop {
            match rx.recv_timeout(Duration::from_millis(100)) {
                Ok(reply) => {
                    if let Reply::Done { success, cancelled: stopped } = reply {
                        if stopped || cancelled {
                            return Err(IdeError::cancelled());
                        }
                        return Ok(success);
                    }
                    on_reply(&reply);
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if cancel.is_cancelled() && !cancelled {
                        cancelled = true;
                        let _ = self.send(&serde_json::json!({ "op": "cancel", "id": id }));
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(IdeError::internal("The javac process exited"));
                }
            }
        }
    }
}

impl Drop for JavacServer {
    fn drop(&mut self) {
        let _ = self.send(&serde_json::json!({ "op": "exit" }));
        let mut child = self.child.lock().unwrap();
        for _ in 0..20 {
            if child.try_wait().ok().flatten().is_some() {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        ide_core::process::kill_tree(&mut child);
    }
}

/// The resident javac servers of one IDE process.
#[derive(Default)]
pub struct JavacPool {
    servers: Mutex<HashMap<ServerKey, Arc<JavacServer>>>,
}

impl JavacPool {
    /// The running server for `key`, started on first use (or after it died).
    pub fn server(&self, jar: &Path, key: &ServerKey) -> IdeResult<Arc<JavacServer>> {
        let mut servers = self.servers.lock().unwrap();
        if let Some(server) = servers.get(key).filter(|s| s.alive()) {
            return Ok(server.clone());
        }
        let server = Arc::new(JavacServer::start(jar, key)?);
        servers.insert(key.clone(), server.clone());
        Ok(server)
    }

    /// Stops every server (the project closed).
    pub fn shutdown(&self) {
        self.servers.lock().unwrap().clear();
    }
}
