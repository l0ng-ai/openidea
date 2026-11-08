//! Laravel support (`docs/php-engine/LARAVEL-ROADMAP.md`): the project
//! model ([`project`]) every Laravel feature reads, the configuration keys
//! ([`config`]), the environment keys ([`env`]), the translations
//! ([`lang`]), the Vite assets ([`assets`]), the routes and middleware
//! ([`routes`]), the route hints and route search ([`route_hints`]), the
//! views ([`views`]), Blade layouts, components and directives ([`blade`])
//! and string references ([`refs`]).
//!
//! Only Laravel's own source and documentation (MIT) are design inputs.

pub mod assets;
pub mod blade;
pub mod config;
pub mod env;
pub mod lang;
pub mod project;
pub mod refs;
pub mod route_hints;
pub mod routes;
pub mod views;

#[cfg(test)]
mod tests;

pub use assets::ViteAssets;
pub use blade::{BladeCatalog, BladeComponent, CustomDirective};
pub use config::{ConfigEntry, ConfigKeys};
pub use env::{EnvEntry, EnvKeys};
pub use lang::{TransEntry, Translations};
pub use project::{LaravelPaths, LaravelProject, Module, ModuleKind, RouteFile};
pub use route_hints::{RouteHint, RouteInfo, RouteLens};
pub use routes::{MiddlewareDef, NameDecl, RouteAction, RouteDef, RouteTable};
pub use views::{ViewEntry, ViewNamespace, ViewTable};
