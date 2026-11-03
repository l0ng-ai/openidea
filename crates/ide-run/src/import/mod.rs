//! Run configurations imported on request from another IDE's project files
//! (`.vscode/launch.json`). Each source turns its entries into [`Entry`]s; [`finish`]
//! gives them ids, skips names that already exist (so importing again adds nothing
//! twice) and resolves compound members by name.

mod vscode;

use crate::RunConfig;
use ide_core::{IdeError, IdeResult};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Component, Path, PathBuf};

/// A project file run configurations can be imported from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum RunImportSource {
    /// VS Code's `.vscode/launch.json`.
    Vscode,
}

impl RunImportSource {
    pub const ALL: [Self; 1] = [Self::Vscode];

    /// The file read, relative to the project root.
    pub fn file(self) -> &'static str {
        match self {
            Self::Vscode => ".vscode/launch.json",
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
    /// The debugger type (`type`) has no equivalent here, e.g. `cppdbg`.
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
    let text = match std::fs::read_to_string(root.join(file)) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(IdeError::not_found(format!("{file} not found")));
        }
        Err(e) => return Err(e.into()),
    };
    let entries = match source {
        RunImportSource::Vscode => vscode::entries(&text, root, env)?,
    };
    Ok(finish(source, entries, existing))
}

/// The sources whose file exists under `root`.
pub fn available(root: &Path) -> Vec<RunImportSource> {
    RunImportSource::ALL.into_iter().filter(|s| root.join(s.file()).is_file()).collect()
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
