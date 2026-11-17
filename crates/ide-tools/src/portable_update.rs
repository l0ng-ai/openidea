//! In-place updates of the Windows unpack-and-run distribution.

use ide_core::{IdeError, IdeResult};
use std::fs;
use std::io::{self, Cursor};
use std::path::{Path, PathBuf};

/// `bytes` must already have passed the updater's signature verification.
pub fn install(exe: &Path, bytes: &[u8]) -> IdeResult<()> {
    let directory = exe.parent().ok_or_else(|| IdeError::invalid("executable has no parent directory"))?;
    let staging = tempfile::Builder::new().prefix(".openidea-update-").tempdir_in(directory)?;
    let files = unpack(bytes, staging.path(), exe)?;
    let mut replaced = Vec::new();
    for (source, target) in files {
        match replace_file(&source, &target) {
            Ok(backup) => replaced.push((target, backup)),
            Err(error) => {
                for (target, backup) in replaced.into_iter().rev() {
                    fs::remove_file(&target)?;
                    if let Some(backup) = backup {
                        fs::rename(&backup, &target).map_err(|restore| {
                            IdeError::internal(format!(
                                "{error}; restore {} from {}: {restore}",
                                target.display(),
                                backup.display()
                            ))
                        })?;
                    }
                }
                return Err(error);
            }
        }
    }
    Ok(())
}

/// Old executables stay locked until their process exits; retry cleanup on the next start.
pub fn cleanup(exe: &Path) {
    for target in [exe.to_path_buf(), exe.with_file_name("WebView2Loader.dll")] {
        let _ = fs::remove_file(backup_path(&target));
    }
}

fn unpack(bytes: &[u8], staging: &Path, exe: &Path) -> IdeResult<Vec<(PathBuf, PathBuf)>> {
    let invalid = |error| IdeError::invalid(format!("portable update archive: {error}"));
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).map_err(invalid)?;
    let mut files = Vec::new();
    let mut has_exe = false;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(invalid)?;
        let name = entry.name().map_err(invalid)?;
        let target = match name.as_ref() {
            "openidea.exe" => {
                has_exe = true;
                exe.to_path_buf()
            }
            "WebView2Loader.dll" => exe.with_file_name("WebView2Loader.dll"),
            name => return Err(IdeError::invalid(format!("unexpected portable update file: {name}"))),
        };
        if !entry.is_file() || entry.is_symlink() || files.iter().any(|(_, path)| path == &target) {
            return Err(IdeError::invalid("portable update contains a duplicate or non-regular file"));
        }
        let source = staging.join(name.as_ref());
        let mut file = fs::File::create(&source)?;
        io::copy(&mut entry, &mut file)?;
        file.sync_all()?;
        files.push((source, target));
    }
    if !has_exe {
        return Err(IdeError::invalid("portable update is missing openidea.exe"));
    }
    Ok(files)
}

fn replace_file(source: &Path, target: &Path) -> IdeResult<Option<PathBuf>> {
    let backup = if target.try_exists()? {
        if !target.is_file() {
            return Err(IdeError::invalid(format!("not an application file: {}", target.display())));
        }
        let backup = backup_path(target);
        if backup.try_exists()? {
            fs::remove_file(&backup)?;
        }
        // Windows forbids overwriting a running exe, but allows renaming it.
        fs::rename(target, &backup)?;
        Some(backup)
    } else {
        None
    };
    if let Err(error) = fs::rename(source, target) {
        if let Some(backup) = &backup {
            fs::rename(backup, target).map_err(|restore| {
                IdeError::internal(format!(
                    "{error}; restore {} from {}: {restore}",
                    target.display(),
                    backup.display()
                ))
            })?;
        }
        return Err(error.into());
    }
    Ok(backup)
}

fn backup_path(target: &Path) -> PathBuf {
    let mut path = target.as_os_str().to_os_string();
    path.push(".openidea-old");
    PathBuf::from(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn package(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name, bytes) in files {
            zip.start_file(*name, zip::write::SimpleFileOptions::default()).unwrap();
            zip.write_all(bytes).unwrap();
        }
        zip.finish().unwrap().into_inner()
    }

    #[test]
    fn replaces_application_files_and_preserves_configuration() {
        for name in ["openidea.exe", "我的 IDE.exe"] {
            let tmp = tempfile::tempdir().unwrap();
            let exe = tmp.path().join(name);
            fs::write(&exe, b"old exe").unwrap();
            fs::write(tmp.path().join("WebView2Loader.dll"), b"old dll").unwrap();
            fs::write(tmp.path().join("settings.toml"), b"my settings").unwrap();
            fs::create_dir(tmp.path().join("data")).unwrap();
            fs::write(tmp.path().join("data/plugins.json"), b"my plugins").unwrap();
            let bytes = package(&[("openidea.exe", b"new exe"), ("WebView2Loader.dll", b"new dll")]);
            install(&exe, &bytes).unwrap();
            assert_eq!(fs::read(&exe).unwrap(), b"new exe");
            assert_eq!(fs::read(tmp.path().join("WebView2Loader.dll")).unwrap(), b"new dll");
            assert_eq!(fs::read(tmp.path().join("settings.toml")).unwrap(), b"my settings");
            assert_eq!(fs::read(tmp.path().join("data/plugins.json")).unwrap(), b"my plugins");
            cleanup(&exe);
            assert!(!backup_path(&exe).exists());
            assert!(!backup_path(&tmp.path().join("WebView2Loader.dll")).exists());
        }
    }

    #[test]
    fn accepts_an_exe_only_package() {
        let tmp = tempfile::tempdir().unwrap();
        let exe = tmp.path().join("openidea.exe");
        fs::write(&exe, b"old").unwrap();
        install(&exe, &package(&[("openidea.exe", b"new")])).unwrap();
        assert_eq!(fs::read(&exe).unwrap(), b"new");
    }

    #[test]
    fn rejects_incomplete_or_unexpected_payloads_before_changing_files() {
        for files in [
            vec![("WebView2Loader.dll", b"new".as_slice())],
            vec![("openidea.exe", b"new"), ("settings.toml", b"overwrite")],
            vec![("openidea.exe", b"new"), ("../outside.txt", b"escape")],
        ] {
            let tmp = tempfile::tempdir().unwrap();
            let exe = tmp.path().join("openidea.exe");
            fs::write(&exe, b"old").unwrap();
            assert!(install(&exe, &package(&files)).is_err());
            assert_eq!(fs::read(&exe).unwrap(), b"old");
        }
    }

    #[cfg(windows)]
    #[test]
    fn updates_a_running_executable_and_restores_on_a_locked_companion() {
        use std::os::windows::fs::OpenOptionsExt;
        use std::process::{Command, Stdio};

        let tmp = tempfile::tempdir().unwrap();
        let exe = tmp.path().join("openidea.exe");
        let ping = Path::new(&std::env::var_os("SystemRoot").unwrap()).join("System32/PING.EXE");
        fs::copy(ping, &exe).unwrap();
        let original = fs::read(&exe).unwrap();
        let dll = tmp.path().join("WebView2Loader.dll");
        fs::write(&dll, b"old dll").unwrap();
        let mut command = Command::new(&exe);
        command.args(["-n", "30", "127.0.0.1"]).stdout(Stdio::null()).stderr(Stdio::null());
        ide_core::process::prepare(&mut command);
        let mut child = command.spawn().unwrap();
        let result = {
            assert!(fs::write(&exe, b"overwrite").is_err(), "fixture must hold the running exe");
            let held = fs::OpenOptions::new().read(true).share_mode(1).open(&dll).unwrap();
            let bytes = package(&[("openidea.exe", b"new exe"), ("WebView2Loader.dll", b"new dll")]);
            assert!(install(&exe, &bytes).is_err());
            assert_eq!(fs::read(&exe).unwrap(), original);
            assert_eq!(fs::read(&dll).unwrap(), b"old dll");
            drop(held);
            install(&exe, &bytes)
        };
        let _ = child.kill();
        let _ = child.wait();
        result.unwrap();
        assert_eq!(fs::read(&exe).unwrap(), b"new exe");
        assert_eq!(fs::read(&dll).unwrap(), b"new dll");
        cleanup(&exe);
        assert!(!backup_path(&exe).exists());
    }

    #[cfg(windows)]
    #[test]
    fn restores_the_old_file_when_the_new_file_cannot_be_moved() {
        use std::os::windows::fs::OpenOptionsExt;

        let tmp = tempfile::tempdir().unwrap();
        let exe = tmp.path().join("openidea.exe");
        let source = tmp.path().join("new.exe");
        fs::write(&exe, b"old").unwrap();
        fs::write(&source, b"new").unwrap();
        let _held = fs::OpenOptions::new().read(true).share_mode(1).open(&source).unwrap();
        assert!(replace_file(&source, &exe).is_err());
        assert_eq!(fs::read(&exe).unwrap(), b"old");
        assert_eq!(fs::read(&source).unwrap(), b"new");
        assert!(!backup_path(&exe).exists());
    }
}
