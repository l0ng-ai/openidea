//! Laravel support (`docs/php-engine/LARAVEL-ROADMAP.md`): the project
//! model ([`project`]) every Laravel feature reads, the Artisan commands
//! ([`artisan`]), the configuration keys
//! ([`config`]), a live database schema ([`database`]), the environment
//! keys ([`env`]), the gates, policies, guards and password brokers
//! ([`auth`]), the translations
//! ([`lang`]), the Vite assets ([`assets`]), the routes and middleware
//! ([`routes`]), the Eloquent model view ([`model_view`]), the route hints and route search ([`route_hints`]), the
//! views ([`views`]), Blade layouts, components and directives ([`blade`]),
//! validation rules ([`validation`]), string references ([`refs`]) and the
//! `ide.json` files of the project and its packages ([`ide_json`]).
//!
//! Only Laravel's own source and documentation (MIT) are design inputs.

pub mod artisan;
pub mod assets;
pub mod auth;
pub mod blade;
pub mod config;
pub mod database;
pub mod env;
pub mod generate;
pub mod ide_json;
pub mod lang;
pub mod model_view;
pub mod project;
pub mod refs;
pub mod route_hints;
pub mod routes;
pub mod validation;
pub mod views;

#[cfg(test)]
mod tests;

pub use artisan::{ArtisanArgument, ArtisanCommand, ArtisanCommands, ArtisanOption, CommandSource};
pub use assets::ViteAssets;
pub use auth::{AuthEntry, AuthFacts, GateDef, PolicyDef};
pub use blade::{BladeCatalog, BladeComponent, CustomDirective};
pub use config::{ConfigEntry, ConfigKeys};
pub use database::{LiveColumn, LiveSchema, LiveTable};
pub use env::{EnvEntry, EnvKeys};
pub use ide_json::IdeJson;
pub use lang::{TransEntry, Translations};
pub use model_view::{ModelLens, ModelView, NewColumn};
pub use project::{LaravelPaths, LaravelProject, Module, ModuleKind, RouteFile};
pub use route_hints::{RouteHint, RouteInfo, RouteLens};
pub use routes::{MiddlewareDef, NameDecl, RouteAction, RouteDef, RouteTable};
pub use views::{ViewEntry, ViewNamespace, ViewTable};
