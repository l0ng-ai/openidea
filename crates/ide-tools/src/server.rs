//! `openidea-server` builds for remote development: the release of this
//! version publishes one per supported host platform (see `release.yml`).

use crate::process::Http;
use crate::{InstallEvent, fetch_verified, sources};
use ide_core::CancellationToken;
use ide_core::{IdeError, IdeResult};
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
        let archive = fetch_verified(&http, &dl, &staging, cancel, emit)?;
        let unpacked = staging.join("openidea-server");
        let mut gz = flate2::read::GzDecoder::new(std::fs::File::open(&archive)?);
        std::io::copy(&mut gz, &mut std::fs::File::create(&unpacked)?)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&unpacked, std::fs::Permissions::from_mode(0o755))?;
        }
        std::fs::rename(&unpacked, &dest)?;
        Ok(dest.clone())
    })();
    let _ = std::fs::remove_dir_all(&staging);
    result
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
    fn unsupported_hosts_are_refused_without_downloading() {
        let tmp = tempfile::tempdir().unwrap();
        let e = fetch(tmp.path(), "1.2.3", "freebsd", "x86_64", &CancellationToken::new(), &|_| {}).unwrap_err();
        assert!(e.message.contains("freebsd-x86_64"), "{e:?}");
    }
}
