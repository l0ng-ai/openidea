//! Run with Coverage: launch plans and coverage reports.
use crate::Host;
use ide_command::command;

use super::blocking;
use ide_core::{IdeError, IdeResult, IpcPath};
use ide_coverage::{CoveragePrepared, CoverageReportSpec, CoverageSuite};
use ide_run::RunConfig;

/// Output directories kept per kind (older runs' data is deleted).
pub const KEEP_RUNS: usize = 10;

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
    // Also reads Cobertura XML, a SimpleCov resultset and coverage.py data files.
    let project = host.project(window)?;
    let (root, cache, config_dir) =
        (project.root.clone(), project.cache_dir.join("coverage-import"), host.config_dir.clone());
    let trusted = project.require_trust();
    blocking(move || {
        if !ide_coverage::is_data_file(&path) {
            return ide_coverage::import(&path, &root);
        }
        // coverage.py analyses the sources with the project's interpreter: that runs project code.
        trusted.map_err(|_| {
            IdeError::unavailable(
                "Reading a .coverage data file runs the project's Python. Trust the project, or import the output of `coverage xml`.",
            )
        })?;
        let python = super::sdk::effective_python(&config_dir, &project, path.parent()).ok_or_else(|| {
            IdeError::unavailable(
                "Reading a .coverage data file needs the project's Python interpreter. Choose one, or import the output of `coverage xml`.",
            )
        })?;
        let out = ide_run::wrap::new_output_dir(&cache, KEEP_RUNS)?;
        ide_coverage::import_data(&path, &root, &python, &out)
    })
    .await
}

ide_command::domain!(coverage: coverage_collect, coverage_import, coverage_prepare);
