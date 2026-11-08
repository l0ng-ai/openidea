//! WSL transport of remote development: `openidea-server --stdio` started with
//! `wsl.exe --exec` inside a distro, instead of over SSH.
//!
//! Every command goes through `--exec`, which runs the program directly without a shell on
//! the Windows side; only fixed scripts reach `sh -c` inside the distro and everything variable
//! (paths, versions) is passed as positional arguments, never spliced into the script.

use crate::remote_dev::{PROBE_MARK, Progress, RemoteStage, SERVER_BIN, SERVER_DIR};
use ide_core::{IdeError, IdeResult};
use ide_jsonrpc::{Handler, Peer};
use parking_lot::Mutex;
use std::collections::VecDeque;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::AsyncWriteExt;

/// Bound for the short probes; `wsl.exe` can wait on a distro that is still starting.
const PROBE_TIMEOUT: Duration = Duration::from_secs(60);
const INSTALL_TIMEOUT: Duration = Duration::from_secs(300);
const UPLOAD_CHUNK: usize = 256 * 1024;
/// Output lines of the server kept for the error shown when it dies early.
const KEPT_LINES: usize = 20;

/// What the probe learned about a distro.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Probe {
    pub home: String,
    /// `uname -sm`.
    pub uname: String,
    /// Installed builds of this version (paths of `openidea-server`).
    pub installed: Vec<String>,
}

fn checked(distro: &str) -> IdeResult<&str> {
    if ide_core::wsl::is_valid_distro(distro) {
        Ok(distro)
    } else {
        Err(IdeError::invalid(format!("'{distro}' is not a valid WSL distribution name")))
    }
}

/// `wsl.exe -d <distro> --exec sh -c <script> sh <args>…`.
fn sh(distro: &str, script: &str, args: &[&str]) -> IdeResult<tokio::process::Command> {
    let mut cmd = tokio::process::Command::new("wsl.exe");
    ide_core::process::prepare(cmd.as_std_mut());
    cmd.args(["-d", checked(distro)?, "--exec", "sh", "-c", script, "sh"])
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    Ok(cmd)
}

/// The reason a `wsl.exe` call failed, as text (its own messages are UTF-16).
fn failure(distro: &str, out: &std::process::Output) -> IdeError {
    let mut text = ide_core::wsl::decode_output(&out.stderr);
    if text.trim().is_empty() {
        text = ide_core::wsl::decode_output(&out.stdout);
    }
    let text: String = text.trim().chars().filter(|c| !c.is_control() || *c == '\n').take(400).collect();
    IdeError::unavailable(format!("cannot run a command in WSL distribution '{distro}': {text}"))
}

async fn output(distro: &str, mut cmd: tokio::process::Command, limit: Duration) -> IdeResult<std::process::Output> {
    let out = tokio::time::timeout(limit, cmd.output())
        .await
        .map_err(|_| IdeError::unavailable(format!("WSL distribution '{distro}' did not answer in time")))?
        .map_err(|e| IdeError::unavailable(format!("cannot start wsl.exe: {e}")))?;
    if out.status.success() { Ok(out) } else { Err(failure(distro, &out)) }
}

/// Prints [`PROBE_MARK`], `$HOME`, `uname -sm` and the installed builds of version `$1`.
pub(crate) fn probe_script() -> String {
    format!(
        r#"echo {PROBE_MARK}; echo "$HOME"; uname -sm; ls -d "$HOME/{SERVER_DIR}/$1"/*/{SERVER_BIN} 2>/dev/null; true"#
    )
}

/// Splits the probe output (after its marker) into [`Probe`].
pub(crate) fn parse_probe(text: &str) -> IdeResult<Probe> {
    // Between markers: `wsl.exe` may print notices to stdout before the script runs.
    let text = text.split_once(PROBE_MARK).map_or("", |(_, rest)| rest);
    let mut lines = text.lines().map(str::trim).filter(|l| !l.is_empty());
    let home = lines.next().unwrap_or_default().to_owned();
    // The path is spliced into nothing, but it must be one clean absolute path.
    if !home.starts_with('/') || home.chars().any(char::is_control) {
        return Err(IdeError::unavailable("cannot find the home directory in the WSL distribution"));
    }
    let uname = lines.next().unwrap_or_default().to_owned();
    Ok(Probe { home, uname, installed: lines.map(str::to_owned).collect() })
}

/// Home directory, platform and installed server builds of `distro` (starts it if stopped).
pub(crate) async fn probe(distro: &str, version: &str) -> IdeResult<Probe> {
    let out = output(distro, sh(distro, &probe_script(), &[version])?, PROBE_TIMEOUT).await?;
    parse_probe(&String::from_utf8_lossy(&out.stdout))
}

/// Where the builds of `version` live in a distro whose home is `home`.
pub(crate) fn version_dir(home: &str, version: &str) -> String {
    format!("{}/{SERVER_DIR}/{version}", home.trim_end_matches('/'))
}

/// Streams `data` into `<version_dir>/<build>/openidea-server` of `distro` and removes the other
/// builds of the version. Returns the installed path.
pub(crate) async fn install(
    distro: &str,
    version_dir: &str,
    build: &str,
    data: &[u8],
    progress: &Arc<Progress>,
) -> IdeResult<String> {
    let build_dir = format!("{version_dir}/{build}");
    let cmd = sh(distro, &install_script(), &[&build_dir, version_dir, build])?;
    let out = upload(cmd, "wsl.exe", data, progress)
        .await
        .map_err(|_| IdeError::unavailable(format!("installing {SERVER_BIN} in '{distro}' timed out")))??;
    if out.status.success() { Ok(format!("{build_dir}/{SERVER_BIN}")) } else { Err(failure(distro, &out)) }
}

/// Reads the server from stdin into `$1/openidea-server` and removes the builds of version folder
/// `$2` other than `$3`. Per install file: another window may be installing the same build.
pub(crate) fn install_script() -> String {
    format!(
        r#"set -e; mkdir -p "$1"; p="$1/{SERVER_BIN}.part.$$"; trap 'rm -f "$p"' EXIT; cat > "$p"; chmod 755 "$p"; mv -f "$p" "$1/{SERVER_BIN}"; find "$2" -mindepth 1 -maxdepth 1 ! -name "$3" -exec rm -rf {{}} +"#
    )
}

/// Runs `cmd` (an [`install_script`]) with `data` on its stdin, reporting the upload. `Err` when it
/// timed out; else the finished command's output (or why it couldn't run), whatever its status.
pub(crate) async fn upload(
    mut cmd: tokio::process::Command,
    program: &str,
    data: &[u8],
    progress: &Arc<Progress>,
) -> Result<IdeResult<std::process::Output>, tokio::time::error::Elapsed> {
    cmd.stdin(Stdio::piped());
    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => return Ok(Err(IdeError::unavailable(format!("cannot start {program}: {e}")))),
    };
    let Some(mut stdin) = child.stdin.take() else {
        return Ok(Err(IdeError::internal(format!("{program} stdin unavailable"))));
    };
    // `stdin` drops at the end of the upload: that is the EOF `cat` waits for.
    let upload = async move {
        for (i, chunk) in data.chunks(UPLOAD_CHUNK).enumerate() {
            stdin.write_all(chunk).await?;
            progress(RemoteStage::Uploading, Some(((i + 1) * UPLOAD_CHUNK).min(data.len()) as f64 / data.len() as f64));
        }
        stdin.flush().await
    };
    tokio::time::timeout(INSTALL_TIMEOUT, async {
        let uploaded = upload.await;
        let failed = |e: std::io::Error| IdeError::unavailable(format!("installing {SERVER_BIN} failed: {e}"));
        match (uploaded, child.wait_with_output().await) {
            // Never a success without the whole binary.
            (Err(e), Ok(out)) if out.status.success() => Err(failed(e)),
            (_, out) => out.map_err(failed),
        }
    })
    .await
}

/// The last lines the server (or `wsl.exe`) wrote outside the protocol.
#[derive(Clone, Default)]
pub(crate) struct Tail(Arc<Mutex<VecDeque<String>>>);

impl Tail {
    pub fn push(&self, line: String) {
        let mut lines = self.0.lock();
        if lines.len() == KEPT_LINES {
            lines.pop_front();
        }
        lines.push_back(line);
    }

    pub fn text(&self) -> String {
        self.0.lock().iter().cloned().collect::<Vec<_>>().join("\n")
    }
}

/// Starts `bin --stdio` in `distro` and speaks the protocol over its stdio. The process dies
/// with the connection.
pub(crate) fn spawn(distro: &str, bin: &str, handler: Arc<dyn Handler>, tail: &Tail) -> IdeResult<Peer> {
    spawn_with(ide_core::wsl::EXE, distro, bin, handler, tail)
}

/// [`spawn`] through `launcher` instead of `wsl.exe` (tests put a stand-in there).
fn spawn_with(launcher: &str, distro: &str, bin: &str, handler: Arc<dyn Handler>, tail: &Tail) -> IdeResult<Peer> {
    let args: Vec<String> = ["-d", checked(distro)?, "--exec", bin, "--stdio"].map(str::to_owned).into();
    let tail = tail.clone();
    Peer::spawn(launcher, &args, &std::env::temp_dir(), &[], handler, Box::new(move |line| tail.push(line)))
        .map_err(|e| IdeError::unavailable(format!("cannot start wsl.exe: {e}")))
}

/// Makes sure this version of the server is installed in `distro`; returns its path there.
pub(crate) async fn ensure_server(
    state: &crate::state::AppState,
    distro: &str,
    progress: Arc<Progress>,
) -> IdeResult<String> {
    use crate::remote_dev::{LocalServer, local_server, platform};
    progress(RemoteStage::Checking, None);
    let version = env!("CARGO_PKG_VERSION");
    let probe = probe(distro, version).await?;
    let (os, arch) = platform(&probe.uname);
    if os != "linux" {
        return Err(IdeError::unavailable(format!("'{distro}' reports {os} instead of linux")));
    }
    let (local, build) = match local_server(state, version, &os, &arch, &probe.installed, progress.clone()).await? {
        LocalServer::Installed(bin) => return Ok(bin),
        LocalServer::Binary(local, build) => (local, build),
    };
    if let Some(bin) = probe.installed.iter().find(|b| b.ends_with(&format!("/{build}/{SERVER_BIN}"))) {
        return Ok(bin.clone());
    }
    let started = std::time::Instant::now();
    progress(RemoteStage::Uploading, Some(0.0));
    let data = tokio::fs::read(&local).await?;
    let bin = install(distro, &version_dir(&probe.home, version), &build, &data, &progress).await?;
    tracing::info!("installed {SERVER_BIN} in WSL '{distro}' in {:?}", started.elapsed());
    Ok(bin)
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOME: &str = "/home/me";
    const UNAME: &str = "Linux x86_64";

    #[test]
    fn probe_output_is_read_after_the_marker() {
        let installed = format!("{}/ab/{SERVER_BIN}", version_dir(HOME, "1"));
        let text = format!("wsl: notice\n{PROBE_MARK}\n{HOME}\n{UNAME}\n{installed}\n");
        let p = parse_probe(&text).unwrap();
        assert_eq!(p, Probe { home: HOME.into(), uname: UNAME.into(), installed: vec![installed] });
    }

    #[test]
    fn a_probe_without_a_clean_home_is_refused() {
        assert!(parse_probe(&format!("{HOME}\n{UNAME}\n")).is_err(), "no marker");
        assert!(parse_probe(&format!("{PROBE_MARK}\nrelative\n{UNAME}\n")).is_err());
        assert!(parse_probe(&format!("{PROBE_MARK}\n")).is_err());
    }

    #[test]
    fn invalid_distro_names_never_reach_wsl_exe() {
        for bad in ["", "--exec", "a b", "a;b"] {
            assert!(sh(bad, "true", &[]).is_err(), "{bad}");
        }
        assert!(sh("Ubuntu-24.04", "true", &[]).is_ok());
    }

    #[test]
    fn version_dir_ignores_a_trailing_slash() {
        assert_eq!(version_dir(&format!("{HOME}/"), "1.2.3"), format!("{HOME}/{SERVER_DIR}/1.2.3"));
    }

    struct Silent;
    impl Handler for Silent {
        fn on_notification(&self, _: &str, _: serde_json::Value) {}
        fn on_request(&self, method: &str, _: serde_json::Value) -> Result<serde_json::Value, (i64, String)> {
            Err((ide_jsonrpc::codes::METHOD_NOT_FOUND, method.to_owned()))
        }
    }

    /// A stand-in for `wsl.exe` that checks the arguments it is given, prints a UTF-16 notice
    /// the way the real one does, then answers one request.
    #[cfg(unix)]
    #[tokio::test]
    async fn speaks_the_protocol_through_the_launcher_after_its_utf16_notice() {
        use std::os::unix::fs::PermissionsExt;
        let (distro, bin) = ("Debian-12", "/home/me/server");
        let dir = tempfile::tempdir().unwrap();
        let launcher = dir.path().join("fake-wsl");
        let script = format!(
            r#"#!/bin/sh
[ "$*" = "-d {distro} --exec {bin} --stdio" ] || {{ echo "unexpected arguments: $*" >&2; exit 2; }}
printf '\377\376N\000o\000\r\000\n\000'
while read -r line; do
  line=${{line%?}}
  case "$line" in Content-Length:*) len=${{line#*: }} ;; "") break ;; esac
done
head -c "$len" >/dev/null
body='{{"jsonrpc":"2.0","id":1,"result":"pong"}}'
printf 'Content-Length: %s\r\n\r\n%s' "${{#body}}" "$body"
"#
        );
        std::fs::write(&launcher, script).unwrap();
        std::fs::set_permissions(&launcher, std::fs::Permissions::from_mode(0o755)).unwrap();
        let tail = Tail::default();
        let peer = spawn_with(launcher.to_str().unwrap(), distro, bin, Arc::new(Silent), &tail).unwrap();
        let reply: String = peer.request("ping", serde_json::Value::Null, None).await.unwrap_or_else(|e| {
            panic!("{e:?}; launcher said: {}", tail.text());
        });
        assert_eq!(reply, "pong");
    }

    #[tokio::test]
    async fn a_bad_distro_name_never_starts_the_launcher() {
        let err = spawn_with("does-not-exist", "-d", "/x", Arc::new(Silent), &Tail::default()).err().unwrap();
        assert!(err.message.contains("not a valid"), "{}", err.message);
    }
}
