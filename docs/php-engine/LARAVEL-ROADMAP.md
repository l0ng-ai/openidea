# Laravel support roadmap (Plan 8)

A second roadmap for the native PHP engine (`crates/ide-php`). It brings OpenIDEA's Laravel support up to the level of the best Laravel tooling, with PhpStorm's Laravel Idea plugin as the benchmark. It starts where Plan 7 of [ROADMAP.md](ROADMAP.md) stops (phases 7.1–7.1.c: facades, container helpers, Eloquent forwarding, scopes, relations, casts, migrations and service-provider bindings; phase 7.4: the Blade language).

This file holds the design and the clean-room rules of Plan 8. Its phases are tracked in [ROADMAP.md](ROADMAP.md) under "Plan 8: Laravel support" and run by the same loop after Plan 7, under the same [RULES.md](RULES.md). Commit messages stay `feat(php-engine): phase 8.N <title>`.

## Clean room

The feature list below comes from Laravel Idea's **public** documentation (laravel-idea.com/docs: overview, Eloquent, code generation, routing, request validation, localization, Blade, intention actions, other features, Artisan commands, ide.json, Livewire, Inertia). Only _what_ it does is used, never _how_.

- Never decompile, disassemble or copy code, templates, icons or text from Laravel Idea, PhpStorm or any other closed-source product.
- Design inputs allowed: Laravel's own source and docs (MIT), barryvdh/laravel-ide-helper (MIT), the Laravel VS Code extension (MIT), Larastan (MIT), and the public ide.json format description.
- Don't use the names "Laravel Idea" or "PhpStorm" in the product. The feature is called **Laravel support**.

## Design

### Where the code lives

- `crates/ide-php/src/frameworks/laravel/`, an extension of the provider added in phase 7.1 (`types/provider/laravel.rs`). Split it into:
  - `project` (the Laravel project model)
  - `refs` (string references)
  - `eloquent`, `routes`, `views`, `config`, `lang`, `validation`, `auth`, `assets`, `artisan`, `generate`, `intentions`, `packages`
- Everything is turned on only when `composer.json`/`composer.lock` requires `laravel/framework`, or `artisan` exists at a content root.

### The Laravel project model (`LaravelProject`)

The facts every feature reads. They are built from the index, the file summaries and a few non-PHP files, and rebuilt incrementally when a watched file changes:

- **Paths:** the Laravel version from `composer.lock`, the app namespace, base paths (app, config, lang, resources/views, routes, database), and modules (directory modules and `nwidart/laravel-modules`).
- **Routes:** route files from `RouteServiceProvider` or `bootstrap/app.php` `withRouting(...)`, with prefixes, name prefixes, middleware groups and controller namespaces.
- **Config:** config keys from `config/*.php`, with nested array keys and their value types.
- **Translations:** translation keys from `lang/**.php` and `lang/*.json`, per locale.
- **Views:** view names from `resources/views/**.blade.php` and registered namespaces (`loadViewsFrom`, `View::addNamespace`), plus Blade components (class and anonymous).
- **Environment:** `.env` and `.env.example` keys.
- **Auth:** gates and policies (`Gate::define`, `Gate::policy`, `$policies`, policy auto-discovery).
- **Assets:** Vite entry points from `vite.config.*`, and the build manifest when present.
- **Artisan:** Artisan commands (`$signature`, `$name`), with arguments and options.
- **Eloquent:** model schema, merged from three sources:
  - migrations (beyond the simple `Schema::create` of 7.1.b: `table()` changes, renames, drops, `foreignId()->constrained()`, `morphs`, `timestamps`, `softDeletes`)
  - casts
  - optionally a live database connection through `ide-db` (the user picks the connection)

Store it as part of the PHP index (redb, postcard), keyed by content hash like the other summaries, so warm starts stay under the 2 s budget.

### String references (the central mechanism)

Most Laravel features are completion, goto, find usages, rename and inspections on **string literals** in known places: `route('…')`, `view('…')`, `config('…')`, `__('…')`, `'required|email'`, `Gate::allows('…')`, and so on. Build one framework for this, the way IntelliJ's reference contributors work (IntelliJ Community is Apache-2.0, so its public design can be followed):

- **Place pattern:** a function, method (class or parent class), `new` call, attribute or Blade directive, plus where the string sits in it:
  - a parameter, by index or by name
  - an array key, value, or value under a given key
  - nested arrays
  - a method's return value
- **Reference kind:** `routeName`, `viewName`, `configKey`, `translationKey`, `validationRule`, `envKey`, `gate`, `middleware`, `controllerAction`, `viteAsset`, `artisanCommand`, `eloquentField`, `inertiaPage`, `livewireComponent`, and more. Each kind supplies:
  - completion items
  - targets for goto and find usages
  - rename support where it makes sense
  - an "unknown …" inspection
- **The rules** are built-in tables first. In phase 8.18 they can also be read from a project's `ide.json`, which is an open, documented JSON format, so packages that ship one work too.

The engine answers through the existing `LanguageService` dispatch (`crates/ide-host/src/php.rs`): completion, goto, references, rename, code actions, inlay hints, code lens and document links. The frontend only changes for the new dialogs and panels (route search, model view, code generation).

### Reused OpenIDEA pieces

- **File and code templates** (`src/features/templates`): generators write files through them, so users can edit the templates.
- **Run configurations** (`ide-run`, `src/features/run`): Artisan commands.
- **Database tools** (`ide-db`, `src/features/database`): live schema and SQL.
- **HTTP client** (`ide-http`, `src/features/http-client`): "create a request for this route".
- **Inspection profiles and quick-fixes** from phase 4.10, and **code lens / inlay hints** from `LanguageService`.

### Front-end independence (rule for every 8.x phase)

The engine may later ship as a standalone LSP server for VS Code and other editors. OpenIDEA is then one front end among several, so every Laravel feature is built as engine logic first, with UI on top.

- **All Laravel knowledge lives in `crates/ide-php`.** That covers the project model, string references, schema, routes, generators' file contents and intentions. Nothing Laravel-specific goes into `ide-host` or the frontend beyond wiring and presentation.
- **Standard editor features answer through `LanguageService` methods that have an LSP equivalent:**
  - completion, definition, references, rename
  - diagnostics, code actions
  - code lens, inlay hints, document links, semantic tokens

  Don't add OpenIDEA-only shortcuts for these.

- **Dialog-driven features are plain engine queries that return data, never UI.** These are route search, the model view, generators and Artisan commands. Some examples:
  - `laravel_routes()` returns a route table
  - `laravel_model_info(class)` returns the model's columns, relations and related classes
  - `laravel_generators()` lists generators with their input fields
  - `laravel_generate(id, inputs)` returns a `WorkspaceEdit` with the new files and edits
  - `laravel_artisan_commands()` returns commands with arguments and options

  Results are serialisable (serde) and use 0-based UTF-16 positions, so an LSP server can expose each one as a custom request (for example `php/laravel/routes`). OpenIDEA's dialogs, panels and run configurations are thin clients of these queries.

- **Engine inputs never depend on an OpenIDEA-only service.** The live database schema (8.11) comes through a small `SchemaSource` trait. OpenIDEA implements it with `ide-db`; another front end can implement it differently (for example from `.env`) or leave it out. The same applies to file templates: the engine ships default templates and accepts overrides from the front end.
- **Settings are one serialisable struct** (`LaravelSettings`) passed into the engine, not read from OpenIDEA's settings store inside the engine. That way VS Code's `contributes.configuration` can map onto it.
- **Tests:** every query gets engine-level tests in `crates/ide-php`, independent of the frontend. Frontend tests only cover presentation.

### Test fixture

`fixtures/laravel-app`: a small, current Laravel application, made from the MIT `laravel/laravel` skeleton plus hand-written code. It includes models with relations, casts and migrations, routes with names and groups, views and Blade components, config and translation keys, Form Requests, policies, commands, and Vite entry points. With no `vendor/`, the engine uses phpstorm-stubs plus the minimal Laravel stubs in `laravel_tests.rs`. A corpus-style test can also use a real `vendor/` when `LARAVEL_APP_DIR` points to one, ignored by default.

## Phases

The phases are in [ROADMAP.md](ROADMAP.md), "Plan 8: Laravel support".
