//! Projects on pypi.org, from its JSON API (`/pypi/<name>/json`).
use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PypiPackage {
    /// The name as PyPI spells it.
    pub name: String,
    pub summary: String,
    /// The newest release that is not a pre-release; empty when every release is yanked.
    pub latest: String,
    /// Releases with files to install, most recently uploaded first; yanked ones left out.
    pub versions: Vec<String>,
}

/// The JSON API URL of a project; `None` unless `name` is a valid distribution name (PEP 508).
pub fn project_url(name: &str) -> Option<String> {
    let edge = |b: Option<&u8>| b.is_some_and(u8::is_ascii_alphanumeric);
    let bytes = name.as_bytes();
    (name.len() <= 128
        && edge(bytes.first())
        && edge(bytes.last())
        && bytes.iter().all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(b)))
    .then(|| format!("https://pypi.org/pypi/{name}/json"))
}

pub fn parse_project(json: &str) -> Option<PypiPackage> {
    #[derive(Deserialize)]
    struct Project {
        info: Info,
        #[serde(default)]
        releases: std::collections::BTreeMap<String, Vec<File>>,
    }
    #[derive(Deserialize)]
    struct Info {
        name: String,
        summary: Option<String>,
        version: String,
        #[serde(default)]
        yanked: bool,
    }
    #[derive(Deserialize)]
    struct File {
        #[serde(default)]
        yanked: bool,
        #[serde(default)]
        upload_time_iso_8601: String,
    }
    let project: Project = serde_json::from_str(json).ok()?;
    // ponytail: ordered by upload time, not PEP 440, so a backport released after a newer
    // major sorts above it. Parse the versions if that order turns out to matter.
    let mut releases: Vec<(String, String)> = project
        .releases
        .into_iter()
        .filter(|(_, files)| files.iter().any(|f| !f.yanked))
        .map(|(version, files)| (files.into_iter().map(|f| f.upload_time_iso_8601).min().unwrap_or_default(), version))
        .collect();
    releases.sort_unstable_by(|a, b| b.cmp(a));
    let info = project.info;
    Some(PypiPackage {
        name: info.name,
        summary: info.summary.unwrap_or_default(),
        latest: if info.yanked { String::new() } else { info.version },
        versions: releases.into_iter().map(|(_, version)| version).collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_distribution_names_get_a_url() {
        assert_eq!(project_url("typing_extensions").as_deref(), Some("https://pypi.org/pypi/typing_extensions/json"));
        assert!(project_url("zope.interface").is_some());
        for bad in ["", "-pip", "pip-", "a/b", "../x", "a b", "requests==2.0", "naïve", "a?b", &"a".repeat(129)] {
            assert_eq!(project_url(bad), None, "{bad}");
        }
    }

    #[test]
    fn releases_are_listed_newest_first_without_yanked_or_empty_ones() {
        let json = r#"{
            "info": {"name": "Demo", "summary": null, "version": "2.0", "yanked": false},
            "releases": {
                "1.0": [{"yanked": false, "upload_time_iso_8601": "2020-01-01T00:00:00.000000Z"}],
                "1.1": [{"yanked": true, "upload_time_iso_8601": "2020-06-01T00:00:00.000000Z"}],
                "2.0": [{"yanked": false, "upload_time_iso_8601": "2021-01-01T00:00:00.000000Z"},
                        {"yanked": false, "upload_time_iso_8601": "2021-01-02T00:00:00.000000Z"}],
                "2.1rc1": [{"yanked": false, "upload_time_iso_8601": "2021-03-01T00:00:00.000000Z"}],
                "0.1": []
            }
        }"#;
        let project = parse_project(json).unwrap();
        assert_eq!(project.name, "Demo");
        assert_eq!(project.summary, "");
        assert_eq!(project.latest, "2.0");
        assert_eq!(project.versions, ["2.1rc1", "2.0", "1.0"]);
        assert_eq!(parse_project(r#"{"message": "Not Found"}"#), None);
    }
}
