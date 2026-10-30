//! Helpers for running a configuration under another tool (coverage, profilers):
//! resolving its directory and tools, and taking its command line apart.

use crate::RunConfig;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// The configuration's working directory (relative ones against `root`).
pub fn run_dir(root: &Path, config: &RunConfig) -> PathBuf {
    match config.cwd.as_deref() {
        Some(c) if c.is_absolute() => c.to_path_buf(),
        Some(c) if !c.as_os_str().is_empty() => root.join(c),
        _ => root.to_path_buf(),
    }
}

/// File name of `command` without a Windows executable extension: `/usr/bin/python3` → `python3`.
pub fn program_name(command: &str) -> String {
    let name = command.rsplit(['/', '\\']).next().unwrap_or(command);
    let lower = name.to_ascii_lowercase();
    for ext in [".exe", ".cmd", ".bat"] {
        if lower.ends_with(ext) {
            return name[..name.len() - ext.len()].to_owned();
        }
    }
    name.to_owned()
}

/// `python`, `python3`, `python3.12`, `py`.
pub fn is_python(command: &str) -> bool {
    let n = program_name(command);
    n == "py" || n.strip_prefix("python").is_some_and(|v| v.chars().all(|c| c.is_ascii_digit() || c == '.'))
}

/// The search path the configuration runs with (its `PATH` override, else the IDE's:
/// the login shell's and the version managers', so `mvn` / `gradle` installed by mise,
/// asdf or Homebrew resolve when the app's own `PATH` is minimal).
pub fn search_path(config: &RunConfig) -> OsString {
    config
        .env
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("PATH"))
        .map(|(_, v)| OsString::from(v))
        .unwrap_or_else(ide_core::tool_path::search_path)
}

/// `node_modules/.bin/<name>` in `dir` or an ancestor up to (and including) `root`.
pub fn node_bin(name: &str, dir: &Path, root: &Path) -> Option<PathBuf> {
    let names = crate::which::executable_names(name, cfg!(windows), std::env::var("PATHEXT").ok().as_deref());
    for d in dir.ancestors() {
        let bin = d.join("node_modules").join(".bin");
        if let Some(found) = names.iter().map(|n| bin.join(n)).find(|p| p.is_file()) {
            return Some(found);
        }
        if d == root {
            break;
        }
    }
    None
}

/// `node_modules/<package>` in `dir` or an ancestor up to `root`.
pub fn node_package(package: &str, dir: &Path, root: &Path) -> bool {
    node_package_json(package, dir, root).is_some()
}

/// The installed version of `node_modules/<package>` (see [`node_package`]).
pub fn node_package_version(package: &str, dir: &Path, root: &Path) -> Option<String> {
    let text = std::fs::read_to_string(node_package_json(package, dir, root)?).ok()?;
    let json: serde_json::Value = serde_json::from_str(&text).ok()?;
    json.get("version")?.as_str().map(str::to_owned)
}

fn node_package_json(package: &str, dir: &Path, root: &Path) -> Option<PathBuf> {
    for d in dir.ancestors() {
        let manifest = d.join("node_modules").join(package).join("package.json");
        if manifest.is_file() {
            return Some(manifest);
        }
        if d == root {
            break;
        }
    }
    None
}

/// A tool from the project (`node_modules/.bin`) or the search path.
pub fn find_tool(name: &str, config: &RunConfig, dir: &Path, root: &Path) -> Option<PathBuf> {
    node_bin(name, dir, root).or_else(|| crate::which::find_executable(name, &search_path(config)))
}

/// Whether `argv` runs and exits successfully (version probes); output is discarded.
pub fn probe(argv: &[String], dir: &Path, config: &RunConfig) -> bool {
    let Some((program, args)) = argv.split_first() else { return false };
    let program = resolve(program, config);
    ide_core::process::prepare(&mut Command::new(program))
        .args(args)
        .current_dir(dir)
        .envs(&config.env)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

/// `program` as spawnable: bare names through the configuration's search path.
fn resolve(program: &str, config: &RunConfig) -> PathBuf {
    let p = Path::new(program);
    if p.components().count() == 1
        && let Some(found) = crate::which::find_executable(program, &search_path(config))
    {
        return found;
    }
    p.to_path_buf()
}

/// A Python command line split into the interpreter part and what it runs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PythonCommand {
    /// Everything up to and including the interpreter (`uv run python`, `.venv/bin/python -X utf8`).
    pub interpreter: Vec<String>,
    /// `-m pytest …`, `script.py …`.
    pub target: Vec<String>,
    /// `uv` / `poetry` / `pipenv` when the interpreter runs through a project manager.
    pub manager: Option<String>,
}

/// Splits `python … script.py`, `python -m pytest …`, `.venv/bin/pytest …` and
/// `uv run pytest …` style command lines. `None` when no Python is involved.
pub fn python_command(config: &RunConfig) -> Option<PythonCommand> {
    let tokens: Vec<String> = std::iter::once(config.command.clone()).chain(config.args.iter().cloned()).collect();
    let manager = ["uv", "poetry", "pipenv", "pdm", "hatch", "rye"]
        .into_iter()
        .find(|m| program_name(&tokens[0]) == *m)
        .map(str::to_owned);
    for (k, t) in tokens.iter().enumerate() {
        if is_python(t) {
            let mut interpreter = tokens[..=k].to_vec();
            let mut rest = &tokens[k + 1..];
            // Interpreter options stay with the interpreter (`-u`, `-X utf8`); `-m` starts the target.
            while let Some(first) = rest.first() {
                if first == "-m" || !first.starts_with('-') {
                    break;
                }
                let takes_value = matches!(first.as_str(), "-X" | "-W");
                let n = if takes_value { 2 } else { 1 }.min(rest.len());
                interpreter.extend(rest[..n].iter().cloned());
                rest = &rest[n..];
            }
            return Some(PythonCommand { interpreter, target: rest.to_vec(), manager });
        }
        let name = program_name(t);
        if name == "pytest" || name == "py.test" {
            let target = std::iter::once("-m".to_owned())
                .chain(std::iter::once("pytest".to_owned()))
                .chain(tokens[k + 1..].iter().cloned())
                .collect();
            let interpreter = if k > 0 {
                tokens[..k].iter().cloned().chain(std::iter::once("python".to_owned())).collect()
            } else if t.contains(['/', '\\']) {
                vec![sibling_python(Path::new(t))]
            } else {
                vec![if cfg!(windows) { "python" } else { "python3" }.to_owned()]
            };
            return Some(PythonCommand { interpreter, target, manager });
        }
    }
    None
}

/// The interpreter next to a virtualenv's `bin/pytest`.
fn sibling_python(tool: &Path) -> String {
    let dir = tool.parent().unwrap_or(Path::new(""));
    let candidates: &[&str] = if cfg!(windows) { &["python.exe"] } else { &["python", "python3"] };
    candidates
        .iter()
        .map(|n| dir.join(n))
        .find(|p| p.exists())
        .unwrap_or_else(|| dir.join(candidates[0]))
        .to_string_lossy()
        .into_owned()
}

/// The `package.json` script a `npm|pnpm|yarn|bun run <script>` configuration runs.
pub fn npm_script(config: &RunConfig, dir: &Path) -> Option<(String, String)> {
    let pm = program_name(&config.command);
    if !matches!(pm.as_str(), "npm" | "pnpm" | "yarn" | "bun") {
        return None;
    }
    let mut args = config.args.iter();
    let first = args.next()?;
    let name = if first == "run" || first == "run-script" { args.next()? } else { first };
    let text = std::fs::read_to_string(dir.join("package.json")).ok()?;
    let json: serde_json::Value = serde_json::from_str(&text).ok()?;
    let script = json.get("scripts")?.get(name)?.as_str()?.to_owned();
    Some((name.clone(), script))
}

/// Arguments the user passes through to a script: everything after `--`.
pub fn passthrough_args(config: &RunConfig) -> Vec<String> {
    config.args.iter().skip_while(|a| *a != "--").skip(1).cloned().collect()
}

/// `go.mod` of `dir` or an ancestor: (module path, module directory).
pub fn go_module(dir: &Path) -> Option<(String, PathBuf)> {
    for d in dir.ancestors() {
        if let Ok(text) = std::fs::read_to_string(d.join("go.mod")) {
            let module = text
                .lines()
                .find_map(|l| l.trim().strip_prefix("module"))
                .map(|m| m.trim().trim_matches('"').to_owned())
                .unwrap_or_default();
            return Some((module, d.to_path_buf()));
        }
    }
    None
}

/// A new empty directory below `parent` for one run's output; all but the newest
/// `keep` earlier ones are removed.
pub fn new_output_dir(parent: &Path, keep: usize) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(parent)?;
    let mut old: Vec<(std::time::SystemTime, PathBuf)> = std::fs::read_dir(parent)?
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .map(|e| (e.metadata().and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH), e.path()))
        .collect();
    old.sort();
    let excess = old.len().saturating_sub(keep);
    for (_, dir) in old.into_iter().take(excess) {
        let _ = std::fs::remove_dir_all(dir);
    }
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis();
    for n in 0.. {
        let dir = parent.join(format!("{stamp}-{n}"));
        match std::fs::create_dir(&dir) {
            Ok(()) => return Ok(dir),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    unreachable!()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn cfg(command: &str, args: &[&str]) -> RunConfig {
        RunConfig {
            id: "t".into(),
            name: "t".into(),
            kind: "shell".into(),
            command: command.into(),
            args: args.iter().map(|s| s.to_string()).collect(),
            cwd: None,
            env: BTreeMap::new(),
            detected: false,
            is_test: false,
            debug_adapter: None,
            allow_parallel: false,
            extras: Default::default(),
        }
    }

    #[test]
    fn names_and_pythons() {
        assert_eq!(program_name("/usr/bin/python3"), "python3");
        assert_eq!(program_name(r"C:\Py\python.exe"), "python");
        assert!(is_python("python3.12") && is_python("py") && !is_python("pytest") && !is_python("pythonista"));
    }

    #[test]
    fn splits_python_command_lines() {
        let p = python_command(&cfg("/v/bin/python", &["-u", "-X", "utf8", "-m", "pytest", "t.py"])).unwrap();
        assert_eq!(p.interpreter, ["/v/bin/python", "-u", "-X", "utf8"]);
        assert_eq!(p.target, ["-m", "pytest", "t.py"]);
        assert_eq!(p.manager, None);

        let p = python_command(&cfg("uv", &["run", "pytest", "-k", "x"])).unwrap();
        assert_eq!(p.interpreter, ["uv", "run", "python"]);
        assert_eq!(p.target, ["-m", "pytest", "-k", "x"]);
        assert_eq!(p.manager.as_deref(), Some("uv"));

        let p = python_command(&cfg("python3", &["main.py", "a"])).unwrap();
        assert_eq!(p.target, ["main.py", "a"]);

        if cfg!(unix) {
            let p = python_command(&cfg("/v/bin/pytest", &[])).unwrap();
            assert!(p.interpreter[0].starts_with("/v/bin/python"));
        }
        assert!(python_command(&cfg("cargo", &["test"])).is_none());
    }

    #[test]
    fn reads_scripts_and_modules() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("package.json"), r#"{"scripts":{"test":"vitest run"}}"#).unwrap();
        let c = cfg("pnpm", &["run", "test", "--", "a.test.ts"]);
        assert_eq!(npm_script(&c, dir.path()), Some(("test".into(), "vitest run".into())));
        assert_eq!(passthrough_args(&c), ["a.test.ts"]);
        std::fs::write(dir.path().join("go.mod"), "module example.com/m\n\ngo 1.22\n").unwrap();
        let sub = dir.path().join("pkg");
        std::fs::create_dir_all(&sub).unwrap();
        assert_eq!(go_module(&sub), Some(("example.com/m".into(), dir.path().to_path_buf())));
    }
}
