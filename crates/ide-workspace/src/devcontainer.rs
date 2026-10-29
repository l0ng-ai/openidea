//! The project's `.devcontainer/devcontainer.json` (or `.devcontainer.json`) as a
//! remote host reads it: `remoteEnv` for every child process of the IDE backend and
//! `postStartCommand` once per backend start. No container is built.

use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// Where the configuration may be, first match wins.
const LOCATIONS: [&str; 2] = [".devcontainer/devcontainer.json", ".devcontainer.json"];

#[derive(Debug, Default, Clone, PartialEq)]
pub struct DevContainer {
    pub path: PathBuf,
    /// Values as written (`None`: unset the variable), substitutions not applied.
    pub remote_env: BTreeMap<String, Option<String>>,
    pub post_start: Option<LifecycleCommand>,
}

/// A lifecycle command in its three forms.
#[derive(Debug, Clone, PartialEq)]
pub enum LifecycleCommand {
    /// Run through `/bin/sh -c`.
    Shell(String),
    /// Run directly: program and arguments, no shell.
    Exec(Vec<String>),
    /// Named commands (each a `Shell` or an `Exec`) run in parallel; all must succeed.
    Parallel(Vec<(String, LifecycleCommand)>),
}

impl LifecycleCommand {
    fn parse(v: &Value) -> Result<Option<Self>, String> {
        Ok(match v {
            Value::Null => None,
            Value::String(s) if s.trim().is_empty() => None,
            Value::String(s) => Some(Self::Shell(s.clone())),
            Value::Array(items) => {
                let args: Vec<String> = items
                    .iter()
                    .map(|i| i.as_str().map(str::to_owned).ok_or("array items must be strings"))
                    .collect::<Result<_, _>>()?;
                (!args.is_empty()).then_some(Self::Exec(args))
            }
            Value::Object(map) => {
                let mut named = Vec::new();
                for (name, v) in map {
                    match Self::parse(v)? {
                        Some(Self::Parallel(_)) => return Err(format!("{name}: expected a string or an array")),
                        Some(c) => named.push((name.clone(), c)),
                        None => {}
                    }
                }
                (!named.is_empty()).then_some(Self::Parallel(named))
            }
            _ => return Err("expected a string, an array or an object".into()),
        })
    }

    /// The single commands to run (one, or each of a `Parallel`), with their names.
    pub fn commands(&self) -> Vec<(Option<&str>, &LifecycleCommand)> {
        match self {
            Self::Parallel(named) => named.iter().map(|(n, c)| (Some(n.as_str()), c)).collect(),
            c => vec![(None, c)],
        }
    }

    /// Program and arguments of a `Shell` or `Exec` command (`Parallel`: `None`).
    pub fn argv(&self) -> Option<Vec<String>> {
        match self {
            Self::Shell(s) => Some(vec!["/bin/sh".into(), "-c".into(), s.clone()]),
            Self::Exec(args) => Some(args.clone()),
            Self::Parallel(_) => None,
        }
    }
}

/// The configuration file of the project at `root`, if it has one.
pub fn find(root: &Path) -> Option<PathBuf> {
    LOCATIONS.iter().map(|l| root.join(l)).find(|p| p.is_file())
}

/// Reads the project's configuration: `Ok(None)` without one, `Err` with a message when
/// it can't be read or parsed.
pub fn load(root: &Path) -> Result<Option<DevContainer>, String> {
    let Some(path) = find(root) else { return Ok(None) };
    let text = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    parse(&text).map(|mut c| {
        c.path = path;
        Some(c)
    })
}

/// Parses `devcontainer.json` text (JSON with comments and trailing commas).
pub fn parse(text: &str) -> Result<DevContainer, String> {
    let json: Value = serde_json::from_str(&ide_core::jsonc::strip(text)).map_err(|e| e.to_string())?;
    let Value::Object(top) = json else { return Err("expected an object".into()) };
    let mut config = DevContainer::default();
    if let Some(env) = top.get("remoteEnv") {
        let Value::Object(env) = env else { return Err("remoteEnv: expected an object".into()) };
        for (k, v) in env {
            let value = match v {
                Value::Null => None,
                Value::String(s) => Some(s.clone()),
                Value::Number(n) => Some(n.to_string()),
                Value::Bool(b) => Some(b.to_string()),
                _ => return Err(format!("remoteEnv.{k}: expected a string")),
            };
            config.remote_env.insert(k.clone(), value);
        }
    }
    if let Some(cmd) = top.get("postStartCommand") {
        config.post_start = LifecycleCommand::parse(cmd).map_err(|e| format!("postStartCommand: {e}"))?;
    }
    Ok(config)
}

/// Expands `${localEnv:NAME}`, `${containerEnv:NAME}` and `${env:NAME}` (all the remote
/// host's environment, through `env`; `${…:NAME:default}` when unset), and
/// `${localWorkspaceFolder}` / `${containerWorkspaceFolder}` (and their `…Basename`) to
/// the project root. Unknown references stay as written.
pub fn substitute(value: &str, root: &Path, env: &dyn Fn(&str) -> Option<String>) -> String {
    let mut out = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(start) = rest.find("${") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = after.find('}') else {
            out.push_str(&rest[start..]);
            return out;
        };
        let inner = &after[..end];
        match resolve(inner, root, env) {
            Some(v) => out.push_str(&v),
            None => out.push_str(&rest[start..start + 2 + end + 1]),
        }
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    out
}

fn resolve(inner: &str, root: &Path, env: &dyn Fn(&str) -> Option<String>) -> Option<String> {
    let basename = || root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    match inner {
        "localWorkspaceFolder" | "containerWorkspaceFolder" => return Some(root.to_string_lossy().into_owned()),
        "localWorkspaceFolderBasename" | "containerWorkspaceFolderBasename" => return Some(basename()),
        _ => {}
    }
    let (scope, spec) = inner.split_once(':')?;
    if !matches!(scope, "localEnv" | "containerEnv" | "env") {
        return None;
    }
    let (name, default) = match spec.split_once(':') {
        Some((name, default)) => (name, Some(default)),
        None => (spec, None),
    };
    Some(env(name).or_else(|| default.map(str::to_owned)).unwrap_or_default())
}

/// `remoteEnv` with substitutions applied against `env` (the environment before it), in
/// order: `None` unsets the variable.
pub fn resolve_env(
    config: &DevContainer,
    root: &Path,
    env: &dyn Fn(&str) -> Option<String>,
) -> Vec<(String, Option<String>)> {
    config.remote_env.iter().map(|(k, v)| (k.clone(), v.as_deref().map(|v| substitute(v, root, env)))).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(name: &str) -> Option<String> {
        match name {
            "PATH" => Some("/usr/bin:/bin".into()),
            "HOME" => Some("/home/me".into()),
            _ => None,
        }
    }

    #[test]
    fn parses_jsonc_with_remote_env_and_post_start() {
        let c = parse(
            r#"{
                // A comment
                "name": "demo",
                "remoteEnv": {
                    "PATH": "${containerEnv:PATH}:/opt/tools/bin",
                    "EMPTY": null,
                    "PORT": 8080, /* numbers are text */
                },
                "postStartCommand": "make dev",
            }"#,
        )
        .unwrap();
        assert_eq!(c.remote_env.get("PATH").unwrap().as_deref(), Some("${containerEnv:PATH}:/opt/tools/bin"));
        assert_eq!(c.remote_env.get("EMPTY"), Some(&None));
        assert_eq!(c.remote_env.get("PORT").unwrap().as_deref(), Some("8080"));
        assert_eq!(c.post_start, Some(LifecycleCommand::Shell("make dev".into())));
    }

    #[test]
    fn post_start_command_forms() {
        let parse_cmd = |json: &str| parse(&format!(r#"{{ "postStartCommand": {json} }}"#)).map(|c| c.post_start);
        assert_eq!(parse_cmd(r#""echo hi""#).unwrap().unwrap().argv().unwrap(), ["/bin/sh", "-c", "echo hi"]);
        let exec = parse_cmd(r#"["npm", "run", "watch"]"#).unwrap().unwrap();
        assert_eq!(exec, LifecycleCommand::Exec(vec!["npm".into(), "run".into(), "watch".into()]));
        assert_eq!(exec.argv().unwrap(), ["npm", "run", "watch"]);
        let parallel =
            parse_cmd(r#"{ "server": "npm start", "db": ["pg_ctl", "start"], "none": "" }"#).unwrap().unwrap();
        let names: Vec<_> = parallel.commands().into_iter().map(|(n, _)| n.unwrap()).collect();
        assert_eq!(names, ["db", "server"]);
        assert!(parallel.argv().is_none());
        assert_eq!(parse_cmd(r#""""#).unwrap(), None);
        assert_eq!(parse_cmd("[]").unwrap(), None);
        assert!(parse_cmd("42").unwrap_err().contains("postStartCommand"));
        assert!(parse_cmd("[1]").is_err());
        assert!(parse_cmd(r#"{ "nested": { "a": "b" } }"#).is_err());
    }

    #[test]
    fn invalid_files_are_errors() {
        assert!(parse("{ \"remoteEnv\": [] }").unwrap_err().contains("remoteEnv"));
        assert!(parse("{ not json").is_err());
        assert!(parse("[]").is_err());
    }

    #[test]
    fn substitutes_remote_env_references() {
        let root = Path::new("/work/demo");
        let s = |v: &str| substitute(v, root, &env);
        assert_eq!(s("${containerEnv:PATH}:/opt/bin"), "/usr/bin:/bin:/opt/bin");
        assert_eq!(s("${localEnv:HOME}/.cache"), "/home/me/.cache");
        assert_eq!(s("${env:HOME}"), "/home/me");
        assert_eq!(s("${localEnv:MISSING}"), "");
        assert_eq!(s("${localEnv:MISSING:fallback}"), "fallback");
        assert_eq!(s("${containerWorkspaceFolder}/bin:${localWorkspaceFolderBasename}"), "/work/demo/bin:demo");
        assert_eq!(s("${unknown} ${other:X} $HOME ${open"), "${unknown} ${other:X} $HOME ${open");
    }

    #[test]
    fn resolves_against_the_environment_before_it() {
        let c = parse(r#"{ "remoteEnv": { "PATH": "/opt/bin:${containerEnv:PATH}", "GONE": null } }"#).unwrap();
        let resolved = resolve_env(&c, Path::new("/p"), &env);
        assert_eq!(
            resolved,
            [("GONE".to_owned(), None), ("PATH".to_owned(), Some("/opt/bin:/usr/bin:/bin".to_owned()))]
        );
    }

    #[test]
    fn finds_either_location() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(load(tmp.path()).unwrap(), None);
        std::fs::write(tmp.path().join(".devcontainer.json"), r#"{ "postStartCommand": "a" }"#).unwrap();
        assert_eq!(load(tmp.path()).unwrap().unwrap().post_start, Some(LifecycleCommand::Shell("a".into())));
        std::fs::create_dir(tmp.path().join(".devcontainer")).unwrap();
        std::fs::write(tmp.path().join(".devcontainer/devcontainer.json"), r#"{ "postStartCommand": "b" }"#).unwrap();
        let c = load(tmp.path()).unwrap().unwrap();
        assert_eq!(c.post_start, Some(LifecycleCommand::Shell("b".into())));
        assert!(c.path.ends_with(".devcontainer/devcontainer.json"));
    }
}
