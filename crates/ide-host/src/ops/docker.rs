//! Docker run configurations: the environment their `docker` command line runs with.
use crate::Host;
use crate::rpc::Dispatcher;
use ide_core::IdeResult;
use ide_docker::DockerEndpoint;
use std::collections::BTreeMap;

/// Environment for a Docker run configuration's command line: selects `endpoint`'s
/// daemon and puts the docker executable on `PATH`.
pub async fn docker_run_env(host: &Host, endpoint: DockerEndpoint) -> IdeResult<BTreeMap<String, String>> {
    // A remote project gets them from the server, since its run configurations start on the remote host.
    endpoint.validate()?;
    host.blocking(move || Ok(ide_docker::run_env(&endpoint))).await
}

pub(crate) fn register(d: &mut Dispatcher) {
    d.add("docker_run_env", |c| async move { docker_run_env(&c.host, c.arg("endpoint")?).await });
}
