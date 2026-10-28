//! LSP over TCP, for servers living inside another program (the Godot editor's
//! GDScript server). Mirrors `ide-dap`'s `tcp` transport: connect to the
//! configured address when something listens there, else start the configured
//! command (`${port}` → a free port, `${root}` → the workspace root) and connect
//! once it accepts. The framing and session are the same as over stdio.

use crate::launch::LaunchError;
use ide_core::CancellationToken;
use ide_jsonrpc::{Handler, Peer};
use ide_language::LanguageServerConfig;
use parking_lot::Mutex;
use std::collections::VecDeque;
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::AsyncRead;

pub(crate) const PORT_PLACEHOLDER: &str = "${port}";
pub(crate) const ROOT_PLACEHOLDER: &str = "${root}";

const PROBE_TIMEOUT: Duration = Duration::from_millis(500);
/// A headless Godot editor imports the project before it listens.
const START_TIMEOUT: Duration = Duration::from_secs(120);
const POLL: Duration = Duration::from_millis(200);
const TAIL_LINES: usize = 20;

/// `${port}` / `${root}` substituted in every argument.
pub(crate) fn substitute_args(args: &[String], port: Option<u16>, root: &Path) -> Vec<String> {
    let root = root.to_string_lossy();
    args.iter()
        .map(|a| {
            let a = a.replace(ROOT_PLACEHOLDER, &root);
            match port {
                Some(p) => a.replace(PORT_PLACEHOLDER, &p.to_string()),
                None => a,
            }
        })
        .collect()
}

pub(crate) fn resolve_addr(addr: &str) -> Result<SocketAddr, LaunchError> {
    addr.to_socket_addrs()
        .ok()
        .and_then(|mut a| a.next())
        .ok_or_else(|| LaunchError::Config(format!("invalid language server address `{addr}`")))
}

/// A connection to `addr` if something accepts there right now.
pub(crate) fn probe(addr: &SocketAddr) -> Option<TcpStream> {
    let stream = TcpStream::connect_timeout(addr, PROBE_TIMEOUT).ok()?;
    let _ = stream.set_nodelay(true);
    Some(stream)
}

/// A port that was free a moment ago on the loopback interface.
pub(crate) fn free_port() -> std::io::Result<u16> {
    Ok(std::net::TcpListener::bind(("127.0.0.1", 0))?.local_addr()?.port())
}

fn into_tokio(stream: TcpStream) -> std::io::Result<tokio::net::TcpStream> {
    stream.set_nonblocking(true)?;
    tokio::net::TcpStream::from_std(stream)
}

/// Connects to the server of `config` (whose `connect` is set), starting `binary` when
/// nothing listens yet. Blocking; must run on a thread inside a Tokio runtime.
#[allow(clippy::too_many_arguments)]
pub(crate) fn connect_or_start(
    config: &LanguageServerConfig,
    addr: &str,
    binary: Option<&Path>,
    env: &[(String, String)],
    root: &Path,
    handler: Arc<dyn Handler>,
    on_stderr: Box<dyn Fn(String) + Send + Sync>,
    cancel: &CancellationToken,
) -> Result<Peer, LaunchError> {
    let addr = resolve_addr(addr)?;
    if let Some(stream) = probe(&addr) {
        tracing::info!("{}: connected to the server running at {addr}", config.name);
        let (r, w) = into_tokio(stream).map_err(|e| LaunchError::Failed(e.to_string()))?.into_split();
        return Ok(Peer::connect(r, w, handler));
    }
    let binary = binary.ok_or(LaunchError::Missing)?;
    let port = config
        .args
        .iter()
        .any(|a| a.contains(PORT_PLACEHOLDER))
        .then(free_port)
        .transpose()
        .map_err(|e| LaunchError::Failed(format!("no free port: {e}")))?;
    let target = port.map_or(addr, |p| SocketAddr::from(([127, 0, 0, 1], p)));
    let args = substitute_args(&config.args, port, root);

    let mut cmd = tokio::process::Command::new(binary);
    ide_core::process::prepare(cmd.as_std_mut());
    cmd.args(&args)
        .current_dir(root)
        .envs(env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let mut child =
        cmd.spawn().map_err(|e| LaunchError::Failed(format!("failed to start {}: {e}", binary.display())))?;
    tracing::info!("{}: started {} {}, waiting for {target}", config.name, binary.display(), args.join(" "));

    let tail: Arc<Mutex<VecDeque<String>>> = Arc::default();
    let on_line: Arc<dyn Fn(String) + Send + Sync> = {
        let tail = tail.clone();
        Arc::new(move |line: String| {
            {
                let mut t = tail.lock();
                if t.len() == TAIL_LINES {
                    t.pop_front();
                }
                t.push_back(line.clone());
            }
            on_stderr(line);
        })
    };
    if let Some(out) = child.stdout.take() {
        pump_lines(out, on_line.clone());
    }
    if let Some(err) = child.stderr.take() {
        pump_lines(err, on_line);
    }
    let failed = |message: String| {
        let tail: Vec<String> = tail.lock().iter().cloned().collect();
        LaunchError::Failed(if tail.is_empty() { message } else { format!("{message}:\n{}", tail.join("\n")) })
    };

    let deadline = Instant::now() + START_TIMEOUT;
    loop {
        if cancel.is_cancelled() {
            let _ = child.start_kill();
            return Err(LaunchError::Failed(format!("{}: start cancelled", config.name)));
        }
        if let Some(stream) = probe(&target) {
            let (r, w) = into_tokio(stream).map_err(|e| LaunchError::Failed(e.to_string()))?.into_split();
            return Ok(Peer::connect_with_child(r, w, handler, child));
        }
        if let Ok(Some(status)) = child.try_wait() {
            return Err(failed(format!("{} exited before accepting connections on {target} ({status})", config.name)));
        }
        if Instant::now() >= deadline {
            let _ = child.start_kill();
            return Err(failed(format!(
                "{} did not accept connections on {target} within {}s",
                config.name,
                START_TIMEOUT.as_secs()
            )));
        }
        std::thread::sleep(POLL);
    }
}

fn pump_lines<R: AsyncRead + Unpin + Send + 'static>(stream: R, on_line: Arc<dyn Fn(String) + Send + Sync>) {
    tokio::spawn(ide_jsonrpc::output::read_lines(stream, move |line| on_line(line)));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placeholders_are_substituted() {
        let args: Vec<String> =
            ["--path", "${root}", "--lsp-port", "${port}", "--x=${port}"].iter().map(|s| s.to_string()).collect();
        assert_eq!(
            substitute_args(&args, Some(6010), Path::new("/p/game")),
            ["--path", "/p/game", "--lsp-port", "6010", "--x=6010"]
        );
        assert_eq!(substitute_args(&args, None, Path::new("/p"))[3], "${port}");
    }

    #[test]
    fn addresses_resolve() {
        assert_eq!(resolve_addr("127.0.0.1:6005").unwrap().port(), 6005);
        assert!(matches!(resolve_addr("nonsense"), Err(LaunchError::Config(_))));
    }
}
