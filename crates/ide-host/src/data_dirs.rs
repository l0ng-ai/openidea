//! Storage policy and best-effort migration of rebuildable desktop data.

use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// Moves the rebuildable local data (tools, language servers, indexes, caches);
/// configuration and roaming data keep following the OS.
pub const LOCAL_DATA_ENV: &str = "OPENIDEA_LOCAL_DATA_DIR";

/// A custom local-data root chosen in Settings › System Settings › Caches,
/// stored in the configuration directory. The environment variable still wins.
pub const OVERRIDE_FILE: &str = "local-data-dir.txt";

/// A pending move of the local data to a newly chosen directory, carried out
/// at the next start (before any project opens), like File › Invalidate Caches.
const MIGRATION_FILE: &str = "local-data-migration.json";

/// `$OPENIDEA_LOCAL_DATA_DIR/<identifier>` when set, else the OS local data directory
/// (Tauri's `app_local_data_dir`). The identifier keeps release and per-worktree
/// debug builds apart under one root. A set but unusable path is an error, never a
/// silent fallback to the OS location.
pub fn local_data_dir(identifier: &str) -> Result<PathBuf, String> {
    resolve_local(std::env::var_os(LOCAL_DATA_ENV), dirs::data_local_dir(), identifier)
}

/// The directory to actually start with: the environment override, else a valid
/// custom directory from Settings, else the OS default. A stored but unusable
/// custom directory is an error, never a silent fallback.
pub fn startup_local_data_dir(identifier: &str) -> Result<PathBuf, String> {
    startup_resolve(std::env::var_os(LOCAL_DATA_ENV), stored_override(identifier), dirs::data_local_dir(), identifier)
}

fn startup_resolve(
    var: Option<OsString>,
    stored: Option<PathBuf>,
    os: Option<PathBuf>,
    identifier: &str,
) -> Result<PathBuf, String> {
    if var.as_ref().is_some_and(|v| !v.is_empty()) {
        return resolve_local(var, os, identifier);
    }
    let Some(root) = stored else { return resolve_local(None, os, identifier) };
    if !root.is_absolute() {
        return Err(format!("custom local data directory must be an absolute path: {}", root.display()));
    }
    resolve_root(root, identifier, "custom local data directory")
}

/// The file holding the custom local-data root, if the platform exposes its
/// configuration directory. Both startup and Settings use this one path.
pub fn override_path(identifier: &str) -> Option<PathBuf> {
    dirs::config_dir().map(|dir| dir.join(identifier).join(OVERRIDE_FILE))
}

fn migration_path(identifier: &str) -> Option<PathBuf> {
    dirs::config_dir().map(|dir| dir.join(identifier).join(MIGRATION_FILE))
}

/// The custom root stored by Settings, if any (validated when it is used).
pub fn stored_override(identifier: &str) -> Option<PathBuf> {
    stored_override_in(&override_path(identifier)?)
}

fn stored_override_in(path: &Path) -> Option<PathBuf> {
    let text = fs::read_to_string(path).ok()?;
    let trimmed = text.trim();
    (!trimmed.is_empty()).then(|| PathBuf::from(trimmed))
}

/// The OS default local data directory (what clearing the custom directory
/// returns to), ignoring any stored override. The environment still applies.
pub fn default_local_data_dir(identifier: &str) -> Result<PathBuf, String> {
    local_data_dir(identifier)
}

/// Stores (`Some`) or clears (`None`) the custom local-data root, returning the
/// directory that takes effect after a restart. A pending custom migration to
/// anywhere else is dropped: only the caller schedules the matching one.
pub fn set_override(identifier: &str, root: Option<&Path>) -> Result<PathBuf, String> {
    let Some(path) = override_path(identifier) else {
        return Err("cannot find the configuration directory".into());
    };
    set_override_in(&path, &migration_path(identifier), root, identifier)
}

fn set_override_in(
    path: &Path,
    migration: &Option<PathBuf>,
    root: Option<&Path>,
    identifier: &str,
) -> Result<PathBuf, String> {
    if let Some(migration) = migration {
        let _ = fs::remove_file(migration);
    }
    let Some(root) = root else {
        if let Err(error) = fs::remove_file(path)
            && error.kind() != io::ErrorKind::NotFound
        {
            return Err(format!("cannot clear the custom local data directory: {error}"));
        }
        return local_data_dir(identifier);
    };
    if !root.is_absolute() {
        return Err(format!("custom local data directory must be an absolute path: {}", root.display()));
    }
    let dir = resolve_root(root.to_path_buf(), identifier, "custom local data directory")?;
    if let Some(parent) = path.parent()
        && let Err(error) = fs::create_dir_all(parent)
    {
        return Err(format!("cannot store the custom local data directory: {error}"));
    }
    if let Err(error) = fs::write(path, format!("{}\n", root.display())) {
        return Err(format!("cannot store the custom local data directory: {error}"));
    }
    Ok(dir)
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
struct CustomMigration {
    from: PathBuf,
    to: PathBuf,
}

/// Schedules a move of the local data from `from` to `to` at the next start.
/// Returns false when there is nothing to move. The caller restarts the IDE.
pub fn schedule_custom_migration(identifier: &str, from: &Path, to: &Path) -> Result<bool, String> {
    let Some(path) = migration_path(identifier) else {
        return Err("cannot find the configuration directory".into());
    };
    schedule_custom_migration_in(&path, from, to)
}

fn schedule_custom_migration_in(path: &Path, from: &Path, to: &Path) -> Result<bool, String> {
    if from == to {
        return Ok(false);
    }
    if let Some(parent) = path.parent()
        && let Err(error) = fs::create_dir_all(parent)
    {
        return Err(format!("cannot schedule the data move: {error}"));
    }
    let json = serde_json::to_vec(&CustomMigration { from: from.into(), to: to.into() })
        .map_err(|error| format!("cannot schedule the data move: {error}"))?;
    if let Err(error) = fs::write(path, json) {
        return Err(format!("cannot schedule the data move: {error}"));
    }
    Ok(true)
}

/// Carries out a scheduled custom migration aimed at `local` (call at start-up,
/// before projects open). Entries that appear in the meantime are never
/// overwritten; a partially moved tree is retried at the next start.
pub fn apply_custom_migration(identifier: &str, local: &Path) {
    let Some(path) = migration_path(identifier) else { return };
    apply_custom_migration_in(&path, local);
}

fn apply_custom_migration_in(path: &Path, local: &Path) {
    let Ok(bytes) = fs::read(path) else { return };
    let Ok(job) = serde_json::from_slice::<CustomMigration>(&bytes) else {
        let _ = fs::remove_file(path);
        return;
    };
    if job.to != local || job.from == local {
        let _ = fs::remove_file(path);
        return;
    }
    move_entries(&job.from, local, &custom_entries(&job.from));
    let leftover = custom_entries(&job.from).into_iter().any(|entry| job.from.join(entry).exists());
    if !leftover {
        let _ = fs::remove_file(path);
    }
}

/// Entries of a local-data tree that move to a newly chosen directory.
/// Non-relocatable tool installs (virtual environments with absolute interpreter
/// paths) stay behind and are reinstalled on demand, as in `migrate_entries`.
fn custom_entries(root: &Path) -> Vec<PathBuf> {
    let mut entries = local_entries(root);
    for extra in ["logs", "agents/tools"] {
        let entry = PathBuf::from(extra);
        if !entries.contains(&entry) {
            entries.push(entry);
        }
    }
    entries
}

/// Moves the local-data tree from `from` to `to`, entry by entry. Same-volume
/// entries rename at once; cross-volume copies run in the background. Targets
/// created in the meantime are never merged into or overwritten.
fn move_entries(from: &Path, to: &Path, entries: &[PathBuf]) {
    if from == to {
        return;
    }
    let mut copies = Vec::new();
    for entry in entries {
        let source = from.join(entry);
        let target = to.join(entry);
        match try_rename(&source, &target) {
            Ok(true) => copies.push((source, target)),
            Ok(false) => {}
            Err(error) => {
                tracing::warn!(?source, ?target, %error, "data move failed; keeping old data, using new location")
            }
        }
    }
    if !copies.is_empty() {
        let result = std::thread::Builder::new().name("openidea-data-migration".into()).spawn(move || {
            for (source, target) in copies {
                tracing::info!(?source, ?target, "copying data to the new location in background");
                if let Err(error) = copy_then_remove(&source, &target) {
                    tracing::warn!(?source, ?target, %error, "data copy failed; keeping old data");
                }
            }
        });
        if let Err(error) = result {
            tracing::warn!(%error, "cannot start data migration worker; keeping old data");
        }
    }
}

fn resolve_local(var: Option<OsString>, os: Option<PathBuf>, identifier: &str) -> Result<PathBuf, String> {
    let Some(root) = var.filter(|v| !v.is_empty()).map(PathBuf::from) else {
        return os.map(|dir| dir.join(identifier)).ok_or_else(|| "cannot find the local data directory".into());
    };
    // The working directory depends on how the IDE was launched.
    if !root.is_absolute() {
        return Err(format!("{LOCAL_DATA_ENV} must be an absolute path: {}", root.display()));
    }
    resolve_root(root, identifier, LOCAL_DATA_ENV)
}

fn resolve_root(root: PathBuf, identifier: &str, what: &str) -> Result<PathBuf, String> {
    let dir = root.join(identifier);
    fs::create_dir_all(&dir)
        .and_then(|()| tempfile::NamedTempFile::new_in(&dir).map(drop))
        .map_err(|error| format!("{what}: cannot write to {}: {error}", dir.display()))?;
    Ok(dir)
}

/// Unknown entries and recovery/user content deliberately stay in roaming data.
pub fn is_local(entry: &Path) -> bool {
    ["tools", "language-server-runtimes", "index", "cache", "lsp", "notebook-runtime", "server", "logs"]
        .iter()
        .any(|root| entry.starts_with(root))
        || entry.starts_with("agents/tools")
        || entry == Path::new("agents/registry.json")
        || (entry.components().count() == 1
            && entry.file_name().is_some_and(|name| name.to_string_lossy().starts_with("java-usages-"))
            && entry.extension().is_some_and(|ext| ext == "jar" || ext == "tmp"))
}

pub fn data_path(data: &Path, local: &Path, entry: &Path) -> PathBuf {
    if is_local(entry) { local.join(entry) } else { data.join(entry) }
}

#[derive(Debug, PartialEq, Eq)]
enum Action {
    Skip,
    Rename,
}

fn action(same_root: bool, source_exists: bool, target_exists: bool) -> Action {
    if same_root || !source_exists || target_exists { Action::Skip } else { Action::Rename }
}

#[derive(Debug, PartialEq, Eq)]
enum RenameFailure {
    Copy,
    KeepSource,
}

fn rename_failure(error: &io::Error) -> RenameFailure {
    if error.kind() == io::ErrorKind::CrossesDevices { RenameFailure::Copy } else { RenameFailure::KeepSource }
}

/// Only Windows splits these paths. Renames are cheap; cross-volume copies run in
/// the background. Consumers always use Local, even when migration fails.
pub fn migrate(data: &Path, local: &Path) {
    if cfg!(target_os = "windows") && data != local {
        migrate_entries(data, local);
    }
}

fn migrate_entries(data: &Path, local: &Path) {
    move_entries(data, local, &local_entries(data));
}

/// The rebuildable entries of the legacy roaming tree that move to Local.
fn local_entries(data: &Path) -> Vec<PathBuf> {
    let mut entries: Vec<PathBuf> = [
        "language-server-runtimes",
        "index",
        "cache",
        "lsp",
        "notebook-runtime",
        "server",
        "java-usages-1.1.1.jar",
        "java-usages-1.2.0.jar",
        "agents/registry.json",
    ]
    .into_iter()
    .map(PathBuf::from)
    .collect();
    // Virtual environments contain absolute interpreter paths. Keep the old copy
    // intact; these tools are installed afresh in Local when requested. Registry
    // agents also have absolute commands in user config, so leave legacy installs.
    match fs::read_dir(data.join("tools")) {
        Ok(tools) => {
            for entry in tools {
                let entry = match entry {
                    Ok(entry) => entry,
                    Err(error) => {
                        tracing::warn!(%error, "cannot enumerate legacy tool; keeping old data, using Local");
                        continue;
                    }
                };
                let name = entry.file_name();
                let venv = ide_tools::registry::TOOLS.iter().any(|tool| {
                    name == tool.name && matches!(tool.method, ide_tools::registry::Method::PipVenv { .. })
                });
                if venv {
                    tracing::info!(?name, "leaving non-relocatable legacy tool; reinstall into Local when needed");
                } else {
                    entries.push(Path::new("tools").join(name));
                }
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => tracing::warn!(%error, "cannot enumerate legacy tools; keeping old data, using Local"),
    }
    entries
}

/// Returns true when a cross-volume copy is needed.
fn try_rename(source: &Path, target: &Path) -> io::Result<bool> {
    if action(source == target, source.try_exists()?, target.try_exists()?) == Action::Skip {
        return Ok(false);
    }
    if fs::symlink_metadata(source)?.file_type().is_symlink() {
        return Err(io::Error::other("refusing to migrate a linked data entry"));
    }
    fs::create_dir_all(target.parent().ok_or_else(|| io::Error::other("missing data parent"))?)?;
    // Relative wrappers work at the old location too, so even a failed rename
    // leaves the old installation usable and needs no rollback.
    relocate_shims(source, source)?;
    match rename_missing(source, target) {
        Ok(()) => {
            tracing::info!(?source, ?target, "moved legacy data to Local");
            Ok(false)
        }
        Err(error) if rename_failure(&error) == RenameFailure::Copy => Ok(true),
        Err(error) => Err(error),
    }
}

fn copy_then_remove(source: &Path, target: &Path) -> io::Result<()> {
    if target.try_exists()? {
        return Ok(());
    }
    let parent = target.parent().ok_or_else(|| io::Error::other("missing data parent"))?;
    fs::create_dir_all(parent)?;
    let staging = parent.join(format!(".migration-{}", uuid::Uuid::new_v4()));
    let result = (|| {
        copy_tree(source, &staging)?;
        relocate_shims(&staging, source)?;
        // A tool may have been installed or a cache rebuilt while copying. Never
        // merge into or overwrite it, and retain the original for recovery.
        if target.try_exists()? {
            tracing::info!(?source, ?target, "Local data created during migration; retaining legacy copy");
            return Ok(());
        }
        rename_missing(&staging, target)?;
        remove_entry(source)?;
        tracing::info!(?source, ?target, "copied legacy data to Local");
        Ok(())
    })();
    if staging.exists() {
        let _ = remove_entry(&staging);
    }
    result
}

// std::fs::rename may replace even an empty directory on modern Windows.
#[cfg(windows)]
fn rename_missing(source: &Path, target: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::MoveFileExW;

    // canonicalize supplies extended-length paths, including redirected UNC roots.
    let source = fs::canonicalize(source)?;
    let target = fs::canonicalize(target.parent().ok_or_else(|| io::Error::other("missing data parent"))?)?
        .join(target.file_name().ok_or_else(|| io::Error::other("missing data name"))?);
    let wide = |path: &Path| -> io::Result<Vec<u16>> {
        let mut value: Vec<u16> = path.as_os_str().encode_wide().collect();
        if value.contains(&0) {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "NUL in data path"));
        }
        value.push(0);
        Ok(value)
    };
    let source = wide(&source)?;
    let target = wide(&target)?;
    // SAFETY: both paths are valid NUL-terminated UTF-16 buffers. No flags means
    // neither replacement nor implicit cross-volume copying is permitted.
    if unsafe { MoveFileExW(source.as_ptr(), target.as_ptr(), 0) } == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

// Filesystem tests run on Unix too; production migration is Windows-only.
#[cfg(not(windows))]
fn rename_missing(source: &Path, target: &Path) -> io::Result<()> {
    if target.try_exists()? {
        return Err(io::Error::from(io::ErrorKind::AlreadyExists));
    }
    fs::rename(source, target)
}

fn remove_entry(path: &Path) -> io::Result<()> {
    if fs::symlink_metadata(path)?.is_dir() { fs::remove_dir_all(path) } else { fs::remove_file(path) }
}

fn copy_tree(source: &Path, target: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(source)?;
    if metadata.file_type().is_symlink() {
        return Err(io::Error::other("refusing to follow a link during data migration"));
    }
    if metadata.is_dir() {
        fs::create_dir(target)?;
        for entry in fs::read_dir(source)? {
            let entry = entry?;
            copy_tree(&entry.path(), &target.join(entry.file_name()))?;
        }
    } else if metadata.is_file() {
        fs::copy(source, target)?;
    } else {
        return Err(io::Error::other("unsupported data entry"));
    }
    Ok(())
}

/// Make our absolute .cmd wrappers relative to their bin directory. They remain
/// valid in both locations if the move must be rolled back. npm shims already use
/// relative paths; payloads and user configuration are never rewritten.
fn relocate_shims(root: &Path, source: &Path) -> io::Result<()> {
    if source.parent().and_then(Path::file_name).is_none_or(|name| name != "tools") {
        return Ok(());
    }
    let bin = root.join("bin");
    if !bin.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(bin)? {
        let path = entry?.path();
        if path.extension().is_none_or(|ext| ext != "cmd") {
            continue;
        }
        let text = fs::read_to_string(&path)?;
        if text.starts_with("@echo off\r\n") {
            let updated = relative_wrapper(&text, source);
            if updated != text {
                fs::write(path, updated)?;
            }
        }
    }
    Ok(())
}

fn relative_wrapper(text: &str, source: &Path) -> String {
    // PathBuf can contain both separators (notably roots joined with "tools/demo").
    // Compare normalized paths, but retain every other byte of the managed wrapper.
    let normalized = text.replace('\\', "/");
    let prefix = source.to_string_lossy().replace('\\', "/");
    #[cfg(windows)]
    let (normalized, prefix) = (normalized.to_ascii_lowercase(), prefix.to_ascii_lowercase());
    let mut updated = text.to_owned();
    let offsets: Vec<_> = normalized.match_indices(&prefix).map(|(offset, _)| offset).collect();
    for offset in offsets.into_iter().rev() {
        let end = offset + prefix.len();
        if normalized.as_bytes().get(end) == Some(&b'/') {
            updated.replace_range(offset..end, "%~dp0..");
        }
    }
    updated
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_dir_follows_the_os_unless_the_variable_is_set() {
        let os = Some(PathBuf::from("/os-local"));
        for var in [None, Some(OsString::new())] {
            assert_eq!(
                resolve_local(var, os.clone(), "ai.l0ng.openidea").unwrap(),
                Path::new("/os-local/ai.l0ng.openidea")
            );
        }
        assert!(resolve_local(None, None, "id").is_err());

        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("missing/nested");
        let dir = resolve_local(Some(root.clone().into()), os.clone(), "ai.l0ng.openidea").unwrap();
        assert_eq!(dir, root.join("ai.l0ng.openidea"));
        assert!(dir.is_dir());
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 0);
        // Debug worktrees have their own identifiers and stay apart under one root.
        assert_ne!(resolve_local(Some(root.clone().into()), None, "dev-a").unwrap(), dir);
    }

    #[test]
    fn local_dir_preserves_an_existing_probe_file() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("id");
        fs::create_dir(&dir).unwrap();
        let probe = dir.join(".openidea-write-check");
        fs::write(&probe, "keep").unwrap();
        assert_eq!(resolve_local(Some(tmp.path().into()), None, "id").unwrap(), dir);
        assert_eq!(fs::read_to_string(probe).unwrap(), "keep");
        assert_eq!(fs::read_dir(dir).unwrap().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn local_dir_preserves_an_existing_probe_symlink_and_its_target() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("id");
        fs::create_dir(&dir).unwrap();
        let target = tmp.path().join("target");
        fs::write(&target, "keep").unwrap();
        let probe = dir.join(".openidea-write-check");
        std::os::unix::fs::symlink(&target, &probe).unwrap();
        assert_eq!(resolve_local(Some(tmp.path().into()), None, "id").unwrap(), dir);
        assert_eq!(fs::read_to_string(target).unwrap(), "keep");
        assert!(fs::symlink_metadata(probe).unwrap().file_type().is_symlink());
        assert_eq!(fs::read_dir(dir).unwrap().count(), 1);
    }

    #[test]
    fn local_dir_allows_concurrent_probes_for_the_same_identifier() {
        let tmp = tempfile::tempdir().unwrap();
        let barrier = std::sync::Barrier::new(8);
        std::thread::scope(|scope| {
            for _ in 0..8 {
                let barrier = &barrier;
                let root = tmp.path();
                scope.spawn(move || {
                    barrier.wait();
                    for _ in 0..16 {
                        assert_eq!(resolve_local(Some(root.into()), None, "id").unwrap(), root.join("id"));
                    }
                });
            }
        });
        assert_eq!(fs::read_dir(tmp.path().join("id")).unwrap().count(), 0);
    }

    #[test]
    fn local_dir_rejects_relative_and_unwritable_paths() {
        for relative in ["local", "./local", "../local"] {
            let error = resolve_local(Some(relative.into()), Some("/os".into()), "id").unwrap_err();
            assert!(error.contains(LOCAL_DATA_ENV) && error.contains("absolute"), "{error}");
        }
        let tmp = tempfile::tempdir().unwrap();
        let blocker = tmp.path().join("file");
        fs::write(&blocker, "").unwrap();
        let error = resolve_local(Some(blocker.into()), Some("/os".into()), "id").unwrap_err();
        assert!(error.contains("cannot write"), "{error}");
    }

    #[cfg(unix)]
    #[test]
    fn local_dir_rejects_an_existing_read_only_directory() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("id");
        fs::create_dir(&dir).unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o555)).unwrap();
        // Root ignores permission bits.
        if fs::write(dir.join("probe"), "").is_err() {
            assert!(resolve_local(Some(tmp.path().into()), None, "id").unwrap_err().contains("cannot write"));
        }
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[test]
    fn wrappers_accept_mixed_separators_without_rewriting_neighbor_paths() {
        let text = "@echo off\r\n\"C:\\old\\tools/demo\\payload.exe\" \"C:\\old\\tools/demo-other\\x\" %*\r\n";
        assert_eq!(
            relative_wrapper(text, Path::new("C:/old/tools/demo")),
            "@echo off\r\n\"%~dp0..\\payload.exe\" \"C:\\old\\tools/demo-other\\x\" %*\r\n"
        );
    }

    #[test]
    fn storage_policy_is_conservative_and_preserves_unix_layout() {
        for entry in [
            "tools/jdks",
            "language-server-runtimes",
            "lsp/jdtls",
            "index/x",
            "cache/x",
            "notebook-runtime",
            "server",
            "logs",
            "agents/tools",
            "agents/registry.json",
            "java-usages-1.1.1.jar",
            "java-usages-1.2.0.jar",
        ] {
            assert!(is_local(Path::new(entry)), "{entry}");
            assert_eq!(
                data_path(Path::new("roaming"), Path::new("local"), Path::new(entry)),
                Path::new("local").join(entry)
            );
            assert_eq!(
                data_path(Path::new("data"), Path::new("data"), Path::new(entry)),
                Path::new("data").join(entry)
            );
        }
        for entry in [
            "git-credentials.json",
            "history",
            "remote",
            "scratches",
            "consoles",
            "plugins",
            "workspaces",
            "agents/models.json",
            "agents/project",
            "unknown",
        ] {
            assert!(!is_local(Path::new(entry)), "{entry}");
            assert_eq!(
                data_path(Path::new("roaming"), Path::new("local"), Path::new(entry)),
                Path::new("roaming").join(entry)
            );
        }
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn unix_startup_does_not_migrate_even_if_given_distinct_roots() {
        assert_eq!(dirs::data_dir(), dirs::data_local_dir());
        let tmp = tempfile::tempdir().unwrap();
        let old = tmp.path().join("old");
        let new = tmp.path().join("new");
        fs::create_dir_all(old.join("index")).unwrap();
        migrate(&old, &new);
        assert!(old.join("index").exists());
        assert!(!new.exists());
    }

    #[test]
    fn decisions_cover_missing_existing_and_failed_renames() {
        assert_eq!(action(true, true, false), Action::Skip);
        assert_eq!(action(false, false, false), Action::Skip);
        assert_eq!(action(false, true, true), Action::Skip);
        assert_eq!(action(false, true, false), Action::Rename);
        assert_eq!(rename_failure(&io::Error::from(io::ErrorKind::CrossesDevices)), RenameFailure::Copy);
        for kind in [io::ErrorKind::PermissionDenied, io::ErrorKind::AlreadyExists, io::ErrorKind::NotFound] {
            assert_eq!(rename_failure(&io::Error::from(kind)), RenameFailure::KeepSource);
        }
    }

    #[test]
    fn same_volume_moves_and_second_start_does_not_overwrite() {
        let tmp = tempfile::tempdir().unwrap();
        let old = tmp.path().join("old");
        let new = tmp.path().join("new");
        fs::create_dir_all(old.join("tools/demo/bin")).unwrap();
        let wrapper = format!("@echo off\r\n\"{}/payload.exe\" %*\r\n", old.join("tools/demo").display());
        fs::write(old.join("tools/demo/bin/demo.cmd"), wrapper).unwrap();
        fs::create_dir_all(old.join("tools/ty/venv")).unwrap();
        fs::write(old.join("git-credentials.json"), "secret").unwrap();
        fs::create_dir_all(old.join("index")).unwrap();
        migrate_entries(&old, &new);
        assert!(!old.join("tools/demo").exists());
        assert!(old.join("tools/ty/venv").exists());
        assert!(old.join("git-credentials.json").exists());
        assert!(fs::read_to_string(new.join("tools/demo/bin/demo.cmd")).unwrap().contains("%~dp0.."));
        fs::create_dir_all(old.join("index")).unwrap();
        fs::write(old.join("index/legacy"), "old").unwrap();
        migrate_entries(&old, &new);
        assert!(old.join("index/legacy").exists());
        assert!(!new.join("index/legacy").exists());
    }

    #[cfg(unix)]
    #[test]
    fn copy_failure_does_not_publish_or_remove_source() {
        let tmp = tempfile::tempdir().unwrap();
        let old = tmp.path().join("old");
        let new = tmp.path().join("new");
        fs::create_dir(&old).unwrap();
        fs::write(old.join("payload"), "old").unwrap();
        std::os::unix::fs::symlink(old.join("payload"), old.join("link")).unwrap();
        assert!(copy_then_remove(&old, &new).is_err());
        assert!(old.join("payload").exists());
        assert!(!new.exists());
        assert_eq!(fs::read_dir(tmp.path()).unwrap().count(), 1);
    }

    #[test]
    fn staged_copy_publishes_complete_data_and_preserves_existing_target() {
        let tmp = tempfile::tempdir().unwrap();
        let old = tmp.path().join("old");
        let new = tmp.path().join("new");
        fs::create_dir_all(old.join("nested")).unwrap();
        fs::write(old.join("nested/tool.exe"), "payload").unwrap();
        copy_then_remove(&old, &new).unwrap();
        assert!(!old.exists());
        assert_eq!(fs::read_to_string(new.join("nested/tool.exe")).unwrap(), "payload");
        fs::create_dir(&old).unwrap();
        fs::write(old.join("legacy"), "old").unwrap();
        copy_then_remove(&old, &new).unwrap();
        assert!(old.join("legacy").exists());
        assert!(!new.join("legacy").exists());
        let old_file = tmp.path().join("registry-old.json");
        let new_file = tmp.path().join("registry-new.json");
        fs::write(&old_file, "cached registry").unwrap();
        copy_then_remove(&old_file, &new_file).unwrap();
        assert!(!old_file.exists());
        assert_eq!(fs::read_to_string(new_file).unwrap(), "cached registry");
    }

    #[test]
    fn publication_refuses_existing_files_and_empty_directories() {
        let tmp = tempfile::tempdir().unwrap();
        for directory in [false, true] {
            let old = tmp.path().join(if directory { "old-dir" } else { "old-file" });
            let new = tmp.path().join(if directory { "new-dir" } else { "new-file" });
            if directory {
                fs::create_dir(&old).unwrap();
                fs::create_dir(&new).unwrap();
                fs::write(old.join("payload"), "old").unwrap();
            } else {
                fs::write(&old, "old").unwrap();
                fs::write(&new, "new").unwrap();
            }
            assert!(rename_missing(&old, &new).is_err());
            assert!(old.exists() && new.exists());
            if directory {
                assert!(!new.join("payload").exists());
            } else {
                assert_eq!(fs::read_to_string(new).unwrap(), "new");
            }
        }
    }

    #[test]
    fn wrapper_failure_keeps_the_old_installation() {
        let tmp = tempfile::tempdir().unwrap();
        let old = tmp.path().join("old/tools/demo");
        let new = tmp.path().join("new/tools/demo");
        fs::create_dir_all(old.join("bin")).unwrap();
        fs::write(old.join("bin/demo.cmd"), [0xff, 0xfe]).unwrap();
        assert!(try_rename(&old, &new).is_err());
        assert!(old.join("bin/demo.cmd").exists());
        assert!(!new.exists());
    }

    #[test]
    fn failures_keep_source_without_publishing_partial_data() {
        let tmp = tempfile::tempdir().unwrap();
        let old = tmp.path().join("old");
        let blocker = tmp.path().join("blocker");
        fs::create_dir(&old).unwrap();
        fs::write(old.join("payload"), "old").unwrap();
        fs::write(&blocker, "file").unwrap();
        assert!(try_rename(&old, &blocker.join("target")).is_err());
        assert!(copy_then_remove(&old, &blocker.join("target")).is_err());
        assert!(old.join("payload").exists());
        assert!(copy_then_remove(&tmp.path().join("missing"), &tmp.path().join("new")).is_err());
        assert!(!tmp.path().join("new").exists());
        assert!(
            !fs::read_dir(tmp.path())
                .unwrap()
                .flatten()
                .any(|e| e.file_name().to_string_lossy().starts_with(".migration-"))
        );
    }

    #[test]
    fn custom_override_round_trips_and_validates() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("local-data-dir.txt");
        let migration = tmp.path().join("local-data-migration.json");
        let id = "ai.test.openidea";
        assert_eq!(stored_override_in(&file), None);

        let root = tmp.path().join("custom-root");
        let dir = set_override_in(&file, &Some(migration.clone()), Some(&root), id).unwrap();
        assert_eq!(dir, root.join(id));
        assert!(dir.is_dir());
        assert_eq!(stored_override_in(&file), Some(root.clone()));
        assert_eq!(startup_resolve(None, stored_override_in(&file), Some(tmp.path().join("os")), id).unwrap(), dir);

        // A relative root is rejected before anything is written.
        let before = fs::read_to_string(&file).unwrap();
        let error = set_override_in(&file, &Some(migration.clone()), Some(Path::new("relative")), id).unwrap_err();
        assert!(error.contains("absolute"), "{error}");
        assert_eq!(fs::read_to_string(&file).unwrap(), before);

        // An unwritable root (an existing file) is rejected too.
        let blocker = tmp.path().join("blocker");
        fs::write(&blocker, "").unwrap();
        let error = set_override_in(&file, &Some(migration.clone()), Some(&blocker), id).unwrap_err();
        assert!(error.contains("cannot write"), "{error}");

        // Clearing removes the file and returns the default.
        let dir = set_override_in(&file, &Some(migration), None, id).unwrap();
        assert!(!file.exists());
        assert_eq!(dir, local_data_dir(id).unwrap());
        assert_eq!(stored_override_in(&file), None);
    }

    #[test]
    fn startup_prefers_the_environment_then_the_override() {
        let tmp = tempfile::tempdir().unwrap();
        let os = tmp.path().join("os");
        let custom = tmp.path().join("custom");
        let env = tmp.path().join("env");
        let id = "ai.test.openidea";

        let error = startup_resolve(None, Some(PathBuf::from("relative")), Some(os.clone()), id).unwrap_err();
        assert!(error.contains("absolute"), "{error}");

        // The environment wins over a stored override.
        let dir = startup_resolve(Some(env.clone().into()), Some(custom.clone()), Some(os.clone()), id).unwrap();
        assert_eq!(dir, env.join(id));

        // Without the environment the override wins over the OS default.
        let dir = startup_resolve(None, Some(custom.clone()), Some(os.clone()), id).unwrap();
        assert_eq!(dir, custom.join(id));

        // And without either the OS default applies.
        let dir = startup_resolve(None, None, Some(os.clone()), id).unwrap();
        assert_eq!(dir, os.join(id));
    }

    #[test]
    fn custom_migration_moves_the_tree_and_clears_itself() {
        let tmp = tempfile::tempdir().unwrap();
        let marker = tmp.path().join("local-data-migration.json");
        let from = tmp.path().join("old-local");
        let to = tmp.path().join("new-local");
        fs::create_dir_all(from.join("index/p1")).unwrap();
        fs::write(from.join("index/p1/symbols"), "index").unwrap();
        fs::create_dir_all(from.join("cache/p1")).unwrap();
        fs::write(from.join("cache/p1/build"), "cache").unwrap();
        fs::create_dir_all(from.join("tools/demo/bin")).unwrap();
        fs::write(from.join("tools/demo/bin/demo.cmd"), "payload").unwrap();
        fs::write(from.join("history"), "roaming stays").unwrap();

        // Nothing to move: no marker is written.
        assert!(!schedule_custom_migration_in(&marker, &from, &from).unwrap());
        assert!(!marker.exists());

        assert!(schedule_custom_migration_in(&marker, &from, &to).unwrap());
        apply_custom_migration_in(&marker, &to);
        assert!(!marker.exists());
        assert_eq!(fs::read_to_string(to.join("index/p1/symbols")).unwrap(), "index");
        assert_eq!(fs::read_to_string(to.join("cache/p1/build")).unwrap(), "cache");
        assert!(to.join("tools/demo/bin/demo.cmd").exists());
        assert!(!from.join("index").exists());
        // Roaming content is not local data and stays behind.
        assert_eq!(fs::read_to_string(from.join("history")).unwrap(), "roaming stays");

        // A migration aimed elsewhere is dropped without touching anything.
        fs::create_dir_all(from.join("lsp")).unwrap();
        assert!(schedule_custom_migration_in(&marker, &from, &tmp.path().join("elsewhere")).unwrap());
        apply_custom_migration_in(&marker, &to);
        assert!(!marker.exists());
        assert!(from.join("lsp").exists());
        assert!(!to.join("lsp").exists());
    }

    #[test]
    fn custom_entries_cover_logs_and_agent_tools() {
        let tmp = tempfile::tempdir().unwrap();
        let entries = custom_entries(tmp.path());
        for expected in ["logs", "agents/tools", "index", "cache", "lsp", "agents/registry.json"] {
            assert!(entries.contains(&PathBuf::from(expected)), "{entries:?}");
        }
    }
}
