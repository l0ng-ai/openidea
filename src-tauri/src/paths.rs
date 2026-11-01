//! The configuration and data directories.
//!
//! By default everything stays where the platform puts it: Tauri's
//! `app_config_dir` for configuration (`settings.toml`, languages, recent
//! projects, window groups) and `app_data_dir` for data (language servers,
//! tools, history, caches). A user who wants everything in one place may
//! choose a custom base directory — Settings › System Settings ›
//! Configuration directory, or the `OPENIDEA_HOME` environment variable —
//! and then config/data/log/tools all hang off it (`config/`, `system/`,
//! `log/`, `tools/`, `language-server-runtimes/`). The switch only ever
//! happens on the user's initiative; nothing migrates on its own.
//!
//! Resolution order: the environment variable, else the pointer file
//! `<default config dir>/home.txt`, else the platform defaults. The pointer
//! lives at a fixed location (inside the default config dir, which the dev
//! identifier makes per-worktree) so a moved base can always be found back;
//! its second line records where the user's data currently lives, which is
//! what the migration dialog moves *from* after a switch. The result is
//! fixed for the process; changing it needs a restart.

use serde::Serialize;
use specta::Type;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Where configuration and data live: the platform defaults, or one
/// user-chosen base directory (`config/` and `system/` under it).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Layout {
    Default,
    Custom(PathBuf),
}

/// The two directories the shell hands its host: user-editable files in
/// `config`, rebuildable and secret state in `data`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Locations {
    pub config: PathBuf,
    pub data: PathBuf,
}

/// What [`init`] resolved: the layout, the two directories, the platform
/// defaults (the pointer's anchor) and the home dir (tilde expansion).
pub struct Resolved {
    pub layout: Layout,
    pub locations: Locations,
    pub defaults: (PathBuf, PathBuf),
    pub home: PathBuf,
}

static RESOLVED: OnceLock<Resolved> = OnceLock::new();

const POINTER_NAME: &str = "home.txt";
const SKIP_NAME: &str = ".skip-migration";

/// Legacy entry → its place in a custom base. The sources are the platform
/// defaults — config-side files in `app_config_dir`, everything else in
/// `app_data_dir` (the same directory on macOS) — and every name is looked
/// up through [`entry_path`], which knows both layouts. Adding an entry is
/// safe on an already-migrated machine: the source is only read where the
/// previous layout actually wrote. Pinned by
/// `migration_moves_the_full_mapping`.
const MOVES: &[(&str, &str)] = &[
    ("settings.toml", "config/settings.toml"),
    ("languages", "config/languages"),
    ("recent.json", "config/recent.json"),
    ("window-groups.json", "config/window-groups.json"),
    ("plugins", "config/plugins"),
    ("git-credentials.json", "system/git-credentials.json"),
    ("ssh-passwords.json", "system/ssh-passwords.json"),
    ("proxy-password.json", "system/proxy-password.json"),
    ("db-passwords.json", "system/db-passwords.json"),
    ("db-history.json", "system/db-history.json"),
    ("docker.json", "system/docker.json"),
    ("docker-passwords.json", "system/docker-passwords.json"),
    ("remote", "system/remote"),
    ("server", "system/server"),
    ("http-history", "system/http-history"),
    ("consoles", "system/consoles"),
    ("scratches", "system/scratches"),
    ("history", "system/history"),
    ("lsp", "system/lsp"),
    ("notebook-runtime", "system/notebook-runtime"),
    ("workspaces", "system/workspaces"),
    ("invalidate-caches.json", "system/invalidate-caches.json"),
    ("tools", "tools"),
    ("language-server-runtimes", "language-server-runtimes"),
];

/// Entries that live on the config side in the *default* layout; every other
/// entry lives on the data side there (in a custom base the MOVES target
/// decides, which puts `plugins` on the config side on purpose).
const DEFAULT_CONFIG_SIDE: &[&str] = &["settings.toml", "languages", "recent.json", "window-groups.json"];

/// Rebuildable caches: dropped, not moved (`index` and `cache` regenerate).
const DROPS: &[&str] = &["index", "cache"];

/// The platform defaults for an identifier — Tauri's `app_config_dir` /
/// `app_data_dir` (which are `dirs::config_dir()` / `dirs::data_dir()` joined
/// with the identifier on every platform).
pub fn default_dirs(identifier: &str) -> (PathBuf, PathBuf) {
    let config = dirs::config_dir().unwrap_or_else(|| dirs::data_dir().unwrap_or_default());
    let data = dirs::data_dir().unwrap_or_else(|| dirs::data_local_dir().unwrap_or_default());
    (config.join(identifier), data.join(identifier))
}

/// The pointer file inside the default config dir: its fixed location is what
/// finds a custom base back after the switch.
pub fn pointer_file(default_config: &Path) -> PathBuf {
    default_config.join(POINTER_NAME)
}

/// The migration dialog's "don't ask again" marker, same anchor as the pointer.
pub fn skip_marker(default_config: &Path) -> PathBuf {
    default_config.join(SKIP_NAME)
}

/// Resolves once per process, from `lib.rs` after the dev build has replaced
/// the identifier (`crate::dev`) — so a dev worktree's defaults and pointer
/// are its own, and the identifier-keyed OS cache stays per worktree too.
pub fn init(identifier: &str) {
    let defaults = default_dirs(identifier);
    let home = dirs::home_dir().unwrap_or_else(|| defaults.1.clone());
    let pointer = std::fs::read_to_string(pointer_file(&defaults.0)).ok();
    let (layout, locations) =
        resolve(std::env::var("OPENIDEA_HOME").ok().as_deref(), pointer.as_deref(), &defaults, &home);
    let _ = RESOLVED.set(Resolved { layout, locations, defaults, home });
}

/// The resolution made by [`init`] at startup; fixed for the process.
pub fn current() -> &'static Resolved {
    RESOLVED.get().expect("paths::init must run before any paths are read")
}

/// Resolution core with explicit inputs (testable without touching the
/// process environment): environment → pointer → platform defaults. A chosen
/// path must be absolute — a relative one would silently depend on the
/// launch directory — and a pointer at a directory that no longer exists
/// means the user removed the target: both fall through to the next source.
fn resolve(
    env: Option<&str>,
    pointer: Option<&str>,
    defaults: &(PathBuf, PathBuf),
    home: &Path,
) -> (Layout, Locations) {
    if let Some(chosen) = env.map(|e| expand_tilde(e, home)).filter(|p| p.is_absolute()) {
        return custom_layout(chosen);
    }
    if let Some(text) = pointer {
        let (target, _) = parse_pointer(text);
        if let Some(t) = target {
            if t == "default" {
                // The sentinel "Reset to default" writes: the platform dirs,
                // explicitly.
                return default_layout(defaults);
            }
            let path = expand_tilde(t, home);
            // A dangling pointer (the target was removed by hand) is not a
            // choice: fall through to the defaults.
            if path.is_absolute() && path.is_dir() {
                return custom_layout(path);
            }
        }
    }
    default_layout(defaults)
}

/// The resolved pair for a chosen base: config/ and system/ under it.
fn custom_layout(base: PathBuf) -> (Layout, Locations) {
    (Layout::Custom(base.clone()), Locations { config: base.join("config"), data: base.join("system") })
}

/// The resolved pair for the platform defaults: the two dirs as they are.
fn default_layout(defaults: &(PathBuf, PathBuf)) -> (Layout, Locations) {
    (Layout::Default, Locations { config: defaults.0.clone(), data: defaults.1.clone() })
}

// The four per-consumer roots below are the only way the shell turns a
// layout into a directory; every call site goes through them (never through
// `dirs::*` or Tauri's `app.path()` directly), which is what keeps reads and
// writes on the resolved location. Pinned by
// `custom_base_routes_every_consumer_off_the_platform_dirs`.

/// Where installed plugins live: beside the data in the default layout, on
/// the config side of a custom base (user-chosen installs, like IDEA's).
pub fn plugins_dir(layout: &Layout, locations: &Locations) -> PathBuf {
    match layout {
        Layout::Default => locations.data.clone(),
        Layout::Custom(_) => locations.config.clone(),
    }
}

/// The log dir: the platform's per-identifier log dir in the default layout
/// (Tauri's `app_log_dir` equivalent), `log/` under a custom base.
pub fn log_dir(layout: &Layout, identifier: &str) -> Option<PathBuf> {
    match layout {
        Layout::Default => crate::logging::log_dir_for(identifier),
        Layout::Custom(base) => Some(base.join("log")),
    }
}

/// The login-shell PATH cache root (the cache file is `<root>/login-path`):
/// the OS cache dir per identifier in the default layout, a custom base's
/// system dir otherwise.
pub fn login_cache_root(layout: &Layout, locations: &Locations, identifier: &str) -> PathBuf {
    match layout {
        // No OS cache dir (rare): degrade to the data dir rather than skip
        // caching — the upstream skip would make every start re-read the
        // login shell.
        Layout::Default => dirs::cache_dir().map(|d| d.join(identifier)).unwrap_or_else(|| locations.data.clone()),
        Layout::Custom(base) => base.join("system"),
    }
}

/// The managed-tools home (`tools/` and `language-server-runtimes/` hang off
/// it): the platform data dir per identifier in the default layout, a custom
/// base itself otherwise.
pub fn tools_home(layout: &Layout, identifier: &str) -> Option<PathBuf> {
    match layout {
        Layout::Default => dirs::data_dir().map(|d| d.join(identifier)),
        Layout::Custom(base) => Some(base.clone()),
    }
}

/// `~` and `~/rest` expand to `home`; anything else is taken literally.
fn expand_tilde(input: &str, home: &Path) -> PathBuf {
    let trimmed = input.trim();
    if trimmed == "~" {
        home.to_path_buf()
    } else if let Some(rest) = trimmed.strip_prefix("~/") {
        home.join(rest)
    } else {
        PathBuf::from(trimmed)
    }
}

/// Line 1 is the target (`default` or an absolute directory), line 2 the
/// location the user's data currently lives in (same vocabulary, optional) —
/// the migration dialog's source.
fn parse_pointer(text: &str) -> (Option<&str>, Option<&str>) {
    let mut lines = text.lines().map(str::trim).filter(|l| !l.is_empty());
    (lines.next(), lines.next())
}

/// The pointer-file spelling of a layout: the literal `default`, or the base's
/// absolute path — the two forms `resolve` reads back.
fn layout_str(layout: &Layout) -> String {
    match layout {
        Layout::Default => "default".to_owned(),
        Layout::Custom(base) => base.to_string_lossy().into_owned(),
    }
}

/// Records `target` (and, right after a switch, where the data currently
/// lives as `previous`) in the pointer file.
pub fn write_pointer(default_config: &Path, target: &Layout, previous: Option<&Layout>) -> std::io::Result<()> {
    let pointer = pointer_file(default_config);
    std::fs::create_dir_all(pointer.parent().expect("the pointer file has a parent"))?;
    let mut text = layout_str(target);
    if let Some(previous) = previous {
        text.push('\n');
        text.push_str(&layout_str(previous));
    }
    std::fs::write(&pointer, text)
}

/// Drops the pointer: no pointer means the platform defaults.
pub fn remove_pointer(default_config: &Path) {
    let _ = std::fs::remove_file(pointer_file(default_config));
}

/// Records the user's "don't migrate, don't ask again" choice. Any new
/// switch clears it (`clear_skip_marker`): a fresh switch asks again.
pub fn write_skip_marker(default_config: &Path) -> std::io::Result<()> {
    let marker = skip_marker(default_config);
    std::fs::create_dir_all(marker.parent().expect("the marker has a parent"))?;
    std::fs::write(marker, b"")
}

/// Removes the marker: a fresh switch asks again (best-effort).
pub fn clear_skip_marker(default_config: &Path) {
    let _ = std::fs::remove_file(skip_marker(default_config));
}

/// The location the user's data currently lives in, per the pointer's second
/// line: what a migration would move *from*.
pub fn previous_layout(resolved: &Resolved) -> Option<Layout> {
    let text = std::fs::read_to_string(pointer_file(&resolved.defaults.0)).ok()?;
    let (_, previous) = parse_pointer(&text);
    match previous {
        None => None,
        Some("default") => Some(Layout::Default),
        Some(path) => Some(Layout::Custom(expand_tilde(path, &resolved.home))),
    }
}

/// Where a new switch should record the data's home. A declined switch
/// leaves the pointer's previous line pointing at the data while the app
/// runs from a fresh, data-less target — the next switch must chain back to
/// that line, or the data would be stranded behind the declined offer. With
/// no live pending migration (nothing recorded, or the target already holds
/// every entry), the current location is the data's home.
pub fn data_home(resolved: &Resolved) -> Layout {
    previous_layout(resolved)
        .filter(|p| migration_pending(p, &resolved.layout, &resolved.defaults).is_some())
        .unwrap_or_else(|| resolved.layout.clone())
}

/// The two roots a layout writes: the config and data sides.
pub fn side_roots(layout: &Layout, defaults: &(PathBuf, PathBuf)) -> (PathBuf, PathBuf) {
    match layout {
        Layout::Default => (defaults.0.clone(), defaults.1.clone()),
        Layout::Custom(base) => (base.join("config"), base.join("system")),
    }
}

/// The two `agents` directories of a layout (the default layout splits the
/// entry kinds across its two roots exactly like a custom base does).
pub fn agents_dirs(layout: &Layout, defaults: &(PathBuf, PathBuf)) -> (PathBuf, PathBuf) {
    let (config, data) = side_roots(layout, defaults);
    (config.join("agents"), data.join("agents"))
}

/// Where one mapped entry lives in a layout.
pub fn entry_path(name: &str, target: &str, layout: &Layout, defaults: &(PathBuf, PathBuf)) -> PathBuf {
    match layout {
        Layout::Default => {
            // The default layout has no per-entry target column: the config
            // side is the four user-editable entries, everything else is data.
            if DEFAULT_CONFIG_SIDE.contains(&name) { defaults.0.join(name) } else { defaults.1.join(name) }
        }
        Layout::Custom(base) => base.join(target),
    }
}

/// Whether a layout already holds recognizable app data — a location the
/// migration dialog must not treat as replaceable.
pub fn layout_has_data(layout: &Layout, defaults: &(PathBuf, PathBuf)) -> bool {
    for &(name, target) in MOVES {
        if entry_path(name, target, layout, defaults).exists() {
            return true;
        }
    }
    let (config, data) = agents_dirs(layout, defaults);
    [config, data].iter().any(|d| std::fs::read_dir(d).is_ok_and(|mut e| e.next().is_some()))
}

/// Whether `base` is, contains, or nests inside a location the app already
/// uses — a migration into such a place would move a directory into itself,
/// and trashing it would take the defaults along.
pub fn base_conflicts(base: &Path, defaults: &(PathBuf, PathBuf), current: Option<&Path>) -> bool {
    let mut used = vec![defaults.0.clone(), defaults.1.clone()];
    if let Some(current) = current {
        used.push(current.to_path_buf());
    }
    let base = canonical(base);
    used.iter().any(|u| {
        let u = canonical(u);
        base.starts_with(&u) || u.starts_with(&base)
    })
}

/// Canonicalizes for comparison; a path that does not exist yet (a freshly
/// chosen base) is canonicalized through its parent so a symlinked ancestor
/// (macOS `/var` → `/private/var`) cannot make two names of one directory
/// look unrelated.
fn canonical(path: &Path) -> PathBuf {
    dunce::canonicalize(path).unwrap_or_else(|_| {
        path.parent()
            .and_then(|parent| dunce::canonicalize(parent).ok())
            .map(|parent| parent.join(path.file_name().unwrap_or_default()))
            .unwrap_or_else(|| path.to_path_buf())
    })
}

/// Outcome of a migration, for the dialog's result reporting.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Migration {
    pub moved: usize,
    pub failed: usize,
}

/// Moves the user's data from one location to another. Idempotent per entry:
/// a target that already exists is never touched, and a source that is
/// already gone needs nothing — a mapping entry added to [`MOVES`] by a
/// later release therefore migrates on the next start instead of being
/// stranded behind a flag.
///
/// `replace_existing` is for a target this very start found empty: the files
/// the boot wrote into it (a fresh settings.toml, an empty plugins dir) are
/// disposable and lose to the moved copies. A target with earlier content
/// keeps the skip rule — the user's newer data always wins.
///
/// No lock: two builds first-launching concurrently both rename; the loser
/// sees the source gone and counts it moved. Logs and the login-shell cache
/// are not migrated (both regenerate), and unknown files — the window-state
/// plugin's included — stay behind.
pub fn migrate(from: &Layout, to: &Layout, defaults: &(PathBuf, PathBuf), replace_existing: bool) -> Migration {
    let mut result = Migration::default();
    let (from_config, from_data) = side_roots(from, defaults);
    // macOS keeps the default config and data in one directory; scanning it
    // once is only an optimization — per-entry idempotency makes a second
    // scan of the same root harmless.
    let sources: Vec<PathBuf> = if from_config == from_data { vec![from_config] } else { vec![from_config, from_data] };
    if !sources.iter().any(|r| r.exists()) {
        return result;
    }
    for &(name, target) in MOVES {
        let src = entry_path(name, target, from, defaults);
        if src.exists() {
            move_entry(&src, &entry_path(name, target, to, defaults), &mut result, replace_existing);
        }
    }
    for root in &sources {
        let agents = root.join("agents");
        if agents.exists() {
            let (config, data) = agents_dirs(to, defaults);
            split_agents(&agents, &config, &data, &mut result, replace_existing);
        }
    }
    for &name in DROPS {
        // Rebuildable caches drop, not move — and only from the data side,
        // where the default layout keeps them (a custom base's `system/`).
        let _ = std::fs::remove_dir_all(side_roots(from, defaults).1.join(name));
    }
    result
}

/// `agents` holds two kinds of entry that move apart: agent definitions
/// (`*.toml`, from the config side) and per-project state (everything else,
/// from the data side) — split across the two sides in either layout.
fn split_agents(src: &Path, to_config: &Path, to_data: &Path, result: &mut Migration, replace_existing: bool) {
    let Ok(entries) = std::fs::read_dir(src) else {
        result.failed += 1;
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let side = if entry.path().extension().is_some_and(|e| e == "toml") { to_config } else { to_data };
        move_entry(&entry.path(), &side.join(&name), result, replace_existing);
    }
}

/// Moves one entry to its target, counting the outcome. A target that
/// already exists is left alone — content already in the target (an earlier
/// start's, or the user's own) always wins over the source copy.
fn move_entry(src: &Path, target: &Path, result: &mut Migration, replace_existing: bool) {
    move_entry_with(src, target, result, attempt_rename, replace_existing);
}

/// `attempt` is a parameter so tests can drive the cross-device fallback:
/// staging a second volume in a test environment is not possible.
fn move_entry_with(
    src: &Path,
    target: &Path,
    result: &mut Migration,
    attempt: fn(&Path, &Path) -> Attempt,
    replace_existing: bool,
) {
    if target.exists() {
        if !replace_existing {
            return;
        }
        // A target this boot created on an empty base: the moved copy wins.
        let _ = remove_any(target);
    }
    if let Some(parent) = target.parent()
        && std::fs::create_dir_all(parent).is_err()
    {
        result.failed += 1;
        return;
    }
    match attempt(src, target) {
        // The second arm is a concurrent first-launch having moved it first.
        Attempt::Moved | Attempt::Gone => result.moved += 1,
        // A base on another volume: rename cannot cross devices, so copy
        // and drop the source instead.
        Attempt::CrossesDevices => match copy_tree(src, target) {
            Ok(()) => {
                let _ = remove_any(src);
                result.moved += 1;
            }
            Err(_) => {
                // A half-copied target would block the next start's retry.
                let _ = remove_any(target);
                result.failed += 1;
            }
        },
        Attempt::Failed => result.failed += 1,
    }
}

/// What one rename attempt concluded.
enum Attempt {
    Moved,
    /// A NotFound with the source still in place would be a real failure, not a win.
    Gone,
    CrossesDevices,
    Failed,
}

fn attempt_rename(src: &Path, target: &Path) -> Attempt {
    match std::fs::rename(src, target) {
        Ok(()) => Attempt::Moved,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound && !src.exists() => Attempt::Gone,
        Err(e) if e.kind() == std::io::ErrorKind::CrossesDevices => Attempt::CrossesDevices,
        Err(_) => Attempt::Failed,
    }
}

/// How many entries a migration would still move: `None` when there is
/// nothing to ask about — no marker to honor, and every entry either already
/// moved or already superseded by content in the target.
pub fn migration_pending(from: &Layout, to: &Layout, defaults: &(PathBuf, PathBuf)) -> Option<usize> {
    if skip_marker(&defaults.0).exists() {
        return None;
    }
    let (from_config, from_data) = side_roots(from, defaults);
    let sources: Vec<PathBuf> = if from_config == from_data { vec![from_config] } else { vec![from_config, from_data] };
    if !sources.iter().any(|r| r.exists()) {
        return None;
    }
    let mut pending = 0usize;
    for &(name, target) in MOVES {
        if entry_path(name, target, from, defaults).exists() && !entry_path(name, target, to, defaults).exists() {
            pending += 1;
        }
    }
    for root in &sources {
        let agents = root.join("agents");
        if std::fs::read_dir(&agents).is_ok_and(|mut e| e.next().is_some()) {
            pending += 1;
        }
    }
    (pending > 0).then_some(pending)
}

/// Moves the previous location's directories to the OS trash after a full
/// migration — recoverable, unlike a delete, and the old state can be
/// restored from there if the user ever needs it back. A custom base is
/// trashed whole (its top level holds `tools/` beyond the two sides).
pub fn trash(layout: &Layout, defaults: &(PathBuf, PathBuf)) -> std::io::Result<()> {
    match layout {
        Layout::Custom(base) => {
            if base.exists() {
                trash::delete(base).map_err(|e| std::io::Error::other(e.to_string()))?;
            }
        }
        Layout::Default => {
            let (config, data) = side_roots(layout, defaults);
            for root in if config == data { vec![config] } else { vec![config, data] } {
                if root.exists() {
                    trash::delete(&root).map_err(|e| std::io::Error::other(e.to_string()))?;
                }
            }
        }
    }
    Ok(())
}

/// Rewrites references to the previous directories in the migrated settings
/// and in the recent projects' run/settings files: a downloaded JDK or a
/// custom tool configured by its old absolute path keeps working against the
/// new location. Longer (entry-specific) replacements run before the bare
/// roots.
pub fn rewrite(from: &Layout, to: &Layout, defaults: &(PathBuf, PathBuf)) -> std::io::Result<()> {
    let mut rules: Vec<(String, String)> = Vec::new();
    for &(name, target) in MOVES {
        rules.push((
            entry_path(name, target, from, defaults).to_string_lossy().into_owned(),
            entry_path(name, target, to, defaults).to_string_lossy().into_owned(),
        ));
    }
    let (from_cfg_a, from_sys_a) = agents_dirs(from, defaults);
    let (to_cfg_a, to_sys_a) = agents_dirs(to, defaults);
    rules.push((from_cfg_a.to_string_lossy().into_owned(), to_cfg_a.to_string_lossy().into_owned()));
    rules.push((from_sys_a.to_string_lossy().into_owned(), to_sys_a.to_string_lossy().into_owned()));
    let (from_cfg, from_data) = side_roots(from, defaults);
    let (to_cfg, to_data) = side_roots(to, defaults);
    rules.push((from_cfg.to_string_lossy().into_owned(), to_cfg.to_string_lossy().into_owned()));
    rules.push((from_data.to_string_lossy().into_owned(), to_data.to_string_lossy().into_owned()));
    rules.sort_by_key(|(from, _)| std::cmp::Reverse(from.len()));

    // The files rewritten live in the *target* layout: the global settings,
    // plus the recent projects' run configurations and settings, which may
    // name tools by their old absolute path.
    let mut files = vec![side_roots(to, defaults).0.join("settings.toml")];
    if let Ok(recent) = std::fs::read_to_string(side_roots(to, defaults).0.join("recent.json"))
        && let Ok(projects) = serde_json::from_str::<Vec<serde_json::Value>>(&recent)
    {
        for project in projects {
            if let Some(path) = project["path"].as_str() {
                for name in ["run.toml", "settings.toml"] {
                    files.push(std::path::Path::new(path).join(".openidea").join(name));
                }
            }
        }
    }
    for file in files {
        let Ok(text) = std::fs::read_to_string(&file) else { continue };
        let mut rewritten = text.clone();
        for (from, to) in &rules {
            rewritten = rewritten.replace(from, to);
        }
        if rewritten != text {
            std::fs::write(&file, rewritten)?;
        }
    }
    Ok(())
}

/// Copies a file or a whole directory tree — the cross-device fallback for
/// [`std::fs::rename`], which cannot leave the volume it is on.
pub(crate) fn copy_tree(src: &Path, target: &Path) -> std::io::Result<()> {
    if src.is_dir() {
        std::fs::create_dir_all(target)?;
        for entry in std::fs::read_dir(src)? {
            let entry = entry?;
            copy_tree(&entry.path(), &target.join(entry.file_name()))?;
        }
        Ok(())
    } else {
        std::fs::copy(src, target).map(|_| ())
    }
}

/// Removes a file or a directory tree, best-effort.
fn remove_any(path: &Path) -> std::io::Result<()> {
    if path.is_dir() { std::fs::remove_dir_all(path) } else { std::fs::remove_file(path) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    /// Writes `root/rel` (a file) creating parent directories on the way.
    fn file(root: &Path, rel: &str) -> PathBuf {
        let path = root.join(rel);
        fs::create_dir_all(path.parent().expect("file has a parent")).unwrap();
        fs::write(&path, rel).unwrap();
        path
    }

    /// Creates `root/rel` (a directory) with one file inside, so a rename
    /// moves content, not just an empty shell.
    fn folder(root: &Path, rel: &str) -> PathBuf {
        let path = root.join(rel);
        fs::create_dir_all(&path).unwrap();
        file(&path, "keep");
        path
    }

    /// A Default-layout fixture: every MOVES entry planted where the default
    /// layout puts it (config side for `DEFAULT_CONFIG_SIDE`, data side for
    /// the rest), plus the agents split, the dropped caches and the files
    /// that must stay behind. Growing MOVES grows the fixture — no count to
    /// keep in step by hand.
    fn default_fixture(tmp: &TempDir) -> (PathBuf, PathBuf) {
        let config = tmp.path().join("default-config");
        let data = tmp.path().join("default-data");
        fs::create_dir_all(&config).unwrap();
        fs::create_dir_all(&data).unwrap();
        for &(name, target) in MOVES {
            let root = if DEFAULT_CONFIG_SIDE.contains(&name) { &config } else { &data };
            if target.contains('.') {
                file(root, name);
            } else {
                folder(root, name);
            }
        }
        file(&config, "agents/my-agent.toml");
        file(&data, "agents/models.json");
        folder(&data, "agents/proj1");
        folder(&data, "agents/tools");
        for name in DROPS {
            folder(&data, name);
        }
        file(&config, ".window-state.json");
        file(&data, "stray.txt");
        (config, data)
    }

    /// A Custom-layout fixture: the same MOVES entries under a base.
    fn custom_fixture(tmp: &TempDir) -> PathBuf {
        let base = tmp.path().join("custom-base");
        fs::create_dir_all(&base).unwrap();
        for &(_, target) in MOVES {
            if target.contains('.') {
                file(&base, target);
            } else {
                folder(&base, target);
            }
        }
        file(&base, "config/agents/my-agent.toml");
        file(&base, "system/agents/models.json");
        folder(&base, "system/agents/proj1");
        folder(&base, "system/agents/tools");
        for name in DROPS {
            folder(&base, &format!("system/{name}"));
        }
        base
    }

    fn defaults_of(config: &Path, data: &Path) -> (PathBuf, PathBuf) {
        (config.to_path_buf(), data.to_path_buf())
    }

    #[test]
    fn env_wins_over_pointer_and_default() {
        let defaults = defaults_of(Path::new("/c"), Path::new("/d"));
        let (layout, _) = resolve(Some("/custom"), Some("/pointer"), &defaults, Path::new("/h"));
        assert_eq!(layout, Layout::Custom(PathBuf::from("/custom")));
    }

    #[test]
    fn env_tilde_expands() {
        let defaults = defaults_of(Path::new("/c"), Path::new("/d"));
        let (layout, _) = resolve(Some("~/env"), None, &defaults, Path::new("/h"));
        assert_eq!(layout, Layout::Custom(PathBuf::from("/h/env")));
    }

    #[test]
    fn empty_or_relative_env_falls_through_to_the_pointer() {
        let tmp = TempDir::new().unwrap();
        let home = tmp.path().join("home");
        let target = home.join("p");
        fs::create_dir_all(&target).unwrap();
        let defaults = defaults_of(Path::new("/c"), Path::new("/d"));
        // An empty or relative env value is not a choice: the pointer decides.
        let (layout, _) = resolve(Some(""), Some("~/p"), &defaults, &home);
        assert_eq!(layout, Layout::Custom(target));
        let (layout, _) = resolve(Some("relative"), Some("~/p"), &defaults, &home);
        assert_eq!(layout, Layout::Custom(home.join("p")));
    }

    #[test]
    fn pointer_used_when_it_points_at_a_directory() {
        let tmp = TempDir::new().unwrap();
        let home = tmp.path().join("home");
        let target = home.join("moved-base");
        fs::create_dir_all(&target).unwrap();
        let defaults = defaults_of(Path::new("/c"), Path::new("/d"));
        // `~` expands and stray whitespace (a hand-edited file) is trimmed.
        let (layout, _) = resolve(None, Some("~/moved-base \n"), &defaults, &home);
        assert_eq!(layout, Layout::Custom(target));
    }

    #[test]
    fn pointer_sentinel_default_restores_the_platform_dirs() {
        let defaults = defaults_of(Path::new("/c"), Path::new("/d"));
        let (layout, locations) = resolve(None, Some("default\n/old-base"), &defaults, Path::new("/h"));
        assert_eq!(layout, Layout::Default);
        assert_eq!(locations, Locations { config: PathBuf::from("/c"), data: PathBuf::from("/d") });
    }

    #[test]
    fn dangling_or_relative_pointer_falls_back_to_the_default() {
        let defaults = defaults_of(Path::new("/c"), Path::new("/d"));
        assert_eq!(resolve(None, Some("/missing"), &defaults, Path::new("/h")).0, Layout::Default);
        assert_eq!(resolve(None, Some("relative"), &defaults, Path::new("/h")).0, Layout::Default);
    }

    #[test]
    fn default_is_the_passed_directories() {
        let defaults = defaults_of(Path::new("/c"), Path::new("/d"));
        let (layout, locations) = resolve(None, None, &defaults, Path::new("/h"));
        assert_eq!(layout, Layout::Default);
        assert_eq!(locations, Locations { config: PathBuf::from("/c"), data: PathBuf::from("/d") });
    }

    #[test]
    fn custom_base_splits_config_and_system() {
        let defaults = defaults_of(Path::new("/c"), Path::new("/d"));
        let (layout, locations) = resolve(Some("/b"), None, &defaults, Path::new("/h"));
        assert_eq!(layout, Layout::Custom(PathBuf::from("/b")));
        assert_eq!(locations, Locations { config: PathBuf::from("/b/config"), data: PathBuf::from("/b/system") });
    }

    #[test]
    fn custom_base_routes_every_consumer_off_the_platform_dirs() {
        // The switch guarantee: after the user chooses a base, nothing reads
        // the platform dirs — every consumer root hangs off the base.
        let defaults = defaults_of(Path::new("/platform-config"), Path::new("/platform-data"));
        let (layout, locations) = resolve(Some("/base"), None, &defaults, Path::new("/h"));
        assert_eq!(locations.config, PathBuf::from("/base/config"));
        assert_eq!(locations.data, PathBuf::from("/base/system"));
        assert_eq!(plugins_dir(&layout, &locations), PathBuf::from("/base/config"));
        assert_eq!(log_dir(&layout, "id"), Some(PathBuf::from("/base/log")));
        assert_eq!(login_cache_root(&layout, &locations, "id"), PathBuf::from("/base/system"));
        assert_eq!(tools_home(&layout, "id"), Some(PathBuf::from("/base")));
    }

    #[test]
    fn default_layout_keeps_the_platform_dirs() {
        // Without a switch, every consumer keeps the platform locations.
        // `tools_home`, the log dir and the login cache read `dirs::` on the
        // real machine, so only their identifier suffix is pinned here.
        let defaults = defaults_of(Path::new("/platform-config"), Path::new("/platform-data"));
        let (layout, locations) = resolve(None, None, &defaults, Path::new("/h"));
        assert_eq!(locations.config, PathBuf::from("/platform-config"));
        assert_eq!(locations.data, PathBuf::from("/platform-data"));
        assert_eq!(plugins_dir(&layout, &locations), PathBuf::from("/platform-data"));
        assert!(tools_home(&layout, "id").is_some_and(|d| d.ends_with("id")));
        assert!(login_cache_root(&layout, &locations, "id").ends_with("id"));
        assert!(log_dir(&layout, "id").is_some_and(|d| d.ends_with("id")));
    }

    #[test]
    fn entries_split_config_and_data_in_the_default_layout() {
        let defaults = defaults_of(Path::new("/c"), Path::new("/d"));
        let layout = Layout::Default;
        assert_eq!(
            entry_path("settings.toml", "config/settings.toml", &layout, &defaults),
            PathBuf::from("/c/settings.toml")
        );
        assert_eq!(entry_path("plugins", "config/plugins", &layout, &defaults), PathBuf::from("/d/plugins"));
        assert_eq!(entry_path("tools", "tools", &layout, &defaults), PathBuf::from("/d/tools"));
        let layout = Layout::Custom(PathBuf::from("/b"));
        assert_eq!(entry_path("plugins", "config/plugins", &layout, &defaults), PathBuf::from("/b/config/plugins"));
    }

    #[test]
    fn migration_moves_the_full_mapping_default_to_custom() {
        let tmp = TempDir::new().unwrap();
        let (config, data) = default_fixture(&tmp);
        let defaults = defaults_of(&config, &data);
        let from = Layout::Default;
        let to = Layout::Custom(tmp.path().join("base"));
        fs::create_dir_all(tmp.path().join("base")).unwrap();

        let result = migrate(&from, &to, &defaults, false);

        assert_eq!(result.failed, 0, "nothing may fail on a clean legacy tree");
        // Every mapped entry plus the four `agents/` entries moved, exactly
        // once each: the count derives from the tables, not from a hand-kept
        // number that would rot when the mapping grows.
        assert_eq!(result.moved, MOVES.len() + 4);
        let base = tmp.path().join("base");
        for &(name, target) in MOVES {
            let landed = if target.contains('.') {
                base.join(target).is_file()
            } else {
                base.join(target).join("keep").is_file()
            };
            assert!(landed, "{target} did not arrive with its content");
            assert!(!config.join(name).exists() && !data.join(name).exists(), "{name} still sits in the default tree");
        }
        assert!(base.join("config/agents/my-agent.toml").is_file());
        assert!(base.join("system/agents/models.json").is_file());
        assert!(base.join("system/agents/proj1/keep").is_file());
        assert!(base.join("system/agents/tools/keep").is_file());
        // Rebuildable caches are dropped, unknown and plugin files stay.
        for name in DROPS {
            assert!(!data.join(name).exists(), "{name} must be dropped");
        }
        assert!(config.join(".window-state.json").is_file());
        assert!(data.join("stray.txt").is_file());
    }

    #[test]
    fn migration_moves_the_full_mapping_custom_to_default() {
        let tmp = TempDir::new().unwrap();
        let base = custom_fixture(&tmp);
        let config = tmp.path().join("default-config");
        let data = tmp.path().join("default-data");
        fs::create_dir_all(&config).unwrap();
        fs::create_dir_all(&data).unwrap();
        let defaults = defaults_of(&config, &data);
        let from = Layout::Custom(base.clone());
        let to = Layout::Default;

        let result = migrate(&from, &to, &defaults, false);

        assert_eq!(result.failed, 0);
        assert_eq!(result.moved, MOVES.len() + 4);
        for &(name, target) in MOVES {
            let root = if DEFAULT_CONFIG_SIDE.contains(&name) { &config } else { &data };
            let landed =
                if target.contains('.') { root.join(name).is_file() } else { root.join(name).join("keep").is_file() };
            assert!(landed, "{name} did not arrive with its content");
            assert!(!base.join(target).exists(), "{target} still sits in the custom base");
        }
        assert!(config.join("agents/my-agent.toml").is_file());
        assert!(data.join("agents/models.json").is_file());
        for name in DROPS {
            assert!(!base.join("system").join(name).exists(), "{name} must be dropped");
        }
    }

    #[test]
    fn migration_moves_a_custom_base_to_another() {
        let tmp = TempDir::new().unwrap();
        let from_base = custom_fixture(&tmp);
        let to_base = tmp.path().join("other-base");
        fs::create_dir_all(&to_base).unwrap();
        let defaults = defaults_of(Path::new("/c"), Path::new("/d"));
        let from = Layout::Custom(from_base);
        let to = Layout::Custom(to_base.clone());

        let result = migrate(&from, &to, &defaults, false);

        assert_eq!(result.failed, 0);
        assert_eq!(result.moved, MOVES.len() + 4);
        assert!(to_base.join("tools/keep").is_file());
        assert!(to_base.join("config/settings.toml").is_file());
    }

    #[test]
    fn migration_reruns_are_noops() {
        let tmp = TempDir::new().unwrap();
        let (config, data) = default_fixture(&tmp);
        let defaults = defaults_of(&config, &data);
        let from = Layout::Default;
        let to = Layout::Custom(tmp.path().join("base"));
        fs::create_dir_all(tmp.path().join("base")).unwrap();
        let first = migrate(&from, &to, &defaults, false);
        assert!(first.moved > 0);

        // Every source is gone and every target exists: a second start, and
        // every start after it, moves nothing and fails nothing.
        let second = migrate(&from, &to, &defaults, false);
        assert_eq!(second, Migration::default());
    }

    #[test]
    fn migration_picks_up_entries_added_after_the_first_run() {
        // The incremental case: a later release adds a mapping entry whose
        // source still sits in the previous tree (an old install kept
        // running, or the entry was simply missed — as `language-server-
        // runtimes` once was). The next start must move it, not strand it
        // behind a flag.
        let tmp = TempDir::new().unwrap();
        let config = tmp.path().join("default-config");
        let data = tmp.path().join("default-data");
        fs::create_dir_all(&config).unwrap();
        fs::create_dir_all(&data).unwrap();
        file(&config, "settings.toml");
        let defaults = defaults_of(&config, &data);
        let from = Layout::Default;
        let to = Layout::Custom(tmp.path().join("base"));
        fs::create_dir_all(tmp.path().join("base")).unwrap();

        let first = migrate(&from, &to, &defaults, false);
        assert_eq!(first, Migration { moved: 1, failed: 0 });

        folder(&data, "language-server-runtimes");
        let second = migrate(&from, &to, &defaults, false);
        assert_eq!(second, Migration { moved: 1, failed: 0 });
        assert!(tmp.path().join("base/language-server-runtimes/keep").is_file());
    }

    #[test]
    fn migration_never_overwrites_target_content() {
        let tmp = TempDir::new().unwrap();
        let config = tmp.path().join("default-config");
        fs::create_dir_all(&config).unwrap();
        file(&config, "settings.toml");
        let defaults = defaults_of(&config, &tmp.path().join("default-data"));
        let from = Layout::Default;
        let to = Layout::Custom(tmp.path().join("base"));
        fs::create_dir_all(tmp.path().join("base")).unwrap();
        // The user already put their own settings in the target: the source
        // copy stays behind instead of clobbering them, counted as neither
        // moved nor failed.
        file(&tmp.path().join("base"), "config/settings.toml");

        let result = migrate(&from, &to, &defaults, false);

        assert_eq!(result, Migration::default());
        assert_eq!(fs::read_to_string(tmp.path().join("base/config/settings.toml")).unwrap(), "config/settings.toml");
        assert_eq!(fs::read_to_string(config.join("settings.toml")).unwrap(), "settings.toml");
    }

    #[test]
    fn a_fresh_target_is_replaced_by_the_moved_copy() {
        // The boot of an empty target wrote a fresh settings file; the user
        // then chose to migrate: the moved copy wins over the boot's.
        let tmp = TempDir::new().unwrap();
        let config = tmp.path().join("default-config");
        fs::create_dir_all(&config).unwrap();
        file(&config, "settings.toml");
        let defaults = defaults_of(&config, &tmp.path().join("default-data"));
        let from = Layout::Default;
        let to = Layout::Custom(tmp.path().join("base"));
        fs::create_dir_all(tmp.path().join("base/config")).unwrap();
        file(&tmp.path().join("base"), "config/settings.toml");

        let result = migrate(&from, &to, &defaults, true);

        assert_eq!(result, Migration { moved: 1, failed: 0 });
        assert_eq!(fs::read_to_string(tmp.path().join("base/config/settings.toml")).unwrap(), "settings.toml");
    }

    #[test]
    fn migration_without_source_directories_creates_nothing() {
        let tmp = TempDir::new().unwrap();
        let defaults = defaults_of(&tmp.path().join("no-config"), &tmp.path().join("no-data"));
        let to = Layout::Custom(tmp.path().join("base"));
        let result = migrate(&Layout::Default, &to, &defaults, false);
        assert_eq!(result, Migration::default());
        assert!(!tmp.path().join("base/config").exists());
    }

    #[test]
    fn migration_scans_a_shared_source_dir_once() {
        // macOS shape: one directory holding both kinds of file.
        let tmp = TempDir::new().unwrap();
        let shared = tmp.path().join("default-config");
        fs::create_dir_all(&shared).unwrap();
        file(&shared, "settings.toml");
        folder(&shared, "tools");
        file(&shared, "agents/a.toml");
        file(&shared, "agents/models.json");
        let defaults = defaults_of(&shared, &shared);
        let from = Layout::Default;
        let to = Layout::Custom(tmp.path().join("base"));
        fs::create_dir_all(tmp.path().join("base")).unwrap();
        // A file already squatting on the `tools` target: skipped, not
        // clobbered, not a failure.
        file(&tmp.path().join("base"), "tools");

        let result = migrate(&from, &to, &defaults, false);

        assert_eq!(result, Migration { moved: 3, failed: 0 });
        assert!(tmp.path().join("base/config/settings.toml").is_file());
        assert!(tmp.path().join("base/config/agents/a.toml").is_file());
        assert!(tmp.path().join("base/system/agents/models.json").is_file());
        assert!(shared.join("tools/keep").is_file(), "the skipped move stays behind");
    }

    #[test]
    fn migration_counts_failures_and_continues() {
        let tmp = TempDir::new().unwrap();
        let config = tmp.path().join("default-config");
        let data = tmp.path().join("default-data");
        fs::create_dir_all(&config).unwrap();
        fs::create_dir_all(&data).unwrap();
        file(&config, "settings.toml");
        folder(&data, "remote");
        let defaults = defaults_of(&config, &data);
        let from = Layout::Default;
        let to = Layout::Custom(tmp.path().join("base"));
        fs::create_dir_all(tmp.path().join("base")).unwrap();
        // A file where `system/` should be: that entry's parent cannot be
        // created, its move fails, and the rest of the mapping still moves.
        file(&tmp.path().join("base"), "system");

        let result = migrate(&from, &to, &defaults, false);

        assert_eq!(result, Migration { moved: 1, failed: 1 });
        assert!(tmp.path().join("base/config/settings.toml").is_file());
        assert!(data.join("remote/keep").is_file(), "the failed move stays behind");
    }

    #[test]
    fn copy_tree_copies_files_and_whole_trees() {
        // The cross-device fallback of `move_entry`: rename across volumes
        // cannot be staged in a test, its helper is covered directly instead.
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("src");
        folder(&src, "nested/deeper");
        file(&src, "top");

        let target = tmp.path().join("dst");
        copy_tree(&src, &target).unwrap();

        assert!(target.join("top").is_file());
        assert!(target.join("nested/deeper/keep").is_file());
        assert!(src.join("top").is_file(), "the caller removes the source, not the copy");
    }

    #[test]
    fn a_cross_device_rename_falls_back_to_copy() {
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("old");
        folder(&src, "jdks");
        let target = tmp.path().join("new").join("tools");
        let mut result = Migration::default();

        move_entry_with(&src, &target, &mut result, |_, _| Attempt::CrossesDevices, false);

        assert_eq!(result, Migration { moved: 1, failed: 0 });
        assert!(target.join("jdks/keep").is_file());
        assert!(!src.exists(), "the source is dropped once the copy is in place");
    }

    #[cfg(unix)]
    #[test]
    fn a_failed_cross_device_copy_leaves_no_half_target() {
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("old");
        fs::create_dir_all(&src).unwrap();
        // A dangling symlink inside: the tree copy fails part-way, after the
        // target directory has been created.
        std::os::unix::fs::symlink("nowhere", src.join("dangling")).unwrap();
        let target = tmp.path().join("new").join("tools");
        let mut result = Migration::default();

        move_entry_with(&src, &target, &mut result, |_, _| Attempt::CrossesDevices, false);

        assert_eq!(result, Migration { moved: 0, failed: 1 });
        assert!(!target.exists(), "the half-copied target is removed so the next start retries");
        assert!(src.is_dir(), "the source stays for the retry");
    }

    #[test]
    fn a_written_pointer_is_resolved_on_the_next_start() {
        let tmp = TempDir::new().unwrap();
        let default_config = tmp.path().join("default-config");
        let target = tmp.path().join("moved-base");
        fs::create_dir_all(&target).unwrap();

        write_pointer(&default_config, &Layout::Custom(target.clone()), None).unwrap();

        let recorded = fs::read_to_string(pointer_file(&default_config)).unwrap();
        assert_eq!(recorded, target.to_string_lossy());
        let defaults = defaults_of(&default_config, &tmp.path().join("default-data"));
        let (layout, _) = resolve(None, Some(&recorded), &defaults, &tmp.path().join("home"));
        assert_eq!(layout, Layout::Custom(target));
    }

    #[test]
    fn previous_layout_reads_the_pointers_second_line() {
        let tmp = TempDir::new().unwrap();
        let default_config = tmp.path().join("default-config");
        let defaults = defaults_of(&default_config, &tmp.path().join("default-data"));
        let home = tmp.path().join("home");
        let resolved = Resolved {
            layout: Layout::Custom(tmp.path().join("new-base")),
            locations: Locations { config: PathBuf::new(), data: PathBuf::new() },
            defaults: defaults.clone(),
            home: home.clone(),
        };

        // No pointer yet: nothing to migrate from.
        assert_eq!(previous_layout(&resolved), None);

        write_pointer(&default_config, &Layout::Custom(tmp.path().join("new-base")), Some(&Layout::Default)).unwrap();
        assert_eq!(previous_layout(&resolved), Some(Layout::Default));

        let old = tmp.path().join("old-base");
        write_pointer(&default_config, &Layout::Default, Some(&Layout::Custom(old.clone()))).unwrap();
        assert_eq!(previous_layout(&resolved), Some(Layout::Custom(old)));

        write_pointer(&default_config, &Layout::Default, None).unwrap();
        assert_eq!(previous_layout(&resolved), None);
    }

    #[test]
    fn data_home_chains_to_where_the_data_lives() {
        // The declined switch: the app runs from the fresh target X while the
        // data stayed in P — a new switch must chain to P, not record X.
        let tmp = TempDir::new().unwrap();
        let default_config = tmp.path().join("default-config");
        let defaults = defaults_of(&default_config, &tmp.path().join("default-data"));
        let p = tmp.path().join("p-base");
        fs::create_dir_all(p.join("config")).unwrap();
        file(&p, "config/settings.toml");
        let x = tmp.path().join("x-base");
        fs::create_dir_all(&x).unwrap();
        let resolved = Resolved {
            layout: Layout::Custom(x.clone()),
            locations: Locations { config: x.join("config"), data: x.join("system") },
            defaults: defaults.clone(),
            home: tmp.path().join("home"),
        };

        write_pointer(&default_config, &Layout::Custom(x.clone()), Some(&Layout::Custom(p.clone()))).unwrap();
        assert_eq!(data_home(&resolved), Layout::Custom(p));

        // Once X holds the entries too, P is superseded: the current
        // location is the data's home even with the line still recorded.
        file(&x, "config/settings.toml");
        assert_eq!(data_home(&resolved), Layout::Custom(x.clone()));

        // After a completed migration the pointer drops the previous line:
        // the current location, again.
        fs::remove_file(x.join("config/settings.toml")).unwrap();
        write_pointer(&default_config, &Layout::Custom(x.clone()), None).unwrap();
        assert_eq!(data_home(&resolved), Layout::Custom(x));
    }

    #[test]
    fn pending_counts_only_entries_still_worth_moving() {
        let tmp = TempDir::new().unwrap();
        let config = tmp.path().join("default-config");
        fs::create_dir_all(&config).unwrap();
        file(&config, "settings.toml");
        let data = tmp.path().join("default-data");
        fs::create_dir_all(&data).unwrap();
        folder(&data, "tools");
        let defaults = defaults_of(&config, &data);
        let from = Layout::Default;
        let to = Layout::Custom(tmp.path().join("base"));
        fs::create_dir_all(tmp.path().join("base")).unwrap();

        // Two movable entries, one already moved, one already superseded.
        fs::create_dir_all(tmp.path().join("base/tools")).unwrap();
        file(&tmp.path().join("base"), "config/recent.json");
        let pending = migration_pending(&from, &to, &defaults);
        assert_eq!(pending, Some(1));

        // "Don't ask again" hides the prompt for good — until the next switch.
        write_skip_marker(&config).unwrap();
        assert_eq!(migration_pending(&from, &to, &defaults), None);
        clear_skip_marker(&config);
        assert_eq!(migration_pending(&from, &to, &defaults), Some(1));
    }

    #[test]
    fn pending_reports_nothing_when_the_source_is_gone() {
        let tmp = TempDir::new().unwrap();
        let defaults = defaults_of(&tmp.path().join("no-config"), &tmp.path().join("no-data"));
        assert_eq!(migration_pending(&Layout::Default, &Layout::Custom(tmp.path().join("base")), &defaults), None);
    }

    #[test]
    fn rewriting_paths_moves_old_references_to_the_new_home() {
        let tmp = TempDir::new().unwrap();
        let config = tmp.path().join("default-config");
        let data = tmp.path().join("default-data");
        fs::create_dir_all(&config).unwrap();
        fs::create_dir_all(&data).unwrap();
        let defaults = defaults_of(&config, &data);
        let base = tmp.path().join("base");
        fs::create_dir_all(base.join("config")).unwrap();
        // The migrated settings name a downloaded JDK by its old path; a
        // recent project's run configuration names a managed tool.
        let jdk = format!("jdk = \"{}/tools/jdks/temurin-25\"", data.display());
        fs::write(base.join("config/settings.toml"), &jdk).unwrap();
        let project = tmp.path().join("project");
        fs::create_dir_all(project.join(".openidea")).unwrap();
        let cmd = format!("command = \"{}/tools/node_modules/.bin/vtsls\"", data.display());
        fs::write(project.join(".openidea/run.toml"), &cmd).unwrap();
        fs::write(base.join("config/recent.json"), format!("[{{\"path\": \"{}\"}}]", project.display())).unwrap();

        rewrite(&Layout::Default, &Layout::Custom(base.clone()), &defaults).unwrap();

        let settings = fs::read_to_string(base.join("config/settings.toml")).unwrap();
        assert_eq!(settings, format!("jdk = \"{}/tools/jdks/temurin-25\"", base.display()));
        let run = fs::read_to_string(project.join(".openidea/run.toml")).unwrap();
        assert_eq!(run, format!("command = \"{}/tools/node_modules/.bin/vtsls\"", base.display()));
    }

    #[test]
    fn rewriting_paths_works_back_to_the_defaults() {
        let tmp = TempDir::new().unwrap();
        let base = tmp.path().join("old-base");
        fs::create_dir_all(base.join("config")).unwrap();
        let config = tmp.path().join("default-config");
        let data = tmp.path().join("default-data");
        fs::create_dir_all(&config).unwrap();
        fs::create_dir_all(&data).unwrap();
        let defaults = defaults_of(&config, &data);
        let jdk = format!("jdk = \"{}/tools/jdks/temurin-25\"", base.display());
        fs::write(config.join("settings.toml"), &jdk).unwrap();

        rewrite(&Layout::Custom(base.clone()), &Layout::Default, &defaults).unwrap();

        let settings = fs::read_to_string(config.join("settings.toml")).unwrap();
        assert_eq!(settings, format!("jdk = \"{}/tools/jdks/temurin-25\"", data.display()));
    }

    #[test]
    fn base_conflicts_rejects_nested_and_containing_bases() {
        let tmp = TempDir::new().unwrap();
        let config = tmp.path().join("default-config");
        let data = tmp.path().join("default-data");
        fs::create_dir_all(&config).unwrap();
        fs::create_dir_all(&data).unwrap();
        let defaults = defaults_of(&config, &data);
        let current = tmp.path().join("current-base");
        fs::create_dir_all(&current).unwrap();

        // Inside or containing the defaults, or the current base: rejected.
        assert!(base_conflicts(&config.join("nested"), &defaults, Some(&current)));
        assert!(base_conflicts(tmp.path(), &defaults, Some(&current)));
        assert!(base_conflicts(&current.join("nested"), &defaults, Some(&current)));
        // A fresh sibling directory: fine.
        let elsewhere = tmp.path().join("elsewhere");
        fs::create_dir_all(&elsewhere).unwrap();
        assert!(!base_conflicts(&elsewhere, &defaults, Some(&current)));
    }

    #[test]
    fn layout_has_data_sees_mapped_entries_only() {
        let tmp = TempDir::new().unwrap();
        let config = tmp.path().join("default-config");
        let data = tmp.path().join("default-data");
        fs::create_dir_all(&config).unwrap();
        fs::create_dir_all(&data).unwrap();
        let defaults = defaults_of(&config, &data);
        assert!(!layout_has_data(&Layout::Default, &defaults));
        file(&config, "settings.toml");
        assert!(layout_has_data(&Layout::Default, &defaults));
    }
}
