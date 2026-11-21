//! File › New Project (`ide-scaffold`). Its commands run in Restricted Mode: New Project writes
//! only where the user chose and runs no code of an open project.
use crate::Host;
use crate::ops::Channel;
use ide_command::command;

use ide_core::{IdeError, IdeResult, IpcPath, RequestId};
use ide_scaffold::{CreateRequest, Field, GeneratorInfo, Requirement, ScaffoldEvent, Values};
use std::path::PathBuf;

fn join_err(e: impl std::fmt::Display) -> IdeError {
    IdeError::internal(e.to_string())
}

/// The project generators File › New Project offers, in list order.
#[command(trust = always)]
pub fn scaffold_catalog() -> Vec<GeneratorInfo> {
    ide_scaffold::catalog()
}

/// The fields a generator's project service adds for `values`; cancellable with
/// `cancel_request(request)`.
#[command(trust = always)]
pub async fn scaffold_options(
    host: &Host,
    generator: String,
    values: Values,
    request: RequestId,
) -> IdeResult<Vec<Field>> {
    // Spring Initializr's Boot versions and dependencies…; empty for other generators.
    let cancel = host.begin_request(request);
    let result = tokio::task::spawn_blocking(move || ide_scaffold::options(&generator, &values, &cancel))
        .await
        .map_err(join_err);
    host.end_request(request);
    result?
}

/// The programs a generator needs for `values`, and whether they are installed.
#[command(trust = always)]
pub async fn scaffold_requirements(generator: String, values: Values) -> IdeResult<Vec<Requirement>> {
    tokio::task::spawn_blocking(move || ide_scaffold::requirements(&generator, &values)).await.map_err(join_err)?
}

/// Whether a project named `name` cannot be created in `location`: something other than an
/// empty folder is already there.
#[command(trust = always)]
pub async fn scaffold_target_taken(location: PathBuf, name: String) -> IdeResult<bool> {
    tokio::task::spawn_blocking(move || ide_scaffold::target_taken(&location.join(name.trim()))).await.map_err(join_err)
}

/// The first of `base`, `base1`, `base2`, … that names nothing in `location` yet.
#[command(trust = always)]
pub async fn scaffold_free_name(location: PathBuf, base: String) -> IdeResult<String> {
    tokio::task::spawn_blocking(move || ide_scaffold::free_name(&location, &base)).await.map_err(join_err)
}

/// Creates a project, streaming progress through `on_event`, and returns its directory,
/// trusted. Cancellable with `cancel_request(request)`; a failed or cancelled run leaves nothing.
#[command(trust = always)]
pub async fn scaffold_create(
    host: &Host,
    req: CreateRequest,
    request: RequestId,
    on_event: Channel<ScaffoldEvent>,
) -> IdeResult<IpcPath> {
    // Trusted because the user just created it; a failed or cancelled run leaves no files behind.
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

ide_command::domain!(
    scaffold:
    scaffold_catalog,
    scaffold_create,
    scaffold_free_name,
    scaffold_options,
    scaffold_requirements,
    scaffold_target_taken,
);
