//! Docker run configurations: the environment their `docker` command line runs with.
use crate::Host;
use crate::rpc::Dispatcher;
use ide_core::IdeResult;
use ide_docker::DockerEndpoint;
use std::collections::BTreeMap;

/// The endpoint's variables plus a `PATH` that finds this host's `docker`. A remote project
/// gets them from the server, since its run configurations start on the remote host.
pub async fn run_env(host: &Host, endpoint: DockerEndpoint) -> IdeResult<BTreeMap<String, String>> {
    endpoint.validate()?;
    host.blocking(move || Ok(ide_docker::run_env(&endpoint))).await
}

pub(crate) fn register(d: &mut Dispatcher) {
    d.add("docker_run_env", |c| async move { run_env(&c.host, c.arg("endpoint")?).await });
}
