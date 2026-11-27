//! Flutter SDKs: Settings › Languages & Frameworks › Flutter (the Flutter plugin's "Flutter SDK path").

use crate::exec::query_in;
use crate::{Sdk, home_dir};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// `flutter --version` may first unpack the Dart SDK or print the analytics notice.
const VERSION_TIMEOUT: Duration = Duration::from_secs(60);

/// What `flutter --version --machine` reports of an SDK.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", default)]
pub struct FlutterVersion {
    /// SDK root (not part of Flutter's answer).
    pub root: String,
    pub framework_version: String,
    pub channel: Option<String>,
    pub dart_sdk_version: Option<String>,
}

pub(crate) fn flutter_script(sdk: &Path) -> PathBuf {
    sdk.join("bin").join(if cfg!(windows) { "flutter.bat" } else { "flutter" })
}

/// The SDK root of a `flutter` executable; on the search path it is often a link into the SDK.
pub fn sdk_of(flutter: &Path) -> Option<PathBuf> {
    let real = dunce::canonicalize(flutter).ok()?;
    let root = real.parent()?.parent()?;
    flutter_script(root).is_file().then(|| root.to_path_buf())
}

/// `flutter --version --machine` of the SDK at `sdk`. `None` when `sdk` holds no `bin/flutter`;
/// an empty `framework_version` when it did not answer.
pub fn version(sdk: &Path) -> Option<FlutterVersion> {
    let flutter = flutter_script(sdk);
    if !flutter.is_file() {
        return None;
    }
    let out = query_in(&flutter, &["--version", "--machine"], Some(sdk), &[], VERSION_TIMEOUT).unwrap_or_default();
    let mut version = parse_version(&out).unwrap_or_default();
    version.root = sdk.to_string_lossy().into_owned();
    Some(version)
}

/// The JSON object of `flutter --version --machine`, after anything it printed first.
fn parse_version(out: &str) -> Option<FlutterVersion> {
    let json = &out[out.find('{')?..=out.rfind('}')?];
    serde_json::from_str(json).ok()
}

/// The framework version an SDK records, without running it.
fn recorded_version(sdk: &Path) -> Option<String> {
    let json = std::fs::read_to_string(sdk.join("bin/cache/flutter.version.json")).ok();
    json.and_then(|j| parse_version(&j))
        .map(|v| v.framework_version)
        .or_else(|| std::fs::read_to_string(sdk.join("version")).ok().map(|v| v.trim().to_owned()))
        .filter(|v| !v.is_empty())
}

/// Flutter SDKs: the one on the search path, fvm's and the usual install folders.
pub(crate) fn detect() -> Vec<Sdk> {
    let mut roots: Vec<(PathBuf, &str)> = Vec::new();
    if let Some(sdk) = crate::exec::which("flutter").and_then(|f| sdk_of(&f)) {
        roots.push((sdk, "path"));
    }
    if let Some(home) = home_dir() {
        for dir in ["flutter", "development/flutter", "sdk/flutter"] {
            roots.push((home.join(dir), "system"));
        }
        if let Ok(versions) = std::fs::read_dir(home.join("fvm/versions")) {
            roots.extend(versions.flatten().map(|e| (e.path(), "fvm")));
        }
    }
    let mut seen = std::collections::HashSet::new();
    roots
        .into_iter()
        .filter(|(sdk, _)| flutter_script(sdk).is_file())
        .filter(|(sdk, _)| seen.insert(dunce::canonicalize(sdk).unwrap_or_else(|_| sdk.clone())))
        .map(|(sdk, source)| {
            let version = recorded_version(&sdk);
            Sdk {
                path: sdk.clone().into(),
                name: format!("Flutter {}", version.as_deref().unwrap_or_default()).trim().to_owned(),
                version,
                source: source.to_owned(),
                home: Some(sdk.into()),
                extra: None,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_version_after_what_flutter_printed_first() {
        let out = "Downloading Dart SDK…\n{\n  \"frameworkVersion\": \"3.38.1\",\n  \"channel\": \"stable\",\n  \"dartSdkVersion\": \"3.10.0\"\n}\n";
        let v = parse_version(out).unwrap();
        assert_eq!(
            (v.framework_version.as_str(), v.channel.as_deref(), v.dart_sdk_version.as_deref()),
            ("3.38.1", Some("stable"), Some("3.10.0"))
        );
        assert_eq!(parse_version("flutter: command not found"), None);
    }

    #[test]
    fn a_folder_without_bin_flutter_is_no_sdk() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(version(dir.path()), None);
        std::fs::create_dir_all(dir.path().join("bin/cache")).unwrap();
        std::fs::write(flutter_script(dir.path()), "").unwrap();
        std::fs::write(dir.path().join("bin/cache/flutter.version.json"), r#"{"frameworkVersion":"3.35.0"}"#).unwrap();
        assert_eq!(recorded_version(dir.path()).as_deref(), Some("3.35.0"));
        assert_eq!(sdk_of(&flutter_script(dir.path())), Some(dunce::canonicalize(dir.path()).unwrap()));
    }
}
