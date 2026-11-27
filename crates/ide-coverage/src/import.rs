//! "Import a report collected in CI from disk": the format is sniffed from the
//! content (lcov, Go cover profile, JaCoCo or Cobertura XML, SimpleCov resultset) and paths recorded on another
//! machine are mapped into the project by their longest existing suffix.

use crate::{Accumulator, CoverageSuite, cobertura, goprofile, jacoco, lcov, simplecov};
use ide_core::{IdeError, IdeResult};
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Format {
    Lcov,
    GoProfile,
    Jacoco,
    Cobertura,
    SimpleCov,
}

pub(crate) fn detect(text: &str) -> Option<Format> {
    let head = text.trim_start_matches('\u{feff}').trim_start();
    if head.starts_with('<') {
        // The root element, after any prolog or DOCTYPE naming it.
        return match (head.find("<report"), head.find("<coverage")) {
            (Some(r), c) if c.is_none_or(|c| r < c) => Some(Format::Jacoco),
            (_, Some(_)) => Some(Format::Cobertura),
            _ => None,
        };
    }
    if head.starts_with('{') {
        return head.contains("\"coverage\"").then_some(Format::SimpleCov);
    }
    let first = head.lines().next().unwrap_or_default();
    if first.starts_with("mode:") {
        return Some(Format::GoProfile);
    }
    head.lines().any(|l| l.trim_start().starts_with("SF:")).then_some(Format::Lcov)
}

/// Reads the report at `path` for the project at `root`. Blocking.
pub fn import(path: &Path, root: &Path) -> IdeResult<CoverageSuite> {
    let text = std::fs::read_to_string(path)?;
    let mut suite = match detect(&text) {
        Some(Format::Lcov) => lcov::parse(&text, root).finish("lcov"),
        Some(Format::SimpleCov) => simplecov::parse(&text, root)?.finish("SimpleCov"),
        Some(Format::GoProfile) => {
            let (module, module_dir) = go_module_for(root, &text);
            goprofile::parse(&text, &module, &module_dir).finish("go test -cover")
        }
        Some(Format::Cobertura) => cobertura::parse(&text, root)
            .map_err(|e| IdeError::invalid(format!("{}: {e}", path.display())))?
            .finish("Cobertura"),
        Some(Format::Jacoco) => {
            // A report inside the project (`<module>/target/site/jacoco/…`) knows its module.
            let module = jacoco::module_dir(path);
            let module =
                if path.starts_with(root) && module.starts_with(root) && module != path.parent().unwrap_or(path) {
                    module
                } else {
                    root.to_path_buf()
                };
            let mut acc = Accumulator { has_branches: true, ..Default::default() };
            jacoco::parse_into(&text, &module, &mut acc)
                .map_err(|e| IdeError::invalid(format!("{}: {e}", path.display())))?;
            acc.finish("JaCoCo")
        }
        None if text.starts_with("!coverage.py: This is a private format") => {
            return Err(IdeError::invalid(format!(
                "{} is coverage.py 4 data, which current coverage.py can't read. Import the output of `coverage xml` instead.",
                path.display()
            )));
        }
        None => {
            return Err(IdeError::invalid(format!(
                "{} is not an lcov tracefile, Go cover profile, JaCoCo or Cobertura XML report or SimpleCov resultset",
                path.display()
            )));
        }
    };
    let mut dirs = HashMap::new();
    for f in &mut suite.files {
        let p: &Path = f.path.as_ref();
        let present = p.parent().is_none_or(|d| dir_exists(d, &mut dirs)) && p.exists();
        if !present && let Some(found) = relocate(p, root) {
            f.path = found.into();
        }
    }
    suite.files.sort_by(|a, b| (a.path.as_ref() as &Path).cmp(b.path.as_ref()));
    Ok(suite)
}

/// Reads a coverage.py data file (see [`crate::is_data_file`]) with the coverage.py of `python`,
/// run in `root`; `out` is an empty scratch directory. Blocking.
pub fn import_data(path: &Path, root: &Path, python: &Path, out: &Path) -> IdeResult<CoverageSuite> {
    crate::coveragepy::import(path, root, python, out)
}

/// Whether `dir` exists, without asking again below a directory known to be missing: every
/// lookup under macOS's `/home` (autofs) takes tens of milliseconds, and CI reports
/// (`/home/runner/work/…`) name thousands of files there.
fn dir_exists(dir: &Path, known: &mut HashMap<PathBuf, bool>) -> bool {
    if let Some(&e) = known.get(dir) {
        return e;
    }
    let e = dir.parent().is_none_or(|p| dir_exists(p, known)) && dir.is_dir();
    known.insert(dir.to_path_buf(), e);
    e
}

/// `/home/runner/work/app/app/src/lib.rs` → `<root>/src/lib.rs`: the longest suffix of
/// `path` that exists under `root`.
pub(crate) fn relocate(path: &Path, root: &Path) -> Option<PathBuf> {
    let parts: Vec<&std::ffi::OsStr> = path
        .components()
        .filter_map(|c| match c {
            Component::Normal(s) => Some(s),
            _ => None,
        })
        .collect();
    (0..parts.len()).find_map(|skip| {
        let candidate = parts[skip..].iter().fold(root.to_path_buf(), |p, s| p.join(s));
        candidate.is_file().then_some(candidate)
    })
}

/// The Go module the profile's import paths belong to: the project's `go.mod`, else one
/// a level or two down whose module path prefixes the profile's files.
fn go_module_for(root: &Path, profile: &str) -> (String, PathBuf) {
    let first = profile
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty() && !l.starts_with("mode:"))
        .and_then(|l| l.rsplit_once(':').map(|(f, _)| f.to_owned()))
        .unwrap_or_default();
    let matches = |module: &str| !module.is_empty() && (first == module || first.starts_with(&format!("{module}/")));
    let read = |dir: &Path| -> Option<String> {
        let text = std::fs::read_to_string(dir.join("go.mod")).ok()?;
        text.lines().find_map(|l| l.trim().strip_prefix("module")).map(|m| m.trim().trim_matches('"').to_owned())
    };
    let mut candidates = vec![root.to_path_buf()];
    for dir in std::fs::read_dir(root).into_iter().flatten().flatten().map(|e| e.path()).filter(|p| p.is_dir()) {
        candidates
            .extend(std::fs::read_dir(&dir).into_iter().flatten().flatten().map(|e| e.path()).filter(|p| p.is_dir()));
        candidates.push(dir);
    }
    let found: Vec<(String, PathBuf)> = candidates.into_iter().filter_map(|d| read(&d).map(|m| (m, d))).collect();
    found
        .iter()
        .find(|(m, _)| matches(m))
        .or_else(|| found.iter().find(|(_, d)| d == root))
        .cloned()
        .unwrap_or_else(|| (String::new(), root.to_path_buf()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_formats() {
        assert_eq!(detect("TN:\nSF:a.rs\nDA:1,1\nend_of_record\n"), Some(Format::Lcov));
        assert_eq!(detect("mode: atomic\nm/a.go:1.1,2.2 1 0\n"), Some(Format::GoProfile));
        assert_eq!(
            detect("<?xml version=\"1.0\"?><!DOCTYPE report><report name=\"x\"></report>"),
            Some(Format::Jacoco)
        );
        assert_eq!(detect("<?xml version=\"1.0\"?><coverage/>"), Some(Format::Cobertura));
        assert_eq!(
            detect("<?xml version=\"1.0\"?><!DOCTYPE coverage SYSTEM \"x.dtd\"><coverage/>"),
            Some(Format::Cobertura)
        );
        assert_eq!(detect("<?xml version=\"1.0\"?><html/>"), None);
        assert_eq!(detect("{\"RSpec\": {\"coverage\": {}}}"), Some(Format::SimpleCov));
        assert_eq!(detect("{\"name\": \"package.json\"}"), None);
        assert_eq!(detect("hello"), None);
    }

    #[test]
    fn missing_directories_are_looked_up_once() {
        let tmp = tempfile::tempdir().unwrap();
        let mut known = HashMap::new();
        assert!(dir_exists(tmp.path(), &mut known));
        let gone = tmp.path().join("gone");
        assert!(!dir_exists(&gone.join("a/b"), &mut known));
        std::fs::create_dir_all(gone.join("a/c")).unwrap();
        // Known to be missing, so its subdirectories are not looked up.
        assert!(!dir_exists(&gone.join("a/c"), &mut known));
        assert_eq!(known.get(&gone), Some(&false));
    }

    #[test]
    fn imports_ci_simplecov_with_foreign_paths() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("app");
        std::fs::create_dir_all(root.join("lib")).unwrap();
        std::fs::write(root.join("lib/a.rb"), "").unwrap();
        let report = tmp.path().join(".resultset.json");
        std::fs::write(
            &report,
            r#"{"RSpec":{"coverage":{"/home/runner/work/app/app/lib/a.rb":{"lines":[null,1,0]}}}}"#,
        )
        .unwrap();
        let suite = import(&report, &root).unwrap();
        assert_eq!(suite.runner, "SimpleCov");
        assert_eq!(suite.files[0].path.as_ref() as &Path, root.join("lib/a.rb"));
        assert_eq!((suite.files[0].lines_total, suite.files[0].lines_covered), (2, 1));
    }

    #[test]
    fn imports_ci_lcov_with_foreign_paths() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("app");
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/lib.rs"), "").unwrap();
        let report = tmp.path().join("lcov.info");
        std::fs::write(&report, "SF:/home/runner/work/app/app/src/lib.rs\nDA:1,1\nDA:2,0\nend_of_record\n").unwrap();
        let suite = import(&report, &root).unwrap();
        assert_eq!(suite.runner, "lcov");
        assert_eq!(suite.files[0].path.as_ref() as &Path, root.join("src/lib.rs"));
        assert_eq!(suite.files[0].lines_covered, 1);
        assert!(import(&tmp.path().join("missing"), &root).is_err());
        std::fs::write(&report, "nothing").unwrap();
        assert!(import(&report, &root).is_err());
        std::fs::write(&report, "!coverage.py: This is a private format, don't read it directly!{\"lines\":{}}")
            .unwrap();
        assert!(import(&report, &root).unwrap_err().to_string().contains("coverage.py 4 data"));
    }

    /// `coverage xml` (coverage.py 7.17, `--branch`) of a project checked out on a CI runner.
    #[test]
    fn imports_coverage_py_xml_with_foreign_sources() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("app");
        std::fs::create_dir_all(root.join("src/calc")).unwrap();
        std::fs::write(root.join("src/calc/__init__.py"), "").unwrap();
        let report = tmp.path().join("coverage.xml");
        std::fs::write(&report, COVERAGE_PY_XML).unwrap();
        let suite = import(&report, &root).unwrap();
        assert_eq!(suite.runner, "Cobertura");
        assert!(suite.has_branches);
        let calc = suite.files.iter().find(|f| f.path.as_ref() as &Path == root.join("src/calc/__init__.py")).unwrap();
        assert_eq!((calc.lines_total, calc.lines_covered, calc.branches_total, calc.branches_covered), (8, 5, 4, 2));
        assert_eq!(calc.lines.iter().filter(|l| l.partial()).map(|l| l.line).collect::<Vec<_>>(), [1, 3]);
        // The test file is not in this checkout: it keeps the runner's path.
        assert!(
            suite.files.iter().any(|f| f.path.as_ref() as &Path == Path::new("/home/runner/work/app/app/test_calc.py"))
        );
    }

    const COVERAGE_PY_XML: &str = r#"<?xml version="1.0" ?>
<coverage version="7.17.5" timestamp="1795754882920" lines-valid="13" lines-covered="10" line-rate="0.7692" branches-valid="4" branches-covered="2" branch-rate="0.5" complexity="0">
	<!-- Generated by coverage.py: https://coverage.readthedocs.io/en/7.17.5 -->
	<!-- Based on https://raw.githubusercontent.com/cobertura/web/master/htdocs/xml/coverage-04.dtd -->
	<sources>
		<source>/home/runner/work/app/app</source>
	</sources>
	<packages>
		<package name="." line-rate="1" branch-rate="1" complexity="0">
			<classes>
				<class name="test_calc.py" filename="test_calc.py" complexity="0" line-rate="1" branch-rate="1">
					<methods/>
					<lines>
						<line number="1" hits="1"/>
						<line number="2" hits="1"/>
						<line number="3" hits="1"/>
						<line number="6" hits="1"/>
						<line number="7" hits="1"/>
					</lines>
				</class>
			</classes>
		</package>
		<package name="src.calc" line-rate="0.625" branch-rate="0.5" complexity="0">
			<classes>
				<class name="__init__.py" filename="src/calc/__init__.py" complexity="0" line-rate="0.625" branch-rate="0.5">
					<methods/>
					<lines>
						<line number="1" hits="1"/>
						<line number="2" hits="1" branch="true" condition-coverage="50% (1/2)" missing-branches="3"/>
						<line number="3" hits="0"/>
						<line number="4" hits="1" branch="true" condition-coverage="50% (1/2)" missing-branches="5"/>
						<line number="5" hits="0"/>
						<line number="6" hits="1"/>
						<line number="13" hits="1"/>
						<line number="14" hits="0"/>
					</lines>
				</class>
			</classes>
		</package>
	</packages>
</coverage>
"#;

    #[test]
    fn imports_go_profiles_of_nested_modules() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("svc/calc")).unwrap();
        std::fs::write(root.join("svc/go.mod"), "module example.com/svc\n").unwrap();
        let report = root.join("cover.out");
        std::fs::write(&report, "mode: set\nexample.com/svc/calc/calc.go:3.1,4.2 1 1\n").unwrap();
        let suite = import(&report, root).unwrap();
        assert_eq!(suite.files[0].path.as_ref() as &Path, root.join("svc/calc/calc.go"));
    }

    #[test]
    fn imports_jacoco_against_the_project() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("p");
        std::fs::create_dir_all(root.join("src/main/java/com/x")).unwrap();
        std::fs::write(root.join("src/main/java/com/x/A.java"), "").unwrap();
        let report = tmp.path().join("jacoco.xml");
        let xml = r#"<report name="p"><package name="com/x"><sourcefile name="A.java"><line nr="2" mi="0" ci="1" mb="0" cb="0"/></sourcefile></package></report>"#;
        std::fs::write(&report, xml).unwrap();
        let suite = import(&report, &root).unwrap();
        assert_eq!(suite.files[0].path.as_ref() as &Path, root.join("src/main/java/com/x/A.java"));
        assert!(suite.has_branches);
    }
}
