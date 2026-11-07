//! Settings › Editor › Inspections: inspection profiles. `Default` and the
//! user's IDE-level copies live in the IDE (global) settings, `Project Default`
//! and project-level copies in the project's; the project picks which one is in
//! effect. The UI applies the profile to diagnostics. Also Editor › Natural
//! Languages › Spelling (the Typo inspection's dictionaries).

use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct InspectionSettings {
    /// Profile in effect for the project: `default`, `project`, or a copy
    /// as `ide:<key>` / `project:<key>`.
    pub profile: String,
    /// The `Default` profile (IDE level): inspection id → override.
    pub default: BTreeMap<String, InspectionOverride>,
    /// The `Project Default` profile (stored with the project).
    pub project: BTreeMap<String, InspectionOverride>,
    /// Profiles copied at IDE level (global settings), by key.
    pub ide_profiles: BTreeMap<String, CustomInspectionProfile>,
    /// Profiles copied at project level (project settings), by key.
    pub project_profiles: BTreeMap<String, CustomInspectionProfile>,
}

impl Default for InspectionSettings {
    fn default() -> Self {
        Self {
            profile: "default".into(),
            default: BTreeMap::new(),
            project: BTreeMap::new(),
            ide_profiles: BTreeMap::new(),
            project_profiles: BTreeMap::new(),
        }
    }
}

impl InspectionSettings {
    /// The overrides of the profile in effect: the chosen one when it exists,
    /// else `Default` (as `effectiveProfileId` / `overridesOf` in
    /// `src/platform/inspections.ts` with a project open).
    pub fn active_overrides(&self) -> &BTreeMap<String, InspectionOverride> {
        let custom = |level: &str, key: &str| match level {
            "ide" => self.ide_profiles.get(key),
            "project" => self.project_profiles.get(key),
            _ => None,
        };
        match self.profile.as_str() {
            "project" => &self.project,
            other => other
                .split_once(':')
                .and_then(|(level, key)| custom(level, key))
                .map_or(&self.default, |p| &p.overrides),
        }
    }
}

/// A named profile made with Copy.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct CustomInspectionProfile {
    pub name: String,
    pub overrides: BTreeMap<String, InspectionOverride>,
}

/// Editor › Natural Languages › Spelling.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct SpellingSettings {
    /// Application-level dictionary: accepted words (IDE settings).
    pub ide_words: Vec<String>,
    /// Project-level dictionary: accepted words (project settings).
    pub project_words: Vec<String>,
    /// Custom dictionaries: plain word lists or Hunspell `.dic` files.
    pub custom_dictionaries: Vec<String>,
}

/// Changes to one inspection; absent fields keep the inspection's defaults.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct InspectionOverride {
    #[specta(optional)]
    pub enabled: Option<bool>,
    #[specta(optional)]
    pub severity: Option<InspectionLevel>,
    /// The inspection's own options (Typo: `processCode`, `processLiterals`,
    /// `processComments`); absent ones keep their defaults.
    #[specta(optional)]
    pub options: Option<BTreeMap<String, bool>>,
}

/// IDEA's highlighting levels.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum InspectionLevel {
    Error,
    Warning,
    WeakWarning,
    ServerProblem,
    Typo,
    /// Reported (Problems, Inspect Code) but not highlighted in the editor.
    None,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overrides_parse_partially() {
        let s: InspectionSettings = serde_json::from_str(
            r#"{"default":{"lsp:ruff":{"enabled":false},"lsp:ruff:F401":{"severity":"weakWarning"}}}"#,
        )
        .unwrap();
        assert_eq!(s.profile, "default");
        assert_eq!(s.default["lsp:ruff"].enabled, Some(false));
        assert_eq!(s.default["lsp:ruff:F401"].severity, Some(InspectionLevel::WeakWarning));
        assert!(s.project.is_empty());
        assert!(s.ide_profiles.is_empty());
        let s: InspectionSettings = serde_json::from_str(
            r#"{"profile":"ide:strict","ideProfiles":{"strict":{"name":"Strict","overrides":{"lsp:ruff":{"severity":"error"}}}}}"#,
        )
        .unwrap();
        assert_eq!(s.ide_profiles["strict"].name, "Strict");
        assert_eq!(s.ide_profiles["strict"].overrides["lsp:ruff"].severity, Some(InspectionLevel::Error));
        assert!(serde_json::from_str::<InspectionSettings>(r#"{"default":{"x":{"severity":"loud"}}}"#).is_err());
        let s: InspectionSettings =
            serde_json::from_str(r#"{"default":{"builtin:spelling":{"options":{"processCode":false}}}}"#).unwrap();
        assert!(!s.default["builtin:spelling"].options.as_ref().unwrap()["processCode"]);
        let back: InspectionSettings = serde_json::from_str(&serde_json::to_string(&s).unwrap()).unwrap();
        assert_eq!(back, s);
    }

    #[test]
    fn the_active_profile_falls_back_to_default() {
        let s: InspectionSettings = serde_json::from_str(
            r#"{"default":{"a":{"enabled":false}},"project":{"b":{"enabled":false}},
                "ideProfiles":{"strict":{"name":"Strict","overrides":{"c":{"enabled":false}}}},
                "projectProfiles":{"team":{"name":"Team","overrides":{"d":{"enabled":false}}}}}"#,
        )
        .unwrap();
        let active = |profile: &str| {
            let s = InspectionSettings { profile: profile.into(), ..s.clone() };
            s.active_overrides().keys().cloned().collect::<Vec<_>>()
        };
        assert_eq!(active("default"), ["a"]);
        assert_eq!(active("project"), ["b"]);
        assert_eq!(active("ide:strict"), ["c"]);
        assert_eq!(active("project:team"), ["d"]);
        assert_eq!(active("ide:gone"), ["a"]);
        assert_eq!(active("project:strict"), ["a"]);
        assert_eq!(active("nonsense"), ["a"]);
    }
}
