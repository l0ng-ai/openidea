//! The shelf: named patches of local changes kept outside git, like IDEA's
//! `.idea/shelf`. Each shelved change list is `<shelf>/<id>/shelved.patch` plus
//! `<shelf>/<id>/shelf.json` with its name, date and files.

use crate::cli::{run, run_env, run_paths};
use crate::{ApplyOutcome, ChangeKind, ChangedFile, Repo, ShelvedChangeList, Stash};
use ide_core::{IdeError, IdeResult};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::Write;
use std::path::{Path, PathBuf};

const PATCH: &str = "shelved.patch";
const INFO: &str = "shelf.json";
const GROUPED: &str = "repositories";
const SNAPSHOT: &str = "snapshot";
const SNAPSHOT_PACK: &str = "snapshot.pack";

/// Correlates a single project-wide Git operation across its individual repository commands.
#[derive(Clone)]
pub struct ShelfBatch {
    id: String,
    base: PathBuf,
}

thread_local! {
    static SHELF_BATCH: std::cell::RefCell<Option<ShelfBatch>> = const { std::cell::RefCell::new(None) };
}

impl ShelfBatch {
    pub fn new(id: String, base: PathBuf) -> Self {
        Self { id, base }
    }

    pub fn run<T>(self, op: impl FnOnce() -> T) -> T {
        struct RestoreBatch(Option<ShelfBatch>);
        impl Drop for RestoreBatch {
            fn drop(&mut self) {
                SHELF_BATCH.with(|slot| slot.replace(self.0.take()));
            }
        }
        let _restore = RestoreBatch(SHELF_BATCH.with(|slot| slot.replace(Some(self))));
        op()
    }
}

pub(crate) fn is_active_batch(id: &str) -> bool {
    SHELF_BATCH.with(|slot| slot.borrow().as_ref().is_some_and(|batch| batch.id == id))
}

#[derive(Clone)]
pub(crate) struct AutomaticShelf {
    pub directory: PathBuf,
    pub changelist_root: Option<PathBuf>,
}

#[derive(Serialize, Deserialize)]
pub(crate) struct SavedShelves {
    pub directory: PathBuf,
    pub entries: Vec<String>,
    pub snapshot: String,
    archive: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub batch: Option<String>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub prefix: String,
}

pub(crate) struct PendingShelf {
    pub id: String,
    pub patch: String,
    pub intact: bool,
}

impl SavedShelves {
    fn archive_path(&self) -> IdeResult<PathBuf> {
        if !self.archive.starts_with(".snapshot-") || self.archive.contains(['/', '\\']) {
            return Err(IdeError::invalid("Invalid automatic Shelf archive"));
        }
        Ok(self.directory.join(&self.archive))
    }

    pub(crate) fn unpack(&self, r: &Repo) -> IdeResult<()> {
        let pack = std::fs::read(self.archive_path()?)?;
        run(r.root(), &["unpack-objects", "-q"], Some(&pack))?;
        Ok(())
    }

    pub(crate) fn pending(&self) -> IdeResult<Vec<PendingShelf>> {
        let mut pending = Vec::new();
        for id in &self.entries {
            if let Some((patch, intact)) = owned_patch(&self.directory, id, &self.archive)? {
                pending.push(PendingShelf { id: id.clone(), patch, intact });
            }
        }
        Ok(pending)
    }

    fn clean_entries(&self) {
        for id in &self.entries {
            let _ = delete(&self.directory, id);
        }
    }

    pub(crate) fn discard(&self) {
        self.clean_entries();
        self.remove_archive();
    }

    pub(crate) fn remove_archive(&self) {
        if let Ok(path) = self.archive_path() {
            let _ = std::fs::remove_file(path);
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Info {
    name: String,
    time_ms: f64,
    #[serde(default)]
    branch: Option<String>,
    files: Vec<crate::ChangedFile>,
    #[serde(default)]
    repo: Option<ide_core::IpcPath>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    repositories: Vec<ShelfRepository>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    group: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct ShelfRepository {
    root: ide_core::IpcPath,
    prefix: String,
    paths: Vec<String>,
}

/// A captured part of a mixed-repository shelf, ready to save before any files are reverted.
pub struct ShelfCapture {
    repo: PathBuf,
    prefix: String,
    patch: String,
    files: Vec<ChangedFile>,
}

impl ShelfCapture {
    pub fn capture(r: &Repo, base: &Path, paths: &[PathBuf]) -> IdeResult<Self> {
        let _scope = r.execution_scope();
        let repo = r.root().to_path_buf();
        let prefix = repository_prefix(&repo, base)?;
        let (patch, files) =
            crate::patch::working_patch_with_prefix(r, &r.rel_paths(paths)?, false, false, Some(&prefix))?;
        Ok(Self { repo, prefix, patch, files })
    }

    pub fn repository(&self) -> &Path {
        &self.repo
    }

    pub fn revert(&self, r: &Repo) -> IdeResult<()> {
        let _scope = r.execution_scope();
        if r.root() != self.repo {
            return Err(IdeError::invalid("The shelf repository has changed"));
        }
        if self.files.is_empty() {
            return Ok(());
        }
        let paths: Vec<_> = self.files.iter().map(|file| file.path.clone()).collect();
        let (current, _) = crate::patch::working_patch_with_prefix(r, &paths, false, false, Some(&self.prefix))?;
        if current != self.patch {
            return Err(IdeError::invalid("Files changed while shelving. The captured changes are on the Shelf."));
        }
        revert_files(r, &self.files)
    }
}

fn repository_prefix(repo: &Path, base: &Path) -> IdeResult<String> {
    let relative =
        repo.strip_prefix(base).map_err(|_| IdeError::invalid("The shelf repositories have no common directory"))?;
    Ok(if relative.as_os_str().is_empty() {
        String::new()
    } else {
        format!("{}/", ide_core::ipc_path::to_ipc(relative))
    })
}

pub fn save_combined(shelf: &Path, base: &Path, name: &str, captures: &[ShelfCapture]) -> IdeResult<ShelvedChangeList> {
    let name = name.trim();
    if name.is_empty() {
        return Err(IdeError::invalid("name must not be empty"));
    }
    let patch: String = captures.iter().map(|capture| capture.patch.as_str()).collect();
    let files = changed_files(&patch);
    if files.is_empty() {
        return Err(IdeError::invalid("no changes to shelve"));
    }
    if files.iter().map(|file| &file.path).collect::<HashSet<_>>().len() != files.len() {
        return Err(IdeError::invalid("A file belongs to more than one repository in this shelf"));
    }
    crate::changelists::ensure_ignored(shelf, &["*"])?;
    let repositories = captures
        .iter()
        .filter(|capture| !capture.files.is_empty())
        .map(|capture| ShelfRepository {
            root: capture.repo.as_path().into(),
            prefix: capture.prefix.clone(),
            paths: capture.files.iter().map(|file| format!("{}{}", capture.prefix, file.path)).collect(),
        })
        .collect();
    let info = Info {
        name: name.to_owned(),
        time_ms: now_ms(),
        branch: None,
        repo: Some(base.into()),
        files,
        repositories,
        group: None,
    };
    write_entry(shelf, info, &patch, None)
}

/// A patch selection with its original repository and the common path prefix to strip when applying it.
pub struct ShelfSelection {
    pub repo: Option<ide_core::IpcPath>,
    prefix: String,
    patch: String,
}

impl ShelfSelection {
    pub fn apply(&self, r: &Repo) -> IdeResult<ApplyOutcome> {
        let _scope = r.execution_scope();
        let mut outcome = crate::patch::apply_with_prefix(r, &self.patch, &self.prefix)?;
        for path in outcome.applied.iter_mut().chain(outcome.conflicts.iter_mut()) {
            *path = format!("{}{path}", self.prefix);
        }
        Ok(outcome)
    }

    pub fn diff_files(&self, r: &Repo) -> IdeResult<Vec<ShelfDiffFile>> {
        diff_from_patch(r, &self.patch, &self.prefix)
    }

    pub fn export(&self, fallback_root: &Path, base: &Path) -> IdeResult<String> {
        let root = self.repo.as_deref().unwrap_or(fallback_root);
        crate::patch::rebase_patch(&self.patch, root, &self.prefix, base)
    }
}

pub fn selections(shelf: &Path, id: &str, path: Option<&str>) -> IdeResult<Vec<ShelfSelection>> {
    let mut selections = Vec::new();
    for member in members(shelf, id)? {
        let dir = entry_dir(shelf, &member)?;
        let patch = std::fs::read_to_string(dir.join(PATCH))?;
        let patch = match path {
            Some(path) => sections_for_path(&patch, path),
            None => patch,
        };
        if !patch.is_empty() {
            selections.extend(selections_in_entry(&dir, patch)?);
        }
    }
    if selections.is_empty() {
        return Err(IdeError::not_found("shelved file not found"));
    }
    Ok(selections)
}

fn selections_in_entry(dir: &Path, patch: String) -> IdeResult<Vec<ShelfSelection>> {
    let info = read_info(dir);
    let Some(info) = info else {
        if dir.join(GROUPED).is_file() {
            return Err(IdeError::invalid("shelf metadata is missing"));
        }
        return Ok(vec![ShelfSelection { repo: None, prefix: String::new(), patch }]);
    };
    if info.repositories.is_empty() {
        if dir.join(GROUPED).is_file() {
            return Err(IdeError::invalid("shelf metadata is missing"));
        }
        return Ok(vec![ShelfSelection { repo: info.repo, prefix: String::new(), patch }]);
    }
    let mut owners = HashMap::new();
    for (index, repository) in info.repositories.iter().enumerate() {
        for path in &repository.paths {
            if owners.insert(path, index).is_some() {
                return Err(IdeError::invalid("A file belongs to more than one repository in this shelf"));
            }
        }
    }
    let mut patches = BTreeMap::<usize, String>::new();
    for (section, file) in crate::patch::sections(&patch) {
        let index =
            owners.get(&file.path).ok_or_else(|| IdeError::invalid("The shelved file has no owning repository"))?;
        patches.entry(*index).or_default().push_str(section);
    }
    Ok(patches
        .into_iter()
        .map(|(index, patch)| {
            let repository = &info.repositories[index];
            ShelfSelection { repo: Some(repository.root.clone()), prefix: repository.prefix.clone(), patch }
        })
        .collect())
}

fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

fn slug(name: &str) -> String {
    let mut s: String = name
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '_' })
        .collect::<String>()
        .split('_')
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join("_");
    s.truncate(s.char_indices().nth(60).map(|(i, _)| i).unwrap_or(s.len()));
    if s.is_empty() { "shelf".to_string() } else { s }
}

fn entry_dir(shelf: &Path, id: &str) -> IdeResult<PathBuf> {
    if id.is_empty() || id.contains(['/', '\\']) || id.starts_with('.') {
        return Err(IdeError::invalid(format!("invalid shelf id '{id}'")));
    }
    let dir = shelf.join(id);
    if !dir.join(PATCH).is_file() {
        return Err(IdeError::not_found(format!("shelved changes '{id}' not found")));
    }
    Ok(dir)
}

fn members(shelf: &Path, id: &str) -> IdeResult<Vec<String>> {
    if !id.starts_with("batch-") {
        entry_dir(shelf, id)?;
        return Ok(vec![id.to_owned()]);
    }
    let mut ids = Vec::new();
    if let Ok(entries) = std::fs::read_dir(shelf) {
        for entry in entries.flatten() {
            let dir = entry.path();
            if dir.join(PATCH).is_file() && read_info(&dir).is_some_and(|info| info.group.as_deref() == Some(id)) {
                ids.push(entry.file_name().to_string_lossy().into_owned());
            }
        }
    }
    if ids.is_empty() {
        return Err(IdeError::not_found(format!("shelved changes '{id}' not found")));
    }
    ids.sort();
    Ok(ids)
}

fn read_info(dir: &Path) -> Option<Info> {
    serde_json::from_slice(&std::fs::read(dir.join(INFO)).ok()?).ok()
}

fn changed_files(patch: &str) -> Vec<ChangedFile> {
    crate::patch::parse_patch(patch)
        .into_iter()
        .map(|file| ChangedFile { path: file.path, kind: file.kind, old_path: file.old_path, link: None })
        .collect()
}

/// Shelved change lists, newest first.
pub fn list(shelf: &Path) -> IdeResult<Vec<ShelvedChangeList>> {
    let mut out = Vec::new();
    let mut groups = HashMap::<String, ShelvedChangeList>::new();
    let Ok(entries) = std::fs::read_dir(shelf) else { return Ok(out) };
    for e in entries.flatten() {
        let dir = e.path();
        if !dir.join(PATCH).is_file() {
            continue;
        }
        let id = e.file_name().to_string_lossy().into_owned();
        let info = read_info(&dir).unwrap_or_else(|| Info {
            name: id.clone(),
            time_ms: 0.0,
            branch: None,
            repo: None,
            repositories: Vec::new(),
            group: None,
            files: std::fs::read_to_string(dir.join(PATCH))
                .map(|p| {
                    crate::patch::parse_patch(&p)
                        .into_iter()
                        .map(|f| crate::ChangedFile { path: f.path, kind: f.kind, old_path: f.old_path, link: None })
                        .collect()
                })
                .unwrap_or_default(),
        });
        let entry = ShelvedChangeList {
            id: info.group.clone().unwrap_or(id),
            name: info.name,
            time_ms: info.time_ms,
            branch: info.branch,
            repo: info.repo,
            files: crate::patch::parse_patch(&std::fs::read_to_string(dir.join(PATCH))?)
                .into_iter()
                .map(|f| crate::ChangedFile { path: f.path, kind: f.kind, old_path: f.old_path, link: None })
                .collect(),
        };
        if let Some(group) = info.group {
            if let Some(existing) = groups.get_mut(&group) {
                existing.files.extend(entry.files);
                existing.time_ms = existing.time_ms.max(entry.time_ms);
                existing.branch = None;
            } else {
                groups.insert(group, entry);
            }
        } else {
            out.push(entry);
        }
    }
    out.extend(groups.into_values());
    out.sort_by(|a, b| b.time_ms.total_cmp(&a.time_ms).then_with(|| a.name.cmp(&b.name)));
    Ok(out)
}

/// The patch text of a shelved change list.
pub fn patch_of(shelf: &Path, id: &str) -> IdeResult<String> {
    let patches = members(shelf, id)?
        .into_iter()
        .map(|id| Ok(std::fs::read_to_string(entry_dir(shelf, &id)?.join(PATCH))?))
        .collect::<IdeResult<Vec<_>>>()?;
    Ok(patches.concat())
}

/// The repository captured when the shelf was made; legacy shelves used the primary repository.
pub fn repository(shelf: &Path, id: &str) -> IdeResult<Option<PathBuf>> {
    let members = members(shelf, id)?;
    Ok(read_info(&entry_dir(shelf, &members[0])?).and_then(|info| info.repo).map(|repo| repo.into_path_buf()))
}

pub fn delete(shelf: &Path, id: &str) -> IdeResult<()> {
    for member in members(shelf, id)? {
        std::fs::remove_dir_all(entry_dir(shelf, &member)?)?;
    }
    Ok(())
}

pub fn rename(shelf: &Path, id: &str, name: &str) -> IdeResult<()> {
    let name = name.trim();
    if name.is_empty() {
        return Err(IdeError::invalid("name must not be empty"));
    }
    for member in members(shelf, id)? {
        rename_entry(&entry_dir(shelf, &member)?, name)?;
    }
    Ok(())
}

fn rename_entry(dir: &Path, name: &str) -> IdeResult<()> {
    let mut info = read_info(dir).unwrap_or(Info {
        name: String::new(),
        time_ms: now_ms(),
        branch: None,
        repo: None,
        repositories: Vec::new(),
        group: None,
        files: vec![],
    });
    info.name = name.to_string();
    std::fs::write(dir.join(INFO), serde_json::to_vec_pretty(&info).map_err(|e| IdeError::internal(e.to_string()))?)?;
    Ok(())
}

/// Saves the changes of `rel_paths` to the shelf and reverts them in the working tree.
pub(crate) fn shelve(r: &Repo, shelf: &Path, name: &str, rel_paths: &[String]) -> IdeResult<ShelvedChangeList> {
    let name = name.trim();
    if name.is_empty() {
        return Err(IdeError::invalid("name must not be empty"));
    }
    let (patch, files) = crate::patch::working_patch(r, rel_paths, false, false)?;
    if files.is_empty() || patch.trim().is_empty() {
        return Err(IdeError::invalid("no changes to shelve"));
    }
    let entry = save_patch(r, shelf, name, &patch, files, None)?;
    revert_files(r, &entry.files)?;
    Ok(entry)
}

/// Creates one visible entry per affected change list and one native archive for restoration.
pub(crate) fn capture_stash(r: &Repo, options: AutomaticShelf, name: &str, stash: &Stash) -> IdeResult<SavedShelves> {
    let base = stash.base.as_deref().ok_or_else(|| IdeError::invalid("The saved local changes have no base commit"))?;
    let batch = SHELF_BATCH.with(|slot| slot.borrow().clone());
    let prefix = batch.as_ref().map(|batch| repository_prefix(r.root(), &batch.base)).transpose()?.unwrap_or_default();
    let working = crate::patch::shelf_tree_patch_with_prefix(r, base, &stash.id, &prefix)?;
    let staged = crate::patch::shelf_tree_patch_with_prefix(r, base, &format!("{}^2", stash.id), &prefix)?;
    let groups = shelf_groups(r, base, stash, options.changelist_root.as_deref(), &working, &staged, &prefix)?;
    if groups.is_empty() {
        return Err(IdeError::invalid("Could not identify the stash containing the saved local changes"));
    }
    let branch = r.branch_info()?.head;
    crate::changelists::ensure_ignored(&options.directory, &["*"])?;
    let revisions = format!("{}\n^{base}\n", stash.id);
    let pack = run(r.root(), &["pack-objects", "--stdout", "--revs"], Some(revisions.as_bytes()))?.stdout;
    let mut archive = tempfile::Builder::new().prefix(".snapshot-").tempfile_in(&options.directory)?;
    archive.write_all(&pack)?;
    let filename = archive.path().file_name().unwrap().to_string_lossy().into_owned();
    let mut saved = SavedShelves {
        directory: options.directory,
        entries: Vec::new(),
        snapshot: stash.id.clone(),
        archive: filename,
        prefix,
        batch: batch.as_ref().map(|batch| batch.id.clone()),
    };
    for ((list, label), (patch, files)) in groups {
        let label = if list.is_empty() { name.to_owned() } else { format!("[{label}] {name}") };
        let mut info = Info {
            name: label,
            time_ms: now_ms(),
            branch: branch.clone(),
            repo: Some(r.root().into()),
            files,
            repositories: Vec::new(),
            group: None,
        };
        if let Some(batch) = &batch {
            let key = format!("{}\0{}\0{name}\0{list}", batch.id, ide_core::ipc_path::to_ipc(&batch.base));
            info.group = Some(format!("batch-{}", blake3::hash(key.as_bytes())));
            info.repo = Some(batch.base.as_path().into());
            info.repositories.push(ShelfRepository {
                root: r.root().into(),
                prefix: saved.prefix.clone(),
                paths: info.files.iter().map(|file| file.path.clone()).collect(),
            });
        }
        match write_entry(&saved.directory, info, &patch, Some(&saved.archive)) {
            Ok(entry) => saved.entries.push(entry.id),
            Err(error) => {
                saved.clean_entries();
                return Err(error);
            }
        }
    }
    if let Err(error) = archive.keep() {
        saved.clean_entries();
        return Err(error.error.into());
    }
    Ok(saved)
}

type ShelfPatch = (String, Vec<ChangedFile>);
type ShelfGroups = BTreeMap<(String, String), ShelfPatch>;

fn shelf_groups(
    r: &Repo,
    base: &str,
    stash: &Stash,
    root: Option<&Path>,
    working: &str,
    staged: &str,
    prefix: &str,
) -> IdeResult<ShelfGroups> {
    let mut groups = ShelfGroups::new();
    let state = root.map(|path| crate::changelists::load(&ide_core::project_dir::path(path, "changelists.json")));
    let mut renamed = HashMap::new();
    if root.is_some() {
        for tree in [format!("{}^2", stash.id), stash.id.clone()] {
            let status = run(r.root(), &["diff", "--name-status", "-z", "--find-renames", base, &tree, "--"], None)?;
            for file in crate::ops::parse_name_status(&status.stdout_str()) {
                if file.kind == ChangeKind::Renamed
                    && let Some(old) = file.old_path
                {
                    renamed.insert(old, file.path);
                }
            }
        }
    }
    let working = crate::patch::sections(working);
    let visible: HashSet<_> = working.iter().map(|(_, file)| file.path.clone()).collect();
    // Index-only edits also belong to the shelf preview.
    for (section, file) in working
        .into_iter()
        .chain(crate::patch::sections(staged).into_iter().filter(|(_, f)| !visible.contains(&f.path)))
    {
        let group = match (root, state.as_ref()) {
            (Some(root), Some(state)) => {
                let rel = file.path.strip_prefix(prefix).unwrap_or(&file.path);
                let path = r.abs_path(renamed.get(rel).map_or(rel, String::as_str));
                let key = ide_core::ipc_path::to_ipc(path.strip_prefix(root).unwrap_or(&path));
                let id = state.files.get(&key).unwrap_or(&state.active);
                let list = state.lists.iter().find(|list| &list.id == id).unwrap_or(&state.lists[0]);
                (list.id.clone(), list.name.clone())
            }
            _ => (String::new(), String::new()),
        };
        let (patch, files) = groups.entry(group).or_default();
        patch.push_str(section);
        files.push(ChangedFile { path: file.path, kind: file.kind, old_path: file.old_path, link: None });
    }
    Ok(groups)
}

fn save_patch(
    r: &Repo,
    shelf: &Path,
    name: &str,
    patch: &str,
    files: Vec<crate::ChangedFile>,
    snapshot: Option<&str>,
) -> IdeResult<ShelvedChangeList> {
    let info = Info {
        name: name.to_string(),
        time_ms: now_ms(),
        branch: r.branch_info()?.head,
        files,
        repo: Some(r.root().to_path_buf().into()),
        repositories: Vec::new(),
        group: None,
    };
    write_entry(shelf, info, patch, snapshot)
}

fn write_entry(shelf: &Path, info: Info, patch: &str, snapshot: Option<&str>) -> IdeResult<ShelvedChangeList> {
    std::fs::create_dir_all(shelf)?;
    let base = slug(&info.name);
    let mut id = base.clone();
    let mut n = 0;
    let dir = loop {
        let dir = shelf.join(&id);
        match std::fs::create_dir(&dir) {
            Ok(()) => break dir,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
        n += 1;
        id = format!("{base}_{n}");
    };
    let write = || -> IdeResult<()> {
        std::fs::write(
            dir.join(INFO),
            serde_json::to_vec_pretty(&info).map_err(|e| IdeError::internal(e.to_string()))?,
        )?;
        if !info.repositories.is_empty() {
            std::fs::write(dir.join(GROUPED), "")?;
        }
        if let Some(snapshot) = snapshot {
            let digest = blake3::hash(patch.as_bytes());
            std::fs::write(dir.join(SNAPSHOT), format!("{snapshot}\n{digest}"))?;
        }
        let mut file = tempfile::NamedTempFile::new_in(&dir)?;
        file.write_all(patch.as_bytes())?;
        file.persist(dir.join(PATCH)).map_err(|error| error.error)?;
        Ok(())
    };
    if let Err(e) = write() {
        let _ = std::fs::remove_dir_all(&dir);
        return Err(e);
    }
    Ok(ShelvedChangeList {
        id,
        name: info.name,
        time_ms: info.time_ms,
        branch: info.branch,
        repo: info.repo,
        files: info.files,
    })
}

/// Whether the pending shelf still exists and whether its snapshot still matches all of its files.
pub(crate) fn pending_snapshot(shelf: &Path, id: &str, snapshot: &str) -> IdeResult<Option<bool>> {
    Ok(owned_patch(shelf, id, snapshot)?.map(|(_, intact)| intact))
}

fn owned_patch(shelf: &Path, id: &str, snapshot: &str) -> IdeResult<Option<(String, bool)>> {
    let dir = shelf.join(id);
    if !dir.join(PATCH).is_file() {
        return Ok(None);
    }
    let dir = entry_dir(shelf, id)?;
    let saved = match std::fs::read_to_string(dir.join(SNAPSHOT)) {
        Ok(saved) => saved,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let Some((id, digest)) = saved.split_once('\n') else { return Ok(None) };
    if id != snapshot {
        return Ok(None);
    }
    let patch = std::fs::read_to_string(dir.join(PATCH))?;
    let intact = blake3::hash(patch.as_bytes()).to_hex().as_str() == digest;
    Ok(Some((patch, intact)))
}

pub(crate) fn materialize_snapshot(r: &Repo, shelf: &Path, id: &str) -> IdeResult<()> {
    let pack = std::fs::read(entry_dir(shelf, id)?.join(SNAPSHOT_PACK))?;
    run(r.root(), &["unpack-objects", "-q"], Some(&pack))?;
    Ok(())
}

/// Restores `files` to HEAD in both index and working tree; files absent from HEAD are removed.
fn revert_files(r: &Repo, files: &[crate::ChangedFile]) -> IdeResult<()> {
    let has_head = r.has_head()?;
    let (in_head, new): (Vec<_>, Vec<_>) = files.iter().partition(|f| has_head && f.kind != ChangeKind::Added);
    let paths = |files: &[&crate::ChangedFile]| -> Vec<String> { files.iter().map(|f| f.path.clone()).collect() };
    if !in_head.is_empty() {
        let args = ["--literal-pathspecs", "restore", "--source=HEAD", "--staged", "--worktree", "--"];
        run_paths(r.root(), &args, &paths(&in_head))?;
    }
    if !new.is_empty() {
        let args = ["--literal-pathspecs", "rm", "--cached", "-q", "-r", "--ignore-unmatch", "--"];
        run_paths(r.root(), &args, &paths(&new))?;
        for f in new {
            let abs = r.abs_path(&f.path);
            if abs.is_file() || abs.is_symlink() {
                std::fs::remove_file(&abs)?;
            }
        }
    }
    Ok(())
}

/// Applies a shelved change list; with `remove`, deletes it from the shelf once it
/// applied without conflicts (conflicts are left for the merge UI and the entry is kept).
pub(crate) fn unshelve(r: &Repo, shelf: &Path, id: &str, remove: bool) -> IdeResult<ApplyOutcome> {
    unshelve_path(r, shelf, id, remove, None)
}

pub fn unshelve_path(r: &Repo, shelf: &Path, id: &str, remove: bool, path: Option<&str>) -> IdeResult<ApplyOutcome> {
    let _scope = r.execution_scope();
    let patch = selected_patch(shelf, id, path)?;
    let outcome = crate::patch::apply(r, &patch)?;
    if remove && outcome.conflicts.is_empty() {
        delete_path(shelf, id, path)?;
    }
    Ok(outcome)
}

#[derive(Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ShelfDiffFile {
    pub path: String,
    pub patch: String,
    pub before: Option<String>,
    pub after: Option<String>,
}

pub fn selected_patch(shelf: &Path, id: &str, path: Option<&str>) -> IdeResult<String> {
    let patch = patch_of(shelf, id)?;
    let Some(path) = path else { return Ok(patch) };
    let selected = sections_for_path(&patch, path);
    if selected.is_empty() {
        return Err(IdeError::not_found("shelved file not found"));
    }
    Ok(selected)
}

fn sections_for_path(patch: &str, path: &str) -> String {
    crate::patch::sections(patch).into_iter().filter(|(_, f)| f.path == path).map(|(p, _)| p).collect()
}

pub fn delete_path(shelf: &Path, id: &str, path: Option<&str>) -> IdeResult<()> {
    let Some(path) = path else { return delete(shelf, id) };
    selected_patch(shelf, id, Some(path))?;
    delete_paths(shelf, id, &[path.to_owned()])
}

pub fn delete_paths(shelf: &Path, id: &str, paths: &[String]) -> IdeResult<()> {
    if paths.is_empty() {
        return Ok(());
    }
    let paths: HashSet<_> = paths.iter().collect();
    for member in members(shelf, id)? {
        delete_paths_in_entry(shelf, &member, &paths)?;
    }
    Ok(())
}

fn delete_paths_in_entry(shelf: &Path, id: &str, paths: &HashSet<&String>) -> IdeResult<()> {
    let dir = entry_dir(shelf, id)?;
    let patch = std::fs::read_to_string(dir.join(PATCH))?;
    let sections = crate::patch::sections(&patch);
    if !sections.iter().any(|(_, file)| paths.contains(&file.path)) {
        return Ok(());
    }
    let remaining: String = sections.into_iter().filter(|(_, f)| !paths.contains(&f.path)).map(|(p, _)| p).collect();
    if remaining.is_empty() {
        return delete(shelf, id);
    }
    if remaining == patch {
        return Ok(());
    }
    let mut info = read_info(&dir).ok_or_else(|| IdeError::invalid("shelf metadata is missing"))?;
    info.files = changed_files(&remaining);
    let mut file = tempfile::NamedTempFile::new_in(&dir)?;
    file.write_all(remaining.as_bytes())?;
    file.persist(dir.join(PATCH)).map_err(|error| error.error)?;
    std::fs::write(dir.join(INFO), serde_json::to_vec_pretty(&info).map_err(|e| IdeError::internal(e.to_string()))?)?;
    Ok(())
}

/// Reconstruct each side in a throwaway index; neither HEAD nor the working files are used.
pub fn diff_files(r: &Repo, shelf: &Path, id: &str) -> IdeResult<Vec<ShelfDiffFile>> {
    diff_from_patch(r, &patch_of(shelf, id)?, "")
}

fn diff_from_patch(r: &Repo, patch: &str, prefix: &str) -> IdeResult<Vec<ShelfDiffFile>> {
    let _scope = r.execution_scope();
    let strip = crate::patch::strip_option(prefix);
    let mut apply = vec!["apply"];
    apply.extend(strip.as_deref());
    let mut out = Vec::new();
    for (section, file) in crate::patch::sections(patch) {
        let mut item = ShelfDiffFile { path: file.path.clone(), patch: section.to_string(), before: None, after: None };
        if !file.binary {
            let reconstruct = || -> IdeResult<(String, String)> {
                let temp = tempfile::tempdir()?;
                let index = temp.path().join("index");
                let env = [("GIT_INDEX_FILE", index.as_os_str())];
                run_env(
                    r.root(),
                    &[apply.as_slice(), &[&format!("--build-fake-ancestor={}", index.display()), "-"]].concat(),
                    Some(section.as_bytes()),
                    &env,
                )?;
                let read = |path: &str| -> IdeResult<String> {
                    let path = path
                        .strip_prefix(prefix)
                        .ok_or_else(|| IdeError::invalid("The patch contains a path outside its repository"))?;
                    let bytes = run_env(r.root(), &["show", &format!(":{path}")], None, &env)?.stdout;
                    if bytes.contains(&0) {
                        return Err(IdeError::invalid("binary file"));
                    }
                    String::from_utf8(bytes).map_err(|_| IdeError::invalid("non-UTF-8 file"))
                };
                let before = if file.kind == ChangeKind::Added {
                    String::new()
                } else {
                    read(file.old_path.as_deref().unwrap_or(&file.path))?
                };
                run_env(
                    r.root(),
                    &[apply.as_slice(), &["--cached", "--binary", "--whitespace=nowarn", "-"]].concat(),
                    Some(section.as_bytes()),
                    &env,
                )?;
                let after = if file.kind == ChangeKind::Deleted { String::new() } else { read(&file.path)? };
                Ok((before, after))
            };
            if let Ok((before, after)) = reconstruct() {
                item.before = Some(before);
                item.after = Some(after);
            }
        }
        out.push(item);
    }
    Ok(out)
}

/// Import into the shelf without applying to the working tree.
pub fn import_patch(shelf: &Path, name: &str, patch: &str, repo: Option<&Path>) -> IdeResult<()> {
    let files = crate::patch::parse_patch(patch);
    if files.is_empty() || crate::patch::sections(patch).len() != files.len() {
        return Err(IdeError::invalid("no file changes found in the patch"));
    }
    std::fs::create_dir_all(shelf)?;
    let mut id = slug(name);
    while shelf.join(&id).exists() {
        id.push('_');
    }
    let dir = shelf.join(id);
    std::fs::create_dir(&dir)?;
    let info = Info {
        name: name.to_string(),
        time_ms: now_ms(),
        branch: None,
        repo: repo.map(|r| r.to_path_buf().into()),
        repositories: Vec::new(),
        group: None,
        files: files
            .into_iter()
            .map(|f| crate::ChangedFile { path: f.path, kind: f.kind, old_path: f.old_path, link: None })
            .collect(),
    };
    std::fs::write(dir.join(PATCH), patch)?;
    std::fs::write(dir.join(INFO), serde_json::to_vec_pretty(&info).map_err(|e| IdeError::internal(e.to_string()))?)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::slug;

    #[test]
    fn slugs() {
        assert_eq!(
            slug("Uncommitted changes before Update at 1/2/24, 10:00"),
            "Uncommitted_changes_before_Update_at_1_2_24_10_00"
        );
        assert_eq!(slug("  ../  "), "shelf");
        assert_eq!(slug("Фикс"), "Фикс");
    }
}
