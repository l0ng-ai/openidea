//! Typed Go configurations use the process service for both build and execution.
use crate::RunConfig;
use ide_core::{IdeError, IdeResult};
use std::collections::HashSet;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

pub struct Plan {
    pub build: RunConfig,
    pub run: Option<RunConfig>,
}

pub fn plan(root: &Path, config: &RunConfig) -> IdeResult<Option<Plan>> {
    if config.kind != "go" || !config.extras.params.contains_key("goKind") {
        return Ok(None);
    }
    let p = &config.extras.params;
    let get = |key: &str| p.get(key).map(String::as_str).unwrap_or("");
    let module = root.join(if get("module").is_empty() { "." } else { get("module") });
    let mut build = config.clone();
    build.cwd = Some(module.clone().into());
    let test = get("goKind") == "test";
    if get("scope") == "directory" {
        let target = module.join(get("target"));
        build.cwd = Some(target.into());
        if let Some(arg) = build.args.iter_mut().skip(1).find(|a| a.as_str() == get("target")) {
            *arg = ".".into();
        }
    }
    if test {
        return Ok(Some(Plan { build, run: None }));
    }
    let output = if get("outputDir").is_empty() {
        crate::config::ignore_private(root, "/bin/")?;
        ide_core::project_dir::path(root, "bin")
    } else {
        root.join(get("outputDir"))
    };
    std::fs::create_dir_all(&output)?;
    let run_after_build = get("runAfterBuild") == "true";
    if !run_after_build {
        // Go requires a directory output for patterns containing several main packages.
        // Preserve explicit -o values, including Go's platform-specific special paths.
        if !build.args.iter().any(|arg| arg == "-o" || arg.starts_with("-o=")) {
            let directory = format!("{}{sep}", output.to_string_lossy(), sep = std::path::MAIN_SEPARATOR);
            build.args.splice(1..1, ["-o".into(), directory]);
        }
        return Ok(Some(Plan { build, run: None }));
    }
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    config.id.hash(&mut hash);
    let mut binary = output.join(format!("go-app-{:x}{}", hash.finish(), std::env::consts::EXE_SUFFIX));
    // An explicit Go -o selects the executable just as it does on the command line.
    let mut i = 1;
    while i < build.args.len() {
        if build.args[i] == "-o" {
            if let Some(path) = build.args.get(i + 1) {
                binary = module.join(path);
            }
            build.args.drain(i..(i + 2).min(build.args.len()));
        } else if let Some(path) = build.args[i].strip_prefix("-o=") {
            binary = module.join(path);
            build.args.remove(i);
        } else {
            i += 1;
        }
    }
    if binary.is_dir() || binary.to_string_lossy().ends_with(['/', '\\']) {
        let target = Path::new(get("target").split('|').next().unwrap_or("."));
        let name = target.file_stem().or_else(|| module.file_name()).unwrap_or_default().to_string_lossy();
        binary = binary.join(format!("{name}{}", std::env::consts::EXE_SUFFIX));
    }
    if let Some(dir) = binary.parent() {
        std::fs::create_dir_all(dir)?;
    }
    build.args.splice(1..1, ["-o".into(), binary.to_string_lossy().into_owned()]);
    let run = if get("runAfterBuild") == "true" {
        let mut run = config.clone();
        run.command = binary.to_string_lossy().into_owned();
        // Program args are stored separately as an argv vector by the form.
        run.args = p
            .get("programArgv")
            .map(|s| serde_json::from_str(s))
            .transpose()
            .map_err(|e| IdeError::invalid(e.to_string()))?
            .unwrap_or_default();
        run.extras.params.clear();
        Some(run)
    } else {
        None
    };
    Ok(Some(Plan { build, run }))
}

/// Uses Go's own build-file selection, including platform suffixes, cgo and build tags.
/// `-find` avoids dependency traversal and package downloads for this local directory.
pub fn package_sources(command: Command, dir: &Path, flags: &[String]) -> IdeResult<Vec<PathBuf>> {
    let package = package_info(command, dir, flags)?;
    Ok(["GoFiles", "CgoFiles"]
        .iter()
        .flat_map(|key| package[key].as_array().into_iter().flatten())
        .filter_map(|p| p.as_str())
        .map(|p| dir.join(p))
        .collect())
}

fn package_info(mut command: Command, dir: &Path, flags: &[String]) -> IdeResult<serde_json::Value> {
    command.args(["list", "-find", "-e", "-json"]);
    let mut it = flags.iter();
    while let Some(arg) = it.next() {
        let name = arg.split('=').next().unwrap_or(arg);
        if ["-tags", "-compiler", "-mod", "-modfile", "-overlay"].contains(&name) {
            command.arg(arg);
            if name == arg
                && let Some(value) = it.next()
            {
                command.arg(value);
            }
        } else if ["-race", "-msan", "-asan"].contains(&name) {
            command.arg(arg);
        }
    }
    command.arg(".").current_dir(dir).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.spawn()?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let reader = std::thread::spawn(move || {
        use std::io::Read;
        let mut text = String::new();
        if let Some(mut stdout) = stdout {
            let _ = stdout.read_to_string(&mut text);
        }
        text
    });
    let errors = std::thread::spawn(move || {
        use std::io::Read;
        let mut text = String::new();
        if let Some(mut stderr) = stderr {
            let _ = stderr.read_to_string(&mut text);
        }
        text
    });
    let deadline = Instant::now() + Duration::from_secs(10);
    let status = loop {
        match child.try_wait()? {
            Some(status) => break status,
            None if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            None => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(IdeError::unavailable("Go package discovery timed out"));
            }
        }
    };
    let text = reader.join().unwrap_or_default();
    let errors = errors.join().unwrap_or_default();
    if !status.success() {
        return Err(IdeError::invalid(format!("Go package discovery failed: {errors}")));
    }
    serde_json::from_str(&text).map_err(|e| IdeError::invalid(e.to_string()))
}

/// Keep the real package and its helpers, selecting tests by their declaration file.
pub fn file_test_exclusions(command: Command, file: &Path, flags: &[String]) -> IdeResult<String> {
    let dir = file.parent().ok_or_else(|| IdeError::invalid("Go test file has no directory"))?;
    let package = package_info(command, dir, flags)?;
    let files: Vec<_> = ["TestGoFiles", "XTestGoFiles"]
        .iter()
        .flat_map(|key| package[key].as_array().into_iter().flatten())
        .filter_map(|path| path.as_str())
        .collect();
    if !files.iter().any(|name| Some(std::ffi::OsStr::new(name)) == file.file_name()) {
        return Err(IdeError::invalid("The selected Go test file is excluded by the current build constraints"));
    }
    let selected: HashSet<_> = test_names(&std::fs::read_to_string(file)?).into_iter().collect();
    let mut excluded = Vec::new();
    for name in files {
        if Some(std::ffi::OsStr::new(name)) != file.file_name() {
            for test in test_names(&std::fs::read_to_string(dir.join(name))?) {
                if selected.contains(&test) {
                    return Err(IdeError::invalid(format!(
                        "Cannot select this file alone: {test} is also declared in {name}. Run the package instead."
                    )));
                }
                if !selected.contains(&test) {
                    excluded.push(test);
                }
            }
        }
    }
    excluded.sort();
    excluded.dedup();
    Ok(if excluded.is_empty() { String::new() } else { format!("^({})$", excluded.join("|")) })
}

fn test_names(text: &str) -> Vec<String> {
    static SYNTAX: OnceLock<ide_language::Syntax> = OnceLock::new();
    SYNTAX
        .get_or_init(Default::default)
        .outline(&ide_core::LanguageId("go".into()), text)
        .into_iter()
        .filter(|item| item.kind == ide_core::SymbolKind::Function)
        .map(|item| item.name)
        .filter(|name| {
            name != "TestMain"
                && ["Test", "Benchmark", "Example", "Fuzz"].iter().any(|prefix| {
                    name.strip_prefix(prefix)
                        .is_some_and(|suffix| suffix.chars().next().is_none_or(|c| !c.is_lowercase()))
                })
        })
        .collect()
}

pub fn exclude_tests(args: &mut Vec<String>, exclusions: &str, binary: bool) {
    if exclusions.is_empty() {
        return;
    }
    let original = std::mem::take(args);
    let mut existing = None;
    let mut program = binary;
    let mut insert_at = binary.then_some(0);
    let mut i = 0;
    while i < original.len() {
        let arg = &original[i];
        if arg == "--" {
            insert_at.get_or_insert(args.len());
            args.extend_from_slice(&original[i..]);
            break;
        }
        if arg == "-test.skip" || (!program && arg == "-skip") {
            existing = original.get(i + 1).cloned();
            i += 2;
            continue;
        }
        if let Some(value) =
            arg.strip_prefix("-test.skip=").or_else(|| if program { None } else { arg.strip_prefix("-skip=") })
        {
            existing = Some(value.to_owned());
            i += 1;
            continue;
        }
        args.push(arg.clone());
        if arg == "-args" {
            program = true;
            insert_at = Some(args.len());
        }
        i += 1;
    }
    let pattern = existing
        .filter(|old| !old.is_empty())
        .map_or_else(|| exclusions.to_owned(), |old| format!("{old}|{exclusions}"));
    let flag = if program { "-test.skip" } else { "-skip" };
    let at = insert_at.unwrap_or(args.len());
    args.splice(at..at, [flag.into(), pattern]);
}

pub fn prepare_test_file(root: &Path, config: &mut RunConfig) -> IdeResult<()> {
    let p = &config.extras.params;
    if config.kind != "go" || p.get("goKind").is_none_or(|s| s != "test") || p.get("scope").is_none_or(|s| s != "file")
    {
        return Ok(());
    }
    let target = p.get("target").ok_or_else(|| IdeError::invalid("Go test file target is missing"))?;
    let file = root.join(p.get("module").map(String::as_str).unwrap_or(".")).join(target);
    let dir = file.parent().ok_or_else(|| IdeError::invalid("Go test file has no directory"))?;
    let mut command = Command::new(&config.command);
    crate::process::configure_environment(&mut command, root, config)?;
    let exclusions = file_test_exclusions(command, &file, &config.args)?;
    let at = config
        .args
        .iter()
        .position(|a| a == target)
        .ok_or_else(|| IdeError::invalid("Go test file target is missing"))?;
    config.args[at] = dunce::canonicalize(dir)?.to_string_lossy().into_owned();
    exclude_tests(&mut config.args, &exclusions, false);
    Ok(())
}

pub use ide_core::go::work_modules;

#[cfg(test)]
mod test_scope_tests {
    use super::*;

    #[test]
    fn finds_declarations_without_requiring_a_testing_import_spelling() {
        assert_eq!(
            test_names(
                "package p\nimport t \"testing\"\n// func TestComment(t *t.T) {}\nvar s = `func TestString(t *t.T) {}`\nfunc TestAlias(\n  t *t.T,\n) {}\nfunc Benchmark速度(b *t.B) {}\nfunc (s Suite) TestMethod(t *t.T) {}\n"
            ),
            ["TestAlias", "Benchmark速度"]
        );
    }

    #[test]
    fn rejects_names_shared_by_internal_and_external_test_packages() {
        if Command::new("go").arg("version").output().is_err() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("go.mod"), "module example.com/ambiguous\ngo 1.22\n").unwrap();
        let file = dir.path().join("internal_test.go");
        std::fs::write(&file, "package p\nimport \"testing\"\nfunc TestSame(t *testing.T) {}\n").unwrap();
        std::fs::write(
            dir.path().join("external_test.go"),
            "package p_test\nimport \"testing\"\nfunc TestSame(t *testing.T) {}\n",
        )
        .unwrap();
        let error = file_test_exclusions(Command::new("go"), &file, &[]).unwrap_err();
        assert!(error.to_string().contains("Run the package instead"), "{error}");
    }

    #[test]
    fn exclusions_preserve_user_filters_and_precede_binary_argument_terminators() {
        for (input, expected) in [
            (vec!["test", ".", "-run", "TestChosen"], vec!["test", ".", "-run", "TestChosen", "-skip", "^TestOther$"]),
            (vec!["test", ".", "-skip="], vec!["test", ".", "-skip", "^TestOther$"]),
            (
                vec!["test", ".", "-skip", "Old", "-args", "-test.skip=Newest", "--", "data"],
                vec!["test", ".", "-args", "-test.skip", "Newest|^TestOther$", "--", "data"],
            ),
        ] {
            let mut args: Vec<String> = input.into_iter().map(str::to_owned).collect();
            exclude_tests(&mut args, "^TestOther$", false);
            assert_eq!(args, expected);
        }
    }
}
