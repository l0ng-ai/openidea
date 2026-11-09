//! Laravel support (`docs/php-engine/LARAVEL-ROADMAP.md`): the project
//! model ([`project`]) every Laravel feature reads, the Artisan commands
//! ([`artisan`]), the configuration keys
//! ([`config`]), a live database schema ([`database`]), the environment
//! keys ([`env`]), the gates, policies, guards and password brokers
//! ([`auth`]), the translations
//! ([`lang`]), the Vite assets ([`assets`]), the routes and middleware
//! ([`routes`]), the Eloquent model view ([`model_view`]), the whole model at once
//! ([`model_summary`]), the route hints and route search ([`route_hints`]), the
//! views ([`views`]), Blade layouts, components and directives ([`blade`]),
//! validation rules ([`validation`]), string references ([`refs`]), the
//! parts read from single files that builds share ([`parts`]) and the
//! `ide.json` files of the project and its packages ([`ide_json`]), and
//! Livewire components ([`livewire`]) and Inertia pages ([`inertia`]) when
//! those packages are installed.
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
pub mod inertia;
pub mod lang;
pub mod livewire;
pub mod model_summary;
pub mod model_view;
pub mod parts;
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
pub use inertia::{InertiaPage, InertiaPages};
pub use lang::{TransEntry, Translations};
pub use livewire::{LivewireComponent, LivewireComponents, LivewireMember};
pub use model_summary::LaravelModelSummary;
pub use model_view::{ModelLens, ModelView, NewColumn};
pub use parts::{Merged, PartReader, TextParts};
pub use project::{LaravelPackages, LaravelPaths, LaravelProject, Module, ModuleKind, RouteFile};
pub use route_hints::{RouteHint, RouteInfo, RouteLens};
pub use routes::{MiddlewareDef, NameDecl, RouteAction, RouteDef, RouteTable};
pub use views::{ViewEntry, ViewNamespace, ViewTable};
