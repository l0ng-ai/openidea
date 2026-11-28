//! Settings › Settings Sync › Sync Now: merges this machine's IDE settings with the ones in the
//! user's settings repository, pushes the result and applies it here.

use crate::Host;
use ide_core::error::ErrorKind;
use ide_core::{IdeError, IdeResult};
use ide_vcs::settings_repo::{SettingsBranch, SettingsRepo};
use ide_workspace::settings_sync::{self as sync, CATEGORIES, STORAGE_CATEGORIES};
use serde::{Deserialize, Serialize};
use serde_json::Value as Json;
use specta::Type;
use std::collections::BTreeMap;

/// How the first sync with a repository that already holds settings treats them.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SettingsSyncMode {
    Merge,
    /// The repository's settings replace this machine's.
    ReplaceLocal,
    /// This machine's settings replace the repository's.
    ReplaceRemote,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SettingsSyncResult {
    /// The repository holds settings this machine never synced with: sync again with a mode.
    pub needs_choice: bool,
    /// Settings both sides changed, where this machine's value replaced the repository's.
    pub overwritten: Vec<String>,
    /// This machine's global settings changed.
    pub settings_changed: bool,
    /// Frontend storage categories that changed here: category → all its entries now.
    pub storage: BTreeMap<String, BTreeMap<String, String>>,
    /// Plugins other computers have and this one does not: id → name.
    pub plugins_elsewhere: BTreeMap<String, String>,
}

type Storage = BTreeMap<String, BTreeMap<String, String>>;

/// One sync at a time, whichever window asks: they share the clone and the settings file.
static RUNNING: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// The repository of the settings, and the categories that sync.
fn repository(host: &Host, prompts: bool) -> IdeResult<Option<(SettingsRepo, Vec<&'static str>)>> {
    let config = host.global_settings.effective().settings_sync;
    let url = config.repository.trim();
    if url.is_empty() {
        return Ok(None);
    }
    let repo = SettingsRepo::open(&host.data_dir.join("settings-sync"), url, prompts)?;
    Ok(Some((repo, CATEGORIES.into_iter().filter(|c| sync::enabled(&config, c)).collect())))
}

/// What `category` syncs of this computer's settings `layer` and frontend `storage`.
fn local_value(category: &str, layer: &Json, storage: &Storage) -> Json {
    if STORAGE_CATEGORIES.contains(&category) {
        let entries = storage.get(category).into_iter().flatten();
        sync::clean(category, &Json::Object(entries.map(|(k, v)| (k.clone(), Json::String(v.clone()))).collect()))
    } else {
        sync::clean(category, layer)
    }
}

/// Whether this computer's settings differ from what it last synced. Reads only the local
/// clone, so an automatic sync after a change that does not sync (a project setting) stays off
/// the network.
pub fn has_local_changes(host: &Host, storage: &Storage) -> IdeResult<bool> {
    let _running = RUNNING.lock().unwrap_or_else(|e| e.into_inner());
    let Some((repo, enabled)) = repository(host, false)? else { return Ok(false) };
    let Some(synced) = repo.synced() else { return Ok(true) };
    let names: Vec<String> = enabled.iter().map(|c| sync::file_name(c)).collect();
    let files = repo.files(&synced, &names)?;
    let layer = host.global_settings.global_layer()?;
    let empty = Json::Object(Default::default());
    Ok(enabled.iter().any(|c| local_value(c, &layer, storage) != sync::from_files(&files, c).unwrap_or(empty.clone())))
}

/// `storage`: the frontend's syncable entries by category (`templates`, `macros`, `ui`), and
/// the installed plugins (`plugins`: id → name).
/// `mode`: `None` unless the user answered [`SettingsSyncResult::needs_choice`].
/// `interactive`: whether git may ask for credentials (Sync Now) or must use saved ones.
pub fn sync_now(
    host: &Host,
    storage: &Storage,
    mode: Option<SettingsSyncMode>,
    interactive: bool,
) -> IdeResult<SettingsSyncResult> {
    let _running = RUNNING.lock().unwrap_or_else(|e| e.into_inner());
    let Some((repo, enabled)) = repository(host, interactive)? else {
        return Err(IdeError::invalid("choose a settings repository first"));
    };
    let machine = host.global_settings.effective().settings_sync.plugins.then(|| machine_id(host)).transpose()?;
    let sync = |mode| sync_once(host, &repo, &enabled, storage, machine.as_deref(), mode);
    match sync(mode) {
        // Another machine pushed in between: merge with its settings too.
        Err(e) if e.kind == ErrorKind::OutOfSync => sync(mode),
        result => result,
    }
}

/// This computer's id in the repository's plugin list: random, kept in the data directory.
fn machine_id(host: &Host) -> IdeResult<String> {
    let file = host.data_dir.join("settings-sync-id");
    match std::fs::read_to_string(&file) {
        Ok(id) if !id.trim().is_empty() => Ok(id.trim().to_owned()),
        _ => {
            let id = uuid::Uuid::new_v4().to_string();
            ide_vfs::write_atomic(&file, id.as_bytes())?;
            Ok(id)
        }
    }
}

fn sync_once(
    host: &Host,
    repo: &SettingsRepo,
    enabled: &[&str],
    storage: &Storage,
    machine: Option<&str>,
    mode: Option<SettingsSyncMode>,
) -> IdeResult<SettingsSyncResult> {
    let mut names: Vec<String> = CATEGORIES.iter().map(|c| sync::file_name(c)).collect();
    names.push(sync::PLUGINS_FILE.into());
    let branch = repo.fetch()?;
    let remote_files = match &branch.commit {
        Some(commit) => repo.files(commit, &names)?,
        None => BTreeMap::new(),
    };
    let base_files = repo.synced().map(|commit| repo.files(&commit, &names)).transpose()?;
    if base_files.is_none() && mode.is_none() && enabled.iter().any(|c| remote_files.contains_key(&sync::file_name(c)))
    {
        return Ok(SettingsSyncResult { needs_choice: true, ..Default::default() });
    }
    let layer = host.global_settings.global_layer()?;
    let mut result = SettingsSyncResult::default();
    let mut files = remote_files.clone();
    let mut layer_changes = Vec::new();
    for &category in enabled {
        let local = local_value(category, &layer, storage);
        let remote = sync::from_files(&remote_files, category);
        let merged = match mode {
            Some(SettingsSyncMode::ReplaceLocal) => remote.unwrap_or_else(|| local.clone()),
            Some(SettingsSyncMode::ReplaceRemote) => local.clone(),
            Some(SettingsSyncMode::Merge) | None => {
                let base = base_files.as_ref().and_then(|files| sync::from_files(files, category));
                sync::merge3(base.as_ref(), Some(&local), remote.as_ref(), &mut Vec::new(), &mut result.overwritten)
                    .unwrap_or_else(|| Json::Object(Default::default()))
            }
        };
        files.insert(sync::file_name(category), sync::to_file(&merged));
        if merged == local {
            continue;
        }
        if STORAGE_CATEGORIES.contains(&category) {
            let entries = serde_json::from_value(merged).map_err(|e| IdeError::internal(e.to_string()))?;
            result.storage.insert(category.to_owned(), entries);
        } else {
            layer_changes.extend(sync::local_changes(&layer, category, &local, &merged));
        }
    }
    if let Some(machine) = machine {
        let local = storage.get("plugins").cloned().unwrap_or_default();
        let remote = remote_files.get(sync::PLUGINS_FILE).map(String::as_str);
        let (text, elsewhere) = sync::merge_plugins(remote, machine, &local);
        files.insert(sync::PLUGINS_FILE.into(), text);
        result.plugins_elsewhere = elsewhere;
    }
    // Check before anything leaves this machine that the merged settings load here.
    host.global_settings.apply_global_changes(&layer_changes, false)?;
    if files != remote_files {
        repo.publish(&branch, &files, "Sync settings")?;
    } else if let SettingsBranch { commit: Some(commit), .. } = &branch {
        repo.mark_synced(commit)?;
    }
    if !layer_changes.is_empty() {
        host.global_settings.apply_global_changes(&layer_changes, true)?;
        result.settings_changed = true;
    }
    Ok(result)
}
