//! Run with Coverage.
//!
//! [`prepare`] turns a run configuration into the command that runs it under
//! the runtime's coverage tool (or explains which tool is missing), and
//! [`collect`] reads the report that run left behind into a [`CoverageSuite`]:
//!
//! | runtime | tool | report |
//! |---|---|---|
//! | Rust (`cargo test` / `run` / `nextest`) | `cargo llvm-cov` | lcov |
//! | JS / TS (vitest, jest scripts) | the runner's `--coverage` | lcov |
//! | Node.js scripts | `c8` | lcov |
//! | Python (pytest, scripts) | coverage.py (`coverage run`, then `coverage lcov`) | lcov |
//! | Go (`go test`) | `-coverprofile` | Go cover profile |
//! | Maven / Gradle tests | JaCoCo (plugin goals / an init script) | JaCoCo XML |
//!
//! Lines in the model are 0-based, like every IPC coordinate.

mod goprofile;
mod import;
mod jacoco;
mod lcov;
mod plan;

pub use import::import;
pub use plan::prepare;

use ide_core::{IdeError, IdeResult, IpcPath};
use ide_run::RunConfig;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Coverage of one source line.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LineCoverage {
    /// 0-based.
    pub line: u32,
    /// Execution count (JaCoCo: covered instructions); 0 = not covered.
    pub hits: u32,
    pub branches_total: u32,
    pub branches_covered: u32,
}

impl LineCoverage {
    /// Covered, but not every branch (or block) on the line.
    pub fn partial(&self) -> bool {
        self.hits > 0 && self.branches_covered < self.branches_total
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FileCoverage {
    pub path: IpcPath,
    /// Sorted by line.
    pub lines: Vec<LineCoverage>,
    pub lines_total: u32,
    pub lines_covered: u32,
    pub branches_total: u32,
    pub branches_covered: u32,
}

/// One coverage run's report.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CoverageSuite {
    /// Tool that produced it, e.g. `cargo-llvm-cov`, `JaCoCo`.
    pub runner: String,
    /// Whether branch counts are meaningful (lcov `BRDA`, JaCoCo); Go profiles only have blocks.
    pub has_branches: bool,
    /// Sorted by path.
    pub files: Vec<FileCoverage>,
}

/// Where the report of a prepared run will be, and how to read it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum CoverageReportSpec {
    /// An lcov tracefile; relative `SF:` paths resolve against `base`.
    Lcov { runner: String, path: IpcPath, base: IpcPath },
    /// `go test -coverprofile`; import paths under `module` map to `module_dir`.
    GoProfile { path: IpcPath, module: String, module_dir: IpcPath },
    /// Every JaCoCo XML report (Maven `target/site/jacoco`, Gradle `build/reports/jacoco`) under `dir`.
    Jacoco { dir: IpcPath },
    /// The tool's raw data is exported to lcov by `argv` first (coverage.py: `… -m coverage lcov -o <lcov>`).
    Exported { runner: String, argv: Vec<String>, cwd: IpcPath, env: BTreeMap<String, String>, lcov: IpcPath },
}

/// A command line that installs a missing tool (run in the Run tool window).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct InstallCommand {
    pub command: String,
    pub args: Vec<String>,
    pub cwd: Option<IpcPath>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum CoveragePrepared {
    Ready {
        runner: String,
        /// What to launch instead of the configuration.
        launch: Box<RunConfig>,
        report: CoverageReportSpec,
    },
    MissingTool {
        tool: String,
        message: String,
        install: Option<InstallCommand>,
    },
    Unsupported {
        reason: String,
    },
}

/// Line data merged from one or more report records.
#[derive(Default)]
pub(crate) struct Accumulator {
    files: BTreeMap<PathBuf, BTreeMap<u32, LineAcc>>,
    pub(crate) has_branches: bool,
}

#[derive(Default)]
struct LineAcc {
    hits: u64,
    /// Branch (or block) key → taken.
    branches: BTreeMap<String, bool>,
}

impl Accumulator {
    pub(crate) fn line(&mut self, file: &Path, line: u32, hits: u64) {
        let acc = self.files.entry(file.to_path_buf()).or_default().entry(line).or_default();
        acc.hits = acc.hits.saturating_add(hits);
    }

    /// A branch outcome on `line`; the same `key` from several records counts once (taken if any).
    pub(crate) fn branch(&mut self, file: &Path, line: u32, key: String, taken: bool) {
        let acc = self.files.entry(file.to_path_buf()).or_default().entry(line).or_default();
        let b = acc.branches.entry(key).or_default();
        *b |= taken;
    }

    /// Declares `file` (a report entry without line data still lists the file).
    pub(crate) fn file(&mut self, file: &Path) {
        self.files.entry(file.to_path_buf()).or_default();
    }

    pub(crate) fn finish(self, runner: &str) -> CoverageSuite {
        let files = self
            .files
            .into_iter()
            .map(|(path, lines)| {
                let lines: Vec<LineCoverage> = lines
                    .into_iter()
                    .map(|(line, acc)| LineCoverage {
                        line,
                        hits: u32::try_from(acc.hits).unwrap_or(u32::MAX),
                        branches_total: acc.branches.len() as u32,
                        branches_covered: acc.branches.values().filter(|t| **t).count() as u32,
                    })
                    .collect();
                FileCoverage {
                    path: path.into(),
                    lines_total: lines.len() as u32,
                    lines_covered: lines.iter().filter(|l| l.hits > 0).count() as u32,
                    branches_total: lines.iter().map(|l| l.branches_total).sum(),
                    branches_covered: lines.iter().map(|l| l.branches_covered).sum(),
                    lines,
                }
            })
            .collect();
        CoverageSuite { runner: runner.to_owned(), has_branches: self.has_branches, files }
    }
}

/// Reads the report described by `spec` (running coverage.py's lcov export first).
/// Blocking: call from a blocking thread.
pub fn collect(spec: &CoverageReportSpec) -> IdeResult<CoverageSuite> {
    match spec {
        CoverageReportSpec::Lcov { runner, path, base } => {
            let text = read_report(path)?;
            Ok(lcov::parse(&text, base).finish(runner))
        }
        CoverageReportSpec::GoProfile { path, module, module_dir } => {
            let text = read_report(path)?;
            Ok(goprofile::parse(&text, module, module_dir).finish("go test -cover"))
        }
        CoverageReportSpec::Jacoco { dir } => {
            let reports = jacoco::find_reports(dir);
            if reports.is_empty() {
                return Err(IdeError::not_found(format!("no JaCoCo report under {}", dir.display())));
            }
            let mut acc = Accumulator { has_branches: true, ..Default::default() };
            for report in reports {
                let xml = std::fs::read_to_string(&report)?;
                let module = jacoco::module_dir(&report);
                jacoco::parse_into(&xml, &module, &mut acc)
                    .map_err(|e| IdeError::invalid(format!("{}: {e}", report.display())))?;
            }
            Ok(acc.finish("JaCoCo"))
        }
        CoverageReportSpec::Exported { runner, argv, cwd, env, lcov } => {
            let (program, args) =
                argv.split_first().ok_or_else(|| IdeError::invalid("empty coverage export command"))?;
            let out = ide_core::process::prepare(&mut Command::new(program))
                .args(args)
                .current_dir(cwd)
                .envs(env)
                .output()
                .map_err(|e| IdeError::unavailable(format!("cannot run {program}: {e}")))?;
            if !out.status.success() {
                let text = ide_core::output_encoding::decode_tool_output(&out.stderr).trim().to_owned();
                let text = if text.is_empty() {
                    ide_core::output_encoding::decode_tool_output(&out.stdout).trim().to_owned()
                } else {
                    text
                };
                return Err(IdeError::not_found(format!("exporting the coverage data failed: {text}")));
            }
            let text = read_report(lcov)?;
            Ok(lcov::parse(&text, cwd).finish(runner))
        }
    }
}

fn read_report(path: &Path) -> IdeResult<String> {
    std::fs::read_to_string(path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => {
            IdeError::not_found(format!("the run produced no coverage report ({})", path.display()))
        }
        _ => e.into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accumulator_merges_records_of_the_same_file() {
        let mut acc = Accumulator::default();
        let f = Path::new("/p/a.rs");
        acc.line(f, 0, 1);
        acc.line(f, 0, 2);
        acc.line(f, 3, 0);
        acc.branch(f, 0, "0:0".into(), true);
        acc.branch(f, 0, "0:1".into(), false);
        acc.branch(f, 0, "0:1".into(), false);
        acc.file(Path::new("/p/empty.rs"));
        let suite = acc.finish("t");
        assert_eq!(suite.files.len(), 2);
        let a = &suite.files[0];
        assert_eq!(a.path.as_ref() as &Path, f);
        assert_eq!((a.lines_total, a.lines_covered, a.branches_total, a.branches_covered), (2, 1, 2, 1));
        assert_eq!(a.lines[0], LineCoverage { line: 0, hits: 3, branches_total: 2, branches_covered: 1 });
        assert!(a.lines[0].partial());
        assert!(!a.lines[1].partial());
        assert_eq!(suite.files[1].lines_total, 0);
    }
}
