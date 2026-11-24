use super::{
    ProjectPatchGroup, missing_patch_base, normalized, patch_file_exists, selected_sections, valid_patch_path,
};
use crate::diff::quote_path;
use crate::{ApplyOutcome, ChangeKind, PatchFile, PatchFileDiff, Repo, Repos, TextEncoding};
use ide_core::{IdeError, IdeResult, IpcPath, ipc_path::to_ipc};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::{BTreeMap, HashMap};
use std::path::{Component, Path, PathBuf};

mod candidates;
pub use candidates::{PatchDirectoryMatches, PatchDirectoryScope, discover_patch_directories};

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PatchPathMapping {
    pub path: String,
    pub directory: Option<IpcPath>,
    pub strip: u32,
    pub file: Option<IpcPath>,
}

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PatchPlacement {
    pub path: String,
    pub target: Option<IpcPath>,
    pub error: Option<String>,
}

pub struct MappedPatch {
    pub files: Vec<PatchFile>,
    pub placements: Vec<PatchPlacement>,
    pub groups: Vec<MappedPatchGroup>,
}

pub struct MappedPatchGroup {
    pub group: ProjectPatchGroup,
    entries: Vec<(usize, String)>,
}

struct Destination {
    root: PathBuf,
    full: PathBuf,
    before: String,
    after: String,
}

impl MappedPatchGroup {
    pub fn preview(&self, repo: &Repo, files: &mut [PatchFile]) -> IdeResult<()> {
        let preview = self.group.preview(repo)?;
        if preview.len() != self.entries.len() {
            return Err(IdeError::invalid("The mapped patch contains inconsistent file headers"));
        }
        for (file, (index, _)) in preview.into_iter().zip(&self.entries) {
            files[*index].applies = file.applies;
        }
        Ok(())
    }

    pub fn file_diff(&self, repo: &Repo, encoding: &dyn Fn(&Path, &[u8]) -> TextEncoding) -> IdeResult<PatchFileDiff> {
        let (_, path) = &self.entries[0];
        self.group.file_diff(repo, path, encoding)
    }

    pub fn apply(&self, repo: &Repo) -> IdeResult<ApplyOutcome> {
        let outcome = self.group.apply(repo)?;
        let absolute = |paths: Vec<String>| paths.into_iter().map(|path| to_ipc(&repo.root().join(path))).collect();
        Ok(ApplyOutcome { applied: absolute(outcome.applied), conflicts: absolute(outcome.conflicts) })
    }
}

impl MappedPatch {
    pub fn new(
        repos: &Repos,
        repo_root: Option<&Path>,
        base: Option<&Path>,
        patch: &str,
        paths: Option<&[String]>,
        mappings: &[PatchPathMapping],
    ) -> IdeResult<Self> {
        let default = match repo_root {
            Some(root) => repos.at_root(root),
            None => repos.primary(),
        }
        .ok_or_else(|| IdeError::unavailable("The patch repository is not in the project"))?;
        let patch = normalized(patch)?;
        let sections = selected_sections(&patch, paths)?;
        if sections.is_empty() {
            return Err(IdeError::invalid("no file changes found in the patch"));
        }
        let mappings: HashMap<_, _> = mappings.iter().map(|mapping| (mapping.path.as_str(), mapping)).collect();
        let destinations: Vec<_> = sections
            .iter()
            .map(|(section, file)| {
                if let Some(target) = mappings.get(file.path.as_str()).and_then(|m| m.file.as_deref()) {
                    return file_destination(repos, file, section, target);
                }
                destination(repos, default, base, file, mappings.get(file.path.as_str()).copied())
            })
            .collect();
        let mut owners = HashMap::new();
        let mut duplicates = std::collections::HashSet::new();
        for ((_, file), destination) in sections.iter().zip(&destinations) {
            if let Ok(destination) = destination {
                let target = to_ipc(&destination.full);
                let target = if cfg!(windows) { target.to_lowercase() } else { target };
                if owners.insert(target.clone(), &file.path).is_some_and(|owner| owner != &file.path) {
                    duplicates.insert(target);
                }
            }
        }

        let mut files = Vec::new();
        let mut placements = Vec::new();
        let mut groups = BTreeMap::new();
        for ((section, mut file), destination) in sections.into_iter().zip(destinations) {
            let mut placement = PatchPlacement { path: file.path.clone(), target: None, error: None };
            file.applies = false;
            match destination {
                Ok(destination) => {
                    file.missing_base = missing_patch_base(&destination.root, &file, &destination.before);
                    let target = to_ipc(&destination.full);
                    let key = if cfg!(windows) { target.to_lowercase() } else { target };
                    placement.target = Some(destination.full.into());
                    if duplicates.contains(&key) {
                        placement.error = Some("Multiple patch files target the same path".into());
                    } else {
                        let group = groups.entry(destination.root.clone()).or_insert_with(|| MappedPatchGroup {
                            group: ProjectPatchGroup {
                                root: destination.root,
                                prefix: String::new(),
                                patch: String::new(),
                            },
                            entries: Vec::new(),
                        });
                        rewrite_headers(
                            &mut group.group.patch,
                            section,
                            &destination.before,
                            &destination.after,
                            mappings.get(file.path.as_str()).is_some_and(|m| m.file.is_some()),
                        );
                        group.entries.push((files.len(), destination.after));
                    }
                }
                Err(error) => placement.error = Some(error.message),
            }
            placements.push(placement);
            files.push(file);
        }
        Ok(Self { files, placements, groups: groups.into_values().collect() })
    }

    pub fn require_destinations(&self) -> IdeResult<()> {
        if let Some(placement) = self.placements.iter().find(|placement| placement.error.is_some()) {
            return Err(IdeError::invalid(format!(
                "{}: {}",
                placement.path,
                placement.error.as_deref().unwrap_or_default()
            )));
        }
        if let Some(file) = self.files.iter().find(|file| file.missing_base) {
            return Err(IdeError::invalid(format!("{}: missing base file", file.path)));
        }
        Ok(())
    }
}

fn file_destination(repos: &Repos, file: &PatchFile, section: &str, target: &Path) -> IdeResult<Destination> {
    if file.kind == ChangeKind::Added {
        return Err(IdeError::invalid("A new file does not need a base file"));
    }
    if !valid_patch_path(Path::new(&file.path))
        || file.old_path.as_deref().is_some_and(|path| !valid_patch_path(Path::new(path)))
    {
        return Err(IdeError::invalid("The patch contains a path outside its repository"));
    }
    let repo = repos
        .for_path(target)
        .ok_or_else(|| IdeError::invalid("The patch destination is outside the project's Git repositories"))?;
    let relative = target
        .strip_prefix(repo.root())
        .ok()
        .filter(|path| valid_patch_path(path))
        .ok_or_else(|| IdeError::invalid("Choose an existing file inside a Git repository"))?;
    if !patch_file_exists(target) {
        return Err(IdeError::invalid("Choose an existing file inside a Git repository"));
    }
    if file.old_path.is_some()
        && !file.binary
        && file.added == 0
        && file.removed == 0
        && !section.lines().any(|line| line.starts_with("old mode "))
    {
        return Err(IdeError::invalid("This patch only renames or copies the file"));
    }
    let path = to_ipc(relative);
    Ok(Destination { root: repo.root().to_owned(), full: target.to_owned(), before: path.clone(), after: path })
}

fn destination(
    repos: &Repos,
    default: &Repo,
    base: Option<&Path>,
    file: &PatchFile,
    mapping: Option<&PatchPathMapping>,
) -> IdeResult<Destination> {
    let directory = mapping.and_then(|m| m.directory.as_deref()).or(base).unwrap_or_else(|| default.root());
    if !directory.is_absolute()
        || directory.components().any(|part| match part {
            Component::ParentDir => true,
            Component::Normal(name) => name.eq_ignore_ascii_case(".git"),
            _ => false,
        })
    {
        return Err(IdeError::invalid("Choose an absolute directory inside a Git repository"));
    }
    let strip = mapping.map_or(0, |m| m.strip) as usize;
    let resolve = |path: &str| {
        let path = Path::new(path);
        if !valid_patch_path(path) {
            return Err(IdeError::invalid("The patch contains a path outside its repository"));
        }
        let path: PathBuf = path.components().skip(strip).collect();
        if path.as_os_str().is_empty() {
            return Err(IdeError::invalid("The patch path has no file name after removing directories"));
        }
        Ok(directory.join(path))
    };
    let full = resolve(&file.path)?;
    let before = resolve(file.old_path.as_deref().unwrap_or(&file.path))?;
    let repo = if base.is_none() && mapping.and_then(|m| m.directory.as_ref()).is_none() {
        default
    } else {
        repos
            .for_path(&full)
            .map(|repo| repo.as_ref())
            .ok_or_else(|| IdeError::invalid("The patch destination is outside the project's Git repositories"))?
    };
    let rel = |path: &Path| {
        path.strip_prefix(repo.root())
            .ok()
            .filter(|path| !path.as_os_str().is_empty())
            .map(to_ipc)
            .ok_or_else(|| IdeError::invalid("Both paths of a rename or copy must be in the same Git repository"))
    };
    if (base.is_some() || mapping.and_then(|m| m.directory.as_ref()).is_some())
        && repos.for_path(&before).is_some_and(|other| other.root() != repo.root())
    {
        return Err(IdeError::invalid("Both paths of a rename or copy must be in the same Git repository"));
    }
    let after = rel(&full)?;
    Ok(Destination { root: repo.root().to_path_buf(), before: rel(&before)?, full, after })
}

/// Change names in the file header only. Hunks and Git's binary payload stay byte-for-byte intact.
pub(super) fn rewrite_headers(out: &mut String, section: &str, before: &str, after: &str, same_file: bool) {
    let old = quote_path(&format!("a/{before}"));
    let new = quote_path(&format!("b/{after}"));
    let mut offset = 0;
    for line in section.split_inclusive('\n') {
        if line.starts_with("@@") || line.starts_with("GIT binary patch") {
            break;
        }
        if same_file
            && ["rename ", "copy ", "similarity index ", "dissimilarity index "]
                .iter()
                .any(|prefix| line.starts_with(prefix))
        {
            offset += line.len();
            continue;
        }
        let replacement = if line.starts_with("diff --git ") {
            Some(format!("diff --git {old} {new}\n"))
        } else if line.starts_with("--- ") && !line.starts_with("--- /dev/null") {
            Some(format!("--- {old}\n"))
        } else if line.starts_with("+++ ") && !line.starts_with("+++ /dev/null") {
            Some(format!("+++ {new}\n"))
        } else {
            ["rename from ", "rename to ", "copy from ", "copy to "]
                .into_iter()
                .find(|prefix| line.starts_with(prefix))
                .map(|prefix| {
                    let path = if prefix.ends_with("from ") { before } else { after };
                    format!("{prefix}{}\n", quote_path(path))
                })
        };
        out.push_str(replacement.as_deref().unwrap_or(line));
        offset += line.len();
    }
    out.push_str(&section[offset..]);
}
