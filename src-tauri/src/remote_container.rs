//! Dev container transport of remote development: the Dev Containers CLI (`devcontainer up`)
//! builds or starts the container of a local folder, then `openidea-server --stdio` runs in it
//! through `docker exec`, installed there the way it is in a WSL distribution.
//!
//! The container id, user and folder come from the CLI's output, are checked, and only ever
//! reach `docker exec` as separate arguments; only fixed scripts reach `sh -c`.

use crate::remote_dev::{Progress, RemoteStage, SERVER_BIN};
use crate::remote_wsl::{Probe, Tail, install_script, parse_probe, probe_script, upload, version_dir};
use ide_core::{IdeError, IdeResult};
use ide_jsonrpc::{Handler, Peer};
use ide_remote::devcontainer::{Up, parse_up};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::AsyncBufReadExt;

/// Building an image (and its features) can take a while on a first open.
const UP_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const PROBE_TIMEOUT: Duration = Duration::from_secs(60);

/// The Dev Containers CLI: the IDE-managed copy (Settings › Tools) or one on `PATH`.
fn cli(data_dir: &Path) -> IdeResult<PathBuf> {
    ide_tools::Tools::new(data_dir)
        .info("devcontainer", &[])
        .ok()
        .and_then(|t| t.path)
        .map(ide_core::IpcPath::into_path_buf)
        .ok_or_else(|| {
            IdeError::unavailable(
                "The Dev Containers CLI is not installed. Install it in Settings › Tools › Dev Containers CLI.",
            )
        })
}

/// `devcontainer up` for `folder` (with configuration `config`, relative to it; empty = the
/// default one). Its log goes to `tail` and the IDE log.
async fn up(cli: &Path, docker: &Path, folder: &Path, config: &str, tail: &Tail) -> IdeResult<Up> {
    let mut cmd = tokio::process::Command::new(cli);
    ide_core::process::prepare(cmd.as_std_mut());
    cmd.arg("up").arg("--workspace-folder").arg(folder);
    if !config.trim().is_empty() {
        cmd.arg("--config").arg(folder.join(config.trim()));
    }
    cmd.arg("--docker-path")
        .arg(docker)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|e| IdeError::unavailable(format!("cannot start devcontainer: {e}")))?;
    let stderr = child.stderr.take();
    let log = tail.clone();
    let reader = tokio::spawn(async move {
        let Some(stderr) = stderr else { return };
        let mut lines = tokio::io::BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            tracing::info!(target: "devcontainer", "{line}");
            log.push(line);
        }
    });
    let out = tokio::time::timeout(UP_TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| IdeError::unavailable("devcontainer up did not finish in time"))?
        .map_err(|e| IdeError::unavailable(format!("devcontainer up failed: {e}")))?;
    let _ = reader.await;
    let result = parse_up(&String::from_utf8_lossy(&out.stdout));
    if out.status.success() {
        return result;
    }
    let error = result
        .err()
        .unwrap_or_else(|| IdeError::unavailable(format!("devcontainer up exited with {status}", status = out.status)));
    Err(match tail.text() {
        t if t.is_empty() => error,
        t => IdeError::unavailable(format!("{}\n{t}", error.message)),
    })
}

/// `docker exec [-i] -u <user> <container> sh -c <script> sh <args>…`.
fn sh(docker: &Path, up: &Up, script: &str, args: &[&str], input: bool) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(docker);
    ide_core::process::prepare(cmd.as_std_mut());
    cmd.arg("exec");
    if input {
        cmd.arg("-i");
    }
    cmd.args(["-u", &up.user, &up.container, "sh", "-c", script, "sh"])
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    cmd
}

fn failure(out: &std::process::Output) -> IdeError {
    let text = String::from_utf8_lossy(if out.stderr.is_empty() { &out.stdout } else { &out.stderr });
    let text: String = text.trim().chars().take(400).collect();
    IdeError::unavailable(format!("cannot run a command in the dev container: {text}"))
}

async fn probe(docker: &Path, up: &Up, version: &str) -> IdeResult<Probe> {
    let out = tokio::time::timeout(PROBE_TIMEOUT, sh(docker, up, &probe_script(), &[version], false).output())
        .await
        .map_err(|_| IdeError::unavailable("the dev container did not answer in time"))?
        .map_err(|e| IdeError::unavailable(format!("cannot start docker: {e}")))?;
    if !out.status.success() {
        return Err(failure(&out));
    }
    parse_probe(&String::from_utf8_lossy(&out.stdout))
}

/// Makes sure this version of the server is installed in the container; returns its path there.
async fn ensure_server(
    state: &crate::state::AppState,
    docker: &Path,
    up: &Up,
    progress: &Arc<Progress>,
) -> IdeResult<String> {
    use crate::remote_dev::{LocalServer, local_server, platform};
    progress(RemoteStage::Checking, None);
    let version = env!("CARGO_PKG_VERSION");
    let probe = probe(docker, up, version).await?;
    let (os, arch) = platform(&probe.uname);
    if os != "linux" {
        return Err(IdeError::unavailable(format!("the dev container reports {os} instead of linux")));
    }
    let (local, build) = match local_server(state, version, &os, &arch, &probe.installed, progress.clone()).await? {
        LocalServer::Installed(bin) => return Ok(bin),
        LocalServer::Binary(local, build) => (local, build),
    };
    if let Some(bin) = probe.installed.iter().find(|b| b.ends_with(&format!("/{build}/{SERVER_BIN}"))) {
        return Ok(bin.clone());
    }
    install(docker, up, &version_dir(&probe.home, version), &build, &local, progress).await
}

/// Copies the server at `local` into `<version_dir>/<build>/openidea-server` in the container and
/// removes the other builds of the version. Returns the installed path.
async fn install(
    docker: &Path,
    up: &Up,
    version_dir: &str,
    build: &str,
    local: &Path,
    progress: &Arc<Progress>,
) -> IdeResult<String> {
    progress(RemoteStage::Uploading, Some(0.0));
    let data = tokio::fs::read(local).await?;
    let build_dir = format!("{version_dir}/{build}");
    let cmd = sh(docker, up, &install_script(), &[&build_dir, version_dir, build], true);
    let out = upload(cmd, "docker", &data, progress)
        .await
        .map_err(|_| IdeError::unavailable(format!("installing {SERVER_BIN} in the dev container timed out")))??;
    if out.status.success() { Ok(format!("{build_dir}/{SERVER_BIN}")) } else { Err(failure(&out)) }
}

/// The arguments of `docker` that start the server in the container: in the project folder, told
/// that the folder is trusted and that the CLI already ran the lifecycle commands.
fn server_args(up: &Up, bin: &str) -> Vec<String> {
    let mut args: Vec<String> = ["exec", "-i", "-u", &up.user, "-w", &up.folder].map(str::to_owned).into();
    for var in [
        format!("{}={}", ide_host::trust::TRUSTED_ROOT_ENV, up.folder),
        format!("{}=1", ide_host::environment::LIFECYCLE_DONE_ENV),
    ] {
        args.extend(["-e".to_owned(), var]);
    }
    args.extend([up.container.clone(), bin.to_owned(), "--stdio".to_owned()]);
    args
}

/// Opens the dev container of local `folder`: starts it with the CLI, installs and starts the
/// server in it. Returns the connection and the project folder in the container.
pub(crate) async fn connect(
    state: &crate::state::AppState,
    folder: &str,
    config: &str,
    handler: Arc<dyn Handler>,
    tail: &Tail,
    progress: &Arc<Progress>,
) -> IdeResult<(Peer, String)> {
    let local = PathBuf::from(folder);
    // `devcontainer up` runs the project's code on this machine (`initializeCommand`, the build).
    if !state.host.trust.trusted(&local).unwrap_or(false) {
        return Err(IdeError::unavailable(format!(
            "Trust {} before reopening it in a container: building it runs the project's commands.",
            local.display()
        )));
    }
    if ide_workspace::devcontainer::find(&local).is_none() && config.trim().is_empty() {
        return Err(IdeError::not_found(format!("{} has no devcontainer.json", local.display())));
    }
    let docker = ide_docker::docker_executable().ok_or_else(|| IdeError::unavailable("Docker is not installed"))?;
    progress(RemoteStage::Container, None);
    // The folder is bind-mounted: the daemon has to see this machine's files.
    let is_local = tokio::task::spawn_blocking(|| ide_docker::endpoint_is_local(&ide_docker::DockerEndpoint::Default))
        .await
        .map_err(|e| IdeError::internal(e.to_string()))??;
    if !is_local {
        return Err(IdeError::unavailable(
            "The Docker daemon of the current context is not on this machine; dev containers need a local one.",
        ));
    }
    let data = state.host.local_data_dir.clone();
    let cli =
        tokio::task::spawn_blocking(move || cli(&data)).await.map_err(|e| IdeError::internal(e.to_string()))??;
    let up = up(&cli, &docker, &local, config, tail).await?;
    let bin = ensure_server(state, &docker, &up, progress).await?;
    progress(RemoteStage::Starting, None);
    let peer = spawn(&docker, &up, &bin, handler, tail)?;
    Ok((peer, up.folder))
}

fn spawn(docker: &Path, up: &Up, bin: &str, handler: Arc<dyn Handler>, tail: &Tail) -> IdeResult<Peer> {
    let tail = tail.clone();
    let program = docker.to_string_lossy();
    Peer::spawn(&program, &server_args(up, bin), &std::env::temp_dir(), &[], handler, Box::new(move |l| tail.push(l)))
        .map_err(|e| IdeError::unavailable(format!("cannot start docker: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "3f1c2b9a7d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8";

    #[test]
    fn the_server_starts_in_the_folder_trusted_and_without_the_lifecycle() {
        let up = Up { container: ID.into(), user: "vscode".into(), folder: "/workspaces/my app".into() };
        let args = server_args(&up, "/home/vscode/.openidea/server/1/ab/openidea-server");
        assert_eq!(
            args,
            [
                "exec",
                "-i",
                "-u",
                "vscode",
                "-w",
                "/workspaces/my app",
                "-e",
                "OPENIDEA_TRUSTED_ROOT=/workspaces/my app",
                "-e",
                "OPENIDEA_LIFECYCLE_DONE=1",
                ID,
                "/home/vscode/.openidea/server/1/ab/openidea-server",
                "--stdio",
            ]
        );
    }

    /// A stand-in for the Dev Containers CLI that checks its arguments and answers like the real one.
    #[cfg(unix)]
    #[tokio::test]
    async fn runs_up_for_the_folder_and_reads_its_result() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("my app");
        let cli = dir.path().join("devcontainer");
        let script = format!(
            r#"#!/bin/sh
[ "$1 $2 $3" = "up --workspace-folder {folder}" ] || {{ echo "unexpected arguments: $*" >&2; exit 2; }}
[ "$4 $5" = "--config {folder}/.devcontainer/python/devcontainer.json" ] || {{ echo "no config: $*" >&2; exit 2; }}
[ "$6 $7" = "--docker-path /usr/bin/docker" ] || {{ echo "no docker path: $*" >&2; exit 2; }}
echo "[1 ms] building" >&2
echo '{{"outcome":"success","containerId":"{ID}","remoteUser":"vscode","remoteWorkspaceFolder":"/workspaces/my app"}}'
"#,
            folder = folder.display()
        );
        std::fs::write(&cli, script).unwrap();
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o755)).unwrap();
        let tail = Tail::default();
        let config = ".devcontainer/python/devcontainer.json";
        let up = up(&cli, Path::new("/usr/bin/docker"), &folder, config, &tail).await.unwrap_or_else(|e| {
            panic!("{e:?}; the CLI said: {}", tail.text());
        });
        assert_eq!(up.folder, "/workspaces/my app");
        assert_eq!(tail.text(), "[1 ms] building");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_failed_up_shows_the_cli_log() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let cli = dir.path().join("devcontainer");
        std::fs::write(&cli, "#!/bin/sh\necho 'Error: Dockerfile not found' >&2\nexit 1\n").unwrap();
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o755)).unwrap();
        let err = up(&cli, Path::new("docker"), dir.path(), "", &Tail::default()).await.unwrap_err();
        assert!(err.message.contains("Dockerfile not found"), "{}", err.message);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_failed_exit_never_connects_even_with_a_success_result() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let cli = dir.path().join("devcontainer");
        let output =
            format!(r#"{{"outcome":"success","containerId":"{ID}","remoteUser":"root","remoteWorkspaceFolder":"/w"}}"#);
        std::fs::write(&cli, format!("#!/bin/sh\ncat <<'RESULT'\n{output}\nRESULT\nexit 1\n")).unwrap();
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o755)).unwrap();
        let err = up(&cli, Path::new("docker"), dir.path(), "", &Tail::default()).await.unwrap_err();
        assert!(err.message.contains("exited with"), "{}", err.message);
    }

    struct Silent;
    impl Handler for Silent {
        fn on_notification(&self, _: &str, _: serde_json::Value) {}
        fn on_request(&self, method: &str, _: serde_json::Value) -> Result<serde_json::Value, (i64, String)> {
            Err((ide_jsonrpc::codes::METHOD_NOT_FOUND, method.to_owned()))
        }
    }

    fn docker_sh(docker: &Path, container: &str, script: &str) -> String {
        let out = std::process::Command::new(docker).args(["exec", container, "sh", "-c", script]).output().unwrap();
        String::from_utf8_lossy(&out.stdout).trim().to_owned()
    }

    /// Against a real daemon and the real Dev Containers CLI (`devcontainer` on `PATH`).
    /// `OPENIDEA_DOCKER_TEST_DIR` names a folder the daemon can bind-mount at the same path, and
    /// `OPENIDEA_SERVER_BIN` an `openidea-server` built for the container's platform.
    #[tokio::test]
    #[ignore = "requires Docker, the Dev Containers CLI, OPENIDEA_DOCKER_TEST_DIR and OPENIDEA_SERVER_BIN"]
    async fn opens_a_real_dev_container() {
        let base = PathBuf::from(std::env::var("OPENIDEA_DOCKER_TEST_DIR").expect("OPENIDEA_DOCKER_TEST_DIR"));
        let server = PathBuf::from(std::env::var("OPENIDEA_SERVER_BIN").expect("OPENIDEA_SERVER_BIN"));
        let root = base.join("devcontainer");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join(".devcontainer")).unwrap();
        std::fs::write(
            root.join(".devcontainer/devcontainer.json"),
            r#"{
  // The CLI runs it once; the server must not run it again.
  "image": "debian:bookworm-slim",
  "postStartCommand": "date +%s%N >> /tmp/post-start",
  "remoteEnv": { "FROM_DEVCONTAINER": "yes" }
}"#,
        )
        .unwrap();
        std::fs::write(root.join("main.py"), "print('hello')\n").unwrap();
        let docker = ide_docker::docker_executable().expect("docker");
        let tail = Tail::default();
        let up = up(Path::new("devcontainer"), &docker, &root, "", &tail)
            .await
            .unwrap_or_else(|e| panic!("{e:?}; the CLI said: {}", tail.text()));
        assert_eq!(up.folder, "/workspaces/devcontainer");
        assert_eq!(up.user, "root");
        let found = probe(&docker, &up, "0.0.0-test").await.unwrap();
        assert_eq!(platform_os(&found.uname), "linux");
        assert!(found.installed.is_empty());
        let progress: Arc<Progress> = Arc::new(|_, _| {});
        let dir = version_dir(&found.home, "0.0.0-test");
        let bin = install(&docker, &up, &dir, "b1", &server, &progress).await.unwrap();
        assert_eq!(probe(&docker, &up, "0.0.0-test").await.unwrap().installed, std::slice::from_ref(&bin));
        let peer = spawn(&docker, &up, &bin, Arc::new(Silent), &tail).unwrap();
        let info: ide_host::rpc::ServerInfo = peer
            .request("initialize", serde_json::json!({ "version": ide_host::rpc::PROTOCOL_VERSION }), None)
            .await
            .unwrap_or_else(|e| panic!("{e:?}; the server said: {}", tail.text()));
        assert_eq!(info.os, "linux");
        let invoke =
            |cmd: &str, args: serde_json::Value| ide_host::rpc::Invoke { window: "main".into(), cmd: cmd.into(), args };
        let project: serde_json::Value = peer
            .request("invoke", invoke("open_project", serde_json::json!({ "path": up.folder })), None)
            .await
            .unwrap_or_else(|e| panic!("{e:?}; the server said: {}", tail.text()));
        assert_eq!(project["root"], "/workspaces/devcontainer");
        assert_eq!(project["trusted"], true, "the trust of the local folder is inherited");
        let files: serde_json::Value = peer
            .request("invoke", invoke("fs_read_dir", serde_json::json!({ "path": up.folder })), None)
            .await
            .unwrap_or_else(|e| panic!("{e:?}; the server said: {}", tail.text()));
        assert!(files.to_string().contains("main.py"), "the project is the local folder: {files}");
        tokio::time::sleep(Duration::from_secs(2)).await;
        assert_eq!(docker_sh(&docker, &up.container, "wc -l < /tmp/post-start"), "1", "postStartCommand ran once");
        drop(peer);
        let removed = std::process::Command::new(&docker).args(["rm", "-f", &up.container]).output().unwrap();
        assert!(removed.status.success());
        std::fs::remove_dir_all(&root).unwrap();
    }

    fn platform_os(uname: &str) -> String {
        crate::remote_dev::platform(uname).0
    }
}
