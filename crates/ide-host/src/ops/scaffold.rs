//! File › New Project (`ide-scaffold`).
use crate::Host;
use crate::ops::Channel;
use crate::rpc::Dispatcher;

use ide_core::{IdeError, IdeResult, IpcPath, RequestId};
use ide_scaffold::{CreateRequest, Field, GeneratorInfo, Requirement, ScaffoldEvent, Values};

fn join_err(e: impl std::fmt::Display) -> IdeError {
    IdeError::internal(e.to_string())
}

/// The project generators File › New Project offers, in list order.
pub fn scaffold_catalog(_host: &Host, _window: &str) -> Vec<GeneratorInfo> {
    ide_scaffold::catalog()
}

/// The fields a generator's project service adds for `values` (Spring Initializr's
/// Boot versions and dependencies…); empty for other generators. Cancellable with
/// `cancel_request(request)`.
pub async fn scaffold_options(
    host: &Host,
    _window: &str,
    generator: String,
    values: Values,
    request: RequestId,
) -> IdeResult<Vec<Field>> {
    let cancel = host.begin_request(request);
    let result = tokio::task::spawn_blocking(move || ide_scaffold::options(&generator, &values, &cancel))
        .await
        .map_err(join_err);
    host.end_request(request);
    result?
}

/// The programs a generator needs for `values`, and whether they are installed.
pub async fn scaffold_requirements(
    _host: &Host,
    _window: &str,
    generator: String,
    values: Values,
) -> IdeResult<Vec<Requirement>> {
    tokio::task::spawn_blocking(move || ide_scaffold::requirements(&generator, &values)).await.map_err(join_err)?
}

/// Creates a project, streaming its steps and tool output through `on_event`, and
/// returns its directory, trusted: the user just created it. Cancellable with
/// `cancel_request(request)`; a failed or cancelled run leaves no files behind.
pub async fn scaffold_create(
    host: &Host,
    _window: &str,
    req: CreateRequest,
    request: RequestId,
    on_event: Channel<ScaffoldEvent>,
) -> IdeResult<IpcPath> {
    let cancel = host.begin_request(request);
    let result = tokio::task::spawn_blocking(move || {
        ide_scaffold::create(&req, &cancel, &|e| {
            let _ = on_event.send(e);
        })
    })
    .await
    .map_err(join_err);
    host.end_request(request);
    let dir = result??;
    host.set_project_trust(&dir, true, false).await?;
    Ok(dir.into())
}

/// Commands of this module the remote server answers.
pub(crate) fn register(d: &mut Dispatcher) {
    d.add("scaffold_catalog", |c| async move { Ok(scaffold_catalog(&c.host, &c.window)) });
    d.add("scaffold_options", |c| async move {
        scaffold_options(&c.host, &c.window, c.arg("generator")?, c.arg("values")?, c.arg("request")?).await
    });
    d.add("scaffold_requirements", |c| async move {
        scaffold_requirements(&c.host, &c.window, c.arg("generator")?, c.arg("values")?).await
    });
    d.add("scaffold_create", |c| async move {
        scaffold_create(&c.host, &c.window, c.arg("req")?, c.arg("request")?, c.sender("onEvent")?).await
    });
}
