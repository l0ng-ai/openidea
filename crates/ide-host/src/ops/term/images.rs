use ide_core::{IdeError, IdeResult};
use std::path::Path;

#[cfg(unix)]
mod unix {
    use super::*;
    use rustix::fs::{self, AtFlags, Dir, Mode, OFlags};
    use std::fs::File;
    use std::io::{self, Write};
    use std::os::unix::fs::MetadataExt;
    use std::time::{Duration, SystemTime};

    const LIFETIME: Duration = Duration::from_secs(24 * 60 * 60);
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
            _ => Err(IdeError::invalid("unsupported image type")),
        }
    }

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

    fn owned_name(name: &str) -> bool {
        let name = name.strip_prefix(".partial-").unwrap_or(name);
        let Some((id, ext)) = name.strip_prefix("image-").and_then(|s| s.split_once('.')) else { return false };
        id.len() == 32
            && id.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
            && matches!(ext, "png" | "jpg" | "gif" | "webp" | "bmp" | "svg" | "tiff" | "ico")
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

#[cfg(unix)]
pub(super) use unix::store;

#[cfg(not(unix))]
pub(super) fn store(_data_dir: &Path, _data: &[u8], _mime: &str) -> IdeResult<String> {
    Err(IdeError::internal("private terminal image storage is unsupported on this platform"))
}
