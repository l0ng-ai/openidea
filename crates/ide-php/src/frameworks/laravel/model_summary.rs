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
    /// The service providers read (the app's, the modules', and the ones
    /// the application and packages register).
    pub providers: usize,
    /// The folders and files of `loadMigrationsFrom`.
    pub package_migrations: usize,
    /// What providers `publishes`.
    pub published: usize,
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
    ///
    /// Once the project itself is loaded, the parts that don't need each
    /// other are built at the same time (roadmap phase 9.4).
    pub fn laravel_model(&self) -> Option<LaravelModelSummary> {
        let project = self.laravel()?;
        let mut routes = None;
        let mut views = None;
        let mut config = None;
        let mut translations = None;
        let mut env = None;
        let mut auth = None;
        let mut artisan = None;
        let mut inertia = None;
        let mut models = 0;
        rayon::scope(|scope| {
            scope.spawn(|_| translations = self.laravel_translations());
            scope.spawn(|_| artisan = self.laravel_artisan());
            scope.spawn(|_| models = self.laravel_models().len());
            scope.spawn(|_| {
                // Blade components and Livewire need the views.
                views = self.laravel_views();
                drop(self.laravel_blade());
                drop(self.laravel_livewire());
            });
            scope.spawn(|_| {
                env = self.laravel_env();
                drop(self.laravel_assets());
                inertia = self.laravel_inertia();
            });
            scope.spawn(|_| {
                routes = self.laravel_routes();
                config = self.laravel_config();
                auth = self.laravel_auth();
            });
        });
        let (routes, views, config, translations) = (routes?, views?, config?, translations?);
        let (env, auth, artisan, inertia) = (env?, auth?, artisan?, inertia?);
        // Built above: these take the cached ones.
        let blade = self.laravel_blade()?;
        let livewire = self.laravel_livewire()?;
        let assets = self.laravel_assets()?;
        let registrations = super::providers::package_registrations(&project, self);
        Some(LaravelModelSummary {
            route_files: project.route_files.len(),
            modules: project.modules.len(),
            providers: registrations.len(),
            package_migrations: registrations.iter().map(|(_, part)| part.migrations.len()).sum(),
            published: registrations.iter().map(|(_, part)| part.publishes.len()).sum(),
            routes: routes.routes().len(),
            middleware: routes.middleware().len(),
            views: views.views().len(),
            blade_components: blade.components.len(),
            config_keys: config.entries().filter(|entry| !entry.is_file).count(),
            translations: translations.entries().len(),
            env_keys: env.entries().len(),
            vite_entries: assets.entries().count(),
            gates: auth.gates.len(),
            policies: auth.policies.len(),
            artisan_commands: artisan.commands.len(),
            livewire_components: livewire.components.len(),
            inertia_pages: inertia.pages.len(),
            models,
        })
    }

    /// Drops the Laravel project model, the files it read that aren't PHP
    /// (`composer.json`, `ide.json`, module manifests) included, as a
    /// watcher batch changing them does; the next request builds it again.
    pub fn forget_laravel_model(&self) {
        self.forget_laravel_parts();
    }
}
