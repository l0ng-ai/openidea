//! Typed Go configurations use the process service for both build and execution.
use crate::RunConfig;
use ide_core::{IdeError, IdeResult};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
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
pub fn package_sources(mut command: Command, dir: &Path, flags: &[String]) -> IdeResult<Vec<PathBuf>> {
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
    let package: serde_json::Value = serde_json::from_str(&text).map_err(|e| IdeError::invalid(e.to_string()))?;
    Ok(["GoFiles", "CgoFiles"]
        .iter()
        .flat_map(|key| package[key].as_array().into_iter().flatten())
        .filter_map(|p| p.as_str())
        .map(|p| dir.join(p))
        .collect())
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
    let mut files = package_sources(command, dir, &config.args)?;
    files.push(file);
    let at = config
        .args
        .iter()
        .position(|a| a == target)
        .ok_or_else(|| IdeError::invalid("Go test file target is missing"))?;
    config.args.splice(at..=at, files.iter().map(|p| p.to_string_lossy().into_owned()));
    Ok(())
}

/// Module directories from a go.work file. Quoted paths and comments follow Go's file syntax.
pub fn work_modules(text: &str) -> Vec<PathBuf> {
    let mut tokens = Vec::new();
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '\n' | '(' | ')' => tokens.push(ch.to_string()),
            ch if ch.is_whitespace() => {}
            '/' if chars.peek() == Some(&'/') => {
                for c in chars.by_ref() {
                    if c == '\n' {
                        tokens.push("\n".into());
                        break;
                    }
                }
            }
            '"' | '`' => {
                let Some(token) = quoted_work_path(&mut chars, ch) else { return Vec::new() };
                tokens.push(token);
            }
            _ => {
                let mut token = ch.to_string();
                while chars.peek().is_some_and(|c| !c.is_whitespace() && *c != '(' && *c != ')') {
                    token.push(chars.next().unwrap());
                }
                tokens.push(token);
            }
        }
    }
    let mut out = Vec::new();
    let mut start = true;
    let mut tokens = tokens.into_iter();
    while let Some(token) = tokens.next() {
        if token == "\n" {
            start = true;
            continue;
        }
        if start
            && token == "use"
            && let Some(path) = tokens.next()
        {
            if path == "(" {
                let mut paths = Vec::new();
                let mut closed = false;
                for path in tokens.by_ref() {
                    if path == ")" {
                        closed = true;
                        break;
                    }
                    if path != "\n" && !path.is_empty() {
                        paths.push(PathBuf::from(path));
                    }
                }
                if closed {
                    out.extend(paths);
                }
            } else if path != "\n" && !path.is_empty() {
                out.push(PathBuf::from(path));
            }
        }
        start = false;
    }
    let mut seen = std::collections::HashSet::new();
    out.retain(|path| seen.insert(path.clone()));
    out
}

fn quoted_work_path(chars: &mut std::iter::Peekable<std::str::Chars<'_>>, quote: char) -> Option<String> {
    let mut bytes = Vec::new();
    while let Some(ch) = chars.next() {
        if ch == quote {
            return String::from_utf8(bytes).ok();
        }
        if ch == '\\' && quote == '"' {
            let escaped = chars.next()?;
            let byte = match escaped {
                'a' => 7,
                'b' => 8,
                'f' => 12,
                'n' => 10,
                'r' => 13,
                't' => 9,
                'v' => 11,
                '\\' => b'\\',
                '"' => b'"',
                'x' => {
                    let digits: String = chars.by_ref().take(2).collect();
                    if digits.len() != 2 {
                        return None;
                    }
                    u8::from_str_radix(&digits, 16).ok()?
                }
                'u' | 'U' => {
                    let width = if escaped == 'u' { 4 } else { 8 };
                    let digits: String = chars.by_ref().take(width).collect();
                    if digits.len() != width {
                        return None;
                    }
                    let ch = char::from_u32(u32::from_str_radix(&digits, 16).ok()?)?;
                    bytes.extend_from_slice(ch.to_string().as_bytes());
                    continue;
                }
                '0'..='7' => {
                    let digits = format!("{escaped}{}", chars.by_ref().take(2).collect::<String>());
                    if digits.len() != 3 {
                        return None;
                    }
                    u8::from_str_radix(&digits, 8).ok()?
                }
                _ => return None,
            };
            bytes.push(byte);
        } else {
            if ch == '\n' && quote == '"' {
                return None;
            }
            bytes.extend_from_slice(ch.to_string().as_bytes());
        }
    }
    None
}
