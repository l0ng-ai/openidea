//! `.vscode/launch.json`: JSON with comments and trailing commas, `configurations` and
//! `compounds`. Python (`debugpy`, the older `python`) and Node.js (`node`, `pwa-node`,
//! `node-terminal`) launches become run configurations of the matching kind, their attach
//! requests Python Remote Debug / Attach to Node.js configurations. Variables with a fixed
//! meaning (`${workspaceFolder}`, `${userHome}`, `${env:NAME}`…) are replaced when importing;
//! an entry using one that depends on the moment VS Code launches it (`${file}`,
//! `${input:…}`, `${command:…}`) is skipped.

use super::{Entry, Found, SkipReason, normalize, relative_to};
use crate::{RunConfig, RunExtras};
use ide_core::{IdeError, IdeResult};
use serde_json::{Map, Value};
use std::cell::Cell;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// Keys this IDE covers on its own (console, source maps, Django detection, child
/// processes) or that only shape VS Code's UI: left out without a note.
const SILENT: &[&str] = &[
    "name",
    "type",
    "request",
    "presentation",
    "internalConsoleOptions",
    "console",
    "outputCapture",
    "redirectOutput",
    "django",
    "sourceMaps",
    "outFiles",
    "resolveSourceMapLocations",
    "autoAttachChildProcesses",
    "showAsyncStacks",
    "smartStep",
    "windows",
    "osx",
    "linux",
];

const COMMON: &[&str] = &["cwd", "env", "envFile"];
const PYTHON_LAUNCH: &[&str] = &["program", "module", "args", "python", "pythonArgs"];
const PYTHON_ATTACH: &[&str] = &["connect", "host", "port", "pathMappings"];
const NODE_LAUNCH: &[&str] = &["program", "args", "runtimeExecutable", "runtimeArgs"];
const NODE_ATTACH: &[&str] = &["address", "port", "localRoot", "remoteRoot"];
const NODE_TERMINAL: &[&str] = &["command"];
const COMPOUND: &[&str] = &["configurations"];

const PACKAGE_MANAGERS: &[&str] = &["npm", "pnpm", "yarn", "bun"];
/// `npm <command>` lines the npm configuration type edits (`src/features/run/types.ts`).
const NPM_COMMANDS: &[&str] = &["run", "test", "start", "install", "ci", "publish", "pack"];

/// Characters that make a `node-terminal` command a shell line rather than a program with arguments.
const SHELL_CHARS: &[char] = &['|', '&', ';', '<', '>', '(', ')', '$', '`', '*', '?', '\n'];

const OS_KEY: &str = if cfg!(windows) {
    "windows"
} else if cfg!(target_os = "macos") {
    "osx"
} else {
    "linux"
};

pub(crate) fn entries(text: &str, root: &Path, env: &BTreeMap<String, String>) -> IdeResult<Vec<Entry>> {
    let json: Value = serde_json::from_str(&ide_core::jsonc::strip(text))
        .map_err(|e| IdeError::invalid(format!(".vscode/launch.json: {e}")))?;
    let windows = cfg!(windows);
    let homes = if windows { ["USERPROFILE", "HOME"] } else { ["HOME", "USERPROFILE"] };
    let home = homes.into_iter().find_map(|k| env_var(env, k, windows));
    let cx = Cx { root: &normalize(root), env, home, machine_values: Cell::new(false) };
    let list = |key: &str| json.get(key).and_then(Value::as_array).cloned().unwrap_or_default();
    let mut out: Vec<Entry> = list("configurations").iter().map(|v| cx.entry(v)).collect();
    out.extend(list("compounds").iter().map(|v| cx.compound(v)));
    Ok(out)
}

struct Cx<'a> {
    root: &'a Path,
    env: &'a BTreeMap<String, String>,
    home: Option<String>,
    /// The entry being converted used `${env:…}` or `${userHome}`: its values belong to this machine.
    machine_values: Cell<bool>,
}

type Res<T> = Result<T, SkipReason>;

fn name_of(v: &Value) -> String {
    v.get("name").and_then(Value::as_str).unwrap_or_default().trim().to_owned()
}

/// The variable `name` of `env`; Windows names ignore case (`${env:PATH}` finds `Path`).
fn env_var(env: &BTreeMap<String, String>, name: &str, windows: bool) -> Option<String> {
    match env.get(name) {
        Some(v) => Some(v.clone()),
        None if windows => env.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.clone()),
        None => None,
    }
}

/// String form of a scalar (`"args": [8000]`, `"env": { "DEBUG": true }`).
fn scalar(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

/// The program's file name without a Windows extension (`npm.cmd` → `npm`).
fn command_name(cmd: &str) -> &str {
    let name = cmd.rsplit(['/', '\\']).next().unwrap_or(cmd);
    name.strip_suffix(".cmd").or_else(|| name.strip_suffix(".exe")).unwrap_or(name)
}

fn config(name: &str, kind: &str, command: String, args: Vec<String>, debug: Option<&str>) -> RunConfig {
    RunConfig {
        id: String::new(),
        name: name.to_owned(),
        kind: kind.to_owned(),
        command,
        args,
        cwd: None,
        env: BTreeMap::new(),
        detected: false,
        is_test: false,
        debug_adapter: debug.map(str::to_owned),
        allow_parallel: false,
        extras: RunExtras::default(),
    }
}

/// `npm run dev`-style words: an npm configuration's `(command, args)`, `run-script` read as `run`.
fn npm_line(words: &[String]) -> Option<(String, Vec<String>)> {
    let (exe, rest) = words.split_first()?;
    if !PACKAGE_MANAGERS.contains(&command_name(exe)) {
        return None;
    }
    let mut args = rest.to_vec();
    if args.first().is_some_and(|a| a == "run-script") {
        args[0] = "run".into();
    }
    NPM_COMMANDS.contains(&args.first()?.as_str()).then(|| (exe.clone(), args))
}

/// Splits a command line into words: whitespace, `'…'` and `"…"` quoting, backslash escapes
/// (like `parseArgs` in `src/platform/commandLine.ts`).
fn split_args(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut has = false;
    let mut quote: Option<char> = None;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        match quote {
            Some(q) if c == q => quote = None,
            Some('"') if c == '\\' && chars.peek().is_some_and(|n| "\"\\$`".contains(*n)) => {
                cur.extend(chars.next());
            }
            Some(_) => cur.push(c),
            None if c == '\'' || c == '"' => {
                quote = Some(c);
                has = true;
            }
            None if c == '\\' && chars.peek().is_some() => {
                cur.extend(chars.next());
                has = true;
            }
            None if c.is_whitespace() => {
                if has || !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
                has = false;
            }
            None => cur.push(c),
        }
    }
    if has || !cur.is_empty() {
        out.push(cur);
    }
    out
}

impl Cx<'_> {
    /// Replaces the variables in `s`.
    fn expand(&self, s: &str) -> Res<String> {
        let mut out = String::with_capacity(s.len());
        let mut rest = s;
        while let Some(start) = rest.find("${") {
            let Some(len) = rest[start..].find('}') else {
                break;
            };
            out.push_str(&rest[..start]);
            let name = &rest[start + 2..start + len];
            let value = match name {
                "workspaceFolder" | "workspaceRoot" => self.root.to_string_lossy().into_owned(),
                "workspaceFolderBasename" => {
                    self.root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
                }
                "userHome" => {
                    self.machine_values.set(true);
                    self.home.clone().ok_or(SkipReason::Variable { variable: format!("${{{name}}}") })?
                }
                "pathSeparator" | "/" => std::path::MAIN_SEPARATOR.to_string(),
                _ => match name.strip_prefix("env:") {
                    Some(var) => {
                        self.machine_values.set(true);
                        env_var(self.env, var, cfg!(windows)).unwrap_or_default()
                    }
                    None => return Err(SkipReason::Variable { variable: format!("${{{name}}}") }),
                },
            };
            out.push_str(&value);
            rest = &rest[start + len + 1..];
        }
        out.push_str(rest);
        Ok(out)
    }

    fn string(&self, obj: &Map<String, Value>, key: &str) -> Res<Option<String>> {
        match obj.get(key).and_then(scalar) {
            Some(s) if !s.trim().is_empty() => self.expand(&s).map(Some),
            _ => Ok(None),
        }
    }

    /// An array of words, or a string split like a command line.
    fn words(&self, obj: &Map<String, Value>, key: &str) -> Res<Vec<String>> {
        match obj.get(key) {
            Some(Value::Array(items)) => items.iter().filter_map(scalar).map(|s| self.expand(&s)).collect(),
            Some(Value::String(s)) => Ok(split_args(&self.expand(s)?)),
            _ => Ok(Vec::new()),
        }
    }

    /// An absolute path inside the project, written relative to `dir` (the run's working
    /// directory, where the process resolves it); anything else as it is.
    fn path_from(&self, value: String, dir: &Path) -> String {
        let path = Path::new(&value);
        if !path.is_absolute() {
            return value;
        }
        let path = normalize(path);
        if path.starts_with(self.root) && dir.starts_with(self.root) {
            relative_to(&path, dir).unwrap_or(value)
        } else {
            value
        }
    }

    /// The working directory (absolute) and the configuration's `cwd` (relative to the root).
    fn cwd(&self, obj: &Map<String, Value>) -> Res<(PathBuf, Option<PathBuf>)> {
        let Some(cwd) = self.string(obj, "cwd")? else {
            return Ok((self.root.to_path_buf(), None));
        };
        let abs = normalize(&self.root.join(cwd));
        let rel = match abs.strip_prefix(self.root) {
            Ok(r) if r.as_os_str().is_empty() => None,
            Ok(r) => Some(PathBuf::from(relative_to(&abs, self.root).unwrap_or_else(|| r.to_string_lossy().into()))),
            Err(_) => Some(abs.clone()),
        };
        Ok((abs, rel))
    }

    /// `env` (a variable set to itself is inherited anyway) and `envFile`.
    fn environment(&self, obj: &Map<String, Value>, c: &mut RunConfig) -> Res<()> {
        if let Some(Value::Object(env)) = obj.get("env") {
            for (k, v) in env {
                let Some(v) = scalar(v) else { continue };
                let own = format!("${{env:{k}}}");
                if v == own || (cfg!(windows) && v.eq_ignore_ascii_case(&own)) {
                    continue;
                }
                c.env.insert(k.clone(), self.expand(&v)?);
            }
        }
        if let Some(file) = self.string(obj, "envFile")? {
            c.extras.env_files.push(self.path_from(file, self.root));
        }
        Ok(())
    }

    fn entry(&self, v: &Value) -> Entry {
        let name = name_of(v);
        self.machine_values.set(false);
        let result = match v.as_object() {
            Some(obj) if !name.is_empty() => self.convert(&name, &overlay(obj)),
            _ => Err(SkipReason::Invalid),
        };
        let result = result.map(|mut found| {
            // Values of this machine (its environment, its home) stay out of the shared run.toml.
            found.config.extras.local = self.machine_values.get();
            found
        });
        Entry { name, result }
    }

    fn convert(&self, name: &str, obj: &Map<String, Value>) -> Res<Found> {
        let ty = obj.get("type").and_then(Value::as_str).unwrap_or_default();
        let request = obj.get("request").and_then(Value::as_str).unwrap_or("launch");
        let (mut config, handled) = match (ty, request) {
            ("debugpy" | "python", "launch") => (self.python_launch(name, obj)?, PYTHON_LAUNCH),
            ("debugpy" | "python", "attach") => (self.python_attach(name, obj)?, PYTHON_ATTACH),
            ("node" | "pwa-node", "launch") => (self.node_launch(name, obj)?, NODE_LAUNCH),
            ("node" | "pwa-node", "attach") => (self.node_attach(name, obj)?, NODE_ATTACH),
            ("node-terminal", "launch") => (self.node_terminal(name, obj)?, NODE_TERMINAL),
            ("debugpy" | "python" | "node" | "pwa-node" | "node-terminal", other) => {
                return Err(SkipReason::UnsupportedRequest { request: other.to_owned() });
            }
            (other, _) => return Err(SkipReason::UnsupportedType { type_: other.to_owned() }),
        };
        if request == "launch" {
            config.cwd = self.cwd(obj)?.1.map(Into::into);
            self.environment(obj, &mut config)?;
        }
        let mut ignored: Vec<String> = obj
            .keys()
            .filter(|k| {
                let k = k.as_str();
                !SILENT.contains(&k) && !handled.contains(&k) && (request != "launch" || !COMMON.contains(&k))
            })
            .cloned()
            .collect();
        if obj.get("pathMappings").and_then(Value::as_array).is_some_and(|m| m.len() > 1) {
            ignored.push("pathMappings".into());
        }
        ignored.sort();
        Ok(Found { config, members: Vec::new(), ignored })
    }

    fn python_launch(&self, name: &str, obj: &Map<String, Value>) -> Res<RunConfig> {
        let (dir, _) = self.cwd(obj)?;
        // `${command:python.interpreterPath}` / `${config:python.defaultInterpreterPath}` name the
        // interpreter VS Code has selected: the project's here. Options after it (`[exe, "-X", "dev"]`) stay.
        let selected = |s: &str| s.starts_with("${command:python.") || s.starts_with("${config:python.");
        let python: Vec<String> = match obj.get("python") {
            Some(Value::Array(items)) => items.iter().filter_map(scalar).collect(),
            Some(v) => scalar(v).into_iter().collect(),
            None => Vec::new(),
        };
        let (command, mut args) = match python.split_first() {
            Some((exe, opts)) => {
                let opts = opts.iter().map(|o| self.expand(o)).collect::<Res<Vec<_>>>()?;
                if exe.trim().is_empty() || selected(exe) {
                    let (exe, mut lead) = self.project_python(&dir);
                    lead.extend(opts);
                    (exe, lead)
                } else {
                    (self.path_from(self.expand(exe)?, &dir), opts)
                }
            }
            None => self.project_python(&dir),
        };
        args.extend(self.words(obj, "pythonArgs")?);
        let rest = self.words(obj, "args")?;
        let mut kind = "python";
        if let Some(module) = self.string(obj, "module")? {
            if module == "pytest" {
                kind = "pytest";
            }
            args.extend(["-m".to_owned(), module]);
        } else if let Some(program) = self.string(obj, "program")? {
            let mut program = self.path_from(program, &dir);
            // Only `manage.py` in the working directory (`./manage.py` too): the Django tests form writes `manage.py`.
            if normalize(Path::new(&program)) == Path::new("manage.py") && rest.first().is_some_and(|a| a == "test") {
                kind = "django-test";
                program = "manage.py".into();
            }
            args.push(program);
        } else {
            return Err(SkipReason::NothingToRun);
        }
        args.extend(rest.into_iter().map(|a| self.path_from(a, &dir)));
        let mut c = config(name, kind, command, args, Some("debugpy"));
        c.is_test = kind != "python";
        Ok(c)
    }

    /// The project's interpreter (see [`crate::detect::project_python`]), relative to `dir`.
    fn project_python(&self, dir: &Path) -> (String, Vec<String>) {
        let (exe, lead) = crate::detect::project_python(self.root);
        let exe =
            if exe.contains('/') { self.path_from(self.root.join(&exe).to_string_lossy().into(), dir) } else { exe };
        (exe, lead)
    }

    fn python_attach(&self, name: &str, obj: &Map<String, Value>) -> Res<RunConfig> {
        if obj.contains_key("processId") || obj.contains_key("listen") {
            return Err(SkipReason::UnsupportedAttach);
        }
        let connect = obj.get("connect").and_then(Value::as_object).unwrap_or(obj);
        let host = self.string(connect, "host")?.unwrap_or_else(|| "localhost".into());
        let Some(port) = self.string(connect, "port")? else {
            return Err(SkipReason::UnsupportedAttach);
        };
        let mut c = config(name, "python-remote", String::new(), Vec::new(), Some("debugpy"));
        c.extras.params = BTreeMap::from([("host".into(), host), ("port".into(), port)]);
        if let Some(Value::Object(m)) = obj.get("pathMappings").and_then(|m| m.get(0)) {
            self.roots(m, &mut c)?;
        }
        Ok(c)
    }

    fn node_launch(&self, name: &str, obj: &Map<String, Value>) -> Res<RunConfig> {
        let (dir, _) = self.cwd(obj)?;
        let exe = self.string(obj, "runtimeExecutable")?.map(|e| self.path_from(e, &dir));
        let mut args = self.words(obj, "runtimeArgs")?;
        let program = self.string(obj, "program")?.map(|p| self.path_from(p, &dir));
        if exe.is_none() && program.is_none() {
            return Err(SkipReason::NothingToRun);
        }
        args.extend(program);
        args.extend(self.words(obj, "args")?.into_iter().map(|a| self.path_from(a, &dir)));
        let exe = exe.unwrap_or_else(|| "node".into());
        let words: Vec<String> = std::iter::once(exe.clone()).chain(args.iter().cloned()).collect();
        Ok(match npm_line(&words) {
            Some((command, args)) => npm_config(name, command, args),
            None => config(name, "node", exe, args, Some("js-debug")),
        })
    }

    fn node_attach(&self, name: &str, obj: &Map<String, Value>) -> Res<RunConfig> {
        if obj.contains_key("processId") {
            return Err(SkipReason::UnsupportedAttach);
        }
        let host = self.string(obj, "address")?.unwrap_or_else(|| "localhost".into());
        let port = self.string(obj, "port")?.unwrap_or_else(|| "9229".into());
        let mut c = config(name, "node-remote", String::new(), Vec::new(), Some("js-debug"));
        c.extras.params = BTreeMap::from([("host".into(), host), ("port".into(), port)]);
        self.roots(obj, &mut c)?;
        Ok(c)
    }

    /// `localRoot` (relative to the project root, empty for the root itself) and `remoteRoot`.
    fn roots(&self, obj: &Map<String, Value>, c: &mut RunConfig) -> Res<()> {
        if let Some(local) = self.string(obj, "localRoot")? {
            let local = self.path_from(local, self.root);
            if local != "." {
                c.extras.params.insert("localRoot".into(), local);
            }
        }
        if let Some(remote) = self.string(obj, "remoteRoot")? {
            c.extras.params.insert("remoteRoot".into(), remote);
        }
        Ok(())
    }

    /// A command typed into a terminal VS Code debugs: an npm script, a program with
    /// arguments, or a shell line (run by the shell, without the debugger).
    fn node_terminal(&self, name: &str, obj: &Map<String, Value>) -> Res<RunConfig> {
        let Some(line) = self.string(obj, "command")? else {
            return Err(SkipReason::NothingToRun);
        };
        let words = split_args(&line);
        let shell = line.contains(SHELL_CHARS) || words.first().is_some_and(|w| w.contains('='));
        if shell {
            return Ok(config(name, "shell", line.trim().to_owned(), Vec::new(), None));
        }
        if let Some((command, args)) = npm_line(&words) {
            return Ok(npm_config(name, command, args));
        }
        let Some((exe, args)) = words.split_first() else {
            return Err(SkipReason::NothingToRun);
        };
        Ok(config(name, "shell", exe.clone(), args.to_vec(), Some("js-debug")))
    }

    fn compound(&self, v: &Value) -> Entry {
        let name = name_of(v);
        let result = match (v.as_object(), v.get("configurations").and_then(Value::as_array)) {
            (Some(obj), Some(list)) if !name.is_empty() => {
                // Members are names, or `{ "name", "folder" }` in multi-root workspaces.
                let members: Vec<String> = list
                    .iter()
                    .filter_map(|m| m.as_str().or_else(|| m.get("name").and_then(Value::as_str)))
                    .map(str::to_owned)
                    .collect();
                let mut ignored: Vec<String> = obj
                    .keys()
                    .filter(|k| !SILENT.contains(&k.as_str()) && !COMPOUND.contains(&k.as_str()))
                    .cloned()
                    .collect();
                ignored.sort();
                Ok(Found { config: config(&name, "compound", String::new(), Vec::new(), None), members, ignored })
            }
            _ => Err(SkipReason::Invalid),
        };
        Entry { name, result }
    }
}

fn npm_config(name: &str, command: String, args: Vec<String>) -> RunConfig {
    config(name, "npm", command, args, Some("js-debug"))
}

/// The entry with its block for this OS (`"linux": { … }`) merged over it, as VS Code does.
fn overlay(obj: &Map<String, Value>) -> Map<String, Value> {
    let mut out = obj.clone();
    if let Some(Value::Object(os)) = obj.get(OS_KEY) {
        for (k, v) in os {
            out.insert(k.clone(), v.clone());
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_like_a_shell() {
        assert_eq!(
            split_args(r#"next dev --port "3 000" 'a b' c\ d"#),
            ["next", "dev", "--port", "3 000", "a b", "c d"]
        );
        assert_eq!(split_args(r#"x "" y"#), ["x", "", "y"]);
    }

    fn cx_expand(env: &[(&str, &str)], text: &str) -> String {
        let env: BTreeMap<String, String> = env.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect();
        let cx = Cx { root: Path::new("/p"), env: &env, home: None, machine_values: Cell::new(false) };
        let out = cx.expand(text).unwrap();
        assert!(cx.machine_values.get() == text.contains("${env:"));
        out
    }

    #[test]
    fn an_unclosed_variable_is_kept_as_written() {
        assert_eq!(cx_expand(&[], "abc${foo"), "abc${foo");
        assert_eq!(cx_expand(&[], "${workspaceFolder}/x ${y"), "/p/x ${y");
    }

    #[test]
    fn windows_variable_names_ignore_case() {
        let env = BTreeMap::from([("Path".to_owned(), r"C:\bin".to_owned())]);
        assert_eq!(env_var(&env, "PATH", true).as_deref(), Some(r"C:\bin"));
        assert_eq!(env_var(&env, "PATH", false), None);
        assert_eq!(env_var(&env, "Path", false).as_deref(), Some(r"C:\bin"));
        assert_eq!(cx_expand(&[("A", "1")], "${env:A}-${env:B}"), "1-");
    }
}
