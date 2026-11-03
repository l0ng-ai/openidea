//! The plugin system's kernel, independent of the Wasm runtime:
//!
//! - [`Manifest`]: `plugin.toml` (0.2 format; 0.1 still parses);
//! - [`Capability`]: what a plugin may do, with its [`Risk`] level;
//! - [`ExtensionPoint`]: one kind of contribution, implemented by the crate that
//!   owns the feature; [`ExtensionRegistry`] validates a package's declarations
//!   ([`ExtensionRegistry::prepare`], no side effects), makes them take effect
//!   all or nothing ([`ExtensionRegistry::commit`]) and withdraws them per plugin;
//! - [`UiStore`] / [`UiPoint`]: UI contributions, validated here and projected
//!   by the client without the possibility to fail;
//! - [`ledger`]: which capabilities the user granted to which plugin;
//! - [`package`]: the package file, its signature and the marketplace index.
//!
//! Dependency direction: `ide-core` ← `ide-extension` ← feature crates (their
//! extension points) and `ide-plugin` (Wasm) ← `ide-host` (assembly).

mod capability;
mod index;
pub mod ledger;
mod manifest;
pub mod package;
mod point;
mod registry;
mod ui;
mod when;

pub use capability::{Capability, CapabilityInfo, Risk, host_matches};
pub use index::ContributionIndex;
pub use manifest::{
    ActivationEvent, Capabilities, ENGINE_VERSION, EVENT_KINDS, LEGACY_API, MANIFEST_FILE, Manifest, check_relative,
    engine_compatible, validate_item_id, validate_plugin_id, validate_point_id,
};
pub use point::{Commit, Disposable, ExtensionPoint, MAX_PACKAGE_FILE, Package, Placement, Prepared, decode};
pub use registry::{ContributionInfo, ExtensionRegistry, PreparedSet};
pub use ui::{UiContribution, UiDecl, UiPoint, UiStore, to_json};
pub use when::validate_when;
