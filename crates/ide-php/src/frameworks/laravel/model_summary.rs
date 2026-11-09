//! The whole Laravel project model at once ([`PhpEngine::laravel_model`]):
//! every part the features read (paths and route files, routes, views,
//! Blade components, configuration, translations, environment keys, Vite
//! assets, gates and policies, Artisan commands, Livewire components,
//! Inertia pages and Eloquent models), built for the current modification
//! count, with how much each part holds. The parity check and the
//! performance budgets of roadmap phase 8.21 time it cold
//! ([`PhpEngine::forget_laravel_model`] first: the files that aren't PHP are
//! read again) and warm (after an edit).

use serde::{Deserialize, Serialize};

use crate::engine::PhpEngine;

/// How much each part of the Laravel project model holds.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaravelModelSummary {
    pub route_files: usize,
    pub modules: usize,
    pub routes: usize,
    pub middleware: usize,
    pub views: usize,
    pub blade_components: usize,
    pub config_keys: usize,
    pub translations: usize,
    pub env_keys: usize,
    pub vite_entries: usize,
    pub gates: usize,
    pub policies: usize,
    pub artisan_commands: usize,
    pub livewire_components: usize,
    pub inertia_pages: usize,
    pub models: usize,
}

impl PhpEngine {
    /// Builds every part of the Laravel project model that isn't built for
    /// the current modification count yet; `None` outside Laravel projects.
    pub fn laravel_model(&self) -> Option<LaravelModelSummary> {
        let project = self.laravel()?;
        let routes = self.laravel_routes()?;
        let views = self.laravel_views()?;
        let blade = self.laravel_blade()?;
        let config = self.laravel_config()?;
        let translations = self.laravel_translations()?;
        let env = self.laravel_env()?;
        let assets = self.laravel_assets()?;
        let auth = self.laravel_auth()?;
        let artisan = self.laravel_artisan()?;
        let livewire = self.laravel_livewire()?;
        let inertia = self.laravel_inertia()?;
        Some(LaravelModelSummary {
            route_files: project.route_files.len(),
            modules: project.modules.len(),
            routes: routes.routes().len(),
            middleware: routes.middleware().len(),
            views: views.views().len(),
            blade_components: blade.components.len(),
            config_keys: config.entries().iter().filter(|entry| !entry.is_file).count(),
            translations: translations.entries().len(),
            env_keys: env.entries().len(),
            vite_entries: assets.entries().count(),
            gates: auth.gates.len(),
            policies: auth.policies.len(),
            artisan_commands: artisan.commands.len(),
            livewire_components: livewire.components.len(),
            inertia_pages: inertia.pages.len(),
            models: self.laravel_models().len(),
        })
    }

    /// Drops the Laravel project model, the files it read that aren't PHP
    /// (`composer.json`, `ide.json`, module manifests) included, as a
    /// watcher batch changing them does; the next request builds it again.
    pub fn forget_laravel_model(&self) {
        self.reset_laravel_cache();
    }
}
