//! Text decoding / encoding with BOM and charset detection, and atomic writes.

use crate::{LoadedText, mtime_ms};
use encoding_rs::{Encoding, UTF_8, UTF_16BE, UTF_16LE};
use ide_core::{IdeError, IdeResult};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

/// Files above this size open with expensive features (LSP, tree-sitter
/// structure, folding) disabled.
pub const LARGE_FILE_THRESHOLD: u64 = 5 * 1024 * 1024;
/// Files above this size open read-only.
pub const READ_ONLY_THRESHOLD: u64 = 50 * 1024 * 1024;
/// Files above this size are refused outright to protect memory.
pub const MAX_OPEN_SIZE: u64 = 512 * 1024 * 1024;
/// How much of a file the binary / UTF-16 heuristics look at.
pub(crate) const SNIFF_LEN: usize = 8 * 1024;

pub(crate) fn encoding_label(enc: &'static Encoding) -> String {
    enc.name().to_ascii_lowercase()
}

/// Detects BOM-less UTF-16 from the distribution of NUL bytes in mostly-ASCII text.
fn sniff_utf16(sample: &[u8]) -> Option<&'static Encoding> {
    if sample.len() < 4 {
        return None;
    }
    let pairs = sample.len() / 2;
    let (mut even, mut odd) = (0usize, 0usize);
    for (i, b) in sample[..pairs * 2].iter().enumerate() {
        if *b == 0 {
            if i % 2 == 0 {
                even += 1;
            } else {
                odd += 1;
            }
        }
    }
    // ASCII-heavy UTF-16: most high bytes are zero, low bytes essentially never are.
    let threshold = pairs * 3 / 5;
    if odd >= threshold && even * 50 <= pairs {
        Some(UTF_16LE)
    } else if even >= threshold && odd * 50 <= pairs {
        Some(UTF_16BE)
    } else {
        None
    }
}

/// Whether a file's head (first [`SNIFF_LEN`] bytes) marks it as binary: the
/// same decision [`decode`] makes, without decoding.
pub(crate) fn looks_binary(head: &[u8]) -> bool {
    let sample = &head[..head.len().min(SNIFF_LEN)];
    Encoding::for_bom(sample).is_none() && sample.contains(&0) && sniff_utf16(sample).is_none()
}

/// Decodes file bytes: `(text, encoding, has_bom, binary)`. Valid UTF-8 is
/// taken over without copying.
pub(crate) fn decode_owned(bytes: Vec<u8>) -> (String, &'static Encoding, bool, bool) {
    if Encoding::for_bom(&bytes).is_none() && !bytes[..bytes.len().min(SNIFF_LEN)].contains(&0) {
        match String::from_utf8(bytes) {
            Ok(text) => return (text, UTF_8, false, false),
            Err(e) => return decode(e.as_bytes()),
        }
    }
    decode(&bytes)
}

/// Decodes file bytes: `(text, encoding, has_bom, binary)`.
pub(crate) fn decode(bytes: &[u8]) -> (String, &'static Encoding, bool, bool) {
    if let Some((enc, bom_len)) = Encoding::for_bom(bytes) {
        let (text, _) = enc.decode_without_bom_handling(&bytes[bom_len..]);
        return (text.into_owned(), enc, true, false);
    }
    let sample = &bytes[..bytes.len().min(SNIFF_LEN)];
    if sample.contains(&0) {
        return match sniff_utf16(sample) {
            Some(enc) => {
                let (text, _) = enc.decode_without_bom_handling(bytes);
                (text.into_owned(), enc, false, false)
            }
            None => (String::new(), UTF_8, false, true),
        };
    }
    if let Ok(text) = std::str::from_utf8(bytes) {
        return (text.to_owned(), UTF_8, false, false);
    }
    let mut detector = chardetng::EncodingDetector::new();
    detector.feed(bytes, true);
    let enc = detector.guess(None, true);
    let (text, _) = enc.decode_without_bom_handling(bytes);
    (text.into_owned(), enc, false, false)
}

/// Bytes of a file inside an archive (size-checked) and the archive's mtime.
fn archive_bytes(path: &Path) -> IdeResult<Option<(Vec<u8>, f64)>> {
    let Some((archive, entry)) = crate::split_archive_path(path) else { return Ok(None) };
    let (size, _) = crate::archive::entry_size(&archive, &entry)?;
    if size > MAX_OPEN_SIZE {
        return Err(IdeError::invalid(format!(
            "{} is too large to open ({} MiB)",
            path.display(),
            size / (1024 * 1024)
        )));
    }
    crate::read_archive_entry(&archive, &entry).map(Some)
}

pub(crate) fn load_text(path: &Path) -> IdeResult<LoadedText> {
    if let Some((bytes, mtime_ms)) = archive_bytes(path)? {
        let len = bytes.len() as u64;
        let (text, enc, has_bom, binary) = decode_owned(bytes);
        return Ok(LoadedText {
            text,
            encoding: encoding_label(enc),
            has_bom,
            binary,
            large: len > LARGE_FILE_THRESHOLD,
            too_large: len > READ_ONLY_THRESHOLD,
            mtime_ms,
        });
    }
    let meta = fs::metadata(path)?;
    if meta.is_dir() {
        return Err(IdeError::invalid(format!("{} is a directory", path.display())));
    }
    if meta.len() > MAX_OPEN_SIZE {
        return Err(IdeError::invalid(format!(
            "{} is too large to open ({} MiB)",
            path.display(),
            meta.len() / (1024 * 1024)
        )));
    }
    let bytes = fs::read(path)?;
    let len = bytes.len() as u64;
    let (text, enc, has_bom, binary) = decode_owned(bytes);
    Ok(LoadedText {
        text,
        encoding: encoding_label(enc),
        has_bom,
        binary,
        large: len > LARGE_FILE_THRESHOLD,
        too_large: len > READ_ONLY_THRESHOLD,
        mtime_ms: mtime_ms(&meta),
    })
}

/// Loads `path` decoded as `encoding` (a WHATWG label) instead of detecting it
/// ("Reload with Encoding"). A matching BOM is stripped and reported.
pub(crate) fn load_text_as(path: &Path, encoding: &str) -> IdeResult<LoadedText> {
    let enc = Encoding::for_label(encoding.trim().as_bytes())
        .ok_or_else(|| IdeError::invalid(format!("unknown encoding {encoding:?}")))?;
    let mut loaded = load_text(path)?;
    let bytes = match archive_bytes(path)? {
        Some((bytes, _)) => bytes,
        None => fs::read(path)?,
    };
    let (body, has_bom) = match Encoding::for_bom(&bytes) {
        Some((bom_enc, len)) if bom_enc == enc => (&bytes[len..], true),
        _ => (&bytes[..], false),
    };
    let (text, _) = enc.decode_without_bom_handling(body);
    loaded.text = text.into_owned();
    loaded.encoding = encoding_label(enc);
    loaded.has_bom = has_bom;
    loaded.binary = false;
    Ok(loaded)
}

/// Encodes `text` to bytes in `encoding` (a WHATWG label). Fails rather than
/// silently substituting characters the encoding cannot represent.
pub fn encode(text: &str, encoding: &str, has_bom: bool) -> IdeResult<Vec<u8>> {
    let enc = Encoding::for_label(encoding.trim().as_bytes())
        .ok_or_else(|| IdeError::invalid(format!("unknown encoding {encoding:?}")))?;
    let mut out = Vec::with_capacity(text.len() + 3);
    if enc == UTF_16LE || enc == UTF_16BE {
        let le = enc == UTF_16LE;
        if has_bom {
            out.extend_from_slice(if le { &[0xFF, 0xFE] } else { &[0xFE, 0xFF] });
        }
        for unit in text.encode_utf16() {
            out.extend_from_slice(&if le { unit.to_le_bytes() } else { unit.to_be_bytes() });
        }
        return Ok(out);
    }
    if enc == UTF_8 {
        if has_bom {
            out.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
        }
        out.extend_from_slice(text.as_bytes());
        return Ok(out);
    }
    let (bytes, _, had_errors) = enc.encode(text);
    if had_errors {
        let bad = text
            .chars()
            .find(|c| {
                let mut buf = [0u8; 4];
                enc.encode(c.encode_utf8(&mut buf)).2
            })
            .map(|c| format!(" (e.g. {c:?})"))
            .unwrap_or_default();
        return Err(IdeError::invalid(format!("text contains characters not representable in {}{bad}", enc.name())));
    }
    Ok(bytes.into_owned())
}

static TMP_COUNTER: AtomicU32 = AtomicU32::new(0);
const TMP_MARKER: &str = ".openidea-tmp-";

fn temp_path_for(target: &Path) -> PathBuf {
    let name = target.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let n = TMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    target.with_file_name(format!(".{name}{TMP_MARKER}{}-{n}", std::process::id()))
}

/// Whether `path` is one of `write_atomic`'s short-lived temp files.
pub(crate) fn is_atomic_temp(path: &Path) -> bool {
    path.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with('.') && n.contains(TMP_MARKER))
}

/// Writes `bytes` to `path` atomically: temp file in the same directory, fsync,
/// rename over the target. Preserves the permissions of an existing file and
/// writes through symlinks. Falls back to an in-place write when the directory
/// does not allow creating files. Returns the new mtime in ms.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> IdeResult<f64> {
    write_atomic_impl(path, bytes, true)
}

/// Replaces a file atomically without falling back to truncating it in place.
/// Preserves existing permissions and writes through symlinks; if a sibling
/// temporary file cannot be created, leaves the existing file untouched.
pub fn write_atomic_strict(path: &Path, bytes: &[u8]) -> IdeResult<f64> {
    write_atomic_impl(path, bytes, false)
}

fn write_atomic_impl(path: &Path, bytes: &[u8], allow_in_place: bool) -> IdeResult<f64> {
    let target = match fs::symlink_metadata(path) {
        Ok(m) if m.file_type().is_symlink() => fs::canonicalize(path)?,
        _ => path.to_path_buf(),
    };
    let existing = fs::metadata(&target).ok();
    if existing.as_ref().is_some_and(|m| m.is_dir()) {
        return Err(IdeError::invalid(format!("{} is a directory", target.display())));
    }
    let tmp = temp_path_for(&target);
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    if existing.is_some() || !allow_in_place {
        use std::os::unix::fs::OpenOptionsExt;
        // Replacement bytes must not become readable before the final
        // permissions are restored, even when the directory has a loose umask.
        options.mode(0o600);
    }
    let file = options.open(&tmp);
    let mut file = match file {
        Ok(f) => f,
        Err(e) if allow_in_place && e.kind() == std::io::ErrorKind::PermissionDenied && existing.is_some() => {
            tracing::debug!("cannot create temp file next to {}: {e}; writing in place", target.display());
            fs::write(&target, bytes)?;
            return Ok(mtime_ms(&fs::metadata(&target)?));
        }
        Err(e) => return Err(e.into()),
    };
    let result = (|| -> std::io::Result<()> {
        file.write_all(bytes)?;
        file.sync_all()?;
        if let Some(meta) = &existing {
            fs::set_permissions(&tmp, meta.permissions())?;
        }
        drop(file);
        fs::rename(&tmp, &target)
    })();
    if let Err(e) = result {
        let _ = fs::remove_file(&tmp);
        return Err(e.into());
    }
    Ok(mtime_ms(&fs::metadata(&target)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strict_write_replaces_complete_contents() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notebook.ipynb");
        fs::write(&path, b"original, longer contents").unwrap();

        write_atomic_strict(&path, b"{\"cells\":[]}").unwrap();

        assert_eq!(fs::read(&path).unwrap(), b"{\"cells\":[]}");
    }

    #[cfg(unix)]
    #[test]
    fn strict_write_preserves_symlink_and_target_permissions() {
        use std::os::unix::fs::{PermissionsExt, symlink};

        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("target.ipynb");
        let link = dir.path().join("link.ipynb");
        fs::write(&target, b"old").unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(0o640)).unwrap();
        symlink(&target, &link).unwrap();

        write_atomic_strict(&link, b"new notebook").unwrap();

        assert!(fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
        assert_eq!(fs::read(&target).unwrap(), b"new notebook");
        assert_eq!(fs::metadata(&target).unwrap().permissions().mode() & 0o777, 0o640);
    }

    #[cfg(unix)]
    #[test]
    fn strict_write_does_not_truncate_when_sibling_creation_is_denied() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notebook.ipynb");
        fs::write(&path, b"original notebook").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o666)).unwrap();
        fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o555)).unwrap();
        // Privileged test runners can bypass directory permissions.
        let probe = dir.path().join("probe");
        if fs::File::create(&probe).is_ok() {
            fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o755)).unwrap();
            fs::remove_file(probe).unwrap();
            return;
        }

        let result = write_atomic_strict(&path, b"replacement");
        fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o755)).unwrap();

        assert_eq!(result.unwrap_err().kind, ide_core::error::ErrorKind::PermissionDenied);
        assert_eq!(fs::read(&path).unwrap(), b"original notebook");
    }

    #[test]
    fn decode_variants() {
        let (t, e, bom, bin) = decode(b"\xEF\xBB\xBFhi");
        assert_eq!((t.as_str(), e, bom, bin), ("hi", UTF_8, true, false));

        let mut le = vec![0xFF, 0xFE];
        le.extend("hé😀".encode_utf16().flat_map(u16::to_le_bytes));
        let (t, e, bom, _) = decode(&le);
        assert_eq!((t.as_str(), e, bom), ("hé😀", UTF_16LE, true));

        let mut be = vec![0xFE, 0xFF];
        be.extend("hey".encode_utf16().flat_map(u16::to_be_bytes));
        assert_eq!(decode(&be).0, "hey");

        let bomless: Vec<u8> = "hello world\nline two\n".encode_utf16().flat_map(u16::to_le_bytes).collect();
        let (t, e, bom, bin) = decode(&bomless);
        assert_eq!((t.as_str(), e, bom, bin), ("hello world\nline two\n", UTF_16LE, false, false));

        let (t, _, _, bin) = decode(b"\x7FELF\x02\x01\x01\x00\x00\x00\x00\x00\x03\x00\x3e\x00\x01");
        assert!(bin);
        assert!(t.is_empty());

        // GBK: "中文测试，这是一段中文文本。"
        let (gbk, _, _) = encoding_rs::GBK.encode("中文测试，这是一段比较长的中文文本，用于编码检测。");
        let (t, e, _, _) = decode(&gbk);
        assert_eq!(t, "中文测试，这是一段比较长的中文文本，用于编码检测。");
        assert_eq!(encoding_label(e), "gbk");

        let (latin, _, _) = encoding_rs::WINDOWS_1252.encode("café crème brûlée à la française");
        let (t, _, _, _) = decode(&latin);
        assert_eq!(t, "café crème brûlée à la française");

        let (t, e, _, _) = decode_owned(latin.to_vec());
        assert_eq!((t.as_str(), e.name()), ("café crème brûlée à la française", "windows-1252"));
        let (t, e, bom, bin) = decode_owned("plain 😀".as_bytes().to_vec());
        assert_eq!((t.as_str(), e, bom, bin), ("plain 😀", UTF_8, false, false));
        assert_eq!(decode_owned(b"\xEF\xBB\xBFhi".to_vec()).0, "hi");
        assert!(decode_owned(b"\x7FELF\x00\x00".to_vec()).3);
        assert_eq!(decode_owned(Vec::new()).0, "");
    }

    #[test]
    fn encode_variants() {
        assert_eq!(encode("hi", "utf-8", true).unwrap(), b"\xEF\xBB\xBFhi");
        assert_eq!(encode("hi", "UTF-8", false).unwrap(), b"hi");
        assert_eq!(encode("A", "utf-16le", true).unwrap(), [0xFF, 0xFE, 0x41, 0x00]);
        assert_eq!(encode("A", "utf-16be", false).unwrap(), [0x00, 0x41]);
        assert_eq!(encode("中", "gbk", true).unwrap(), [0xD6, 0xD0]);
        assert_eq!(encode("x", "nope", false).unwrap_err().kind, ide_core::error::ErrorKind::InvalidInput);
        assert_eq!(encode("中", "windows-1252", false).unwrap_err().kind, ide_core::error::ErrorKind::InvalidInput);
    }
}
