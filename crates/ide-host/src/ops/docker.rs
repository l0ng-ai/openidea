//! Docker run configurations: the environment their `docker` command line runs with; and Docker
//! connections through an SSH configuration, tunnelled with the IDE's own SSH client.
use crate::Host;
use ide_command::command;
use ide_core::{IdeError, IdeResult};
use ide_docker::DockerEndpoint;
use ide_ssh::Tunnel;
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

/// What each tunnelled connection runs on the SSH host, as the Docker CLI's `ssh://` does.
const DIAL: &str = "docker system dial-stdio";

/// Open tunnels of [`DockerEndpoint::Ssh`] connections, by SSH configuration id.
#[derive(Default)]
pub struct DockerTunnels(tokio::sync::Mutex<HashMap<String, Arc<Tunnel>>>);

/// `endpoint` as docker can use it: an SSH configuration becomes the local end of a tunnel to its
/// host's daemon (opened on first use, reopened when the SSH connection dropped).
pub async fn resolve(host: &Host, endpoint: DockerEndpoint) -> IdeResult<DockerEndpoint> {
    let DockerEndpoint::Ssh { config } = endpoint else { return Ok(endpoint) };
    let id = config.trim().to_owned();
    let mut tunnels = host.docker_tunnels.0.lock().await;
    let tunnel = match tunnels.get(&id).filter(|t| !t.is_closed()) {
        Some(t) => t.clone(),
        None => {
            let session = host.ssh.session(&id).await?;
            // Fail with the reason here: a missing docker only shows as a dropped connection later.
            let probe = session.exec("docker version --format {{.Client.Version}}", None).await?;
            if !probe.success() {
                let why = String::from_utf8_lossy(&probe.stderr).trim().to_owned();
                return Err(IdeError::unavailable(format!(
                    "docker could not be run on {} over SSH{}",
                    session.label(),
                    if why.is_empty() { String::new() } else { format!(": {why}") }
                )));
            }
            let t = Arc::new(Tunnel::command(session, DIAL).await?);
            tunnels.insert(id, t.clone());
            t
        }
    };
    Ok(DockerEndpoint::Tcp { host: format!("tcp://127.0.0.1:{}", tunnel.port()), tls_cert_dir: None })
}

/// Environment for a Docker run configuration's command line: selects `endpoint`'s
/// daemon and puts the docker executable on `PATH`.
#[command(trust = always)]
pub async fn docker_run_env(host: &Host, endpoint: DockerEndpoint) -> IdeResult<BTreeMap<String, String>> {
    // A remote project gets them from the server, since its run configurations start on the remote host.
    endpoint.validate()?;
    let endpoint = resolve(host, endpoint).await?;
    host.blocking(move || Ok(ide_docker::run_env(&endpoint))).await
}

ide_command::domain!(docker: docker_run_env);
