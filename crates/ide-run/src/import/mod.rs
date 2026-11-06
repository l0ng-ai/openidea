//! Run configurations imported on request from another IDE's project files
//! (`.vscode/launch.json`, JetBrains `.run/*.run.xml` and `.idea/workspace.xml`). Each source
//! turns its entries into [`Entry`]s; [`finish`] gives them ids, skips names that already exist
//! (so importing again adds nothing twice) and resolves compound members by name.

mod jetbrains;
mod vscode;

use crate::RunConfig;
use ide_core::{IdeError, IdeResult};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Component, Path, PathBuf};

/// Project files run configurations can be imported from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum RunImportSource {
    /// VS Code's `.vscode/launch.json`.
    Vscode,
    /// JetBrains IDEs' `.run/*.run.xml`, `.idea/runConfigurations/*.xml` and `.idea/workspace.xml`.
    Jetbrains,
}

impl RunImportSource {
    pub const ALL: [Self; 2] = [Self::Vscode, Self::Jetbrains];

    /// The files read, relative to the project root, as the summary names them.
    pub fn file(self) -> &'static str {
        match self {
            Self::Vscode => ".vscode/launch.json",
            Self::Jetbrains => ".run, .idea",
        }
    }

    fn is_present(self, root: &Path) -> bool {
        match self {
            Self::Vscode => root.join(self.file()).is_file(),
            Self::Jetbrains => !jetbrains::files(root).is_empty(),
        }
    }
}

/// What an import found: configurations to add and entries left out, with the reason.
#[derive(Clone, Debug, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RunImport {
    pub source: RunImportSource,
    /// The file read, relative to the project root.
    pub file: String,
    pub imported: Vec<ImportedRunConfig>,
    pub skipped: Vec<SkippedRunConfig>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ImportedRunConfig {
    pub config: RunConfig,
    /// Keys of the source entry with no equivalent here (`preLaunchTask`, `justMyCode`…).
    pub ignored: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SkippedRunConfig {
    pub name: String,
    pub reason: SkipReason,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SkipReason {
    /// A configuration with this name already exists.
    NameTaken,
    /// The configuration type has no equivalent here: a VS Code debugger (`cppdbg`), a JetBrains type (`Application`).
    UnsupportedType {
        #[serde(rename = "type")]
        type_: String,
    },
    /// A `request` other than `launch` and `attach`.
    UnsupportedRequest { request: String },
    /// An attach other than to a host and port (to a process id, or listening for it).
    UnsupportedAttach,
    /// Uses a variable only known when VS Code starts it (`${file}`, `${input:…}`, `${command:…}`).
    Variable { variable: String },
    /// No program, module or command.
    NothingToRun,
    /// A JetBrains path variable with no value here (`$MAVEN_REPOSITORY$`, user-defined ones).
    PathVariable { variable: String },
    /// `$MODULE_DIR$` in a project with several modules: which module's directory is unknown.
    SeveralModules { variable: String },
    /// A file the configuration needs isn't in the project (Django's `manage.py`).
    MissingFile { file: String },
    /// A project file that can't be read, or isn't XML; `name` is the file.
    InvalidFile { detail: String },
    /// A compound member that is neither imported nor an existing configuration.
    MissingMember { member: String },
    /// Not an object with a name.
    Invalid,
}

/// One entry of the source file, before ids and names are settled.
pub(crate) struct Entry {
    pub name: String,
    pub result: Result<Found, SkipReason>,
}

pub(crate) struct Found {
    /// `id` is assigned by [`finish`].
    pub config: RunConfig,
    /// Names of the configurations a compound starts.
    pub members: Vec<String>,
    pub ignored: Vec<String>,
}

/// Configurations from `source` under `root`, given the ones the project has now (`existing`,
/// detected included). `env` resolves `${env:NAME}` and `${userHome}`.
pub fn import(
    root: &Path,
    source: RunImportSource,
    existing: &[RunConfig],
    env: &BTreeMap<String, String>,
) -> IdeResult<RunImport> {
    let file = source.file();
    if !source.is_present(root) {
        return Err(IdeError::not_found(format!("{file} not found")));
    }
    let entries = match source {
        RunImportSource::Vscode => vscode::entries(&std::fs::read_to_string(root.join(file))?, root, env)?,
        RunImportSource::Jetbrains => jetbrains::entries(root, env)?,
    };
    Ok(finish(source, entries, existing))
}

/// The sources with files under `root`.
pub fn available(root: &Path) -> Vec<RunImportSource> {
    RunImportSource::ALL.into_iter().filter(|s| s.is_present(root)).collect()
}

fn unique_id(name: &str, ids: &mut HashSet<String>) -> String {
    let slug = crate::config::slug(name);
    let base = format!("user:{}", if slug.is_empty() { "imported" } else { &slug });
    let mut id = base.clone();
    let mut n = 2;
    while ids.contains(&id) {
        id = format!("{base}-{n}");
        n += 1;
    }
    ids.insert(id.clone());
    id
}

pub(crate) fn finish(source: RunImportSource, entries: Vec<Entry>, existing: &[RunConfig]) -> RunImport {
    let mut ids: HashSet<String> = existing.iter().map(|c| c.id.clone()).collect();
    let mut by_name: HashMap<String, String> = HashMap::new();
    for c in existing {
        // Imported names are trimmed: compare existing ones the same way.
        by_name.entry(c.name.trim().to_owned()).or_insert_with(|| c.id.clone());
    }
    let mut imported: Vec<(usize, ImportedRunConfig)> = Vec::new();
    let mut skipped: Vec<(usize, SkippedRunConfig)> = Vec::new();
    let mut compounds = Vec::new();
    let skip = |name: String, reason| SkippedRunConfig { name, reason };

    // Compounds last: their members may be any configuration of the file.
    for (i, e) in entries.into_iter().enumerate() {
        match e.result {
            Err(reason) => skipped.push((i, skip(e.name, reason))),
            Ok(_) if by_name.contains_key(&e.name) => skipped.push((i, skip(e.name, SkipReason::NameTaken))),
            Ok(found) if found.config.kind == "compound" => {
                // Reserve the name so a later configuration can't take it.
                by_name.insert(e.name.clone(), String::new());
                compounds.push((i, e.name, found));
            }
            Ok(mut found) => {
                found.config.id = unique_id(&e.name, &mut ids);
                by_name.insert(e.name.clone(), found.config.id.clone());
                imported.push((i, ImportedRunConfig { config: found.config, ignored: found.ignored }));
            }
        }
    }
    for (i, name, mut found) in compounds {
        let members: Result<Vec<String>, String> = found
            .members
            .iter()
            .map(|m| by_name.get(m).filter(|id| !id.is_empty()).cloned().ok_or_else(|| m.clone()))
            .collect();
        match members {
            Ok(members) => {
                found.config.id = unique_id(&name, &mut ids);
                found.config.extras.compound = members;
                imported.push((i, ImportedRunConfig { config: found.config, ignored: found.ignored }));
            }
            Err(member) => skipped.push((i, skip(name, SkipReason::MissingMember { member }))),
        }
    }
    imported.sort_by_key(|(i, _)| *i);
    skipped.sort_by_key(|(i, _)| *i);
    RunImport {
        source,
        file: source.file().to_owned(),
        imported: imported.into_iter().map(|(_, c)| c).collect(),
        skipped: skipped.into_iter().map(|(_, s)| s).collect(),
    }
}

// ------------------------------------------------------------- shared by the sources

/// The variable `name` of `env`; Windows names ignore case (`${env:PATH}` finds `Path`).
pub(crate) fn env_var(env: &BTreeMap<String, String>, name: &str, windows: bool) -> Option<String> {
    match env.get(name) {
        Some(v) => Some(v.clone()),
        None if windows => env.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.clone()),
        None => None,
    }
}

/// The program's file name without a Windows extension (`npm.cmd` → `npm`).
pub(crate) fn command_name(cmd: &str) -> &str {
    let name = cmd.rsplit(['/', '\\']).next().unwrap_or(cmd);
    name.strip_suffix(".cmd").or_else(|| name.strip_suffix(".exe")).unwrap_or(name)
}

pub(crate) fn config(name: &str, kind: &str, command: String, args: Vec<String>, debug: Option<&str>) -> RunConfig {
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
        extras: crate::RunExtras::default(),
    }
}

/// Splits a command line into words: whitespace, `'…'` and `"…"` quoting, backslash escapes
/// (like `parseArgs` in `src/platform/commandLine.ts`).
pub fn split_args(line: &str) -> Vec<String> {
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

/// An absolute path inside the project, written relative to `dir` (the run's working
/// directory, where the process resolves it); anything else as it is.
pub(crate) fn path_from(root: &Path, value: String, dir: &Path) -> String {
    let path = Path::new(&value);
    if !path.is_absolute() {
        return value;
    }
    let path = normalize(path);
    if path.starts_with(root) && dir.starts_with(root) { relative_to(&path, dir).unwrap_or(value) } else { value }
}

/// The project's interpreter (see [`crate::detect::project_python`]), relative to `dir`.
pub(crate) fn project_python(root: &Path, dir: &Path) -> (String, Vec<String>) {
    let (exe, lead) = crate::detect::project_python(root);
    let exe = if exe.contains('/') { path_from(root, root.join(&exe).to_string_lossy().into(), dir) } else { exe };
    (exe, lead)
}

/// The working directory `cwd` (absolute) and the configuration's `cwd` (relative to the root, `None` for the root).
pub(crate) fn working_dir(root: &Path, cwd: &str) -> (PathBuf, Option<PathBuf>) {
    let abs = normalize(&root.join(cwd));
    let rel = match abs.strip_prefix(root) {
        Ok(r) if r.as_os_str().is_empty() => None,
        Ok(r) => Some(PathBuf::from(relative_to(&abs, root).unwrap_or_else(|| r.to_string_lossy().into()))),
        Err(_) => Some(abs.clone()),
    };
    (abs, rel)
}

/// `path` as written relative to `base` (both absolute, without `..`), with `/` separators;
/// `None` when they don't share a prefix (another drive).
pub(crate) fn relative_to(path: &Path, base: &Path) -> Option<String> {
    let path: Vec<Component> = path.components().collect();
    let base: Vec<Component> = base.components().collect();
    let common = path.iter().zip(&base).take_while(|(a, b)| a == b).count();
    if common == 0 {
        return None;
    }
    let mut parts: Vec<String> = base[common..].iter().map(|_| "..".to_owned()).collect();
    parts.extend(path[common..].iter().map(|c| c.as_os_str().to_string_lossy().into_owned()));
    Some(if parts.is_empty() { ".".to_owned() } else { parts.join("/") })
}

/// Drops `.` components and folds `..` into the parent, without touching the disk.
pub(crate) fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    out.push(c);
                }
            }
            other => out.push(other),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_paths_climb_out_of_the_base() {
        let root = Path::new("/p");
        assert_eq!(relative_to(Path::new("/p/manage.py"), root).as_deref(), Some("manage.py"));
        assert_eq!(relative_to(Path::new("/p"), root).as_deref(), Some("."));
        assert_eq!(
            relative_to(Path::new("/p/.venv/bin/python"), Path::new("/p/api")).as_deref(),
            Some("../.venv/bin/python")
        );
        assert_eq!(normalize(Path::new("/p/./api/../web")), PathBuf::from("/p/web"));
    }
}
