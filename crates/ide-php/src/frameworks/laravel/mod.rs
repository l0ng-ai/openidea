//! Laravel support (`docs/php-engine/LARAVEL-ROADMAP.md`): the project
//! model ([`project`]) every Laravel feature reads.
//!
//! Only Laravel's own source and documentation (MIT) are design inputs.

pub mod project;

#[cfg(test)]
mod tests;

pub use project::{LaravelPaths, LaravelProject, Module, ModuleKind, RouteFile};
