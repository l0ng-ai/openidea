//! Raw byte access for non-text viewers (image viewer, hex view): a cheap
//! probe deciding whether a file is text, and bounded reads encoded as base64
//! so they travel over JSON IPC compactly.

use crate::encoding::looks_binary;
use crate::{READ_ONLY_THRESHOLD, SNIFF_LEN};
use ide_core::{IdeError, IdeResult};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// Largest chunk one [`read_range`] call returns (the hex view pages through files).
pub const MAX_RANGE_LEN: u32 = 1024 * 1024;
/// Largest image [`read_data_url`] inlines.
pub const MAX_IMAGE_SIZE: u64 = 64 * 1024 * 1024;

/// What the editor needs to know before choosing a viewer for a file.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FileProbe {
    pub size: u64,
    /// Content looks binary (same heuristic as text loading).
    pub binary: bool,
    /// Above the read-only threshold: the text editor would open it read-only.
    pub too_large: bool,
}

/// A slice of a file: `data` is base64; `total` is the file size.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ByteRange {
    pub offset: u64,
    pub data: String,
    pub total: u64,
}

/// Entry bytes of an archive path (`<archive>!/<entry>`), `None` for ordinary paths.
fn archive_bytes(path: &Path, limit: u64) -> IdeResult<Option<Vec<u8>>> {
    let Some((archive, entry)) = crate::split_archive_path(path) else { return Ok(None) };
    let (size, _) = crate::archive::entry_size(&archive, &entry)?;
    if size > limit {
        return Err(IdeError::invalid(format!("{} is too large ({} MiB)", path.display(), size / (1024 * 1024))));
    }
    Ok(Some(crate::read_archive_entry(&archive, &entry)?.0))
}

/// Reads only the head of the file to classify it.
pub fn probe(path: &Path) -> IdeResult<FileProbe> {
    if let Some((archive, entry)) = crate::split_archive_path(path) {
        let (size, _) = crate::archive::entry_size(&archive, &entry)?;
        let head =
            if size > crate::MAX_OPEN_SIZE { Vec::new() } else { crate::read_archive_entry(&archive, &entry)?.0 };
        return Ok(FileProbe { size, binary: looks_binary(&head), too_large: size > READ_ONLY_THRESHOLD });
    }
    let meta = fs::metadata(path)?;
    if meta.is_dir() {
        return Err(IdeError::invalid(format!("{} is a directory", path.display())));
    }
    let mut head = Vec::with_capacity(SNIFF_LEN);
    File::open(path)?.take(SNIFF_LEN as u64).read_to_end(&mut head)?;
    Ok(FileProbe { size: meta.len(), binary: looks_binary(&head), too_large: meta.len() > READ_ONLY_THRESHOLD })
}

/// Reads up to `len` bytes (capped at [`MAX_RANGE_LEN`]) from `offset`.
pub fn read_range(path: &Path, offset: u64, len: u32) -> IdeResult<ByteRange> {
    if let Some(bytes) = archive_bytes(path, crate::MAX_OPEN_SIZE)? {
        let total = bytes.len() as u64;
        let offset = offset.min(total);
        let end = (offset + u64::from(len.min(MAX_RANGE_LEN))).min(total);
        return Ok(ByteRange { offset, data: base64(&bytes[offset as usize..end as usize]), total });
    }
    let mut file = File::open(path)?;
    let total = file.metadata()?.len();
    let offset = offset.min(total);
    let len = u64::from(len.min(MAX_RANGE_LEN)).min(total - offset);
    file.seek(SeekFrom::Start(offset))?;
    let mut buf = Vec::with_capacity(len as usize);
    file.take(len).read_to_end(&mut buf)?;
    Ok(ByteRange { offset, data: base64(&buf), total })
}

/// MIME type of the image formats the viewer shows, by extension.
pub fn image_mime(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "bmp" => "image/bmp",
        "avif" => "image/avif",
        _ => return None,
    })
}

/// The server and share of a Windows network path (`\\server\share\…`, also written with `/`
/// or as `\\?\UNC\…`).
#[cfg(windows)]
fn share(path: &Path) -> Option<(&std::ffi::OsStr, &std::ffi::OsStr)> {
    use std::path::{Component, Prefix};
    let mut components = path.components();
    let Component::Prefix(prefix) = components.next()? else { return None };
    match prefix.kind() {
        // `//?/UNC/server/share`, the spelling a canonical share path crosses the IPC boundary
        // in (`ide_core::ipc_path`): with `/`, `std` reads the share `UNC` of a server `?`.
        Prefix::UNC(device, unc) if device == "?" => {
            let names = (components.next()?, components.next()?, components.next()?);
            match names {
                (Component::RootDir, Component::Normal(server), Component::Normal(share))
                    if unc.eq_ignore_ascii_case("UNC") =>
                {
                    Some((server, share))
                }
                _ => None,
            }
        }
        Prefix::UNC(server, share) | Prefix::VerbatimUNC(server, share) => Some((server, share)),
        _ => None,
    }
}

/// Whether `path` names a file on one of this machine's drives. On Windows that is an absolute
/// path starting at a drive letter. Every other spelling can lead to a server, and opening a
/// share signs in to its server with the user's credentials: `\\server\share`, `\\?\UNC\…`,
/// device paths, and `\??\UNC\…`, which carries no prefix `std` knows and which Windows opens
/// as written.
pub fn on_local_drive(path: &Path) -> bool {
    #[cfg(windows)]
    {
        use std::path::{Component, Prefix};
        path.is_absolute()
            && matches!(
                path.components().next(),
                Some(Component::Prefix(prefix)) if matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_))
            )
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        true
    }
}

/// Whether two network paths are on the same share of the same server.
pub fn same_share(a: &Path, b: &Path) -> bool {
    #[cfg(windows)]
    {
        let same = |x: &std::ffi::OsStr, y: &std::ffi::OsStr| x.eq_ignore_ascii_case(y);
        matches!((share(a), share(b)), (Some(a), Some(b)) if same(a.0, b.0) && same(a.1, b.1))
    }
    #[cfg(not(windows))]
    {
        let _ = (a, b);
        false
    }
}

/// Whether a path written in content (Markdown, a page, an agent's reply) may be opened: one
/// on a local drive, or on the share one of `opened` (what the user opened) is on.
pub fn content_path_allowed<P: AsRef<Path>>(path: &Path, opened: &[P]) -> bool {
    on_local_drive(path) || opened.iter().any(|o| same_share(o.as_ref(), path))
}

/// The whole image as a `data:` URL (allowed by the webview's CSP, unlike file URLs). The path
/// often comes from text someone else wrote (Markdown): see [`content_path_allowed`].
pub fn read_data_url(path: &Path, opened: &[std::path::PathBuf]) -> IdeResult<String> {
    if !content_path_allowed(path, opened) {
        return Err(IdeError::invalid(format!("{} is not on a local drive or an opened share", path.display())));
    }
    let mime =
        image_mime(path).ok_or_else(|| IdeError::invalid(format!("{} is not a supported image", path.display())))?;
    if let Some(bytes) = archive_bytes(path, MAX_IMAGE_SIZE)? {
        return Ok(format!("data:{mime};base64,{}", base64(&bytes)));
    }
    let meta = fs::metadata(path)?;
    if meta.len() > MAX_IMAGE_SIZE {
        return Err(IdeError::invalid(format!(
            "{} is too large to preview ({} MiB)",
            path.display(),
            meta.len() / (1024 * 1024)
        )));
    }
    let bytes = fs::read(path)?;
    Ok(format!("data:{mime};base64,{}", base64(&bytes)))
}

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Standard base64 with padding.
pub fn base64(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(chunk.get(1).copied().unwrap_or(0)) << 8)
            | u32::from(chunk.get(2).copied().unwrap_or(0));
        let sextet = |shift: u32| ALPHABET[((n >> shift) & 63) as usize] as char;
        out.push(sextet(18));
        out.push(sextet(12));
        out.push(if chunk.len() > 1 { sextet(6) } else { '=' });
        out.push(if chunk.len() > 2 { sextet(0) } else { '=' });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Security audit lead 3: an image path from agent markdown must not make the host open a
    /// network share (on Windows that authenticates to the named host with the user's credentials).
    #[cfg(windows)]
    #[test]
    fn read_data_url_refuses_network_paths() {
        let dir = tempfile::tempdir().unwrap();
        let local = dir.path().join("dummy.png");
        std::fs::write(&local, b"\x89PNG dummy").unwrap();
        // The same file reached over SMB through the loopback admin share.
        let s = local.to_str().unwrap();
        let back = format!(r"\\127.0.0.1\{}${}", &s[..1], &s[2..]);
        // The webview hands the host the forward-slash form (`file://host/share` -> `//host/share`).
        let forward = back.replace('\\', "/");
        // The NT spelling: no `\\` in front, and Windows opens it all the same.
        let nt = format!(r"\??\UNC{}", &back[1..]);
        for unc in [forward, back, nt].map(std::path::PathBuf::from) {
            assert!(
                std::fs::read(&unc).is_ok(),
                "control: {} is not reachable over SMB, fixture not live",
                unc.display()
            );
            let read = read_data_url(&unc, &[]);
            assert!(read.is_err(), "read_data_url opened {} over SMB: {:?}", unc.display(), read.map(|s| s.len()));
        }
    }

    /// The exception to the above: an image on the share a project is open on, and only there.
    #[cfg(windows)]
    #[test]
    fn read_data_url_reads_the_share_a_project_is_on() {
        let dir = tempfile::tempdir().unwrap();
        let local = dir.path().join("dummy.png");
        std::fs::write(&local, b"\x89PNG dummy").unwrap();
        let s = local.to_str().unwrap();
        let on = |server: &str| std::path::PathBuf::from(format!(r"\\{server}\{}${}", &s[..1], &s[2..]));
        let image = on("127.0.0.1");
        let wanted = read_data_url(&local, &[]).unwrap();
        // A project root as typed, and as `canonicalize` returns it.
        for root in [r"\\127.0.0.1\C$\work", r"\\?\UNC\127.0.0.1\c$\work"].map(std::path::PathBuf::from) {
            let opened = [std::path::PathBuf::from(r"D:\other"), root];
            assert_eq!(read_data_url(&image, &opened).unwrap(), wanted);
            assert_eq!(read_data_url(Path::new(&image.to_str().unwrap().replace('\\', "/")), &opened).unwrap(), wanted);
            // The spelling paths of a project on a share cross the IPC boundary in.
            let wire = |path: &Path| std::path::PathBuf::from(format!("//?/UNC/{}", &path.to_str().unwrap()[2..]));
            assert_eq!(read_data_url(&wire(&image), &opened).unwrap(), wanted);
            assert_eq!(read_data_url(&image, &[wire(Path::new(r"\\127.0.0.1\C$\work"))]).unwrap(), wanted);
            // The same file through another name of this machine: a server the user did not open.
            let other = on("localhost");
            assert!(std::fs::read(&other).is_ok(), "control: {} is not reachable over SMB", other.display());
            for other in [wire(&other), other] {
                let read = read_data_url(&other, &opened);
                assert!(
                    read.is_err(),
                    "read_data_url opened {} over SMB: {:?}",
                    other.display(),
                    read.map(|s| s.len())
                );
            }
        }
    }

    #[cfg(windows)]
    #[test]
    fn only_absolute_paths_starting_at_a_drive_letter_are_local() {
        for path in [r"C:\a.png", "C:/a.png", r"\\?\C:\a.png", r"z:\share\a.png"] {
            assert!(on_local_drive(Path::new(path)), "{path}");
        }
        for path in [
            r"\\server\share\a.png",
            "//server/share/a.png",
            r"/\server/share/a.png",
            r"\\?\UNC\server\share\a.png",
            "//?/UNC/server/share/a.png",
            r"\\.\UNC\server\share\a.png",
            r"\\?\GLOBALROOT\Device\Mup\server\share\a.png",
            r"\??\UNC\server\share\a.png",
            r"\??\C:\a.png",
            r"\a.png",
            r"C:a.png",
            "a.png",
            r"..\a.png",
        ] {
            assert!(!on_local_drive(Path::new(path)), "{path}");
        }
        let project = Path::new(r"\\nas\work\app");
        assert!(same_share(project, Path::new("//NAS/Work/app/docs/a.png")));
        assert!(same_share(project, Path::new(r"\\?\UNC\nas\work\other\a.png")));
        assert!(!same_share(project, Path::new(r"\\nas\private\a.png")));
        assert!(!same_share(project, Path::new(r"\\evil\work\app\a.png")));
        assert!(!same_share(project, Path::new(r"\??\UNC\nas\work\app\a.png")));
        assert!(!same_share(Path::new(r"C:\app"), Path::new(r"C:\app\a.png")));
        // Read by `std` as the share `UNC` of a server named `?`: the spelling a share's paths
        // cross the IPC boundary in.
        assert!(!same_share(Path::new("//?/UNC/nas/work/app"), Path::new("//?/UNC/evil/share/a.png")));
        assert!(same_share(Path::new("//?/UNC/nas/work/app"), Path::new("//?/unc/NAS/Work/docs/a.png")));
        assert!(same_share(project, Path::new("//?/UNC/nas/work/docs/a.png")));
        assert!(same_share(Path::new(r"\\?\UNC\nas\work\app"), Path::new("//?/UNC/nas/work/docs/a.png")));
        for device in ["//?/UNC/nas", "//?/UNC/../nas/work/a.png", "//?/C:/a.png", "//?/nas/work/a.png"] {
            assert!(!same_share(Path::new(device), Path::new(device)), "{device}");
        }

        assert!(content_path_allowed(Path::new(r"C:\app\a.png"), &[project]));
        assert!(content_path_allowed(Path::new(r"\\nas\work\docs\a.png"), &[Path::new(r"C:\app"), project]));
        assert!(!content_path_allowed(Path::new(r"\\nas\private\a.png"), &[project]));
        assert!(!content_path_allowed(Path::new(r"\\nas\work\docs\a.png"), &[Path::new(r"C:\app")]));
        assert!(!content_path_allowed(Path::new(r"\\nas\work\docs\a.png"), &[] as &[&Path]));
    }

    #[test]
    fn base64_matches_rfc4648_vectors() {
        for (input, expected) in [
            ("", ""),
            ("f", "Zg=="),
            ("fo", "Zm8="),
            ("foo", "Zm9v"),
            ("foob", "Zm9vYg=="),
            ("fooba", "Zm9vYmE="),
            ("foobar", "Zm9vYmFy"),
        ] {
            assert_eq!(base64(input.as_bytes()), expected);
        }
        assert_eq!(base64(&[0xff, 0xfe, 0x00]), "//4A");
    }

    #[test]
    fn probe_classifies_text_and_binary() {
        let dir = tempfile::tempdir().unwrap();
        let text = dir.path().join("a.txt");
        fs::write(&text, "hello\nworld\n").unwrap();
        assert_eq!(probe(&text).unwrap(), FileProbe { size: 12, binary: false, too_large: false });
        let bin = dir.path().join("a.bin");
        fs::write(&bin, [0u8, 1, 2, 3, 0, 0, 0xff, 0x10]).unwrap();
        assert!(probe(&bin).unwrap().binary);
        // BOM-less UTF-16 has NULs but is text.
        let utf16 = dir.path().join("u.txt");
        let bytes: Vec<u8> = "hello world, this is text".encode_utf16().flat_map(u16::to_le_bytes).collect();
        fs::write(&utf16, bytes).unwrap();
        assert!(!probe(&utf16).unwrap().binary);
        assert!(probe(dir.path()).is_err());
    }

    #[test]
    fn read_range_is_bounded_by_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("data");
        fs::write(&f, b"0123456789").unwrap();
        let r = read_range(&f, 4, 3).unwrap();
        assert_eq!((r.offset, r.data.as_str(), r.total), (4, "NDU2", 10));
        let tail = read_range(&f, 8, 100).unwrap();
        assert_eq!(tail.data, base64(b"89"));
        let past = read_range(&f, 50, 10).unwrap();
        assert_eq!((past.offset, past.data.as_str()), (10, ""));
    }

    #[test]
    fn data_url_for_images_only() {
        let dir = tempfile::tempdir().unwrap();
        let png = dir.path().join("x.PNG");
        fs::write(&png, [0x89, b'P', b'N', b'G']).unwrap();
        assert_eq!(
            read_data_url(&png, &[]).unwrap(),
            format!("data:image/png;base64,{}", base64(&[0x89, b'P', b'N', b'G']))
        );
        let txt = dir.path().join("x.txt");
        fs::write(&txt, "x").unwrap();
        assert!(read_data_url(&txt, &[]).is_err());
        assert_eq!(image_mime(Path::new("a/b.svg")), Some("image/svg+xml"));
    }
}
