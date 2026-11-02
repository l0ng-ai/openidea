//! Storage policy and best-effort migration of rebuildable desktop data.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

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
    let mut entries: Vec<PathBuf> = [
        "language-server-runtimes",
        "index",
        "cache",
        "lsp",
        "notebook-runtime",
        "server",
        "java-usages-1.1.1.jar",
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
    let mut copies = Vec::new();
    for entry in entries {
        let source = data.join(&entry);
        let target = data_path(data, local, &entry);
        match try_rename(&source, &target) {
            Ok(true) => copies.push((source, target)),
            Ok(false) => {}
            Err(error) => {
                tracing::warn!(?source, ?target, %error, "data migration failed; keeping old data, using Local")
            }
        }
    }
    if !copies.is_empty() {
        let result = std::thread::Builder::new().name("openidea-data-migration".into()).spawn(move || {
            for (source, target) in copies {
                tracing::info!(?source, ?target, "copying legacy data in background");
                if let Err(error) = copy_then_remove(&source, &target) {
                    tracing::warn!(?source, ?target, %error, "data copy failed; keeping old data, using Local");
                }
            }
        });
        if let Err(error) = result {
            tracing::warn!(%error, "cannot start data migration worker; keeping old data, using Local");
        }
    }
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
}
