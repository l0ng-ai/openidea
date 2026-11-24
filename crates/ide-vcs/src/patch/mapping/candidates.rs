use super::{
    Destination, PatchPathMapping, ProjectPatchGroup, destination, file_destination, missing_patch_base, normalized,
    rewrite_headers, selected_sections, valid_patch_path,
};
use crate::{ChangeKind, PatchFile, Repo, Repos};
use ide_core::{IdeResult, IpcPath, ipc_path::to_ipc};
use serde::Serialize;
use specta::Type;
use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::path::{Path, PathBuf};

const MENU_LIMIT: usize = 8;
const CHECK_LIMIT: usize = 32;

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PatchDirectoryCandidate {
    pub directory: IpcPath,
    pub source: IpcPath,
    pub strip: u32,
    pub applies: Option<bool>,
}

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PatchDirectoryMatches {
    pub path: String,
    pub candidates: Vec<PatchDirectoryCandidate>,
}

struct Match {
    candidate: PatchDirectoryCandidate,
    target: Destination,
}

pub struct PatchDirectoryScope<'a> {
    pub repo: &'a Repo,
    pub base: Option<&'a Path>,
    pub only_repository: bool,
    pub automatic: bool,
}

/// Match missing base files and additions to existing path suffixes. Check the resulting
/// mappings with Git before adopting any inferred destination.
pub fn discover_patch_directories(
    repos: &Repos,
    scope: PatchDirectoryScope<'_>,
    patch: &str,
    overrides: &[PatchPathMapping],
    indexed_files: impl FnOnce(&HashSet<&OsStr>) -> Vec<PathBuf>,
    existing_directories: impl FnOnce(&HashSet<&OsStr>) -> Vec<PathBuf>,
) -> IdeResult<(Vec<PatchDirectoryMatches>, Vec<PatchPathMapping>)> {
    let PatchDirectoryScope { repo: default, base, automatic, .. } = scope;
    let patch = normalized(patch)?;
    let sections = selected_sections(&patch, None)?;
    let overrides: HashMap<_, _> = overrides.iter().map(|mapping| (mapping.path.as_str(), mapping)).collect();
    let mut occupied = HashSet::new();
    let mut missing = Vec::new();
    for (section, file) in &sections {
        let before = Path::new(file.old_path.as_deref().unwrap_or(&file.path));
        let original = destination(repos, default, base, file, None);
        if valid_patch_path(before) {
            let needs_base = if file.kind == ChangeKind::Added {
                new_file_anchors(before).next().is_some()
                    && !original.as_ref().is_ok_and(|route| route.full.parent().is_some_and(Path::is_dir))
            } else {
                original.as_ref().map_or(true, |route| missing_patch_base(&route.root, file, &route.before))
            };
            if needs_base {
                missing.push((*section, file, before));
            }
        }
        let mapping = overrides.get(file.path.as_str()).copied();
        let active = match mapping {
            Some(mapping) => match mapping.file.as_deref() {
                Some(path) => file_destination(repos, file, section, path),
                None => destination(repos, default, base, file, Some(mapping)),
            },
            None => original,
        };
        if let Ok(route) = active {
            occupied.extend(path_keys(&route));
        }
    }

    let names: HashSet<_> = missing
        .iter()
        .filter(|(_, file, _)| file.kind != ChangeKind::Added)
        .filter_map(|(_, _, before)| before.file_name())
        .collect();
    let dir_names: HashSet<_> = missing
        .iter()
        .filter(|(_, file, _)| file.kind == ChangeKind::Added)
        .flat_map(|(_, _, path)| new_file_anchors(path))
        .filter_map(Path::file_name)
        .collect();
    let indexed = indexed_files(&names);
    let dirs = existing_directories(&dir_names);
    let indexed = by_name(&indexed);
    let dirs = by_name(&dirs);

    let mut checks_left = CHECK_LIMIT;
    let mut matches = Vec::new();
    let mut inferred = Vec::new();
    let mut seen = HashSet::new();
    for (section, file, before) in missing {
        // Several sections for the same path have no single hunk context to rank on.
        if !seen.insert(file.path.as_str()) {
            inferred.retain(|(mapping, _): &(PatchPathMapping, Destination)| mapping.path != file.path);
            continue;
        }
        let mut choices = if file.kind == ChangeKind::Added {
            new_file_anchors(before)
                .flat_map(|anchor| named_paths(&dirs, anchor).map(move |path| (anchor, path)))
                .filter_map(|(anchor, path)| candidate_for(repos, &scope, file, anchor, path))
                .collect::<Vec<_>>()
        } else {
            named_paths(&indexed, before).filter_map(|path| candidate_for(repos, &scope, file, before, path)).collect()
        };
        choices.sort_by(|a, b| {
            a.candidate.strip.cmp(&b.candidate.strip).then(a.candidate.source.cmp(&b.candidate.source))
        });
        let mut locations = HashSet::new();
        choices.retain(|entry| locations.insert(entry.candidate.source.clone()));
        let truncated = choices.len() > MENU_LIMIT;
        choices.truncate(MENU_LIMIT);
        for entry in choices.iter_mut().take(checks_left) {
            checks_left -= 1;
            let Some(repo) = repos.at_root(&entry.target.root) else { continue };
            let mut rewritten = String::new();
            rewrite_headers(&mut rewritten, section, &entry.target.before, &entry.target.after, false);
            let group = ProjectPatchGroup { root: entry.target.root.clone(), prefix: String::new(), patch: rewritten };
            entry.candidate.applies = group.preview(repo).ok().map(|files| files.iter().all(|file| file.applies));
        }
        choices.sort_by_key(|entry| (entry.candidate.applies != Some(true), entry.candidate.strip));
        let best = choices.first();
        if automatic
            && !truncated
            && !overrides.contains_key(file.path.as_str())
            && let Some(best) = best
            && best.candidate.applies == Some(true)
            && choices.iter().skip(1).all(|entry| {
                entry.candidate.strip > best.candidate.strip
                    || (file.kind != ChangeKind::Added && entry.candidate.applies == Some(false))
            })
        {
            let mapping = mapping_for(file, &best.candidate);
            if let Ok(route) = destination(repos, default, base, file, Some(&mapping))
                && path_keys(&route).all(|key| !occupied.contains(&key))
            {
                inferred.push((mapping, route));
            }
        }
        if !choices.is_empty() {
            matches.push(PatchDirectoryMatches {
                path: file.path.clone(),
                candidates: choices.into_iter().map(|entry| entry.candidate).collect(),
            });
        }
    }
    let mut owners = HashMap::new();
    for (_, route) in &inferred {
        for key in path_keys(route) {
            *owners.entry(key).or_insert(0) += 1;
        }
    }
    let automatic = inferred
        .into_iter()
        .filter(|(_, route)| path_keys(route).all(|key| owners[&key] == 1))
        .map(|(mapping, _)| mapping)
        .collect();
    Ok((matches, automatic))
}

/// A new file can be inside new subfolders. Match any existing ancestor that retains
/// at least two components, so a generic name such as "src" cannot move an addition.
fn new_file_anchors(path: &Path) -> impl Iterator<Item = &Path> {
    path.ancestors().skip(1).take_while(|dir| dir.parent().is_some_and(|parent| !parent.as_os_str().is_empty()))
}

fn by_name(paths: &[PathBuf]) -> HashMap<&OsStr, Vec<&Path>> {
    let mut grouped: HashMap<_, Vec<_>> = HashMap::new();
    for path in paths {
        if let Some(name) = path.file_name() {
            grouped.entry(name).or_default().push(path.as_path());
        }
    }
    grouped
}

fn named_paths<'a>(paths: &'a HashMap<&OsStr, Vec<&'a Path>>, path: &Path) -> impl Iterator<Item = &'a Path> {
    path.file_name().and_then(|name| paths.get(name)).into_iter().flatten().copied()
}

fn path_keys(route: &Destination) -> impl Iterator<Item = String> + '_ {
    let key = |path: &str| {
        let absolute = to_ipc(&route.root.join(path));
        if cfg!(windows) { absolute.to_lowercase() } else { absolute }
    };
    let after = key(&route.after);
    let before = key(&route.before);
    let differs = before != after;
    std::iter::once(after).chain(differs.then_some(before))
}

fn mapping_for(file: &PatchFile, candidate: &PatchDirectoryCandidate) -> PatchPathMapping {
    PatchPathMapping {
        path: file.path.clone(),
        directory: Some(candidate.directory.clone()),
        strip: candidate.strip,
        file: None,
    }
}

fn candidate_for(
    repos: &Repos,
    scope: &PatchDirectoryScope<'_>,
    file: &PatchFile,
    anchor: &Path,
    local: &Path,
) -> Option<Match> {
    let added = file.kind == ChangeKind::Added;
    let common = anchor.components().rev().zip(local.components().rev()).take_while(|(a, b)| a == b).count();
    if common < if added { 2 } else { 1 } {
        return None;
    }
    let mapping = PatchPathMapping {
        path: file.path.clone(),
        directory: Some(local.ancestors().nth(common)?.into()),
        strip: u32::try_from(anchor.components().count() - common).ok()?,
        file: None,
    };
    let target = destination(repos, scope.repo, scope.base, file, Some(&mapping)).ok()?;
    if (scope.only_repository && target.root != scope.repo.root())
        || missing_patch_base(&target.root, file, &target.before)
    {
        return None;
    }
    let candidate = PatchDirectoryCandidate {
        source: if added { target.full.as_path() } else { local }.into(),
        directory: mapping.directory?,
        strip: mapping.strip,
        applies: None,
    };
    Some(Match { candidate, target })
}
