//! Archive extraction (zip / vsix, tar.gz, tar.xz, single-file gzip) and
//! executable discovery inside extracted trees.

use ide_core::{CancellationToken, IdeError, IdeResult};
use std::fs::{self, File};
use std::io::{self, BufReader};
use std::path::{Component, Path, PathBuf};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ArchiveKind {
    Zip,
    TarGz,
    TarXz,
    TarBz2,
    /// A single gzip-compressed executable.
    Gz,
    /// The download is the executable itself.
    Raw,
}

impl ArchiveKind {
    pub fn from_name(name: &str) -> Self {
        let n = name.to_ascii_lowercase();
        if n.ends_with(".zip") || n.ends_with(".vsix") {
            Self::Zip
        } else if n.ends_with(".tar.gz") || n.ends_with(".tgz") {
            Self::TarGz
        } else if n.ends_with(".tar.xz") || n.ends_with(".txz") {
            Self::TarXz
        } else if n.ends_with(".tar.bz2") || n.ends_with(".tbz2") {
            Self::TarBz2
        } else if n.ends_with(".gz") {
            Self::Gz
        } else {
            Self::Raw
        }
    }
}

fn io_err(context: &str, e: impl std::fmt::Display) -> IdeError {
    IdeError::new(ide_core::error::ErrorKind::Io, format!("{context}: {e}"))
}

fn check(cancel: &CancellationToken) -> IdeResult<()> {
    if cancel.is_cancelled() { Err(IdeError::cancelled()) } else { Ok(()) }
}

/// Unpacks `archive` into `dest` (created if needed). `Gz` / `Raw` payloads
/// are written to `dest/<single_name>`. Stops between entries once `cancel` fires.
pub fn extract(
    archive: &Path,
    kind: ArchiveKind,
    dest: &Path,
    single_name: &str,
    cancel: &CancellationToken,
) -> IdeResult<()> {
    check(cancel)?;
    fs::create_dir_all(dest)?;
    match kind {
        ArchiveKind::Zip => extract_zip(archive, dest, cancel),
        ArchiveKind::TarGz => {
            let gz = flate2::read::GzDecoder::new(BufReader::new(File::open(archive)?));
            extract_tar(tar::Archive::new(gz), dest, cancel)
        }
        ArchiveKind::TarXz => extract_with_tar(archive, dest, "-xJf", cancel),
        ArchiveKind::TarBz2 => extract_with_tar(archive, dest, "-xjf", cancel),
        ArchiveKind::Gz => {
            let mut gz = flate2::read::GzDecoder::new(BufReader::new(File::open(archive)?));
            let target = dest.join(single_name);
            let mut out = File::create(&target)?;
            io::copy(&mut gz, &mut out).map_err(|e| io_err("decompressing", e))?;
            make_executable(&target)
        }
        ArchiveKind::Raw => {
            let target = dest.join(single_name);
            fs::copy(archive, &target)?;
            make_executable(&target)
        }
    }
}

fn extract_tar<R: io::Read>(mut archive: tar::Archive<R>, dest: &Path, cancel: &CancellationToken) -> IdeResult<()> {
    archive.set_preserve_permissions(true);
    archive.set_overwrite(true);
    for entry in archive.entries().map_err(|e| io_err("reading archive", e))? {
        check(cancel)?;
        let mut entry = entry.map_err(|e| io_err("reading archive", e))?;
        // `unpack_in` refuses entries escaping `dest` (returns Ok(false)).
        entry.unpack_in(dest).map_err(|e| io_err("extracting", e))?;
    }
    Ok(())
}

fn extract_zip(archive: &Path, dest: &Path, cancel: &CancellationToken) -> IdeResult<()> {
    let mut zip = zip::ZipArchive::new(BufReader::new(File::open(archive)?)).map_err(|e| io_err("reading zip", e))?;
    for i in 0..zip.len() {
        check(cancel)?;
        let mut file = zip.by_index(i).map_err(|e| io_err("reading zip", e))?;
        let Some(rel) = file.enclosed_name() else { continue };
        if !is_safe_relative(&rel) {
            continue;
        }
        let out = dest.join(&rel);
        if file.is_dir() {
            fs::create_dir_all(&out)?;
            continue;
        }
        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent)?;
        }
        #[cfg(unix)]
        if file.is_symlink() {
            let mut target = String::new();
            io::Read::read_to_string(&mut file, &mut target)?;
            let _ = fs::remove_file(&out);
            std::os::unix::fs::symlink(target, &out)?;
            continue;
        }
        let mut w = File::create(&out)?;
        io::copy(&mut file, &mut w).map_err(|e| io_err("extracting", e))?;
        #[cfg(unix)]
        if let Some(mode) = file.unix_mode() {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&out, fs::Permissions::from_mode(mode & 0o777))?;
        }
    }
    Ok(())
}

/// `.tar.xz` / `.tar.bz2` go through the system `tar` (bsdtar on macOS/Windows, GNU tar
/// + xz / bzip2 on Linux).
fn extract_with_tar(archive: &Path, dest: &Path, flags: &str, cancel: &CancellationToken) -> IdeResult<()> {
    let tar = which::which("tar").map_err(|_| IdeError::unavailable("`tar` is required to unpack this archive"))?;
    let mut cmd = std::process::Command::new(tar);
    cmd.arg(flags).arg(archive).arg("-C").arg(dest);
    let (ok, output, _) = crate::process::run_collect(cmd, cancel, &|_| {})?;
    if !ok {
        return Err(io_err("tar failed", output.trim()));
    }
    Ok(())
}

fn is_safe_relative(p: &Path) -> bool {
    p.components().all(|c| matches!(c, Component::Normal(_) | Component::CurDir))
}

pub fn make_executable(path: &Path) -> IdeResult<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(path)?.permissions();
        perms.set_mode(perms.mode() | 0o755);
        fs::set_permissions(path, perms)?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

/// Finds the executable named one of `names` (with platform suffixes; `*`
/// wildcards allowed) in `root`, preferring files in `bin/` directories, then
/// shallower paths.
pub fn locate(root: &Path, names: &[String]) -> Option<PathBuf> {
    let mut best: Option<(usize, usize, PathBuf)> = None;
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(ft) = entry.file_type() else { continue };
            if ft.is_dir() {
                if depth < 6 {
                    stack.push((path, depth + 1));
                }
                continue;
            }
            let file_name = entry.file_name().to_string_lossy().into_owned();
            let matches = |n: &String| {
                if n.contains('*') { crate::platform::glob_match(n, &file_name) } else { *n == file_name }
            };
            let Some(rank) = names.iter().position(matches) else { continue };
            let in_bin = dir.file_name().is_some_and(|n| n == "bin");
            let score = (rank, depth + usize::from(!in_bin));
            if best.as_ref().is_none_or(|(r, d, _)| score < (*r, *d)) {
                best = Some((score.0, score.1, path));
            }
        }
    }
    best.map(|(_, _, p)| p)
}

/// Creates `bin_dir/<command>` that runs `target`: a shell wrapper on Unix
/// (keeps the target's own directory layout intact), a `.cmd` shim on Windows.
/// Like [`link_executable`], with `env` set for `target`.
pub fn env_wrapper(bin_dir: &Path, command: &str, target: &Path, env: &[(&str, &Path)]) -> IdeResult<PathBuf> {
    fs::create_dir_all(bin_dir)?;
    #[cfg(unix)]
    {
        let quote = |p: &Path| format!("'{}'", p.to_string_lossy().replace('\'', r"'\''"));
        let vars: String = env.iter().map(|(k, v)| format!("{k}={} ", quote(v))).collect();
        let link = bin_dir.join(command);
        fs::write(&link, format!("#!/bin/sh\n{vars}exec {} \"$@\"\n", quote(target)))?;
        make_executable(&link)?;
        Ok(link)
    }
    #[cfg(not(unix))]
    {
        let link = bin_dir.join(format!("{command}.cmd"));
        let vars: String = env.iter().map(|(k, v)| format!("set \"{k}={}\"\r\n", v.display())).collect();
        fs::write(&link, format!("@echo off\r\nsetlocal\r\n{vars}\"{}\" %*\r\n", target.display()))?;
        Ok(link)
    }
}

pub fn link_executable(bin_dir: &Path, command: &str, target: &Path) -> IdeResult<PathBuf> {
    fs::create_dir_all(bin_dir)?;
    #[cfg(unix)]
    {
        let link = bin_dir.join(command);
        if link == target {
            return Ok(link);
        }
        let quoted = target.to_string_lossy().replace('\'', r"'\''");
        // A Node script without a shebang (e.g. js-debug's dapDebugServer.js) runs through `node`.
        let runner = if target.extension().is_some_and(|e| e == "js") { "node " } else { "" };
        fs::write(&link, format!("#!/bin/sh\nexec {runner}'{quoted}' \"$@\"\n"))?;
        make_executable(&link)?;
        make_executable(target)?;
        Ok(link)
    }
    #[cfg(not(unix))]
    {
        let link = bin_dir.join(format!("{command}.cmd"));
        let runner = if target.extension().is_some_and(|e| e == "js") { "node " } else { "" };
        fs::write(&link, format!("@echo off\r\n{runner}\"{}\" %*\r\n", target.display()))?;
        Ok(link)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn tar_gz(path: &Path, files: &[(&str, &[u8], u32)]) {
        let gz = flate2::write::GzEncoder::new(File::create(path).unwrap(), flate2::Compression::fast());
        let mut b = tar::Builder::new(gz);
        for (name, data, mode) in files {
            let mut h = tar::Header::new_gnu();
            h.set_size(data.len() as u64);
            h.set_mode(*mode);
            h.set_cksum();
            b.append_data(&mut h, name, *data).unwrap();
        }
        b.into_inner().unwrap().finish().unwrap();
    }

    fn zip_file(path: &Path, files: &[(&str, &[u8], u32)]) {
        let mut z = zip::ZipWriter::new(File::create(path).unwrap());
        for (name, data, mode) in files {
            let opts = zip::write::SimpleFileOptions::default().unix_permissions(*mode);
            z.start_file(*name, opts).unwrap();
            z.write_all(data).unwrap();
        }
        z.finish().unwrap();
    }

    #[test]
    fn kinds() {
        assert_eq!(ArchiveKind::from_name("a.vsix"), ArchiveKind::Zip);
        assert_eq!(ArchiveKind::from_name("a.ZIP"), ArchiveKind::Zip);
        assert_eq!(ArchiveKind::from_name("a.tar.gz"), ArchiveKind::TarGz);
        assert_eq!(ArchiveKind::from_name("a.tgz"), ArchiveKind::TarGz);
        assert_eq!(ArchiveKind::from_name("zls.tar.xz"), ArchiveKind::TarXz);
        assert_eq!(ArchiveKind::from_name("goose.tar.bz2"), ArchiveKind::TarBz2);
        assert_eq!(ArchiveKind::from_name("taplo-darwin-aarch64.gz"), ArchiveKind::Gz);
        assert_eq!(ArchiveKind::from_name("marksman-macos"), ArchiveKind::Raw);
        assert_eq!(ArchiveKind::from_name("marksman.exe"), ArchiveKind::Raw);
    }

    #[test]
    fn extraction_stops_when_cancelled() {
        let tmp = tempfile::tempdir().unwrap();
        let archive = tmp.path().join("a.tar.gz");
        tar_gz(&archive, &[("one", b"1", 0o644), ("two", b"2", 0o644)]);
        let cancel = CancellationToken::new();
        cancel.cancel();
        let dest = tmp.path().join("out");
        for kind in [ArchiveKind::TarGz, ArchiveKind::Zip, ArchiveKind::TarXz, ArchiveKind::Raw] {
            let err = extract(&archive, kind, &dest, "x", &cancel).unwrap_err();
            assert_eq!(err.kind, ide_core::error::ErrorKind::Cancelled, "{kind:?}");
        }
        assert!(!dest.join("one").exists());
    }

    #[test]
    fn extracts_tar_gz_and_locates_binary() {
        let tmp = tempfile::tempdir().unwrap();
        let archive = tmp.path().join("lua.tar.gz");
        tar_gz(
            &archive,
            &[
                ("bin/lua-language-server", b"#!/bin/sh\necho 3.13.5\n", 0o755),
                ("main.lua", b"-- entry", 0o644),
                ("meta/3rd/lua-language-server", b"not me", 0o644),
            ],
        );
        let dest = tmp.path().join("out");
        extract(&archive, ArchiveKind::TarGz, &dest, "x", &CancellationToken::new()).unwrap();
        assert_eq!(fs::read_to_string(dest.join("main.lua")).unwrap(), "-- entry");
        let found = locate(&dest, &["lua-language-server".into()]).unwrap();
        assert_eq!(found, dest.join("bin/lua-language-server"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_ne!(fs::metadata(&found).unwrap().permissions().mode() & 0o111, 0);
        }
    }

    #[test]
    fn extracts_zip_with_modes_and_nested_dirs() {
        let tmp = tempfile::tempdir().unwrap();
        let archive = tmp.path().join("codelldb.vsix");
        zip_file(
            &archive,
            &[
                ("extension/package.json", b"{}", 0o644),
                ("extension/adapter/codelldb", b"\x7fELF", 0o755),
                ("extension/lldb/bin/lldb", b"\x7fELF", 0o755),
            ],
        );
        let dest = tmp.path().join("out");
        extract(&archive, ArchiveKind::Zip, &dest, "x", &CancellationToken::new()).unwrap();
        let found = locate(&dest, &["codelldb".into()]).unwrap();
        assert_eq!(found, dest.join("extension/adapter/codelldb"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&found).unwrap().permissions().mode() & 0o777, 0o755);
            assert_eq!(fs::metadata(dest.join("extension/package.json")).unwrap().permissions().mode() & 0o777, 0o644);
        }
    }

    #[test]
    fn zip_entries_cannot_escape() {
        let tmp = tempfile::tempdir().unwrap();
        let archive = tmp.path().join("evil.zip");
        zip_file(&archive, &[("../escape.txt", b"x", 0o644), ("ok.txt", b"y", 0o644)]);
        let dest = tmp.path().join("out");
        extract(&archive, ArchiveKind::Zip, &dest, "x", &CancellationToken::new()).unwrap();
        assert!(!tmp.path().join("escape.txt").exists());
        assert!(dest.join("ok.txt").exists());
    }

    #[test]
    fn single_gzip_and_raw_payloads() {
        let tmp = tempfile::tempdir().unwrap();
        let gz_path = tmp.path().join("taplo-darwin-aarch64.gz");
        let mut gz = flate2::write::GzEncoder::new(File::create(&gz_path).unwrap(), flate2::Compression::fast());
        gz.write_all(b"taplo-binary").unwrap();
        gz.finish().unwrap();
        let dest = tmp.path().join("bin");
        extract(&gz_path, ArchiveKind::Gz, &dest, "taplo", &CancellationToken::new()).unwrap();
        assert_eq!(fs::read(dest.join("taplo")).unwrap(), b"taplo-binary");

        let raw = tmp.path().join("marksman-macos");
        fs::write(&raw, b"mm").unwrap();
        extract(&raw, ArchiveKind::Raw, &dest, "marksman", &CancellationToken::new()).unwrap();
        assert_eq!(fs::read(dest.join("marksman")).unwrap(), b"mm");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_ne!(fs::metadata(dest.join("marksman")).unwrap().permissions().mode() & 0o111, 0);
        }
    }

    #[test]
    fn locate_prefers_name_order_then_bin_then_depth() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fs::create_dir_all(root.join("a/b/bin")).unwrap();
        fs::write(root.join("a/kotlin-lsp.sh"), "").unwrap();
        fs::write(root.join("a/b/bin/kotlin-lsp"), "").unwrap();
        let names = ["kotlin-lsp".to_string(), "kotlin-lsp.sh".to_string()];
        assert_eq!(locate(root, &names).unwrap(), root.join("a/b/bin/kotlin-lsp"));
        assert!(locate(root, &["nope".into()]).is_none());
    }

    #[test]
    fn locate_supports_wildcards() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fs::create_dir_all(root.join("extension/server")).unwrap();
        fs::write(root.join("extension/server/com.microsoft.java.debug.plugin-0.53.2.jar"), "").unwrap();
        fs::write(root.join("extension/package.json"), "").unwrap();
        let found = locate(root, &["com.microsoft.java.debug.plugin-*.jar".into()]).unwrap();
        assert!(found.ends_with("server/com.microsoft.java.debug.plugin-0.53.2.jar"));
    }

    #[cfg(unix)]
    #[test]
    fn wrapper_runs_target() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("dist dir/tool");
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(&target, "#!/bin/sh\necho \"hi $1\"\n").unwrap();
        let link = link_executable(&tmp.path().join("bin"), "tool", &target).unwrap();
        let out = std::process::Command::new(&link).arg("there").output().unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "hi there");
    }
}
