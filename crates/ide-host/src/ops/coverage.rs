//! Run with Coverage: launch plans and coverage reports.
use crate::Host;
use ide_command::command;

use ide_core::{IdeError, IdeResult, IpcPath};
use ide_coverage::{CoveragePrepared, CoverageReportSpec, CoverageSuite};
use ide_run::RunConfig;

/// Output directories kept per kind (older runs' data is deleted).
pub const KEEP_RUNS: usize = 10;

pub async fn blocking<T: Send + 'static>(f: impl FnOnce() -> IdeResult<T> + Send + 'static) -> IdeResult<T> {
    tokio::task::spawn_blocking(f).await.map_err(|e| IdeError::internal(e.to_string()))?
}

/// How to run `config` with coverage: the command to launch and where its report will be,
/// or which tool is missing.
#[command(trust = trusted)]
pub async fn coverage_prepare(host: &Host, window: &str, config: RunConfig) -> IdeResult<CoveragePrepared> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    let (root, cache) = (project.root.clone(), project.cache_dir.join("coverage"));
    blocking(move || {
        let out = ide_run::wrap::new_output_dir(&cache, KEEP_RUNS)?;
        Ok(ide_coverage::prepare(&root, &config, &out))
    })
    .await
}

/// Reads the report a coverage run left behind.
#[command(trust = trusted)]
pub async fn coverage_collect(host: &Host, window: &str, report: CoverageReportSpec) -> IdeResult<CoverageSuite> {
    host.require_trust(window)?;
    blocking(move || ide_coverage::collect(&report)).await
}

/// Reads a report collected elsewhere (CI): lcov, a Go cover profile or JaCoCo XML,
/// with paths mapped into this project.
#[command(trust = always)]
pub async fn coverage_import(host: &Host, window: &str, path: IpcPath) -> IdeResult<CoverageSuite> {
    // Also reads a SimpleCov resultset.
    let root = host.project(window)?.root.clone();
    blocking(move || ide_coverage::import(&path, &root)).await
}

ide_command::domain!(coverage: coverage_collect, coverage_import, coverage_prepare);
