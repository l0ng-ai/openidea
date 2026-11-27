//! coverage.py data files (`.coverage`, and `.coverage.*` of parallel runs): SQLite databases of
//! executed lines and arcs. Which lines are statements, excluded or branches only comes from
//! analysing the source, so coverage.py in the project's interpreter combines the data into a
//! scratch file (`[paths]` of the project's configuration applies) and writes Cobertura XML.

use crate::{CoverageSuite, cobertura};
use ide_core::{IdeError, IdeResult};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;

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

/// The files a `coverage xml -i` run skipped: `… No source for code: '<path>'. …`.
fn missing_sources(stderr: &str) -> Vec<PathBuf> {
    stderr
        .lines()
        .filter_map(|l| l.split_once("No source for code: '")?.1.split_once("'.").map(|(p, _)| PathBuf::from(p)))
        .collect()
}

fn coverage(python: &Path, root: &Path, args: &[&std::ffi::OsStr]) -> IdeResult<String> {
    let out = ide_core::process::prepare(Command::new(python).current_dir(root))
        .args(["-m", "coverage"])
        .args(args)
        .output()
        .map_err(|e| IdeError::unavailable(format!("cannot run {}: {e}", python.display())))?;
    let stderr = ide_core::output_encoding::decode_tool_output(&out.stderr);
    if out.status.success() {
        return Ok(stderr);
    }
    if stderr.contains("No module named coverage") {
        return Err(IdeError::unavailable(format!(
            "Reading a .coverage data file needs coverage.py in the project's interpreter ({}). Install it, or import the output of `coverage xml`.",
            python.display()
        )));
    }
    let text =
        if stderr.trim().is_empty() { ide_core::output_encoding::decode_tool_output(&out.stdout) } else { stderr };
    Err(IdeError::invalid(format!("coverage.py could not read the data: {}", text.trim())))
}

/// Reads the data file at `path` with `python`'s coverage.py, run in `root`; `out` holds the
/// scratch files. Blocking.
pub(crate) fn import(path: &Path, root: &Path, python: &Path, out: &Path) -> IdeResult<CoverageSuite> {
    let data = out.join(".coverage");
    let xml = out.join("coverage.xml");
    let inputs = inputs(path);
    let mut args: Vec<&std::ffi::OsStr> =
        vec!["combine".as_ref(), "--keep".as_ref(), "--data-file".as_ref(), data.as_ref()];
    args.extend(inputs.iter().map(|p| p.as_os_str()));
    coverage(python, root, &args)?;
    // `-i`: report what has source here instead of failing on the first file that has none.
    let stderr = coverage(
        python,
        root,
        &["xml".as_ref(), "-i".as_ref(), "--data-file".as_ref(), data.as_ref(), "-o".as_ref(), xml.as_ref()],
    )?;
    let text = std::fs::read_to_string(&xml)?;
    let mut acc = cobertura::parse(&text, root).map_err(|e| IdeError::invalid(format!("{}: {e}", xml.display())))?;
    for file in missing_sources(&stderr) {
        acc.file(&file);
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
    fn reads_files_without_source_from_warnings() {
        let stderr = "/v/lib/coverage/report_core.py:122: CoverageWarning: Couldn't parse '/ci/app/a.py': No source for code: '/ci/app/a.py'. (couldnt-parse); see https://coverage.readthedocs.io\n  coverage._warn(msg, slug=\"couldnt-parse\")\n";
        assert_eq!(missing_sources(stderr), [PathBuf::from("/ci/app/a.py")]);
    }
}
