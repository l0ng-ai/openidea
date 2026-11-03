use ide_core::{IdeError, IdeResult};
use std::path::Path;

const LIFETIME: std::time::Duration = std::time::Duration::from_secs(24 * 60 * 60);
const DIRECTORY: &str = "terminal-images";

fn extension(mime: &str) -> IdeResult<&str> {
    match mime {
        "image/png" => Ok("png"),
        "image/jpeg" => Ok("jpg"),
        "image/gif" => Ok("gif"),
        "image/webp" => Ok("webp"),
        "image/bmp" => Ok("bmp"),
        "image/svg+xml" => Ok("svg"),
        "image/tiff" => Ok("tiff"),
        "image/x-icon" => Ok("ico"),
        "audio/wav" | "audio/x-wav" => Ok("wav"),
        "audio/mpeg" => Ok("mp3"),
        "audio/mp4" => Ok("m4a"),
        "audio/ogg" => Ok("ogg"),
        "audio/webm" | "video/webm" => Ok("webm"),
        "audio/flac" => Ok("flac"),
        "audio/aac" => Ok("aac"),
        "video/mp4" => Ok("mp4"),
        "video/ogg" => Ok("ogv"),
        "video/quicktime" => Ok("mov"),
        _ => Err(IdeError::invalid("unsupported clipboard media type")),
    }
}

fn owned_name(name: &str) -> bool {
    let name = name.strip_prefix(".partial-").unwrap_or(name);
    let Some((id, ext)) = name.strip_prefix("image-").and_then(|s| s.split_once('.')) else { return false };
    id.len() == 32
        && id.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        && matches!(
            ext,
            "png"
                | "jpg"
                | "gif"
                | "webp"
                | "bmp"
                | "svg"
                | "tiff"
                | "ico"
                | "wav"
                | "mp3"
                | "m4a"
                | "ogg"
                | "webm"
                | "flac"
                | "aac"
                | "mp4"
                | "ogv"
                | "mov"
        )
}

#[cfg(unix)]
mod unix {
    use super::*;
    use rustix::fs::{self, AtFlags, Dir, Mode, OFlags};
    use std::fs::File;
    use std::io::{self, Write};
    use std::os::unix::fs::MetadataExt;
    use std::time::SystemTime;

    fn open_directory(data_dir: &Path) -> io::Result<File> {
        if !data_dir.is_absolute() {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "data directory must be absolute"));
        }
        // The configured data directory and its ancestors are the host's trust boundary.
        let parent =
            fs::open(data_dir, OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC, Mode::empty())?;
        match fs::mkdirat(&parent, DIRECTORY, Mode::from_bits_truncate(0o700)) {
            Ok(()) | Err(rustix::io::Errno::EXIST) => (),
            Err(e) => return Err(e.into()),
        }
        let dir: File = fs::openat(
            &parent,
            DIRECTORY,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )?
        .into();
        let meta = dir.metadata()?;
        if meta.uid() != rustix::process::geteuid().as_raw() || meta.mode() & 0o7777 != 0o700 {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "terminal image directory is not private or owned by the current user",
            ));
        }
        Ok(dir)
    }

    fn cleanup(dir: &File, now: SystemTime) -> io::Result<()> {
        for entry in Dir::read_from(dir)? {
            let entry = entry?;
            let name = entry.file_name();
            if !name.to_str().is_ok_and(owned_name) {
                continue;
            }
            // Never follow symlinks; opening nonblocking avoids hanging on an unexpected FIFO.
            let fd = match fs::openat(
                dir,
                name,
                OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
                Mode::empty(),
            ) {
                Ok(fd) => fd,
                Err(_) => continue,
            };
            let file = File::from(fd);
            let meta = file.metadata()?;
            if meta.is_file()
                && meta.uid() == rustix::process::geteuid().as_raw()
                && meta
                    .modified()
                    .ok()
                    .and_then(|time| now.duration_since(time).ok())
                    .is_some_and(|age| age >= LIFETIME)
            {
                match fs::unlinkat(dir, name, AtFlags::empty()) {
                    Ok(()) | Err(rustix::io::Errno::NOENT) => (),
                    Err(error) => return Err(error.into()),
                }
            }
        }
        Ok(())
    }

    fn store_with(
        data_dir: &Path,
        data: &[u8],
        mime: &str,
        now: SystemTime,
        write: impl FnOnce(&mut File, &[u8]) -> io::Result<()>,
    ) -> IdeResult<String> {
        let ext = extension(mime)?;
        let dir = open_directory(data_dir)?;
        cleanup(&dir, now)?;
        let name = format!("image-{}.{}", uuid::Uuid::new_v4().simple(), ext);
        let temporary = format!(".partial-{name}");
        let fd = fs::openat(
            &dir,
            temporary.as_str(),
            OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::from_bits_truncate(0o600),
        )
        .map_err(io::Error::from)?;
        let mut file = File::from(fd);
        if let Err(error) = write(&mut file, data) {
            let _ = fs::unlinkat(&dir, temporary.as_str(), AtFlags::empty());
            return Err(error.into());
        }
        if let Err(error) = fs::linkat(&dir, temporary.as_str(), &dir, name.as_str(), AtFlags::empty()) {
            let _ = fs::unlinkat(&dir, temporary.as_str(), AtFlags::empty());
            return Err(io::Error::from(error).into());
        }
        let _ = fs::unlinkat(&dir, temporary.as_str(), AtFlags::empty());
        Ok(data_dir.join(DIRECTORY).join(name).to_string_lossy().into_owned())
    }

    pub(in crate::ops::term) fn store(data_dir: &Path, data: &[u8], mime: &str) -> IdeResult<String> {
        store_with(data_dir, data, mime, SystemTime::now(), |file, bytes| file.write_all(bytes))
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::fs;
        use std::os::unix::fs::{PermissionsExt, symlink};
        use std::time::Duration;

        #[test]
        fn stores_bytes_with_private_modes_and_unpredictable_names() {
            let root = tempfile::tempdir().unwrap();
            let first = store(root.path(), b"image bytes", "image/png").unwrap();
            let second = store(root.path(), b"other", "image/jpeg").unwrap();
            assert_ne!(first, second);
            assert_eq!(fs::read(&first).unwrap(), b"image bytes");
            assert_eq!(fs::metadata(&first).unwrap().permissions().mode() & 0o777, 0o600);
            assert_eq!(fs::metadata(root.path().join(DIRECTORY)).unwrap().permissions().mode() & 0o777, 0o700);
            assert!(owned_name(Path::new(&first).file_name().unwrap().to_str().unwrap()));
        }

        #[test]
        fn expiry_only_removes_owned_regular_files_at_boundary() {
            let root = tempfile::tempdir().unwrap();
            let dir = open_directory(root.path()).unwrap();
            let path = root.path().join(DIRECTORY);
            let now = SystemTime::now();
            let names = [
                "image-00000000000000000000000000000001.png",
                "image-00000000000000000000000000000002.png",
                "image-00000000000000000000000000000003.png",
                "unrelated.png",
            ];
            for (name, time) in names.iter().zip([
                now - LIFETIME,
                now - LIFETIME + Duration::from_secs(1),
                now + Duration::from_secs(1),
                now - LIFETIME,
            ]) {
                let file = File::create(path.join(name)).unwrap();
                file.set_times(fs::FileTimes::new().set_modified(time)).unwrap();
            }
            let link = path.join("image-00000000000000000000000000000004.png");
            symlink(path.join(names[0]), &link).unwrap();
            cleanup(&dir, now).unwrap();
            assert!(!path.join(names[0]).exists());
            for name in &names[1..] {
                assert!(path.join(name).exists());
            }
            assert!(fs::symlink_metadata(link).unwrap().file_type().is_symlink());
        }

        #[test]
        fn rejects_symlink_and_insecure_directory() {
            let root = tempfile::tempdir().unwrap();
            let outside = tempfile::tempdir().unwrap();
            let target = root.path().join(DIRECTORY);
            symlink(outside.path(), &target).unwrap();
            assert!(store(root.path(), b"x", "image/png").is_err());
            fs::remove_file(&target).unwrap();
            fs::create_dir(&target).unwrap();
            fs::set_permissions(&target, fs::Permissions::from_mode(0o755)).unwrap();
            assert!(store(root.path(), b"x", "image/png").is_err());
            assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
        }

        #[test]
        fn failed_write_removes_partial_file() {
            let root = tempfile::tempdir().unwrap();
            let result = store_with(root.path(), b"partial", "image/png", SystemTime::now(), |file, bytes| {
                file.write_all(bytes)?;
                Err(io::Error::other("simulated failure"))
            });
            assert!(result.is_err());
            assert_eq!(fs::read_dir(root.path().join(DIRECTORY)).unwrap().count(), 0);
        }
    }
}

#[cfg(windows)]
mod windows {
    use super::*;
    use std::fs::{self, File, OpenOptions};
    use std::io::{self, Write};
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    use std::time::SystemTime;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ,
        FILE_SHARE_WRITE,
    };

    fn open_directory(path: &Path) -> io::Result<File> {
        if !path.is_absolute() {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "data directory must be absolute"));
        }
        let dir = OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)?;
        let meta = dir.metadata()?;
        if !meta.is_dir() || meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "terminal media directory must not be a reparse point",
            ));
        }
        Ok(dir)
    }

    fn cleanup(path: &Path, now: SystemTime) -> io::Result<()> {
        for entry in fs::read_dir(path)? {
            let entry = entry?;
            if !entry.file_name().to_str().is_some_and(owned_name) {
                continue;
            }
            let file = match OpenOptions::new().read(true).custom_flags(FILE_FLAG_OPEN_REPARSE_POINT).open(entry.path())
            {
                Ok(file) => file,
                Err(_) => continue,
            };
            let meta = file.metadata()?;
            if meta.is_file()
                && meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0
                && meta
                    .modified()
                    .ok()
                    .and_then(|time| now.duration_since(time).ok())
                    .is_some_and(|age| age >= LIFETIME)
            {
                match fs::remove_file(entry.path()) {
                    Ok(()) => (),
                    Err(error) if error.kind() == io::ErrorKind::NotFound => (),
                    Err(error) => return Err(error),
                }
            }
        }
        Ok(())
    }

    fn store_with(
        data_dir: &Path,
        data: &[u8],
        mime: &str,
        now: SystemTime,
        write: impl FnOnce(&mut File, &[u8]) -> io::Result<()>,
    ) -> IdeResult<String> {
        let ext = extension(mime)?;
        let _parent = open_directory(data_dir)?;
        let path = data_dir.join(DIRECTORY);
        match fs::create_dir(&path) {
            Ok(()) => (),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => (),
            Err(error) => return Err(error.into()),
        }
        let _dir = open_directory(&path)?;
        cleanup(&path, now)?;
        let name = format!("image-{}.{}", uuid::Uuid::new_v4().simple(), ext);
        let target = path.join(&name);
        let temporary = path.join(format!(".partial-{name}"));
        let mut file = OpenOptions::new().write(true).create_new(true).open(&temporary)?;
        let result = write(&mut file, data);
        drop(file);
        if let Err(error) = result {
            let _ = fs::remove_file(&temporary);
            return Err(error.into());
        }
        if let Err(error) = fs::hard_link(&temporary, &target) {
            let _ = fs::remove_file(&temporary);
            return Err(error.into());
        }
        let _ = fs::remove_file(&temporary);
        Ok(target.to_string_lossy().into_owned())
    }

    pub(in crate::ops::term) fn store(data_dir: &Path, data: &[u8], mime: &str) -> IdeResult<String> {
        store_with(data_dir, data, mime, SystemTime::now(), |file, bytes| file.write_all(bytes))
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::time::Duration;

        fn junction(path: &Path, target: &Path) {
            let output = std::process::Command::new("powershell.exe")
                .args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    "New-Item -ItemType Junction -Path $env:OPENIDEA_TEST_JUNCTION -Target $env:OPENIDEA_TEST_TARGET -ErrorAction Stop | Out-Null",
                ])
                .env("OPENIDEA_TEST_JUNCTION", path)
                .env("OPENIDEA_TEST_TARGET", target)
                .output()
                .unwrap();
            assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        }

        #[test]
        fn rejects_reparse_data_and_storage_directories() {
            let root = tempfile::tempdir().unwrap();
            let outside = tempfile::tempdir().unwrap();
            let link = root.path().join("data");
            junction(&link, outside.path());
            assert!(store(&link, b"x", "image/png").is_err());
            assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
            fs::remove_dir(&link).unwrap();
            let link = root.path().join(DIRECTORY);
            junction(&link, outside.path());
            assert!(store(root.path(), b"x", "image/png").is_err());
            assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
            fs::remove_dir(&link).unwrap();
        }

        #[test]
        fn expiry_only_removes_owned_regular_media_at_boundary() {
            let root = tempfile::tempdir().unwrap();
            let outside = tempfile::tempdir().unwrap();
            let path = root.path().join(DIRECTORY);
            fs::create_dir(&path).unwrap();
            let _dir = open_directory(&path).unwrap();
            let now = SystemTime::now();
            let names = [
                "image-00000000000000000000000000000001.png",
                "image-00000000000000000000000000000002.mp3",
                ".partial-image-00000000000000000000000000000003.mp4",
                "image-00000000000000000000000000000004.webm",
                "image-00000000000000000000000000000005.wav",
                "unrelated.png",
                "image-00000000000000000000000000000006.exe",
            ];
            for (name, time) in names.iter().zip([
                now - LIFETIME,
                now - LIFETIME,
                now - LIFETIME,
                now - LIFETIME + Duration::from_secs(1),
                now + Duration::from_secs(1),
                now - LIFETIME,
                now - LIFETIME,
            ]) {
                let file = File::create(path.join(name)).unwrap();
                file.set_times(fs::FileTimes::new().set_modified(time)).unwrap();
            }
            let link = path.join("image-00000000000000000000000000000007.png");
            junction(&link, outside.path());
            let directory = path.join("image-00000000000000000000000000000008.png");
            fs::create_dir(&directory).unwrap();
            cleanup(&path, now).unwrap();
            for name in &names[..3] {
                assert!(!path.join(name).exists());
            }
            for name in &names[3..] {
                assert!(path.join(name).exists());
            }
            assert!(directory.is_dir());
            assert!(fs::symlink_metadata(&link).unwrap().file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0);
            fs::remove_dir(link).unwrap();
        }

        #[test]
        fn failed_write_removes_partial_file() {
            let root = tempfile::tempdir().unwrap();
            let result = store_with(root.path(), b"partial", "audio/ogg", SystemTime::now(), |file, bytes| {
                file.write_all(bytes)?;
                Err(io::Error::other("simulated failure"))
            });
            assert!(result.is_err());
            assert_eq!(fs::read_dir(root.path().join(DIRECTORY)).unwrap().count(), 0);
        }

        #[test]
        fn publication_preserves_existing_target() {
            let root = tempfile::tempdir().unwrap();
            let path = root.path().join(DIRECTORY);
            let result = store_with(root.path(), b"new", "video/mp4", SystemTime::now(), |file, bytes| {
                file.write_all(bytes)?;
                let temporary = fs::read_dir(&path)?.next().unwrap()?.file_name();
                let target = temporary.to_str().unwrap().strip_prefix(".partial-").unwrap();
                fs::write(path.join(target), b"existing")
            });
            assert!(result.is_err());
            let files: Vec<_> = fs::read_dir(&path).unwrap().map(|entry| entry.unwrap().path()).collect();
            assert_eq!(files.len(), 1);
            assert_eq!(fs::read(&files[0]).unwrap(), b"existing");
            assert!(!files[0].file_name().unwrap().to_str().unwrap().starts_with(".partial-"));
        }

        #[test]
        fn storage_handles_prevent_directory_replacement() {
            let root = tempfile::tempdir().unwrap();
            let path = root.path().join(DIRECTORY);
            let result = store_with(root.path(), b"x", "image/png", SystemTime::now(), |file, bytes| {
                assert!(fs::rename(&path, root.path().join("replaced")).is_err());
                file.write_all(bytes)
            });
            assert_eq!(fs::read(result.unwrap()).unwrap(), b"x");
        }
    }
}

#[cfg(unix)]
pub(super) use unix::store;

#[cfg(windows)]
pub(super) use windows::store;

#[cfg(not(any(unix, windows)))]
pub(super) fn store(_data_dir: &Path, _data: &[u8], _mime: &str) -> IdeResult<String> {
    Err(IdeError::internal("private terminal image storage is unsupported on this platform"))
}

#[cfg(all(test, any(unix, windows)))]
mod tests {
    use super::*;

    #[test]
    fn stores_supported_media_with_expected_extensions_and_unique_names() {
        let root = tempfile::tempdir().unwrap();
        let types = [
            ("image/png", "png"),
            ("image/jpeg", "jpg"),
            ("image/gif", "gif"),
            ("image/webp", "webp"),
            ("image/bmp", "bmp"),
            ("image/svg+xml", "svg"),
            ("image/tiff", "tiff"),
            ("image/x-icon", "ico"),
            ("audio/wav", "wav"),
            ("audio/x-wav", "wav"),
            ("audio/mpeg", "mp3"),
            ("audio/mp4", "m4a"),
            ("audio/ogg", "ogg"),
            ("audio/webm", "webm"),
            ("audio/flac", "flac"),
            ("audio/aac", "aac"),
            ("video/mp4", "mp4"),
            ("video/webm", "webm"),
            ("video/ogg", "ogv"),
            ("video/quicktime", "mov"),
        ];
        let mut paths = std::collections::HashSet::new();
        for (mime, ext) in types {
            let path = store(root.path(), mime.as_bytes(), mime).unwrap();
            assert_eq!(std::fs::read(&path).unwrap(), mime.as_bytes());
            assert_eq!(Path::new(&path).extension().unwrap(), ext);
            assert!(owned_name(Path::new(&path).file_name().unwrap().to_str().unwrap()));
            assert!(paths.insert(path));
        }
        assert_eq!(std::fs::read_dir(root.path().join(DIRECTORY)).unwrap().count(), types.len());
    }

    #[test]
    fn rejects_unsupported_mime_before_creating_storage() {
        let root = tempfile::tempdir().unwrap();
        for mime in ["text/plain", "application/octet-stream", "image/unknown", "audio/unknown", "video/unknown", ""] {
            let error = store(root.path(), b"x", mime).unwrap_err();
            assert_eq!(error.kind, ide_core::error::ErrorKind::InvalidInput);
            assert_eq!(error.message, "unsupported clipboard media type");
        }
        assert!(!root.path().join(DIRECTORY).exists());
    }

    #[test]
    fn rejects_relative_data_directory() {
        assert!(store(Path::new("relative-data"), b"x", "image/png").is_err());
    }
}
