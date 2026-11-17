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
mod plugin_point;
mod point;
mod registry;
mod resolve;
mod ui;
mod when;

/// Environment variables that make a program load or run code of the caller's choosing
/// (`LD_PRELOAD`, `NODE_OPTIONS`, `GIT_SSH_COMMAND`, …). A `process:<tool>` grant covers
/// the tool, not these, so plugin-supplied environments must not set them.
pub fn is_code_injection_env(name: &str) -> bool {
    const EXACT: &[&str] = &[
        "BASH_ENV",
        "ENV",
        "SHELLOPTS",
        "PROMPT_COMMAND",
        "NODE_OPTIONS",
        "NODE_PATH",
        "PYTHONSTARTUP",
        "PYTHONPATH",
        "PYTHONHOME",
        "PERL5OPT",
        "PERL5LIB",
        "RUBYOPT",
        "RUBYLIB",
        "JAVA_TOOL_OPTIONS",
        "JDK_JAVA_OPTIONS",
        "_JAVA_OPTIONS",
        "CLASSPATH",
        "GIT_SSH",
        "GIT_SSH_COMMAND",
        "GIT_ASKPASS",
        "GIT_EXTERNAL_DIFF",
        "GIT_PROXY_COMMAND",
        "GIT_EXEC_PATH",
        "GIT_CONFIG_COUNT",
        "GIT_CONFIG_PARAMETERS",
    ];
    let upper = name.to_ascii_uppercase();
    upper.starts_with("LD_")
        || upper.starts_with("DYLD_")
        || upper.starts_with("GIT_CONFIG_KEY_")
        || upper.starts_with("GIT_CONFIG_VALUE_")
        || EXACT.contains(&upper.as_str())
}

pub use capability::{Capability, CapabilityInfo, Risk, expand_ipc_name, host_matches, validate_ipc_name};
pub use index::ContributionIndex;
pub use manifest::{
    ActivationEvent, CATEGORIES, Capabilities, ENGINE_VERSION, EVENT_KINDS, LEGACY_API, MANIFEST_FILE, MAX_CATEGORIES,
    Manifest, check_relative, engine_compatible, validate_item_id, validate_plugin_id, validate_point_id,
};
pub use plugin_point::{FieldType, PointDecl};
pub use point::{Commit, Disposable, ExtensionPoint, MAX_PACKAGE_FILE, Package, Placement, Prepared, decode};
pub use registry::{
    ChangeListener, Contribution, ContributionInfo, DeclaredPoint, ExtensionRegistry, LOCALES_DIR, LOCALES_POINT,
    PreparedSet,
};
pub use resolve::{Blocked, Dependency, DependencyState, Node, Plan, dependency_state, dependents, plan};
pub use ui::{UiContribution, UiDecl, UiPoint, UiStore, to_json};
pub use when::validate_when;

#[cfg(test)]
mod env_tests {
    use super::is_code_injection_env;

    #[test]
    fn flags_variables_that_load_code() {
        for name in ["LD_PRELOAD", "ld_library_path", "DYLD_INSERT_LIBRARIES", "NODE_OPTIONS", "GIT_SSH_COMMAND"] {
            assert!(is_code_injection_env(name), "{name}");
        }
        for name in ["GIT_CONFIG_KEY_0", "BASH_ENV", "JAVA_TOOL_OPTIONS"] {
            assert!(is_code_injection_env(name), "{name}");
        }
        for name in ["RUST_LOG", "HOME", "CI", "GIT_DIR", "FORCE_COLOR"] {
            assert!(!is_code_injection_env(name), "{name}");
        }
    }
}
