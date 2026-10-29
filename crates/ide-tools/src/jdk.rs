//! JDK downloads (IDEA's Download JDK): Eclipse Temurin builds from the
//! Adoptium API, unpacked into `<tools>/jdks/<vendor>-<version>` (or a chosen
//! location) where JDK discovery finds them. Parsing is pure so it is testable
//! without network.

use crate::platform::{Arch, Os, Platform};
use crate::process::{Emit, Http};
use crate::sources::Download;
use crate::{InstallEvent, InstallGuard, Tools, archive, clear_quarantine, fetch_verified};
use ide_core::error::ErrorKind;
use ide_core::{CancellationToken, IdeError, IdeResult};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};

const ADOPTIUM_API: &str = "https://api.adoptium.net/v3";

/// A JDK distribution the IDE can download.
#[derive(Clone, Debug, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct JdkVendor {
    pub id: String,
    pub name: String,
}

pub const TEMURIN: &str = "temurin";

pub fn vendors() -> Vec<JdkVendor> {
    vec![JdkVendor { id: TEMURIN.into(), name: "Eclipse Temurin".into() }]
}

/// Java versions a vendor publishes.
#[derive(Clone, Debug, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct JdkReleases {
    /// Feature versions, newest first.
    pub versions: Vec<u32>,
    /// The long-term-support ones among them.
    pub lts: Vec<u32>,
    /// The version offered first (the newest LTS).
    pub recommended: u32,
}

/// A JDK the IDE downloaded.
#[derive(Clone, Debug, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DownloadedJdk {
    pub home: ide_core::IpcPath,
    /// Full version, e.g. `25.0.1`.
    pub version: String,
    pub major: u32,
}

/// Where downloaded JDKs go by default.
pub fn jdks_dir(app_data: &Path) -> PathBuf {
    crate::tools_dir(app_data).join("jdks")
}

fn proto(msg: impl Into<String>) -> IdeError {
    IdeError::new(ErrorKind::Protocol, msg)
}

fn vendor_or_err(vendor: &str) -> IdeResult<()> {
    if vendor == TEMURIN { Ok(()) } else { Err(IdeError::invalid(format!("unknown JDK vendor `{vendor}`"))) }
}

pub fn adoptium_releases_url() -> String {
    format!("{ADOPTIUM_API}/info/available_releases")
}

#[derive(Deserialize)]
struct AvailableReleases {
    available_releases: Vec<u32>,
    #[serde(default)]
    available_lts_releases: Vec<u32>,
    #[serde(default)]
    most_recent_lts: Option<u32>,
}

pub fn parse_releases(json: &str) -> IdeResult<JdkReleases> {
    let r: AvailableReleases =
        serde_json::from_str(json).map_err(|e| proto(format!("unexpected Adoptium response: {e}")))?;
    let mut versions = r.available_releases;
    versions.sort_unstable_by(|a, b| b.cmp(a));
    versions.dedup();
    let recommended = r
        .most_recent_lts
        .or_else(|| r.available_lts_releases.iter().copied().max())
        .or_else(|| versions.first().copied())
        .ok_or_else(|| proto("Adoptium lists no Java versions"))?;
    Ok(JdkReleases { versions, lts: r.available_lts_releases, recommended })
}

fn adoptium_os(os: Os) -> &'static str {
    match os {
        Os::Mac => "mac",
        Os::Linux => "linux",
        Os::Windows => "windows",
    }
}

fn adoptium_arch(arch: Arch) -> &'static str {
    match arch {
        Arch::X64 => "x64",
        Arch::Arm64 => "aarch64",
    }
}

/// The latest Temurin JDK build of Java `feature` for `platform`.
pub fn adoptium_assets_url(feature: u32, platform: Platform) -> String {
    format!(
        "{ADOPTIUM_API}/assets/latest/{feature}/hotspot?architecture={}&image_type=jdk&os={}&vendor=eclipse",
        adoptium_arch(platform.arch),
        adoptium_os(platform.os),
    )
}

#[derive(Deserialize)]
struct Asset {
    binary: Binary,
    version: AssetVersion,
}

#[derive(Deserialize)]
struct Binary {
    #[serde(default)]
    image_type: Option<String>,
    #[serde(default)]
    heap_size: Option<String>,
    #[serde(default)]
    os: Option<String>,
    package: Package,
}

#[derive(Deserialize)]
struct Package {
    name: String,
    link: String,
    #[serde(default)]
    checksum: Option<String>,
    #[serde(default)]
    size: Option<u64>,
}

#[derive(Deserialize)]
struct AssetVersion {
    major: u32,
    #[serde(default)]
    minor: u32,
    #[serde(default)]
    security: u32,
    #[serde(default)]
    openjdk_version: Option<String>,
}

impl AssetVersion {
    /// `25.0.1` (`openjdk_version` without its build; `1.8.0_472` style for Java 8).
    fn display(&self) -> String {
        let plain = || format!("{}.{}.{}", self.major, self.minor, self.security);
        match &self.openjdk_version {
            Some(v) => {
                let v = v.split(['+', '-']).next().unwrap_or(v);
                if v.is_empty() { plain() } else { v.to_owned() }
            }
            None => plain(),
        }
    }
}

/// The JDK archive (`.tar.gz` on macOS / Linux, `.zip` on Windows) in an Adoptium
/// `assets/latest` response; `None` when there is no build for the platform.
pub fn adoptium_pick(json: &str, platform: Platform) -> IdeResult<Option<(Download, u32)>> {
    let assets: Vec<Asset> =
        serde_json::from_str(json).map_err(|e| proto(format!("unexpected Adoptium response: {e}")))?;
    let ext = if platform.os == Os::Windows { ".zip" } else { ".tar.gz" };
    let os = adoptium_os(platform.os);
    let found = assets.into_iter().find(|a| {
        a.binary.image_type.as_deref().is_none_or(|t| t == "jdk")
            && a.binary.heap_size.as_deref().is_none_or(|h| h == "normal")
            && a.binary.os.as_deref().is_none_or(|o| o == os)
            && a.binary.package.name.ends_with(ext)
    });
    Ok(found.map(|a| {
        let sha256 = a.binary.package.checksum.map(|c| c.trim().to_ascii_lowercase()).filter(|c| c.len() == 64);
        (
            Download {
                version: a.version.display(),
                name: a.binary.package.name,
                url: a.binary.package.link,
                size: a.binary.package.size,
                sha256,
                checksum_url: None,
            },
            a.version.major,
        )
    }))
}

/// Folder name of a downloaded JDK, as IDEA names them: `temurin-25.0.1`.
pub fn jdk_dir_name(vendor: &str, version: &str) -> String {
    let safe: String =
        version.chars().map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '_') { c } else { '-' }).collect();
    format!("{vendor}-{safe}")
}

fn is_jdk_home(dir: &Path, platform: Platform) -> bool {
    dir.join("release").is_file() && dir.join("bin").join(platform.exe("java")).is_file()
}

/// The JDK home inside an unpacked JDK: `dir` itself, `dir/Contents/Home`
/// (a macOS bundle), or either of those below one top-level folder
/// (`jdk-25.0.1+8/`, `jdk-25.0.1+8/Contents/Home`).
pub fn find_jdk_home(dir: &Path, platform: Platform) -> Option<PathBuf> {
    let candidates = |d: &Path| [d.to_path_buf(), d.join("Contents").join("Home")];
    if let Some(home) = candidates(dir).into_iter().find(|h| is_jdk_home(h, platform)) {
        return Some(home);
    }
    let mut subdirs: Vec<PathBuf> = std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .map(|e| e.path())
        .collect();
    subdirs.sort();
    subdirs.iter().flat_map(|d| candidates(d)).find(|h| is_jdk_home(h, platform))
}

/// The directory to move into place: the archive's single top-level folder
/// holding the JDK, else everything that was unpacked.
fn unpacked_root(pkg: &Path, home: &Path) -> PathBuf {
    match home.strip_prefix(pkg).ok().and_then(|rel| rel.components().next()) {
        Some(first) if first.as_os_str() != "Contents" => pkg.join(first),
        _ => pkg.to_path_buf(),
    }
}

impl Tools {
    fn http(&self) -> IdeResult<Http> {
        Http::new(&self.system_path)
    }

    /// Java versions `vendor` publishes.
    pub fn jdk_releases(&self, vendor: &str, cancel: &CancellationToken) -> IdeResult<JdkReleases> {
        vendor_or_err(vendor)?;
        parse_releases(&self.http()?.get_text(&adoptium_releases_url(), cancel)?)
    }

    /// Downloads the latest `vendor` JDK of Java `feature` into
    /// `<location>/<vendor>-<version>` (`location` defaults to the tools' `jdks`
    /// folder), verifying its SHA-256. A JDK already there is reused.
    pub fn download_jdk(
        &self,
        vendor: &str,
        feature: u32,
        location: Option<&Path>,
        cancel: &CancellationToken,
        emit: Emit,
    ) -> IdeResult<DownloadedJdk> {
        vendor_or_err(vendor)?;
        let _guard = InstallGuard::acquire(&format!("jdk-{vendor}-{feature}"))?;
        let http = self.http()?;
        let location = location.map(Path::to_path_buf).unwrap_or_else(|| self.root.join("jdks"));
        emit(InstallEvent::Line { text: format!("Resolving the latest Eclipse Temurin {feature}…") });
        let mut picked =
            adoptium_pick(&http.get_text(&adoptium_assets_url(feature, self.platform), cancel)?, self.platform)?;
        if picked.is_none() && self.platform.os == Os::Mac && self.platform.arch == Arch::Arm64 {
            // Java 8 has no Apple Silicon build: the Intel one runs under Rosetta.
            let intel = Platform { os: Os::Mac, arch: Arch::X64 };
            picked = adoptium_pick(&http.get_text(&adoptium_assets_url(feature, intel), cancel)?, intel)?;
        }
        let (dl, major) = picked.ok_or_else(|| {
            IdeError::unavailable(format!(
                "Eclipse Temurin {feature} has no build for {:?} {:?}",
                self.platform.os, self.platform.arch
            ))
        })?;
        let target = location.join(jdk_dir_name(vendor, &dl.version));
        let done = |home: PathBuf| DownloadedJdk { home: home.into(), version: dl.version.clone(), major };
        if let Some(home) = find_jdk_home(&target, self.platform) {
            emit(InstallEvent::Line { text: format!("{} is already installed", target.display()) });
            return Ok(done(home));
        }
        emit(InstallEvent::Line { text: format!("Downloading {} ({})", dl.name, dl.url) });
        std::fs::create_dir_all(&location)?;
        // Next to the target, so moving it into place never crosses file systems.
        let staging = location.join(format!(".staging-{}", jdk_dir_name(vendor, &dl.version)));
        let _ = std::fs::remove_dir_all(&staging);
        std::fs::create_dir_all(&staging)?;
        let result = (|| {
            let archive = fetch_verified(&http, &dl, &staging, cancel, emit)?;
            emit(InstallEvent::Line { text: "Extracting…".into() });
            let pkg = staging.join("pkg");
            archive::extract(&archive, archive::ArchiveKind::from_name(&dl.name), &pkg, "java", cancel)?;
            let home = find_jdk_home(&pkg, self.platform)
                .ok_or_else(|| IdeError::new(ErrorKind::Io, format!("no JDK found in {}", dl.name)))?;
            // Last point to stop: from here the JDK replaces what is at `target`.
            if cancel.is_cancelled() {
                return Err(IdeError::cancelled());
            }
            if target.exists() {
                std::fs::remove_dir_all(&target)?;
            }
            std::fs::rename(unpacked_root(&pkg, &home), &target)?;
            clear_quarantine(&target);
            find_jdk_home(&target, self.platform)
                .ok_or_else(|| IdeError::new(ErrorKind::Io, format!("no JDK found in {}", target.display())))
        })();
        let _ = std::fs::remove_dir_all(&staging);
        let home = result?;
        emit(InstallEvent::Line { text: format!("Eclipse Temurin {} installed in {}", dl.version, home.display()) });
        Ok(done(home))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MAC_ARM: Platform = Platform { os: Os::Mac, arch: Arch::Arm64 };
    const LINUX_X64: Platform = Platform { os: Os::Linux, arch: Arch::X64 };
    const WIN_X64: Platform = Platform { os: Os::Windows, arch: Arch::X64 };

    #[test]
    fn releases() {
        let json = r#"{"available_lts_releases":[8,11,17,21,25],"available_releases":[8,11,16,17,21,24,25,26],
            "most_recent_feature_release":26,"most_recent_lts":25,"tip_version":27}"#;
        let r = parse_releases(json).unwrap();
        assert_eq!(r.versions, [26, 25, 24, 21, 17, 16, 11, 8]);
        assert_eq!(r.lts, [8, 11, 17, 21, 25]);
        assert_eq!(r.recommended, 25);
        assert!(parse_releases("{}").is_err());
    }

    #[test]
    fn asset_urls() {
        assert_eq!(
            adoptium_assets_url(25, MAC_ARM),
            "https://api.adoptium.net/v3/assets/latest/25/hotspot?architecture=aarch64&image_type=jdk&os=mac&vendor=eclipse"
        );
        assert_eq!(
            adoptium_assets_url(21, WIN_X64),
            "https://api.adoptium.net/v3/assets/latest/21/hotspot?architecture=x64&image_type=jdk&os=windows&vendor=eclipse"
        );
        assert!(adoptium_assets_url(17, LINUX_X64).contains("os=linux"));
    }

    fn asset(name: &str, os: &str, heap: &str, checksum: &str) -> String {
        format!(
            r#"{{"binary":{{"architecture":"x64","heap_size":"{heap}","image_type":"jdk","os":"{os}",
                "installer":{{"name":"x.msi","link":"https://e/x.msi","checksum":"00"}},
                "package":{{"name":"{name}","link":"https://e/{name}","checksum":"{checksum}","size":1234}}}},
              "release_name":"jdk-25.0.1+8","vendor":"eclipse",
              "version":{{"major":25,"minor":0,"security":1,"build":8,"openjdk_version":"25.0.1+8-LTS"}}}}"#
        )
    }

    #[test]
    fn picks_the_platform_archive() {
        let sum = "36DC14D797AAFF6D89AAB302CD053FDBA6207DFDCF772052FA7B023A94B0E857";
        let json = format!(
            "[{},{},{}]",
            asset("OpenJDK25U-jdk_x64_windows_hotspot_25.0.1_8.zip", "windows", "large", sum),
            asset("OpenJDK25U-jdk_x64_windows_hotspot_25.0.1_8.zip", "windows", "normal", sum),
            asset("OpenJDK25U-jdk_x64_linux_hotspot_25.0.1_8.tar.gz", "linux", "normal", sum),
        );
        let (dl, major) = adoptium_pick(&json, WIN_X64).unwrap().unwrap();
        assert_eq!(dl.name, "OpenJDK25U-jdk_x64_windows_hotspot_25.0.1_8.zip");
        assert_eq!(dl.url, "https://e/OpenJDK25U-jdk_x64_windows_hotspot_25.0.1_8.zip");
        assert_eq!(dl.sha256.as_deref(), Some(sum.to_ascii_lowercase().as_str()));
        assert_eq!((dl.version.as_str(), major, dl.size), ("25.0.1", 25, Some(1234)));
        let (dl, _) = adoptium_pick(&json, LINUX_X64).unwrap().unwrap();
        assert!(dl.name.ends_with(".tar.gz"));
        // No build for the platform (Java 8 on Apple Silicon): an empty list.
        assert_eq!(adoptium_pick("[]", MAC_ARM).unwrap(), None);
        assert_eq!(adoptium_pick(&json, MAC_ARM).unwrap(), None);
        assert!(adoptium_pick("{\"errorMessage\":\"x\"}", MAC_ARM).is_err());
    }

    #[test]
    fn java_8_versions_and_dir_names() {
        let v = AssetVersion { major: 8, minor: 0, security: 472, openjdk_version: Some("1.8.0_472-b08".into()) };
        assert_eq!(v.display(), "1.8.0_472");
        let v = AssetVersion { major: 21, minor: 0, security: 9, openjdk_version: None };
        assert_eq!(v.display(), "21.0.9");
        assert_eq!(jdk_dir_name(TEMURIN, "25.0.1"), "temurin-25.0.1");
        assert_eq!(jdk_dir_name(TEMURIN, "1.8.0_472"), "temurin-1.8.0_472");
    }

    fn fake_jdk(home: &Path, platform: Platform) {
        std::fs::create_dir_all(home.join("bin")).unwrap();
        std::fs::write(home.join("release"), "JAVA_VERSION=\"25.0.1\"\n").unwrap();
        std::fs::write(home.join("bin").join(platform.exe("java")), "").unwrap();
    }

    #[test]
    fn finds_the_home_of_each_archive_layout() {
        let tmp = tempfile::tempdir().unwrap();
        // macOS: jdk-25.0.1+8/Contents/Home
        let mac = tmp.path().join("mac");
        fake_jdk(&mac.join("jdk-25.0.1+8/Contents/Home"), MAC_ARM);
        std::fs::create_dir_all(mac.join("jdk-25.0.1+8/Contents/MacOS")).unwrap();
        let home = find_jdk_home(&mac, MAC_ARM).unwrap();
        assert_eq!(home, mac.join("jdk-25.0.1+8/Contents/Home"));
        assert_eq!(unpacked_root(&mac, &home), mac.join("jdk-25.0.1+8"));
        // Once moved into place, the bundle itself.
        assert_eq!(find_jdk_home(&mac.join("jdk-25.0.1+8"), MAC_ARM).unwrap(), mac.join("jdk-25.0.1+8/Contents/Home"));
        // Linux tar.gz / Windows zip: jdk-25.0.1+8/bin/java[.exe]
        for platform in [LINUX_X64, WIN_X64] {
            let dir = tmp.path().join(format!("{:?}", platform.os));
            fake_jdk(&dir.join("jdk-25.0.1+8"), platform);
            let home = find_jdk_home(&dir, platform).unwrap();
            assert_eq!(home, dir.join("jdk-25.0.1+8"));
            assert_eq!(unpacked_root(&dir, &home), dir.join("jdk-25.0.1+8"));
        }
        // Without a top-level folder, everything unpacked is the JDK.
        let flat = tmp.path().join("flat");
        fake_jdk(&flat, LINUX_X64);
        assert_eq!(find_jdk_home(&flat, LINUX_X64).unwrap(), flat);
        assert_eq!(unpacked_root(&flat, &flat), flat);
        let bundle = tmp.path().join("bundle");
        fake_jdk(&bundle.join("Contents/Home"), MAC_ARM);
        assert_eq!(unpacked_root(&bundle, &bundle.join("Contents/Home")), bundle);
        // A Windows layout isn't a JDK for Linux (no `bin/java`), nor is a folder without `release`.
        assert_eq!(find_jdk_home(&tmp.path().join("Windows"), LINUX_X64), None);
        std::fs::create_dir_all(tmp.path().join("norelease/bin")).unwrap();
        std::fs::write(tmp.path().join("norelease/bin/java"), "").unwrap();
        assert_eq!(find_jdk_home(&tmp.path().join("norelease"), LINUX_X64), None);
    }

    #[test]
    fn unknown_vendors_are_refused() {
        let tools = Tools::with_paths(PathBuf::from("/nonexistent"), Default::default(), LINUX_X64);
        let err = tools.download_jdk("acme", 25, None, &CancellationToken::new(), &|_| {}).unwrap_err();
        assert_eq!(err.kind, ErrorKind::InvalidInput, "{err:?}");
    }

    /// Downloads a real JDK from Adoptium: `OPENIDEA_LIVE_JDK=25 cargo nextest run -p ide-tools live_download`;
    /// `OPENIDEA_LIVE_JDK_OS=windows|linux` fetches and unpacks another platform's archive (not run).
    #[test]
    fn live_download() {
        let Some(feature) = std::env::var("OPENIDEA_LIVE_JDK").ok().and_then(|v| v.parse::<u32>().ok()) else {
            return;
        };
        let tmp = tempfile::tempdir().unwrap();
        let other = match std::env::var("OPENIDEA_LIVE_JDK_OS").as_deref() {
            Ok("windows") => Some(WIN_X64),
            Ok("linux") => Some(LINUX_X64),
            _ => None,
        };
        if let Some(platform) = other {
            let tools = Tools::with_paths(crate::tools_dir(tmp.path()), crate::default_search_path(), platform);
            let jdk = tools.download_jdk(TEMURIN, feature, None, &CancellationToken::new(), &|_| {}).unwrap();
            let home = jdk.home.into_path_buf();
            eprintln!("{}", home.display());
            assert!(home.join("bin").join(platform.exe("java")).is_file());
            assert_eq!(home.parent(), Some(jdks_dir(tmp.path()).as_path()), "no Contents/Home outside macOS");
            return;
        }
        let tools = Tools::new(tmp.path());
        let releases = tools.jdk_releases(TEMURIN, &CancellationToken::new()).unwrap();
        assert!(releases.versions.contains(&feature), "{releases:?}");
        let emit = |e: InstallEvent| {
            if let InstallEvent::Line { text } = e {
                eprintln!("{text}");
            }
        };
        let jdk = tools.download_jdk(TEMURIN, feature, None, &CancellationToken::new(), &emit).unwrap();
        let home = jdk.home.clone().into_path_buf();
        assert!(home.starts_with(jdks_dir(tmp.path())), "{}", home.display());
        let out = std::process::Command::new(home.join("bin").join(Platform::current().exe("java")))
            .arg("-version")
            .output()
            .unwrap();
        let text = String::from_utf8_lossy(&out.stderr);
        eprintln!("{text}");
        assert!(out.status.success() && text.contains("Temurin"), "{text}");
        // Downloading again reuses it.
        let again = tools.download_jdk(TEMURIN, feature, None, &CancellationToken::new(), &|_| {}).unwrap();
        assert_eq!(again.home, jdk.home);
    }
}
