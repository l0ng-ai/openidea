//! The unified home: configuration, system data, logs and managed tools under
//! one base directory (`~/.openidea` by default), shared by every build — the
//! installed app and each dev worktree alike, so a language server installed
//! once is found by all of them.
//!
//! Resolution order: the `OPENIDEA_HOME` environment variable, else the path
//! recorded in `~/.openidea/home.txt` (written by Settings › System Settings),
//! else `~/.openidea` itself. The pointer file keeps its fixed default
//! location so a moved base can always be found back. The result is fixed for
//! the process; changing it needs a restart.

use serde::Serialize;
use specta::Type;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

static BASE: OnceLock<PathBuf> = OnceLock::new();

/// The installed app's identifier: whose old directories a previous
/// installation's files live in. Keep in sync with `tauri.conf.json`.
pub const RELEASE_IDENTIFIER: &str = "ai.l0ng.openidea";

/// The previous installation's directories: Tauri's `app_config_dir` /
/// `app_data_dir` of the release identifier. A dev build migrates these too
/// (the installed app's language servers live there, and `app.path()` in a
/// dev build would name the worktree's own directory instead); dev
/// worktrees' own per-identifier directories are abandoned, not merged.
pub fn legacy_dirs() -> Option<(PathBuf, PathBuf)> {
    let config = dirs::config_dir().map(|d| d.join(RELEASE_IDENTIFIER))?;
    let data = dirs::data_dir().map(|d| d.join(RELEASE_IDENTIFIER))?;
    Some((config, data))
}

/// The base directory every build shares (see the module docs).
pub fn base() -> PathBuf {
    BASE.get_or_init(|| {
        let home = dirs::home_dir().unwrap_or_else(|| dirs::data_dir().unwrap_or_default());
        let pointer = std::fs::read_to_string(home.join(".openidea").join("home.txt")).ok();
        resolve(std::env::var("OPENIDEA_HOME").ok().as_deref(), pointer.as_deref(), &home)
    })
    .clone()
}

/// The layout under a base: user-editable files in `config`, rebuildable and
/// secret state in `system`, rotated files in `log`. Managed tools stay at
/// the top level (`tools/`, `language-server-runtimes/`) because the
/// ide-tools functions join their own subdirectories onto the base.
pub fn config_dir(base: &Path) -> PathBuf {
    base.join("config")
}

pub fn system_dir(base: &Path) -> PathBuf {
    base.join("system")
}

pub fn log_dir(base: &Path) -> PathBuf {
    base.join("log")
}

/// Resolution core with explicit inputs (testable without touching the
/// process environment): environment → pointer → default. A chosen path must
/// be absolute; a relative one would silently depend on the launch directory,
/// and a dangling pointer means the user removed the target — both fall
/// through to the next source.
fn resolve(env: Option<&str>, pointer: Option<&str>, home: &Path) -> PathBuf {
    if let Some(chosen) = env.map(|e| expand_tilde(e, home)).filter(|p| p.is_absolute()) {
        return chosen;
    }
    if let Some(chosen) = pointer.map(|p| expand_tilde(p, home)).filter(|p| p.is_absolute() && p.is_dir()) {
        return chosen;
    }
    home.join(".openidea")
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

/// Legacy entry → its place under the new base. The sources are the old Tauri
/// `app_config_dir` / `app_data_dir` (the same directory on macOS), and every
/// name is looked up in both: which side a file sat on differs per platform.
///
/// Adding an entry is safe on an already-migrated machine: the entry's source
/// is only read in the old directories, which a migrated machine no longer
/// writes to. The mapping is pinned by `migration_moves_the_full_mapping`.
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

/// Rebuildable caches: dropped, not moved (`index` and `cache` regenerate).
const DROPS: &[&str] = &["index", "cache"];

/// Outcome of a legacy migration, for the dialog's result reporting.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Migration {
    pub moved: usize,
    pub failed: usize,
}

/// Moves an old installation's files into `base`. Idempotent per entry: a
/// target that already exists is never touched, and a source that is already
/// gone needs nothing — a mapping entry added to [`MOVES`] by a later release
/// therefore migrates on the next start instead of being stranded behind a
/// flag.
///
/// `replace_existing` is for a base this very start created empty: the files
/// the boot wrote into it (a fresh settings.toml, an empty plugins dir) are
/// disposable and lose to the legacy copies. A base with earlier content
/// keeps the skip rule — the user's newer data always wins.
///
/// No lock: two builds first-launching concurrently both rename; the loser
/// sees the source gone and counts it moved. Logs and the login-shell cache
/// are not migrated (both regenerate), and unknown files — the window-state
/// plugin's included — stay behind.
pub fn migrate_legacy(base: &Path, legacy_config: &Path, legacy_data: &Path, replace_existing: bool) -> Migration {
    let mut result = Migration::default();
    // macOS keeps the old config and data in one directory; scanning it once
    // is only an optimization — per-entry idempotency makes a second scan of
    // the same root harmless.
    let roots: Vec<&Path> =
        if legacy_config == legacy_data { vec![legacy_config] } else { vec![legacy_config, legacy_data] };
    if !roots.iter().any(|r| r.exists()) {
        return result;
    }
    for &(name, target) in MOVES {
        for &root in &roots {
            let src = root.join(name);
            if src.exists() {
                move_entry(&src, &base.join(target), &mut result, replace_existing);
            }
        }
    }
    for &root in &roots {
        let agents = root.join("agents");
        if agents.exists() {
            split_agents(&agents, base, &mut result, replace_existing);
        }
    }
    for &name in DROPS {
        for &root in &roots {
            let _ = std::fs::remove_dir_all(root.join(name));
        }
    }
    result
}

/// `agents` holds two kinds of entry that move apart: agent definitions
/// (`*.toml`, from the old config side) and per-project state (everything
/// else, from the old data side) — one directory on macOS, two elsewhere.
fn split_agents(src: &Path, base: &Path, result: &mut Migration, replace_existing: bool) {
    let Ok(entries) = std::fs::read_dir(src) else {
        result.failed += 1;
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let side =
            if entry.path().extension().is_some_and(|e| e == "toml") { "config/agents" } else { "system/agents" };
        move_entry(&entry.path(), &base.join(side).join(&name), result, replace_existing);
    }
}

/// Moves one legacy entry to its target, counting the outcome. A target that
/// already exists is left alone — content already in the base (an earlier
/// start's, or the user's own) always wins over the legacy copy.
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
        // A target this boot created on an empty base: the legacy copy wins.
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
        // A base on another volume (a portable `OPENIDEA_HOME`): rename
        // cannot cross devices, so copy and drop the source instead.
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

/// Records `target` in `~/.openidea/home.txt` — the pointer file lives at its
/// fixed default location so a moved base can always be found back. The
/// environment variable still wins over it.
pub fn write_pointer(home: &Path, target: &Path) -> std::io::Result<()> {
    let pointer = home.join(".openidea").join("home.txt");
    std::fs::create_dir_all(pointer.parent().expect("the pointer file has a parent"))?;
    std::fs::write(&pointer, target.to_string_lossy().as_bytes())
}

/// The "don't ask again" marker of the migration dialog: at its fixed
/// default location, like the pointer file, so it is found regardless of the
/// current base.
pub fn skip_marker(home: &Path) -> PathBuf {
    home.join(".openidea").join(".skip-migration")
}

/// Records the user's "don't migrate, don't ask again" choice.
pub fn write_skip_marker(home: &Path) -> std::io::Result<()> {
    let marker = skip_marker(home);
    std::fs::create_dir_all(marker.parent().expect("the marker has a parent"))?;
    std::fs::write(marker, b"")
}

/// How many entries a migration would still move: `None` when there is
/// nothing to ask about — no marker to honor, and every legacy entry either
/// already moved or already superseded by content in the base.
pub fn migration_pending(base: &Path, home: &Path, legacy_config: &Path, legacy_data: &Path) -> Option<usize> {
    if skip_marker(home).exists() {
        return None;
    }
    let roots: Vec<&Path> =
        if legacy_config == legacy_data { vec![legacy_config] } else { vec![legacy_config, legacy_data] };
    let mut pending = 0usize;
    for &(name, target) in MOVES {
        for &root in &roots {
            if root.join(name).exists() && !base.join(target).exists() {
                pending += 1;
            }
        }
    }
    for &root in &roots {
        let agents = root.join("agents");
        if std::fs::read_dir(&agents).is_ok_and(|mut e| e.next().is_some()) {
            pending += 1;
        }
    }
    (pending > 0).then_some(pending)
}

/// Moves the old installation's directories to the OS trash after a full
/// migration — recoverable, unlike a delete, and the old version can be
/// restored from there if the user ever needs it back.
pub fn trash_legacy(legacy_config: &Path, legacy_data: &Path) -> std::io::Result<()> {
    for root in if legacy_config == legacy_data { vec![legacy_config] } else { vec![legacy_config, legacy_data] } {
        if root.exists() {
            trash::delete(root).map_err(|e| std::io::Error::other(e.to_string()))?;
        }
    }
    Ok(())
}

/// Rewrites references to the old directories in the migrated settings and
/// in the recent projects' run/settings files: a downloaded JDK or a custom
/// tool configured by its old absolute path keeps working against the new
/// base. Longer (entry-specific) replacements run before the bare root.
pub fn rewrite_legacy_paths(base: &Path, legacy_config: &Path, legacy_data: &Path) -> std::io::Result<()> {
    let mut rules: Vec<(String, String)> = Vec::new();
    let roots: Vec<(&Path, &str)> = if legacy_config == legacy_data {
        vec![(legacy_config, "")]
    } else {
        vec![(legacy_config, "config"), (legacy_data, "system")]
    };
    for (root, bare) in &roots {
        for &(name, target) in MOVES {
            rules.push((
                root.join(name).to_string_lossy().into_owned(),
                base.join(target).to_string_lossy().into_owned(),
            ));
        }
        // `agents` splits by entry kind; a path reference is per-project state.
        rules.push((
            root.join("agents").to_string_lossy().into_owned(),
            base.join("system/agents").to_string_lossy().into_owned(),
        ));
        let bare_target = if bare.is_empty() { base.to_path_buf() } else { base.join(bare) };
        rules.push((root.to_string_lossy().into_owned(), bare_target.to_string_lossy().into_owned()));
    }
    rules.sort_by(|a, b| b.0.len().cmp(&a.0.len()));

    let mut files = vec![base.join("config/settings.toml")];
    // Recent projects' run configurations and settings may name tools by
    // their old absolute path.
    if let Ok(recent) = std::fs::read_to_string(base.join("config/recent.json"))
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
/// [`std::fs::rename`], which cannot leave the volume it is on, and the
/// "Move existing data" copy of the settings UI.
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

    #[test]
    fn env_wins_over_pointer_and_default() {
        assert_eq!(resolve(Some("/custom"), Some("/pointer"), Path::new("/h")), PathBuf::from("/custom"));
    }

    #[test]
    fn env_tilde_expands() {
        assert_eq!(resolve(Some("~/env"), None, Path::new("/h")), PathBuf::from("/h/env"));
    }

    #[test]
    fn empty_or_relative_env_falls_through_to_the_pointer() {
        let tmp = TempDir::new().unwrap();
        let home = tmp.path().join("home");
        let target = home.join("p");
        fs::create_dir_all(&target).unwrap();
        // An empty or relative env value is not a choice: the pointer decides.
        assert_eq!(resolve(Some(""), Some("~/p"), &home), target);
        assert_eq!(resolve(Some("relative"), Some("~/p"), &home), target);
    }

    #[test]
    fn pointer_used_when_it_points_at_a_directory() {
        let tmp = TempDir::new().unwrap();
        let home = tmp.path().join("home");
        let target = home.join("moved-base");
        fs::create_dir_all(&target).unwrap();
        // `~` expands and stray whitespace (a hand-edited file) is trimmed.
        let base = resolve(None, Some(&format!("~/moved-base \n")), &home);
        assert_eq!(base, target);
    }

    #[test]
    fn dangling_or_relative_pointer_falls_back_to_the_default() {
        let home = Path::new("/h");
        assert_eq!(resolve(None, Some("/missing"), home), home.join(".openidea"));
        assert_eq!(resolve(None, Some("relative"), home), home.join(".openidea"));
    }

    #[test]
    fn default_is_dot_openidea_under_home() {
        assert_eq!(resolve(None, None, Path::new("/h")), PathBuf::from("/h/.openidea"));
    }

    #[test]
    fn layout_under_base() {
        let base = Path::new("/b");
        assert_eq!(config_dir(base), PathBuf::from("/b/config"));
        assert_eq!(system_dir(base), PathBuf::from("/b/system"));
        assert_eq!(log_dir(base), PathBuf::from("/b/log"));
    }

    /// The full legacy tree, split like Linux/Windows (config ≠ data): every
    /// MOVES entry is planted on the side its target implies (config/* on the
    /// config side, everything else on the data side), plus the agents split,
    /// the dropped caches and the files that must stay behind. Growing MOVES
    /// grows the fixture — no count to keep in step by hand.
    fn split_legacy(tmp: &TempDir) -> (PathBuf, PathBuf) {
        let legacy_config = tmp.path().join("old-config");
        let legacy_data = tmp.path().join("old-data");
        fs::create_dir_all(&legacy_config).unwrap();
        fs::create_dir_all(&legacy_data).unwrap();
        for &(name, target) in MOVES {
            let root = if target.starts_with("config/") { &legacy_config } else { &legacy_data };
            if target.contains('.') {
                file(root, name);
            } else {
                folder(root, name);
            }
        }
        file(&legacy_config, "agents/my-agent.toml");
        file(&legacy_data, "agents/models.json");
        folder(&legacy_data, "agents/proj1");
        folder(&legacy_data, "agents/tools");
        for name in DROPS {
            folder(&legacy_data, name);
        }
        file(&legacy_data, ".window-state.json");
        file(&legacy_data, "stray.txt");
        (legacy_config, legacy_data)
    }

    #[test]
    fn migration_moves_the_full_mapping() {
        let tmp = TempDir::new().unwrap();
        let (legacy_config, legacy_data) = split_legacy(&tmp);
        let base = tmp.path().join("base");
        fs::create_dir_all(&base).unwrap();

        let result = migrate_legacy(&base, &legacy_config, &legacy_data, false);

        assert_eq!(result.failed, 0, "nothing may fail on a clean legacy tree");
        // Every mapped entry plus the four `agents/` entries moved, exactly
        // once each: the count derives from the tables, not from a hand-kept
        // number that would rot when the mapping grows.
        assert_eq!(result.moved, MOVES.len() + 4);
        for &(name, target) in MOVES {
            let landed = if target.contains('.') {
                base.join(target).is_file()
            } else {
                base.join(target).join("keep").is_file()
            };
            assert!(landed, "{target} did not arrive with its content");
            // Entries move, not copy: the source must be gone from both roots.
            assert!(
                !legacy_config.join(name).exists() && !legacy_data.join(name).exists(),
                "{name} still sits in the legacy tree"
            );
        }
        assert!(base.join("config/agents/my-agent.toml").is_file());
        assert!(base.join("system/agents/models.json").is_file());
        assert!(base.join("system/agents/proj1/keep").is_file());
        assert!(base.join("system/agents/tools/keep").is_file());
        // Rebuildable caches are dropped, unknown and plugin files stay.
        for name in DROPS {
            assert!(!legacy_data.join(name).exists(), "{name} must be dropped");
        }
        assert!(legacy_data.join(".window-state.json").is_file());
        assert!(legacy_data.join("stray.txt").is_file());
    }

    #[test]
    fn migration_reruns_are_noops() {
        let tmp = TempDir::new().unwrap();
        let (legacy_config, legacy_data) = split_legacy(&tmp);
        let base = tmp.path().join("base");
        fs::create_dir_all(&base).unwrap();
        let first = migrate_legacy(&base, &legacy_config, &legacy_data, false);
        assert!(first.moved > 0);

        // Every source is gone and every target exists: a second start, and
        // every start after it, moves nothing and fails nothing.
        let second = migrate_legacy(&base, &legacy_config, &legacy_data, false);
        assert_eq!(second, Migration::default());
    }

    #[test]
    fn migration_picks_up_entries_added_after_the_first_run() {
        // The incremental case: a later release adds a mapping entry whose
        // source still sits in the legacy tree (an old install kept running,
        // or the entry was simply missed — as `language-server-runtimes` once
        // was). The next start must move it, not strand it behind a flag.
        let tmp = TempDir::new().unwrap();
        let legacy_config = tmp.path().join("old-config");
        let legacy_data = tmp.path().join("old-data");
        fs::create_dir_all(&legacy_config).unwrap();
        fs::create_dir_all(&legacy_data).unwrap();
        file(&legacy_config, "settings.toml");
        let base = tmp.path().join("base");
        fs::create_dir_all(&base).unwrap();

        let first = migrate_legacy(&base, &legacy_config, &legacy_data, false);
        assert_eq!(first, Migration { moved: 1, failed: 0 });

        folder(&legacy_data, "language-server-runtimes");
        let second = migrate_legacy(&base, &legacy_config, &legacy_data, false);
        assert_eq!(second, Migration { moved: 1, failed: 0 });
        assert!(base.join("language-server-runtimes/keep").is_file());
    }

    #[test]
    fn migration_never_overwrites_base_content() {
        let tmp = TempDir::new().unwrap();
        let legacy_config = tmp.path().join("old-config");
        fs::create_dir_all(&legacy_config).unwrap();
        file(&legacy_config, "settings.toml");
        let base = tmp.path().join("base");
        fs::create_dir_all(&base).unwrap();
        // The user already put their own settings in the base: the legacy
        // copy stays behind instead of clobbering them, counted as neither
        // moved nor failed.
        file(&base, "config/settings.toml");

        let result = migrate_legacy(&base, &legacy_config, &tmp.path().join("no-data"), false);

        assert_eq!(result, Migration::default());
        assert_eq!(fs::read_to_string(base.join("config/settings.toml")).unwrap(), "config/settings.toml");
        assert_eq!(fs::read_to_string(legacy_config.join("settings.toml")).unwrap(), "settings.toml");
    }

    #[test]
    fn migration_without_legacy_directories_creates_nothing() {
        let tmp = TempDir::new().unwrap();
        let base = tmp.path().join("base");
        let result = migrate_legacy(&base, &tmp.path().join("no-config"), &tmp.path().join("no-data"), false);
        assert_eq!(result, Migration::default());
        assert!(!config_dir(&base).exists());
    }

    #[test]
    fn migration_without_mapped_entries_moves_nothing() {
        let tmp = TempDir::new().unwrap();
        let legacy = tmp.path().join("old");
        fs::create_dir_all(&legacy).unwrap();
        file(&legacy, "stray.txt");
        let base = tmp.path().join("base");

        let result = migrate_legacy(&base, &legacy, &legacy, false);

        assert_eq!(result, Migration::default());
        assert!(legacy.join("stray.txt").is_file());
        assert!(!config_dir(&base).exists(), "migration itself creates no layout");
    }

    #[test]
    fn migration_scans_a_shared_legacy_dir_once() {
        let tmp = TempDir::new().unwrap();
        // macOS shape: one directory holding both kinds of file.
        let legacy = tmp.path().join("old");
        fs::create_dir_all(&legacy).unwrap();
        file(&legacy, "settings.toml");
        folder(&legacy, "tools");
        file(&legacy, "agents/a.toml");
        file(&legacy, "agents/models.json");
        let base = tmp.path().join("base");
        fs::create_dir_all(&base).unwrap();
        // A file already squatting on the `tools` target: skipped, not
        // clobbered, not a failure.
        file(&base, "tools");

        let result = migrate_legacy(&base, &legacy, &legacy, false);

        assert_eq!(result, Migration { moved: 3, failed: 0 });
        assert!(base.join("config/settings.toml").is_file());
        assert!(base.join("config/agents/a.toml").is_file());
        assert!(base.join("system/agents/models.json").is_file());
        assert!(legacy.join("tools/keep").is_file(), "the skipped move stays behind");
    }

    #[test]
    fn migration_counts_failures_and_continues() {
        let tmp = TempDir::new().unwrap();
        let legacy_config = tmp.path().join("old-config");
        let legacy_data = tmp.path().join("old-data");
        fs::create_dir_all(&legacy_config).unwrap();
        fs::create_dir_all(&legacy_data).unwrap();
        file(&legacy_config, "settings.toml");
        folder(&legacy_data, "remote");
        let base = tmp.path().join("base");
        fs::create_dir_all(&base).unwrap();
        // A file where `system/` should be: that entry's parent cannot be
        // created, its move fails, and the rest of the mapping still moves.
        file(&base, "system");

        let result = migrate_legacy(&base, &legacy_config, &legacy_data, false);

        assert_eq!(result, Migration { moved: 1, failed: 1 });
        assert!(base.join("config/settings.toml").is_file());
        assert!(legacy_data.join("remote/keep").is_file(), "the failed move stays behind");
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
        let home = tmp.path().join("home");
        let target = tmp.path().join("moved-base");
        fs::create_dir_all(&target).unwrap();

        write_pointer(&home, &target).unwrap();

        let recorded = fs::read_to_string(home.join(".openidea").join("home.txt")).unwrap();
        assert_eq!(resolve(None, Some(&recorded), &home), target);
    }

    #[test]
    fn legacy_dirs_belong_to_the_release_identifier() {
        let (config, data) = legacy_dirs().expect("the platform has config and data directories");
        assert!(config.ends_with(RELEASE_IDENTIFIER), "{}", config.display());
        assert!(data.ends_with(RELEASE_IDENTIFIER), "{}", data.display());
    }

    #[test]
    fn a_fresh_base_is_replaced_by_the_legacy_copy() {
        // The boot of an empty base wrote a fresh settings file; the user
        // then chose to migrate: the legacy copy wins over the boot's.
        let tmp = TempDir::new().unwrap();
        let legacy_config = tmp.path().join("old-config");
        fs::create_dir_all(&legacy_config).unwrap();
        file(&legacy_config, "settings.toml");
        let base = tmp.path().join("base");
        fs::create_dir_all(base.join("config")).unwrap();
        file(&base, "config/settings.toml");

        let result = migrate_legacy(&base, &legacy_config, &tmp.path().join("no-data"), true);

        assert_eq!(result, Migration { moved: 1, failed: 0 });
        assert_eq!(fs::read_to_string(base.join("config/settings.toml")).unwrap(), "settings.toml");
    }

    #[test]
    fn pending_counts_only_entries_still_worth_moving() {
        let tmp = TempDir::new().unwrap();
        let home = tmp.path().join("home");
        let legacy = tmp.path().join("old");
        fs::create_dir_all(&legacy).unwrap();
        file(&legacy, "settings.toml");
        folder(&legacy, "tools");
        let base = tmp.path().join("base");
        fs::create_dir_all(&base).unwrap();

        // Two movable entries, one already moved, one already superseded.
        fs::create_dir_all(base.join("tools")).unwrap();
        file(&base, "config/recent.json");
        let pending = migration_pending(&base, &home, &legacy, &legacy);
        assert_eq!(pending, Some(1));

        // "Don't ask again" hides the prompt for good.
        write_skip_marker(&home).unwrap();
        assert_eq!(migration_pending(&base, &home, &legacy, &legacy), None);
    }

    #[test]
    fn rewriting_paths_moves_old_references_to_the_new_home() {
        let tmp = TempDir::new().unwrap();
        let legacy = tmp.path().join("old");
        fs::create_dir_all(&legacy).unwrap();
        let base = tmp.path().join("base");
        fs::create_dir_all(base.join("config")).unwrap();
        // The migrated settings name a downloaded JDK by its old path; a
        // recent project's run configuration names a managed tool.
        let jdk = format!("jdk = \"{}/tools/jdks/temurin-25\"", legacy.display());
        fs::write(base.join("config/settings.toml"), &jdk).unwrap();
        let project = tmp.path().join("project");
        fs::create_dir_all(project.join(".openidea")).unwrap();
        let cmd = format!("command = \"{}/tools/node_modules/.bin/vtsls\"", legacy.display());
        fs::write(project.join(".openidea/run.toml"), &cmd).unwrap();
        fs::write(base.join("config/recent.json"), format!("[{{\"path\": \"{}\"}}]", project.display())).unwrap();

        rewrite_legacy_paths(&base, &legacy, &legacy).unwrap();

        let settings = fs::read_to_string(base.join("config/settings.toml")).unwrap();
        assert_eq!(settings, format!("jdk = \"{}/tools/jdks/temurin-25\"", base.display()));
        let run = fs::read_to_string(project.join(".openidea/run.toml")).unwrap();
        assert_eq!(run, format!("command = \"{}/tools/node_modules/.bin/vtsls\"", base.display()));
    }
}
