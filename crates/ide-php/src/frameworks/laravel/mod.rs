//! Laravel support (`docs/php-engine/LARAVEL-ROADMAP.md`): the project
//! model ([`project`]) every Laravel feature reads, the configuration keys
//! ([`config`]) and string references ([`refs`]).
//!
//! Only Laravel's own source and documentation (MIT) are design inputs.

pub mod config;
pub mod project;
pub mod refs;

#[cfg(test)]
mod tests;

pub use config::{ConfigEntry, ConfigKeys};
pub use project::{LaravelPaths, LaravelProject, Module, ModuleKind, RouteFile};
