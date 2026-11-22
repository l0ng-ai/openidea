//! .NET tool installs: the SDKs `dotnet` offers, the target framework a tool package on
//! nuget.org needs, and NuGet errors in `dotnet tool install` output. Parsing is pure;
//! network access goes through the `fetch` callback.

use ide_core::error::ErrorKind;
use ide_core::{IdeError, IdeResult};
use serde::Deserialize;

pub const SDK_DOWNLOAD_URL: &str = "https://dotnet.microsoft.com/download";

/// Catalog entries read before giving up on finding an older compatible version.
const MAX_VERSIONS_CHECKED: usize = 20;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Sdk {
    pub major: u32,
    pub version: String,
}

/// The newest SDK in `dotnet --list-sdks` output (`6.0.300 [/usr/local/share/dotnet/sdk]`).
pub fn newest_sdk(list_sdks: &str) -> Option<Sdk> {
    list_sdks
        .lines()
        .filter_map(|l| l.split_whitespace().next())
        .filter_map(|v| {
            let release = v.split('-').next()?;
            let parts: Vec<u32> = release.split('.').map(str::parse).collect::<Result<_, _>>().ok()?;
            Some((parts, v))
        })
        .max_by(|(a, _), (b, _)| a.cmp(b))
        .and_then(|(parts, v)| Some(Sdk { major: *parts.first()?, version: v.to_string() }))
}

/// Major .NET version of a target framework folder: `net11.0`, `netcoreapp3.1`, `net8.0-windows`.
/// .NET Framework monikers (`net48`) have no dot and give `None`.
pub fn tfm_major(tfm: &str) -> Option<u32> {
    let rest = tfm.strip_prefix("netcoreapp").or_else(|| tfm.strip_prefix("net"))?;
    rest.split_once('.')?.0.parse().ok()
}

/// `error NUxxxx: …` lines of `dotnet tool install` output, without the restore project path
/// that precedes them, each once.
pub fn nuget_errors(output: &str) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    for line in output.lines() {
        let Some(at) = line.find("error NU") else { continue };
        let error = line[at..].trim().to_string();
        if !found.contains(&error) {
            found.push(error);
        }
    }
    found
}

pub fn registration_url(package: &str) -> String {
    format!("https://api.nuget.org/v3/registration5-semver1/{}/index.json", package.to_ascii_lowercase())
}

#[derive(Deserialize)]
struct Registration {
    items: Vec<RegistrationPage>,
}

#[derive(Deserialize)]
struct RegistrationPage {
    #[serde(rename = "@id")]
    id: String,
    /// Left out when the package has many versions; the page URL then lists them.
    #[serde(default)]
    items: Option<Vec<RegistrationLeaf>>,
}

#[derive(Deserialize)]
struct RegistrationLeaf {
    #[serde(rename = "catalogEntry")]
    catalog_entry: CatalogSummary,
}

#[derive(Deserialize)]
struct CatalogSummary {
    #[serde(rename = "@id")]
    id: String,
    version: String,
    #[serde(default = "listed_default")]
    listed: bool,
}

fn listed_default() -> bool {
    true
}

#[derive(Deserialize)]
struct CatalogEntry {
    #[serde(default, rename = "packageEntries")]
    package_entries: Vec<PackageEntry>,
}

#[derive(Deserialize)]
struct PackageEntry {
    #[serde(rename = "fullName")]
    full_name: String,
}

fn proto(what: &str, e: serde_json::Error) -> IdeError {
    IdeError::new(ErrorKind::Protocol, format!("unexpected NuGet {what}: {e}"))
}

/// The lowest .NET major a tool package runs on, from its `tools/<tfm>/` folders.
pub fn catalog_framework_major(json: &str) -> IdeResult<Option<u32>> {
    let entry: CatalogEntry = serde_json::from_str(json).map_err(|e| proto("catalog entry", e))?;
    Ok(entry
        .package_entries
        .iter()
        .filter_map(|e| e.full_name.strip_prefix("tools/")?.split('/').next())
        .filter_map(tfm_major)
        .min())
}

/// Which version of a .NET tool to install with the SDK at hand.
#[derive(Debug, PartialEq, Eq)]
pub enum ToolPick {
    /// The latest version runs on the SDK, or its framework is unknown: install without `--version`.
    Latest,
    /// The latest version needs a newer SDK; `version` is the newest one that does not.
    Older { version: String, latest: String, needs: u32 },
    /// No checked version runs on the SDK.
    Incompatible { latest: String, needs: u32 },
}

/// Walks the package's stable, listed versions on nuget.org from the newest down until one
/// targets a framework the SDK supports.
pub fn pick_tool_version(
    package: &str,
    sdk_major: u32,
    mut fetch: impl FnMut(&str) -> IdeResult<String>,
) -> IdeResult<ToolPick> {
    let index: Registration =
        serde_json::from_str(&fetch(&registration_url(package))?).map_err(|e| proto("registration", e))?;
    let mut latest: Option<(String, u32)> = None;
    let mut checked = 0;
    for page in index.items.into_iter().rev() {
        let leaves = match page.items {
            Some(items) => items,
            None => serde_json::from_str::<RegistrationPage>(&fetch(&page.id)?)
                .map_err(|e| proto("registration page", e))?
                .items
                .unwrap_or_default(),
        };
        for leaf in leaves.into_iter().rev() {
            let entry = leaf.catalog_entry;
            if !entry.listed || entry.version.contains('-') {
                continue;
            }
            let Some(major) = catalog_framework_major(&fetch(&entry.id)?)? else {
                if latest.is_none() {
                    return Ok(ToolPick::Latest);
                }
                continue;
            };
            match &latest {
                None if major <= sdk_major => return Ok(ToolPick::Latest),
                None => latest = Some((entry.version.clone(), major)),
                Some((latest, needs)) if major <= sdk_major => {
                    return Ok(ToolPick::Older { version: entry.version, latest: latest.clone(), needs: *needs });
                }
                Some(_) => {}
            }
            checked += 1;
            if checked >= MAX_VERSIONS_CHECKED {
                break;
            }
        }
        if checked >= MAX_VERSIONS_CHECKED {
            break;
        }
    }
    Ok(match latest {
        Some((latest, needs)) => ToolPick::Incompatible { latest, needs },
        None => ToolPick::Latest,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn newest_sdk_compares_numerically() {
        let out = "6.0.300 [/usr/local/share/dotnet/sdk]\n10.0.100-rc.2.25502.107 [/usr/local/share/dotnet/sdk]\n9.0.306 [/usr/local/share/dotnet/sdk]\n";
        assert_eq!(newest_sdk(out), Some(Sdk { major: 10, version: "10.0.100-rc.2.25502.107".into() }));
        assert_eq!(newest_sdk("6.0.300 [/x]\n6.0.1000 [/x]\n").unwrap().version, "6.0.1000");
        assert_eq!(newest_sdk(""), None);
        assert_eq!(newest_sdk("not an sdk\n"), None);
    }

    #[test]
    fn framework_monikers() {
        assert_eq!(tfm_major("net11.0"), Some(11));
        assert_eq!(tfm_major("netcoreapp3.1"), Some(3));
        assert_eq!(tfm_major("net8.0-windows"), Some(8));
        assert_eq!(tfm_major("net48"), None);
        assert_eq!(tfm_major("netstandard2.0"), None);
    }

    #[test]
    fn nuget_errors_drop_the_project_path_and_repeats() {
        let out = "\
     1>/var/folders/T/abc/restore.csproj : error NU1202: Package csharp-ls 0.29.0 is not compatible with net6.0 (.NETCoreApp,Version=v6.0) / any. Package csharp-ls 0.29.0 supports: net11.0 (.NETCoreApp,Version=v11.0) / any
The tool package could not be restored.
         /var/folders/T/abc/restore.csproj : error NU1202: Package csharp-ls 0.29.0 is not compatible with net6.0 (.NETCoreApp,Version=v6.0) / any. Package csharp-ls 0.29.0 supports: net11.0 (.NETCoreApp,Version=v11.0) / any
* The required NuGet feed cannot be accessed, perhaps because of an Internet connection problem.
";
        assert_eq!(
            nuget_errors(out),
            [
                "error NU1202: Package csharp-ls 0.29.0 is not compatible with net6.0 (.NETCoreApp,Version=v6.0) / any. Package csharp-ls 0.29.0 supports: net11.0 (.NETCoreApp,Version=v11.0) / any"
            ]
        );
        assert!(nuget_errors("Tool 'x' failed to install.").is_empty());
    }

    #[test]
    fn catalog_framework_is_the_lowest_tools_folder() {
        let json = r#"{"packageEntries":[
            {"fullName":"tools/net10.0/any/fsautocomplete.dll"},
            {"fullName":"tools/net8.0/any/fsautocomplete.dll"},
            {"fullName":"README.md"}
        ]}"#;
        assert_eq!(catalog_framework_major(json).unwrap(), Some(8));
        assert_eq!(catalog_framework_major(r#"{"packageEntries":[]}"#).unwrap(), None);
    }

    fn leaf(version: &str, listed: bool) -> String {
        format!(
            r#"{{"catalogEntry":{{"@id":"https://catalog/{version}.json","version":"{version}","listed":{listed}}}}}"#
        )
    }

    fn catalog(tfm: &str) -> String {
        format!(r#"{{"packageEntries":[{{"fullName":"tools/{tfm}/any/tool.dll"}}]}}"#)
    }

    /// csharp-ls's history: 0.20.0 on net9.0, 0.28.0 on net10.0, 0.29.0 on net11.0.
    fn feed() -> HashMap<String, String> {
        let page2 = format!(
            r#"{{"@id":"https://reg/page2","items":[{},{},{}]}}"#,
            leaf("0.28.0", true),
            leaf("0.29.0-beta", true),
            leaf("0.29.0", true)
        );
        HashMap::from([
            (registration_url("csharp-ls"), format!(r#"{{"items":[{{"@id":"https://reg/page1"}},{}]}}"#, page2)),
            (
                "https://reg/page1".into(),
                format!(
                    r#"{{"@id":"https://reg/page1","items":[{},{}]}}"#,
                    leaf("0.20.0", true),
                    leaf("0.21.0", false)
                ),
            ),
            ("https://catalog/0.20.0.json".into(), catalog("net9.0")),
            ("https://catalog/0.21.0.json".into(), catalog("net8.0")),
            ("https://catalog/0.28.0.json".into(), catalog("net10.0")),
            ("https://catalog/0.29.0-beta.json".into(), catalog("net9.0")),
            ("https://catalog/0.29.0.json".into(), catalog("net11.0")),
        ])
    }

    fn pick(sdk_major: u32) -> (ToolPick, Vec<String>) {
        let feed = feed();
        let mut fetched = Vec::new();
        let pick = pick_tool_version("csharp-ls", sdk_major, |url| {
            fetched.push(url.to_string());
            feed.get(url).cloned().ok_or_else(|| IdeError::not_found(url.to_string()))
        })
        .unwrap();
        (pick, fetched)
    }

    #[test]
    fn latest_version_on_a_new_enough_sdk() {
        let (p, fetched) = pick(11);
        assert_eq!(p, ToolPick::Latest);
        assert_eq!(fetched.len(), 2, "{fetched:?}");
    }

    #[test]
    fn newest_compatible_older_version_skips_prereleases() {
        let (p, _) = pick(10);
        assert_eq!(p, ToolPick::Older { version: "0.28.0".into(), latest: "0.29.0".into(), needs: 11 });
    }

    #[test]
    fn older_versions_on_a_page_that_is_not_inline_skip_unlisted_ones() {
        let (p, fetched) = pick(9);
        assert_eq!(p, ToolPick::Older { version: "0.20.0".into(), latest: "0.29.0".into(), needs: 11 });
        assert!(fetched.contains(&"https://reg/page1".to_string()));
        assert!(!fetched.contains(&"https://catalog/0.21.0.json".to_string()));
    }

    #[test]
    fn no_compatible_version_reports_what_the_latest_needs() {
        let (p, _) = pick(6);
        assert_eq!(p, ToolPick::Incompatible { latest: "0.29.0".into(), needs: 11 });
    }
}
