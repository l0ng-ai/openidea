//! Creating a project: requirements, the generator's zip / commands / files in a staging
//! directory next to the target, then one rename. A failed or cancelled run leaves nothing.

use crate::catalog::def;
use crate::model::{CreateRequest, Cwd, Def, Field, RequireDef, Requirement, ScaffoldEvent, StepDef, Values};
use crate::providers;
use crate::template::{matches, render};
use ide_core::error::ErrorKind;
use ide_core::{CancellationToken, IdeError, IdeResult};
use ide_tools::archive::{ArchiveKind, extract};
use ide_tools::{Http, InstallEvent, parse_version, run_quiet, run_streamed};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;

pub type Emit<'a> = &'a dyn Fn(ScaffoldEvent);

/// Text of this crate the UI shows (translated there), besides the definitions'.
#[cfg(test)]
pub(crate) const SHOWN: &[&str] = &[
    "Downloading the project",
    "Extracting",
    "Writing files",
    "Creating Git repository",
    "Enter a project name",
    "The name contains characters a folder name cannot have",
    "Language:",
    "Type:",
    "Packaging:",
    "Configuration:",
    "Dependencies:",
    "Extensions:",
    "Application type:",
    "Build system:",
    "Test framework:",
    "Features:",
];

fn unknown(id: &str) -> IdeError {
    IdeError::new(ErrorKind::NotFound, format!("Unknown project generator `{id}`"))
}

fn search_path() -> OsString {
    ide_core::process::host_var_os("PATH").unwrap_or_default()
}

/// `values` plus every field's rendered default it lacks, `name` included.
fn with_defaults(def: &Def, name: &str, values: &Values) -> Values {
    let mut out = values.clone();
    out.entry("name".into()).or_insert_with(|| name.to_owned());
    for f in &def.fields {
        if !out.contains_key(&f.id) {
            let v = render(&f.default, &out);
            out.insert(f.id.clone(), v);
        }
    }
    out
}

/// The fields a project service adds to the form (its metadata); empty for other generators.
pub fn options(id: &str, values: &Values, cancel: &CancellationToken) -> IdeResult<Vec<Field>> {
    let def = def(id).ok_or_else(|| unknown(id))?;
    match &def.service {
        Some(service) => providers::fields(service.provider, values, cancel),
        None => Ok(Vec::new()),
    }
}

/// `a` ≥ `b`, comparing the numeric parts of dotted versions.
pub(crate) fn version_at_least(a: &str, b: &str) -> bool {
    let parts = |s: &str| -> Vec<u64> {
        s.split(['.', '-', '+'])
            .map_while(|p| p.chars().take_while(char::is_ascii_digit).collect::<String>().parse().ok())
            .collect()
    };
    let (a, b) = (parts(a), parts(b));
    for i in 0..a.len().max(b.len()) {
        let (x, y) = (a.get(i).copied().unwrap_or(0), b.get(i).copied().unwrap_or(0));
        if x != y {
            return x > y;
        }
    }
    true
}

fn requirement(r: &RequireDef, values: &Values, search: &OsString) -> Requirement {
    let program = render(&r.program, values);
    let min = r.min.clone();
    let found_path = ide_core::process::find_executable(&program, search);
    let found = found_path.as_ref().and_then(|path| {
        if r.version_args.is_empty() {
            return Some(String::new());
        }
        let mut cmd = Command::new(path);
        cmd.args(&r.version_args).env("PATH", search);
        let (_, out) = run_quiet(cmd, std::time::Duration::from_secs(20))?;
        Some(parse_version(&out).unwrap_or_default())
    });
    let satisfied = match (&found, &min) {
        (None, _) => false,
        (Some(_), None) => true,
        (Some(v), Some(min)) => !v.is_empty() && version_at_least(v, min),
    };
    Requirement { program, min, found: found.filter(|v| !v.is_empty()), satisfied, hint: r.hint.clone() }
}

/// The programs `id` needs for `values`, and whether this machine has them.
pub fn requirements(id: &str, values: &Values) -> IdeResult<Vec<Requirement>> {
    let def = def(id).ok_or_else(|| unknown(id))?;
    let values = with_defaults(def, "app", values);
    let search = search_path();
    let mut out: Vec<Requirement> = Vec::new();
    for r in def.requires.iter().filter(|r| matches(&r.when, &values)) {
        let req = requirement(r, &values, &search);
        if !out.iter().any(|o| o.program == req.program) {
            out.push(req);
        }
    }
    Ok(out)
}

/// Why `name` cannot name the project folder.
pub fn name_error(name: &str) -> Option<&'static str> {
    let n = name.trim();
    if n.is_empty() {
        Some("Enter a project name")
    } else if n.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|']) || n == "." || n == ".." || n.starts_with('.')
    {
        Some("The name contains characters a folder name cannot have")
    } else {
        None
    }
}

/// The staging directory; removed on drop unless the project was moved out of it.
struct Staging(PathBuf);

impl Drop for Staging {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn line_sink<'a>(emit: Emit<'a>) -> impl Fn(InstallEvent) + 'a {
    move |e| match e {
        InstallEvent::Line { text } => emit(ScaffoldEvent::Line { text: strip_ansi(&text) }),
        InstallEvent::Progress { message, .. } if !message.is_empty() => emit(ScaffoldEvent::Line { text: message }),
        InstallEvent::Progress { .. } => {}
    }
}

/// `s` without terminal escape sequences (colours, cursor movement).
pub(crate) fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            if c != '\r' && (c == '\t' || !c.is_control()) {
                out.push(c);
            }
            continue;
        }
        match chars.next() {
            // CSI: parameters, then one final byte in `@`..`~`.
            Some('[') => {
                for c in chars.by_ref() {
                    if ('@'..='~').contains(&c) {
                        break;
                    }
                }
            }
            // OSC: up to BEL or ESC `\`.
            Some(']') => {
                while let Some(c) = chars.next() {
                    if c == '\u{7}' {
                        break;
                    }
                    if c == '\u{1b}' {
                        chars.next();
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    out
}

/// The program and arguments of `step`: its `program`, or the `package` run through the
/// package manager chosen in the `pm` field.
pub(crate) fn argv(step: &StepDef, values: &Values) -> Vec<String> {
    let args = step
        .args
        .iter()
        .flat_map(|a| a.applied(values))
        .map(|a| render(a, values))
        .filter(|a| !a.is_empty())
        .collect::<Vec<_>>();
    let Some(package) = &step.package else {
        return std::iter::once(render(&step.program, values)).chain(args).collect();
    };
    let package = render(package, values);
    let pm = values.get("pm").map(String::as_str).unwrap_or("npm");
    let runner: Vec<String> = match pm {
        "pnpm" => vec!["pnpm".into(), "dlx".into()],
        "bun" => vec!["bunx".into()],
        // `yarn dlx` exists only in Yarn 2+; npx is installed alongside every Node.js.
        _ => vec!["npx".into(), "--yes".into()],
    };
    runner.into_iter().chain(std::iter::once(package)).chain(args).collect()
}

fn run_step(
    step: &StepDef,
    values: &Values,
    project: &Path,
    search: &OsString,
    cancel: &CancellationToken,
    emit: Emit,
) -> IdeResult<()> {
    let argv = argv(step, values);
    emit(ScaffoldEvent::Step { text: step.label.clone() });
    let Some(program) = ide_core::process::find_executable(&argv[0], search) else {
        if step.optional {
            emit(ScaffoldEvent::Line { text: format!("`{}` is not installed; skipped", argv[0]) });
            return Ok(());
        }
        return Err(IdeError::unavailable(format!("`{}` is not installed", argv[0])));
    };
    let cwd = match step.cwd {
        Cwd::Project => project.to_path_buf(),
        Cwd::Parent => project.parent().unwrap_or(project).to_path_buf(),
    };
    let mut cmd = Command::new(program);
    cmd.args(&argv[1..]).current_dir(cwd).env("PATH", search);
    // Official CLIs take their defaults instead of asking when they see a CI run.
    cmd.env("CI", "1").env("NO_COLOR", "1").env("FORCE_COLOR", "0").env("npm_config_yes", "true");
    for (key, value) in &step.env {
        let value = render(value, values);
        if !value.is_empty() {
            cmd.env(key, value);
        }
    }
    let sink = line_sink(emit);
    let result = run_streamed(cmd, cancel, &sink);
    if result.is_ok()
        && let Some(created) = &step.creates
        && let Some(parent) = project.parent()
    {
        let created = parent.join(render(created, values));
        if created != project && created.is_dir() && !project.exists() {
            std::fs::rename(created, project)?;
        }
    }
    match result {
        Ok(_) => Ok(()),
        Err(_) if cancel.is_cancelled() => Err(IdeError::cancelled()),
        Err(e) if step.optional => {
            emit(ScaffoldEvent::Line { text: e.message.clone() });
            Ok(())
        }
        Err(e) => Err(e),
    }
}

/// Moves the only directory of `dir` (a zip's top folder) up into `dir`.
fn hoist_single_dir(dir: &Path) -> IdeResult<()> {
    let entries: Vec<_> = std::fs::read_dir(dir)?.filter_map(Result::ok).collect();
    let [only] = entries.as_slice() else { return Ok(()) };
    if !only.file_type()?.is_dir() {
        return Ok(());
    }
    let inner = only.path();
    for entry in std::fs::read_dir(&inner)? {
        let entry = entry?;
        std::fs::rename(entry.path(), dir.join(entry.file_name()))?;
    }
    std::fs::remove_dir(inner)?;
    Ok(())
}

fn write_files(def: &Def, values: &Values, project: &Path) -> IdeResult<()> {
    for file in def.files.iter().filter(|f| matches(&f.when, values)) {
        let rel = render(&file.path, values);
        let rel = Path::new(&rel);
        if rel.is_absolute() || rel.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
            return Err(IdeError::internal(format!("generator file outside the project: {}", rel.display())));
        }
        let path = project.join(rel);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&path, render(&file.content, values))?;
        if file.executable {
            ide_tools::archive::make_executable(&path)?;
        }
    }
    Ok(())
}

fn render_table(table: &toml::Table, values: &Values) -> toml::Table {
    let mut out = toml::Table::new();
    for (key, value) in table {
        match value {
            toml::Value::String(s) => {
                let s = render(s, values);
                if !s.is_empty() {
                    out.insert(key.clone(), toml::Value::String(s));
                }
            }
            toml::Value::Table(t) => {
                let t = render_table(t, values);
                if !t.is_empty() {
                    out.insert(key.clone(), toml::Value::Table(t));
                }
            }
            other => {
                out.insert(key.clone(), other.clone());
            }
        }
    }
    out
}

fn write_settings(def: &Def, values: &Values, project: &Path) -> IdeResult<()> {
    let Some(settings) = &def.settings else { return Ok(()) };
    let table = render_table(settings, values);
    if table.is_empty() {
        return Ok(());
    }
    let dir = project.join(".openidea");
    std::fs::create_dir_all(&dir)?;
    let text = toml::to_string(&table).map_err(|e| IdeError::internal(e.to_string()))?;
    std::fs::write(dir.join("settings.toml"), text)?;
    Ok(())
}

fn download_service(
    def: &Def,
    values: &Values,
    staging: &Path,
    project: &Path,
    cancel: &CancellationToken,
    emit: Emit,
) -> IdeResult<()> {
    let Some(service) = &def.service else { return Ok(()) };
    let url = providers::download_url(service.provider, values);
    emit(ScaffoldEvent::Step { text: "Downloading the project".into() });
    emit(ScaffoldEvent::Line { text: url.clone() });
    let zip = staging.join("project.zip");
    let sink = line_sink(emit);
    Http::new(&search_path())?.download(&url, &zip, None, cancel, &sink)?;
    emit(ScaffoldEvent::Step { text: "Extracting".into() });
    extract(&zip, ArchiveKind::Zip, project, "", cancel)?;
    let _ = std::fs::remove_file(&zip);
    let mut sidecar = zip.into_os_string();
    sidecar.push(".url");
    let _ = std::fs::remove_file(sidecar);
    hoist_single_dir(project)?;
    for wrapper in ["mvnw", "gradlew"] {
        let path = project.join(wrapper);
        if path.is_file() {
            ide_tools::archive::make_executable(&path)?;
        }
    }
    Ok(())
}

/// Creates the project `req` describes and returns its directory.
pub fn create(req: &CreateRequest, cancel: &CancellationToken, emit: Emit) -> IdeResult<PathBuf> {
    let def = def(&req.generator).ok_or_else(|| unknown(&req.generator))?;
    create_with(def, req, cancel, emit)
}

pub(crate) fn create_with(
    def: &Def,
    req: &CreateRequest,
    cancel: &CancellationToken,
    emit: Emit,
) -> IdeResult<PathBuf> {
    let name = req.name.trim();
    if let Some(e) = name_error(name) {
        return Err(IdeError::invalid(e));
    }
    let location = req.location.to_path_buf();
    if !location.is_dir() {
        std::fs::create_dir_all(&location)?;
    }
    let target = location.join(name);
    if target.exists() && std::fs::read_dir(&target).map(|mut d| d.next().is_some()).unwrap_or(true) {
        return Err(IdeError::invalid(format!("{} already exists and is not empty", target.display())));
    }
    let values = with_defaults(def, name, &req.values);

    let search = search_path();
    let mut missing = def
        .requires
        .iter()
        .filter(|r| matches(&r.when, &values))
        .map(|r| requirement(r, &values, &search))
        .filter(|r| !r.satisfied);
    if let Some(r) = missing.next() {
        let need = r.min.as_ref().map(|m| format!(" {m} or later")).unwrap_or_default();
        return Err(IdeError::unavailable(format!("`{}`{need} is required to create this project", r.program)));
    }

    let staging = Staging(location.join(format!(".{name}.openidea-new-{}", std::process::id())));
    let _ = std::fs::remove_dir_all(&staging.0);
    std::fs::create_dir_all(&staging.0)?;
    let project = staging.0.join(name);

    download_service(def, &values, &staging.0, &project, cancel, emit)?;
    let creates_dir = def.steps.iter().any(|s| s.cwd == Cwd::Parent && matches(&s.when, &values));
    if !creates_dir {
        std::fs::create_dir_all(&project)?;
    }
    for step in def.steps.iter().filter(|s| matches(&s.when, &values)) {
        if cancel.is_cancelled() {
            return Err(IdeError::cancelled());
        }
        if step.cwd == Cwd::Project {
            std::fs::create_dir_all(&project)?;
        }
        run_step(step, &values, &project, &search, cancel, emit)?;
    }
    if !project.is_dir() {
        return Err(IdeError::internal(format!("the generator did not create {}", project.display())));
    }
    if !def.files.is_empty() {
        emit(ScaffoldEvent::Step { text: "Writing files".into() });
    }
    write_files(def, &values, &project)?;
    write_settings(def, &values, &project)?;
    for step in def.after.iter().filter(|s| matches(&s.when, &values)) {
        if cancel.is_cancelled() {
            return Err(IdeError::cancelled());
        }
        run_step(step, &values, &project, &search, cancel, emit)?;
    }
    let git_dir = project.join(".git");
    if !(req.git && def.git) && git_dir.is_dir() {
        // Some CLIs always create a repository.
        std::fs::remove_dir_all(&git_dir)?;
    } else if req.git && def.git && !git_dir.exists() {
        emit(ScaffoldEvent::Step { text: "Creating Git repository".into() });
        if let Err(e) = ide_vcs::init(&project) {
            emit(ScaffoldEvent::Line { text: e.message.clone() });
        }
    }
    if cancel.is_cancelled() {
        return Err(IdeError::cancelled());
    }
    if target.exists() {
        std::fs::remove_dir(&target)?;
    }
    std::fs::rename(&project, &target)?;
    Ok(target)
}

#[cfg(test)]
mod tests;
