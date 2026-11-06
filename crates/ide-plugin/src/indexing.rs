//! Edges a `document-indexer` export returns, and what the host answers from them.
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
    pub definitions: Vec<Anchor>,
    pub references: Vec<Anchor>,
    #[serde(default)]
    pub aliases: Vec<Alias>,
    #[serde(default)]
    pub markers: Vec<Anchor>,
}

/// The resolved gutter markers of one file.
#[derive(Clone, Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FileMarkers {
    pub path: PathBuf,
    pub version: Option<u32>,
    pub markers: Vec<NavigationResult>,
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
