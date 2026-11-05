//! "Import a report collected in CI from disk": the format is sniffed from the
//! content (lcov, Go cover profile, JaCoCo XML, SimpleCov resultset) and paths recorded on another
//! machine are mapped into the project by their longest existing suffix.

use crate::{Accumulator, CoverageSuite, goprofile, jacoco, lcov, simplecov};
use ide_core::{IdeError, IdeResult};
use std::path::{Component, Path, PathBuf};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Format {
    Lcov,
    GoProfile,
    Jacoco,
    SimpleCov,
}

pub(crate) fn detect(text: &str) -> Option<Format> {
    let head = text.trim_start_matches('\u{feff}').trim_start();
    if head.starts_with('<') {
        return head.contains("<report").then_some(Format::Jacoco);
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
        None => {
            return Err(IdeError::invalid(format!(
                "{} is not an lcov tracefile, Go cover profile, JaCoCo XML report or SimpleCov resultset",
                path.display()
            )));
        }
    };
    for f in &mut suite.files {
        let p: &Path = f.path.as_ref();
        if !p.exists()
            && let Some(found) = relocate(p, root)
        {
            f.path = found.into();
        }
    }
    suite.files.sort_by(|a, b| (a.path.as_ref() as &Path).cmp(b.path.as_ref()));
    Ok(suite)
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
        assert_eq!(detect("<?xml version=\"1.0\"?><coverage/>"), None);
        assert_eq!(detect("{\"RSpec\": {\"coverage\": {}}}"), Some(Format::SimpleCov));
        assert_eq!(detect("{\"name\": \"package.json\"}"), None);
        assert_eq!(detect("hello"), None);
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
    }

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
