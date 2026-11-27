//! coverage.py data files (`.coverage`, and `.coverage.*` of parallel runs): SQLite databases of
//! executed lines and arcs. Which lines are statements, excluded or branches only comes from
//! analysing the source, so coverage.py in the project's interpreter combines the data into a
//! scratch file (`[paths]` of the project's configuration applies) and writes Cobertura XML.

use crate::{CoverageSuite, cobertura};
use ide_core::cli_process::{CliTool, Decoding};
use ide_core::{IdeError, IdeResult};
use std::ffi::OsStr;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

const COVERAGE_PY: CliTool = CliTool::new("coverage.py", Decoding::ToolOutput);
/// Analysing a large project's sources takes a while; a `[run] plugins` that hangs must not
/// block the import for good.
const TIMEOUT: Duration = Duration::from_secs(600);
/// Files of the combined data (`relative_files` keeps them relative to the directory it ran in).
const MEASURED: &str = "import sys, json, coverage\n\
    d = coverage.CoverageData(sys.argv[1]); d.read(); print(json.dumps(sorted(d.measured_files())))";
/// The files coverage.py reads its configuration from, in the directory it runs in.
const CONFIG_FILES: [&str; 4] = [".coveragerc", "setup.cfg", "tox.ini", "pyproject.toml"];

/// Whether `path` is an SQLite database (coverage.py 5+ data).
pub fn is_data_file(path: &Path) -> bool {
    let mut head = [0u8; 16];
    std::fs::File::open(path).and_then(|mut f| f.read_exact(&mut head)).is_ok() && &head == b"SQLite format 3\0"
}

/// `path`, or every `.coverage.*` file next to it when it is one of a parallel run's.
fn inputs(path: &Path) -> Vec<PathBuf> {
    let parallel = path.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with(".coverage."));
    let mut files: Vec<PathBuf> = match (parallel, path.parent()) {
        (true, Some(dir)) => std::fs::read_dir(dir)
            .into_iter()
            .flatten()
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with(".coverage.")) && is_data_file(p)
            })
            .collect(),
        _ => Vec::new(),
    };
    if files.is_empty() {
        files.push(path.to_path_buf());
    }
    files.sort();
    files
}

/// Where coverage.py ran: the nearest directory of `path` inside `root` with a coverage.py
/// configuration file (a monorepo's `backend/pyproject.toml`), else `root`.
fn run_dir(path: &Path, root: &Path) -> PathBuf {
    path.ancestors()
        .skip(1)
        .take_while(|d| d.starts_with(root))
        .find(|d| CONFIG_FILES.iter().any(|f| d.join(f).is_file()))
        .unwrap_or(root)
        .to_path_buf()
}

/// Runs `python -W ignore <args>` in `dir` and returns its stdout. Python warnings are
/// ignored so `PYTHONWARNINGS=error` can't turn coverage.py's warnings into failures.
fn python(python: &Path, dir: &Path, args: &[&OsStr]) -> IdeResult<String> {
    let mut cmd = Command::new(python);
    cmd.current_dir(dir).args(["-W", "ignore"]).args(args);
    let out = COVERAGE_PY.run(cmd, TIMEOUT, None)?;
    if out.success {
        return Ok(out.stdout);
    }
    let text = if out.stderr.trim().is_empty() { out.stdout } else { out.stderr };
    let text = text.trim();
    if text.contains("No module named coverage") {
        return Err(IdeError::unavailable(format!(
            "Reading a .coverage data file needs coverage.py in the project's interpreter ({}). Install it, or import the output of `coverage xml`.",
            python.display()
        )));
    }
    if text.contains("no such option") {
        return Err(IdeError::unavailable(format!(
            "Reading a .coverage data file needs coverage.py 6.3 or later in the project's interpreter ({}): {text}",
            python.display()
        )));
    }
    Err(IdeError::invalid(format!("coverage.py could not read the data: {text}")))
}

/// Reads the data file at `path` with `python`'s coverage.py, run where the project's coverage.py
/// configuration is; `out` holds the scratch files. Blocking.
pub(crate) fn import(path: &Path, root: &Path, python_path: &Path, out: &Path) -> IdeResult<CoverageSuite> {
    let dir = run_dir(path, root);
    let data = out.join(".coverage");
    let xml = out.join("coverage.xml");
    let coverage = |args: &[&OsStr]| {
        let mut all: Vec<&OsStr> = vec!["-m".as_ref(), "coverage".as_ref()];
        all.extend(args);
        python(python_path, &dir, &all)
    };
    let inputs = inputs(path);
    let mut args: Vec<&OsStr> = vec!["combine".as_ref(), "--keep".as_ref(), "--data-file".as_ref(), data.as_ref()];
    args.extend(inputs.iter().map(|p| p.as_os_str()));
    coverage(&args)?;
    // `-i`: report what has source here instead of failing on the first file that has none.
    // `--fail-under=0`: a `[report] fail_under` the data misses must not fail the import.
    coverage(&[
        "xml".as_ref(),
        "-i".as_ref(),
        "--fail-under=0".as_ref(),
        "--data-file".as_ref(),
        data.as_ref(),
        "-o".as_ref(),
        xml.as_ref(),
    ])?;
    let text = std::fs::read_to_string(&xml)?;
    let mut acc = cobertura::parse(&text, &dir).map_err(|e| IdeError::invalid(format!("{}: {e}", xml.display())))?;
    // The files the report left out (no source here): listed without lines.
    let measured = python(python_path, &dir, &["-c".as_ref(), MEASURED.as_ref(), data.as_ref()])?;
    let measured: Vec<PathBuf> = serde_json::from_str(measured.trim())
        .map_err(|e| IdeError::invalid(format!("coverage.py listed the measured files unreadably: {e}")))?;
    for file in measured {
        acc.file(&dir.join(file));
    }
    Ok(acc.finish("coverage.py"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_files_of_a_parallel_run() {
        let tmp = tempfile::tempdir().unwrap();
        let db = |name: &str| {
            let p = tmp.path().join(name);
            std::fs::write(&p, b"SQLite format 3\0rest").unwrap();
            p
        };
        let a = db(".coverage.host.1.x");
        let b = db(".coverage.host.2.y");
        let single = db(".coverage");
        std::fs::write(tmp.path().join(".coverage.notes"), "text").unwrap();
        std::fs::write(tmp.path().join(".coveragerc"), "[run]\n").unwrap();
        assert!(is_data_file(&a) && !is_data_file(&tmp.path().join(".coveragerc")));
        assert_eq!(inputs(&a), [a.clone(), b]);
        assert_eq!(inputs(&single), [single]);
    }

    /// Two parallel runs recorded on another machine (`…/ci/app`), mapped by the project's `[paths]`.
    /// Needs coverage.py in `python3`; skipped without it.
    #[test]
    fn combines_parallel_data_with_the_projects_paths() {
        let has_coverage = Command::new("python3").args(["-m", "coverage", "--version"]).output();
        if !has_coverage.is_ok_and(|o| o.status.success()) {
            eprintln!("skipped: no coverage.py in python3");
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        // coverage.py reports real paths (`/private/var/…` for macOS's `/var/…`).
        let base = tmp.path().canonicalize().unwrap();
        let ci = base.join("ci/app");
        let root = base.join("project");
        let calc = "def sign(n):\n    if n < 0:\n        return -1\n    return 1\n";
        for dir in [&ci, &root] {
            std::fs::create_dir_all(dir).unwrap();
            std::fs::write(dir.join("calc.py"), calc).unwrap();
        }
        std::fs::write(ci.join("gone.py"), "x = 1\n").unwrap();
        std::fs::write(ci.join("neg.py"), "import calc, gone\ncalc.sign(-1)\n").unwrap();
        std::fs::write(ci.join("pos.py"), "import calc\ncalc.sign(1)\n").unwrap();
        for script in ["neg.py", "pos.py"] {
            let ok = Command::new("python3")
                .current_dir(&ci)
                .args(["-m", "coverage", "run", "--branch", "--parallel-mode", script])
                .status()
                .unwrap();
            assert!(ok.success());
        }
        let data = root.join("data");
        std::fs::create_dir_all(&data).unwrap();
        for e in std::fs::read_dir(&ci).unwrap().flatten() {
            if e.file_name().to_string_lossy().starts_with(".coverage.") {
                std::fs::rename(e.path(), data.join(e.file_name())).unwrap();
            }
        }
        std::fs::remove_dir_all(&ci).unwrap();
        std::fs::write(root.join(".coveragerc"), "[paths]\nsource =\n    ./\n    */ci/app/\n").unwrap();
        let first = std::fs::read_dir(&data).unwrap().flatten().next().unwrap().path();
        let out = base.join("out");
        std::fs::create_dir_all(&out).unwrap();
        let suite = import(&first, &root, Path::new("python3"), &out).unwrap();

        let calc = suite.files.iter().find(|f| f.path.as_ref() as &Path == root.join("calc.py")).unwrap();
        // Both runs together take both branches of line 2.
        assert_eq!((calc.lines_total, calc.lines_covered, calc.branches_total, calc.branches_covered), (4, 4, 2, 2));
        // The scripts and `gone.py` have no source in the project: listed without lines.
        let empty: Vec<&str> = suite
            .files
            .iter()
            .filter(|f| f.lines.is_empty())
            .filter_map(|f| (f.path.as_ref() as &Path).file_name()?.to_str())
            .collect();
        assert_eq!(empty, ["gone.py", "neg.py", "pos.py"]);
        // They keep the recorded path, so the import notification counts them as not in the project.
        assert!(suite.files.iter().filter(|f| f.lines.is_empty()).all(|f| (f.path.as_ref() as &Path).starts_with(&ci)));
        assert_eq!(std::fs::read_dir(&data).unwrap().count(), 2, "the user's data files are kept");
    }

    #[test]
    fn runs_where_the_coverage_configuration_is() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("backend/reports")).unwrap();
        std::fs::create_dir_all(root.join("data")).unwrap();
        std::fs::write(root.join("backend/pyproject.toml"), "").unwrap();
        assert_eq!(run_dir(&root.join("backend/reports/.coverage"), root), root.join("backend"));
        assert_eq!(run_dir(&root.join("data/.coverage"), root), root);
        // A data file outside the project runs in the project.
        assert_eq!(run_dir(Path::new("/elsewhere/.coverage"), root), root);
    }

    /// A stand-in interpreter that prints `stderr` and exits with `code`.
    #[cfg(unix)]
    fn fake_python(dir: &Path, stderr: &str, code: i32) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let p = dir.join("python");
        std::fs::write(&p, format!("#!/bin/sh\necho '{stderr}' >&2\nexit {code}\n")).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        p
    }

    #[cfg(unix)]
    #[test]
    fn reports_why_coverage_py_failed() {
        let tmp = tempfile::tempdir().unwrap();
        let data = tmp.path().join(".coverage");
        let err = |stderr: &str| {
            let python = fake_python(tmp.path(), stderr, 1);
            import(&data, tmp.path(), &python, tmp.path()).unwrap_err().to_string()
        };
        assert!(err("No module named coverage").contains("needs coverage.py in the project's interpreter"));
        assert!(err("no such option: --data-file").contains("needs coverage.py 6.3 or later"));
        assert!(err("No usable data files").contains("coverage.py could not read the data: No usable data files"));
    }

    /// A monorepo member's data recorded with `relative_files`, below its `fail_under`, with
    /// coverage.py's warnings turned off. Needs coverage.py in `python3`; skipped without it.
    #[test]
    fn reads_a_members_relative_data_below_fail_under() {
        let has_coverage = Command::new("python3").args(["-m", "coverage", "--version"]).output();
        if !has_coverage.is_ok_and(|o| o.status.success()) {
            eprintln!("skipped: no coverage.py in python3");
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        let member = root.join("backend");
        std::fs::create_dir_all(member.join("app")).unwrap();
        std::fs::write(
            member.join("pyproject.toml"),
            "[tool.coverage.run]\nrelative_files = true\nbranch = true\ndisable_warnings = [\"couldnt-parse\"]\n\
             [tool.coverage.report]\nfail_under = 90\n",
        )
        .unwrap();
        std::fs::write(member.join("app/x.py"), "def f(n):\n    if n:\n        return 1\n    return 2\n").unwrap();
        std::fs::write(member.join("t.py"), "from app import x\nx.f(1)\n").unwrap();
        let ok = Command::new("python3").current_dir(&member).args(["-m", "coverage", "run", "t.py"]).status().unwrap();
        assert!(ok.success());
        std::fs::remove_file(member.join("t.py")).unwrap();
        let out = root.join("out");
        std::fs::create_dir_all(&out).unwrap();
        let suite = import(&member.join(".coverage"), &root, Path::new("python3"), &out).unwrap();

        let x = suite.files.iter().find(|f| f.path.as_ref() as &Path == member.join("app/x.py")).unwrap();
        assert_eq!((x.lines_total, x.lines_covered, x.branches_total, x.branches_covered), (4, 3, 2, 1));
        // `t.py` has no source any more and its warning is off: still listed, without lines.
        let t = suite.files.iter().find(|f| f.path.as_ref() as &Path == member.join("t.py")).unwrap();
        assert!(t.lines.is_empty());
    }
}
