//! Manifest dependencies and repository versions, independent of editor and transport.
mod cache;
pub mod cargo;

pub use cache::VersionCache;
use ide_core::{CancellationToken, IdeResult};
use serde::{Deserialize, Serialize};
use specta::Type;

/// A repository adapter; Maven/npm can use the same cache and editor protocol.
pub trait DependencyVersionSource: Send + Sync {
    /// A filesystem-safe, stable repository identifier.
    fn id(&self) -> &'static str;
    /// Non-yanked versions in descending semantic order.
    fn fetch(&self, package: &str, cancel: &CancellationToken) -> IdeResult<Vec<String>>;
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DependencyUpdate {
    pub latest: String,
    pub replacement: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ManifestDependency {
    pub package: String,
    pub requirement: String,
    /// UTF-16 offsets of the string's contents (quotes excluded).
    pub from: u32,
    pub to: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DependencyVersions {
    pub dependency: ManifestDependency,
    pub versions: Vec<String>,
    pub update: Option<DependencyUpdate>,
}
