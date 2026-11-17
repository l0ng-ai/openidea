//! Docker run configurations: the environment their `docker` command line runs with.
use crate::Host;
use ide_command::command;
use ide_core::IdeResult;
use ide_docker::DockerEndpoint;
use std::collections::BTreeMap;

/// Environment for a Docker run configuration's command line: selects `endpoint`'s
/// daemon and puts the docker executable on `PATH`.
#[command(trust = always)]
pub async fn docker_run_env(host: &Host, endpoint: DockerEndpoint) -> IdeResult<BTreeMap<String, String>> {
    // A remote project gets them from the server, since its run configurations start on the remote host.
    endpoint.validate()?;
    host.blocking(move || Ok(ide_docker::run_env(&endpoint))).await
}

ide_command::domain!(docker: docker_run_env);
