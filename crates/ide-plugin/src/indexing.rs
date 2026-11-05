use ide_core::{Location, Range};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::PathBuf;
#[derive(Clone, Debug, Deserialize, Serialize, Type)]
#[serde(deny_unknown_fields)]
pub struct Anchor {
    pub key: String,
    pub range: Range,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Alias {
    pub prefix: String,
    pub target: String,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Edges {
    #[serde(default)]
    pub aliases: Vec<Alias>,
    #[serde(default)]
    pub presentation: Presentation,
    pub definitions: Vec<Anchor>,
    pub references: Vec<Anchor>,
}

/// Optional declarative UI contributions. No plugin HTML or scripts reach the UI.
#[derive(Clone, Default, Debug, Deserialize, Serialize, Type)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
pub struct Presentation {
    pub icon: Option<String>,
    pub linked_only: bool,
    pub markers: Vec<Anchor>,
    pub regions: Vec<EmbeddedRegion>,
}
#[derive(Clone, Debug, Deserialize, Serialize, Type)]
#[serde(deny_unknown_fields)]
pub struct EmbeddedRegion {
    pub language: String,
    pub range: Range,
}
#[derive(Clone, Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FilePresentation {
    pub path: PathBuf,
    pub version: Option<u32>,
    pub icon: Option<String>,
    pub markers: Vec<NavigationResult>,
    pub regions: Vec<EmbeddedRegion>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NavigationResult {
    pub range: Range,
    pub targets: Vec<Location>,
}

pub struct IndexSymbol {
    pub name: String,
    pub kind: String,
    pub container: Option<String>,
    pub range: Range,
}
