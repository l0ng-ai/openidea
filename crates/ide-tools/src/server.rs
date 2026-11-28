//! `openidea-server` builds for remote development: the release of this
//! version publishes one per supported host platform (see `release-build.yml`).

use crate::process::Http;
use crate::{InstallEvent, fetch_verified, sources};
use ide_core::CancellationToken;
use ide_core::{IdeError, IdeResult};
use std::io::Read;
use std::path::{Path, PathBuf};

const RELEASES: &str = "https://github.com/l0ng-ai/openidea/releases/download";

/// Host platforms with a published server (Rust's `OS`-`ARCH` names).
pub const PLATFORMS: &[(&str, &str)] =
    &[("linux", "x86_64"), ("linux", "aarch64"), ("macos", "aarch64"), ("macos", "x86_64")];

/// The release asset of the server for `os`-`arch` (gzip-compressed binary).
pub fn asset_name(os: &str, arch: &str) -> String {
    format!("openidea-server-{os}-{arch}.gz")
}

/// Where a downloaded server of `version` is kept.
pub fn cached_path(app_data: &Path, version: &str, os: &str, arch: &str) -> PathBuf {
    app_data.join("server").join(version).join(format!("{os}-{arch}")).join("openidea-server")
}

/// The server of `version` for `os`-`arch`: the cached download, or the release
/// asset downloaded now (checksum verified).
pub fn fetch(
    app_data: &Path,
    version: &str,
    os: &str,
    arch: &str,
    cancel: &CancellationToken,
    emit: &dyn Fn(InstallEvent),
) -> IdeResult<PathBuf> {
    let dest = cached_path(app_data, version, os, arch);
    if dest.is_file() {
        return Ok(dest);
    }
    if !PLATFORMS.contains(&(os, arch)) {
        return Err(IdeError::unavailable(format!("remote development does not support {os}-{arch} hosts")));
    }
    let name = asset_name(os, arch);
    let url = format!("{RELEASES}/v{version}/{name}");
    let dir = dest.parent().expect("cached path has a parent");
    std::fs::create_dir_all(dir)?;
    let staging = tempfile_dir(dir)?;
    let result = (|| {
        let http = Http::new(&ide_core::tool_path::search_path())?;
        // The binary runs on the remote host: never install it unverified.
        let checksum_url = format!("{url}.sha256");
        let sha256 = sources::parse_checksum(&http.get_text(&checksum_url, cancel)?, &name)
            .ok_or_else(|| IdeError::unavailable(format!("no SHA-256 for {name} at {checksum_url}")))?;
        let dl = sources::Download {
            version: version.to_owned(),
            checksum_url: None,
            name,
            url,
            size: None,
            sha256: Some(sha256),
        };
        // The remote server binary is not part of Tools › Download sources: it always comes
        // from its own release.
        let archive = fetch_verified(&Default::default(), &http, &dl, &staging, cancel, emit)?;
        let unpacked = staging.join("openidea-server");
        let mut gz = flate2::read::GzDecoder::new(std::fs::File::open(&archive)?);
        std::io::copy(&mut gz, &mut std::fs::File::create(&unpacked)?)?;
        drop(gz);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&unpacked, std::fs::Permissions::from_mode(0o755))?;
        }
        std::fs::rename(&unpacked, &dest)?;
        // The executable is the cache entry; keeping the archive only optimizes SSH uploads.
        let _ = std::fs::rename(archive, dest.with_extension("gz"));
        Ok(dest.clone())
    })();
    let _ = std::fs::remove_dir_all(&staging);
    result
}

/// The cached release gzip, if it unpacks to the selected server binary.
pub fn matching_archive(binary: &Path, expected: blake3::Hash) -> Option<Vec<u8>> {
    let archive = binary.with_extension("gz");
    let binary_size = binary.metadata().ok()?.len();
    let meta = archive.metadata().ok()?;
    if !meta.is_file() || meta.len() >= binary_size {
        return None;
    }
    let mut packed = Vec::with_capacity(meta.len().try_into().ok()?);
    std::fs::File::open(archive).ok()?.take(binary_size).read_to_end(&mut packed).ok()?;
    if packed.len() as u64 >= binary_size {
        return None;
    }
    // The receiver decodes every gzip member. Read one byte past the expected size
    // so a correct-sized stream still has its trailer and any remaining input checked.
    let gzip = flate2::read::MultiGzDecoder::new(packed.as_slice());
    let mut hash = blake3::Hasher::new();
    let decoded_size = std::io::copy(&mut gzip.take(binary_size.checked_add(1)?), &mut hash).ok()?;
    (decoded_size == binary_size && hash.finalize() == expected).then_some(packed)
}

fn tempfile_dir(parent: &Path) -> IdeResult<PathBuf> {
    // Unique per call: two windows of this process may download at once.
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let dir = parent.join(format!(".download-{}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_and_cache_layout() {
        assert_eq!(asset_name("linux", "x86_64"), "openidea-server-linux-x86_64.gz");
        let p = cached_path(Path::new("/data"), "1.2.3", "linux", "aarch64");
        assert_eq!(p, Path::new("/data/server/1.2.3/linux-aarch64/openidea-server"));
    }

    #[test]
    fn cached_archive_must_decode_to_the_selected_build() {
        use std::io::Write as _;
        let pack = |bytes: &[u8]| {
            let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::best());
            gzip.write_all(bytes).unwrap();
            gzip.finish().unwrap()
        };
        let tmp = tempfile::tempdir().unwrap();
        let binary = tmp.path().join("openidea-server");
        let archive = binary.with_extension("gz");
        let payload = [b'a'; 4096];
        let expected = blake3::hash(&payload);
        std::fs::write(&binary, payload).unwrap();
        assert!(matching_archive(&binary, expected).is_none());

        let gzip = pack(&payload);
        std::fs::write(&archive, &gzip).unwrap();
        assert_eq!(matching_archive(&binary, expected), Some(gzip.clone()));

        let extra_member = pack(b"extra output");
        for invalid in [
            pack(&[b'b'; 4096]),
            gzip[..gzip.len() - 1].to_vec(),
            [gzip.as_slice(), &extra_member].concat(),
            [gzip.as_slice(), b"trailing junk"].concat(),
        ] {
            std::fs::write(&archive, &invalid).unwrap();
            assert!(matching_archive(&binary, expected).is_none());
        }
    }

    #[test]
    fn unsupported_hosts_are_refused_without_downloading() {
        let tmp = tempfile::tempdir().unwrap();
        let e = fetch(tmp.path(), "1.2.3", "freebsd", "x86_64", &CancellationToken::new(), &|_| {}).unwrap_err();
        assert!(e.message.contains("freebsd-x86_64"), "{e:?}");
    }
}
