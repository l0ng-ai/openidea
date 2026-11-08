//! Laravel support (`docs/php-engine/LARAVEL-ROADMAP.md`): the project
//! model ([`project`]) every Laravel feature reads, the configuration keys
//! ([`config`]), the routes and middleware ([`routes`]) and string
//! references ([`refs`]).
//!
//! Only Laravel's own source and documentation (MIT) are design inputs.

pub mod config;
pub mod project;
pub mod refs;
pub mod routes;

#[cfg(test)]
mod tests;

pub use config::{ConfigEntry, ConfigKeys};
pub use project::{LaravelPaths, LaravelProject, Module, ModuleKind, RouteFile};
pub use routes::{MiddlewareDef, NameDecl, RouteAction, RouteDef, RouteTable};
