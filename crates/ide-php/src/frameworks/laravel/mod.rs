//! Laravel support (`docs/php-engine/LARAVEL-ROADMAP.md`): the project
//! model ([`project`]) every Laravel feature reads, the configuration keys
//! ([`config`]), the routes and middleware ([`routes`]), the route hints
//! and route search ([`route_hints`]) and string references ([`refs`]).
//!
//! Only Laravel's own source and documentation (MIT) are design inputs.

pub mod config;
pub mod project;
pub mod refs;
pub mod route_hints;
pub mod routes;

#[cfg(test)]
mod tests;

pub use config::{ConfigEntry, ConfigKeys};
pub use project::{LaravelPaths, LaravelProject, Module, ModuleKind, RouteFile};
pub use route_hints::{RouteHint, RouteInfo, RouteLens};
pub use routes::{MiddlewareDef, NameDecl, RouteAction, RouteDef, RouteTable};
