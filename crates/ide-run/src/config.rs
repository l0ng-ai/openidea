//! User-defined run configurations persisted in `<root>/.openidea/run.toml`:
//!
//! ```toml
//! [[configurations]]
//! id = "user:server"
//! name = "Server"
//! kind = "shell"
//! command = "cargo"
//! args = ["run", "--release"]
//! cwd = "server"
//! env = { RUST_LOG = "debug" }
//! is-test = false
//! debug-adapter = "codelldb"
//! allow-parallel = true
//! folder = "Servers"
//! params = { mode = "command" }
//! env-files = [".env"]
//! include-system-env = false
//! stdin-file = "input.txt"
//! output-file = "out/server.log"
//! before-launch = [{ kind = "build" }, { kind = "run", target = "user:migrate" }]
//! emulate-terminal = true
//! stop-command = "docker stop server"
//!
//! [[templates]]          # per-type defaults for new configurations
//! kind = "npm"
//! env = { NODE_ENV = "development" }
//! ```
//!
//! Configurations not stored as project files live in the same format in the
//! workspace-local, git-ignored `run.local.toml`.

use crate::{BeforeLaunchTask, RunConfig, RunExtras};
use ide_core::{IdeError, IdeResult, project_dir};
use serde::Deserialize;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use toml_edit::{Array, ArrayOfTables, DocumentMut, InlineTable, Item, Table, value};

const FILE: &str = "run.toml";
const LOCAL_FILE: &str = "run.local.toml";
const CONFIGURATIONS: &str = "configurations";
const TEMPLATES: &str = "templates";

/// Where run configurations are written.
pub(crate) fn config_path(root: &Path) -> PathBuf {
    project_dir::path(root, FILE)
}

/// Workspace-local configurations ("Store as project file" off).
pub(crate) fn local_path(root: &Path) -> PathBuf {
    project_dir::path(root, LOCAL_FILE)
}

#[derive(Deserialize)]
struct FileDoc {
    #[serde(default, rename = "suppressed-ids")]
    suppressed_ids: Vec<String>,
    #[serde(default)]
    configurations: Vec<FileConfig>,
    #[serde(default)]
    templates: Vec<FileConfig>,
}

fn yes() -> bool {
    true
}

#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
struct FileConfig {
    id: Option<String>,
    name: Option<String>,
    kind: Option<String>,
    #[serde(default)]
    command: String,
    #[serde(default)]
    args: Vec<String>,
    cwd: Option<PathBuf>,
    #[serde(default)]
    env: BTreeMap<String, String>,
    #[serde(default, alias = "isTest", alias = "is_test")]
    is_test: bool,
    #[serde(alias = "debugAdapter", alias = "debug_adapter")]
    debug_adapter: Option<String>,
    #[serde(default, alias = "allowParallel", alias = "allow_parallel")]
    allow_parallel: bool,
    #[serde(default)]
    params: BTreeMap<String, String>,
    folder: Option<String>,
    #[serde(default = "yes", alias = "includeSystemEnv")]
    include_system_env: bool,
    #[serde(default, alias = "envFiles")]
    env_files: Vec<String>,
    #[serde(alias = "stdinFile")]
    stdin_file: Option<String>,
    #[serde(alias = "outputFile")]
    output_file: Option<String>,
    #[serde(default, alias = "beforeLaunch")]
    before_launch: Vec<BeforeLaunchTask>,
    #[serde(default)]
    compound: Vec<String>,
    #[serde(default, alias = "showOnStdout")]
    show_on_stdout: bool,
    #[serde(default, alias = "showOnStderr")]
    show_on_stderr: bool,
    #[serde(alias = "openToolWindow")]
    open_tool_window: Option<bool>,
    #[serde(default, alias = "focusToolWindow")]
    focus_tool_window: bool,
    #[serde(default, alias = "emulateTerminal")]
    emulate_terminal: bool,
    #[serde(alias = "stopCommand")]
    stop_command: Option<String>,
    target: Option<String>,
}

fn slug(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars() {
        if c.is_alphanumeric() {
            out.extend(c.to_lowercase());
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    out.trim_matches('-').to_owned()
}

fn read_doc(path: &Path) -> IdeResult<Option<FileDoc>> {
    let text = match fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    toml::from_str(&text).map(Some).map_err(|e| IdeError::invalid(format!("{}: {}", path.display(), e.message())))
}

fn non_empty(s: Option<String>) -> Option<String> {
    s.filter(|s| !s.trim().is_empty())
}

fn convert(configs: Vec<FileConfig>, local: bool) -> Vec<RunConfig> {
    let mut out = Vec::with_capacity(configs.len());
    for (i, c) in configs.into_iter().enumerate() {
        let name = c.name.filter(|n| !n.is_empty()).unwrap_or_else(|| {
            if c.command.is_empty() { format!("Configuration {}", i + 1) } else { c.command.clone() }
        });
        let id = c.id.filter(|id| !id.is_empty()).unwrap_or_else(|| format!("user:{}", slug(&name)));
        out.push(RunConfig {
            id,
            name,
            kind: c.kind.filter(|k| !k.is_empty()).unwrap_or_else(|| "shell".to_owned()),
            command: c.command,
            args: c.args,
            cwd: c.cwd.filter(|p| !p.as_os_str().is_empty()).map(Into::into),
            env: c.env,
            detected: false,
            is_test: c.is_test,
            debug_adapter: c.debug_adapter.filter(|d| !d.is_empty()),
            allow_parallel: c.allow_parallel,
            extras: RunExtras {
                params: c.params,
                folder: non_empty(c.folder),
                local,
                include_system_env: c.include_system_env,
                env_files: c.env_files.into_iter().filter(|f| !f.trim().is_empty()).collect(),
                stdin_file: non_empty(c.stdin_file),
                output_file: non_empty(c.output_file),
                before_launch: c.before_launch.into_iter().filter(|t| !t.kind.is_empty()).collect(),
                compound: c.compound,
                show_on_stdout: c.show_on_stdout,
                show_on_stderr: c.show_on_stderr,
                open_tool_window: c.open_tool_window,
                focus_tool_window: c.focus_tool_window,
                emulate_terminal: c.emulate_terminal,
                stop_command: non_empty(c.stop_command),
                target: non_empty(c.target),
            },
        });
    }
    out
}

/// Project configurations (`run.toml`) followed by workspace-local ones (`run.local.toml`).
pub(crate) fn load(root: &Path) -> IdeResult<Vec<RunConfig>> {
    let mut out = read_doc(&config_path(root))?.map(|d| convert(d.configurations, false)).unwrap_or_default();
    if let Some(local) = read_doc(&local_path(root))? {
        let ids: Vec<String> = out.iter().map(|c| c.id.clone()).collect();
        out.extend(convert(local.configurations, true).into_iter().filter(|c| !ids.contains(&c.id)));
    }
    Ok(out)
}

pub(crate) fn load_templates(root: &Path) -> IdeResult<Vec<RunConfig>> {
    Ok(read_doc(&config_path(root))?.map(|d| convert(d.templates, false)).unwrap_or_default())
}

pub(crate) fn load_suppressed(root: &Path) -> IdeResult<Vec<String>> {
    Ok(read_doc(&local_path(root))?.map(|d| d.suppressed_ids).unwrap_or_default())
}

fn to_table(c: &RunConfig) -> Table {
    let mut t = Table::new();
    t.insert("id", value(&c.id));
    t.insert("name", value(&c.name));
    t.insert("kind", value(&c.kind));
    t.insert("command", value(&c.command));
    if !c.args.is_empty() {
        t.insert("args", value(c.args.iter().collect::<Array>()));
    }
    if let Some(cwd) = &c.cwd {
        t.insert("cwd", value(cwd.to_string_lossy().replace('\\', "/")));
    }
    if !c.env.is_empty() {
        let mut env = InlineTable::new();
        for (k, v) in &c.env {
            env.insert(k, v.into());
        }
        t.insert("env", value(env));
    }
    if c.is_test {
        t.insert("is-test", value(true));
    }
    if let Some(adapter) = &c.debug_adapter {
        t.insert("debug-adapter", value(adapter));
    }
    if c.allow_parallel {
        t.insert("allow-parallel", value(true));
    }
    let x = &c.extras;
    if let Some(folder) = &x.folder {
        t.insert("folder", value(folder));
    }
    if !x.params.is_empty() {
        let mut params = InlineTable::new();
        for (k, v) in &x.params {
            params.insert(k, v.into());
        }
        t.insert("params", value(params));
    }
    if !x.include_system_env {
        t.insert("include-system-env", value(false));
    }
    if !x.env_files.is_empty() {
        t.insert("env-files", value(x.env_files.iter().collect::<Array>()));
    }
    if let Some(f) = &x.stdin_file {
        t.insert("stdin-file", value(f));
    }
    if let Some(f) = &x.output_file {
        t.insert("output-file", value(f));
    }
    if !x.before_launch.is_empty() {
        let mut tasks = Array::new();
        for task in &x.before_launch {
            let mut it = InlineTable::new();
            it.insert("kind", task.kind.as_str().into());
            if !task.target.is_empty() {
                it.insert("target", task.target.as_str().into());
            }
            tasks.push(it);
        }
        t.insert("before-launch", value(tasks));
    }
    if !x.compound.is_empty() {
        t.insert("compound", value(x.compound.iter().collect::<Array>()));
    }
    for (key, on) in [
        ("show-on-stdout", x.show_on_stdout),
        ("show-on-stderr", x.show_on_stderr),
        ("focus-tool-window", x.focus_tool_window),
        ("emulate-terminal", x.emulate_terminal),
    ] {
        if on {
            t.insert(key, value(true));
        }
    }
    if let Some(open) = x.open_tool_window {
        t.insert("open-tool-window", value(open));
    }
    if let Some(stop) = &x.stop_command {
        t.insert("stop-command", value(stop));
    }
    if let Some(target) = &x.target {
        t.insert("target", value(target));
    }
    t
}

/// Replaces the `key` array of tables in the file at `path`, keeping unrelated keys and comments.
fn write_array(path: &Path, key: &str, configs: &[&RunConfig], suppressed: Option<&[String]>) -> IdeResult<()> {
    let existing = match fs::read_to_string(path) {
        Ok(t) => Some(t),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.into()),
    };
    if existing.is_none() && configs.is_empty() && suppressed.is_none_or(|ids| ids.is_empty()) {
        return Ok(());
    }
    // A file we cannot parse is replaced.
    let mut doc = existing.as_deref().and_then(|t| t.parse::<DocumentMut>().ok()).unwrap_or_default();
    if configs.is_empty() {
        doc.remove(key);
    } else {
        let mut array = ArrayOfTables::new();
        for c in configs {
            array.push(to_table(c));
        }
        doc.insert(key, Item::ArrayOfTables(array));
    }
    if let Some(ids) = suppressed {
        if ids.is_empty() {
            doc.remove("suppressed-ids");
        } else {
            doc.insert("suppressed-ids", value(ids.iter().collect::<Array>()));
        }
    }
    let text = doc.to_string();
    if existing.as_deref() == Some(text.as_str()) {
        return Ok(());
    }

    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("toml.tmp");
    fs::write(&tmp, text)?;
    fs::rename(&tmp, path).inspect_err(|_| {
        let _ = fs::remove_file(&tmp);
    })?;
    Ok(())
}

/// Keeps the workspace-local file out of version control (`.openidea/.gitignore`).
fn ignore_local(root: &Path) -> IdeResult<()> {
    let entry = format!("/{LOCAL_FILE}");
    let file = project_dir::path(root, ".gitignore");
    let current = fs::read_to_string(&file).unwrap_or_default();
    if current.lines().any(|l| l.trim() == entry) {
        return Ok(());
    }
    let mut text = current;
    if text.is_empty() {
        text.push_str("# Per-user IDE state\n");
    } else if !text.ends_with('\n') {
        text.push('\n');
    }
    text.push_str(&entry);
    text.push('\n');
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir)?;
    }
    fs::write(file, text)?;
    Ok(())
}

pub(crate) fn save(root: &Path, configs: &[RunConfig], removed_detected_ids: &[String]) -> IdeResult<()> {
    let mut suppressed = load_suppressed(root)?;
    suppressed.extend_from_slice(removed_detected_ids);
    suppressed.sort();
    suppressed.dedup();
    suppressed.retain(|id| !configs.iter().any(|c| &c.id == id));
    let (local, shared): (Vec<&RunConfig>, Vec<&RunConfig>) = configs.iter().partition(|c| c.extras.local);
    write_array(&config_path(root), CONFIGURATIONS, &shared, None)?;
    if !local.is_empty() || !suppressed.is_empty() {
        ignore_local(root)?;
    }
    write_array(&local_path(root), CONFIGURATIONS, &local, Some(&suppressed))
}

pub(crate) fn save_templates(root: &Path, templates: &[RunConfig]) -> IdeResult<()> {
    write_array(&config_path(root), TEMPLATES, &templates.iter().collect::<Vec<_>>(), None)
}
