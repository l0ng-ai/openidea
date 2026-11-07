# Laravel support roadmap (Plan 8)

A second roadmap for the native PHP engine (`crates/ide-php`). It brings OpenIDEA's Laravel support up to the level of the best Laravel tooling, with PhpStorm's Laravel Idea plugin as the benchmark. It starts where Plan 7 of [ROADMAP.md](ROADMAP.md) stops (phases 7.1–7.1.c: facades, container helpers, Eloquent forwarding, scopes, relations, casts, migrations and service-provider bindings; phase 7.4: the Blade language).

Run it only after every phase of `ROADMAP.md` is done. The same [RULES.md](RULES.md) apply, with this file in place of `ROADMAP.md`. Phases are numbered 8.x, so commit messages stay `feat(php-engine): phase 8.N <title>`.

## How to track

- `- [ ]` to do, `- [x]` done, `- [!]` blocked with the reason after the title.
- One phase per session: the first `- [ ]` line. Each phase ends with code, tests, fmt, clippy, the required tests, the box ticked, a line in `PROGRESS.md` and one commit.

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

### Test fixture

`fixtures/laravel-app`: a small, current Laravel application, made from the MIT `laravel/laravel` skeleton plus hand-written code. It includes models with relations, casts and migrations, routes with names and groups, views and Blade components, config and translation keys, Form Requests, policies, commands, and Vite entry points. With no `vendor/`, the engine uses phpstorm-stubs plus the minimal Laravel stubs in `laravel_tests.rs`. A corpus-style test can also use a real `vendor/` when `LARAVEL_APP_DIR` points to one, ignored by default.

## Phases

- [ ] Phase 8.1: Laravel fixture app
      Create `fixtures/laravel-app` as described in the design, with a short README listing what each file exercises. Add `crates/ide-php/tests/laravel_app.rs`, which opens it with the engine and checks it indexes with no diagnostics except deliberate ones. Add a `laravel` case to `language_smoke` (ignored like the PHP one) that checks hover and completion on a model attribute. Tests: the new integration test.

- [ ] Phase 8.2: Laravel project model
      Build `LaravelProject` (see the design):
  - detection and version
  - base paths and app namespace
  - route files and their group attributes, from `RouteServiceProvider` or `bootstrap/app.php`
  - modules, both directory-based and `nwidart/laravel-modules`

  It is stored in the index, updated from watcher batches, and exposed as `PhpEngine::laravel()`. Tests: unit tests on snippets, plus the fixture app (route files found, prefixes right, modules listed).

- [ ] Phase 8.3: String reference framework
      Add `refs`, the framework from the design:
  - place patterns
  - the reference-kind trait (complete, resolve, find usages, rename, validate)
  - a lookup from the caret's string literal to its kind, which works in partial strings while typing

  Hook it into completion, goto, references, rename and document highlights. Implement it first for one kind, `configKey` (`config('app.name')`, `Config::get`, `config()->get`), with completion of nested keys segment by segment, goto to the array entry, and find usages. Tests: caret fixtures in partial and complete strings, and a pattern-matching table test.

- [ ] Phase 8.4: Routes: names, actions and middleware
      Add the `routeName` kind:
  - `route()`, `to_route()`, `redirect()->route()`, `URL::route`, `Route::has`, `->name()` prefixes in groups
  - completion, goto to the `->name()` call, find usages, rename across route files and callers, and an "undefined route" inspection

  Add the `controllerAction` kind:
  - `[Controller::class, 'method']`, `'Controller@method'` and invokable controllers
  - completion, goto, and usages of controller methods counted as route references

  Add the `middleware` kind (aliases, groups, `middleware()` chains), and completion of the `only`/`except` actions in `Route::resource`.

  Tests: caret fixtures on the fixture app.

- [ ] Phase 8.5: Route hints and route search
      Add these hints:
  - a code lens on controller methods listing the routes that point to them (method, URI, name)
  - an inlay hint after each `Route::get(...)` and similar call showing the full URI with group prefixes

  Clicking a lens or hint offers:
  - go to the declaration
  - copy the URL
  - open it in the browser, using `APP_URL` from `.env`
  - create an HTTP client request (`.http` file through `ide-http`)

  Add a Route Search dialog (search everywhere scope "Routes", by name or URI part). Add a setting to turn the hints off. User-visible text goes in `en.json` and `zh.json`. Tests: engine unit tests for the route table, and frontend tests for the dialog.

- [ ] Phase 8.6: Views
      Add the `viewName` kind:
  - `view()`, `View::make`, `Route::view`, `@include`/`@extends`/`@each`, `return view(...)`, `markdown()` in mailables, namespaced views (`pkg::name`)
  - completion as a path tree, goto to the file, find usages from a view file, rename (moves the file and updates the strings), and an "undefined view" inspection with a "Create view" quick-fix

  Add completion of the variables passed to a view (`view('x', ['user' => …])`, `compact()`, `with()`) inside the Blade file, using the embedded PHP analysis of phase 7.4. Tests: caret fixtures, a rename test, and a quick-fix test.

- [ ] Phase 8.7: Blade: layouts, sections, stacks and components
      Building on phase 7.4, add:
  - completion and goto for sections from the parent layout (`@section`/`@yield`), and for stacks (`@push`/`@stack`)
  - an inspection for unclosed sections
  - Blade components (`<x-…>` tags):
    - class-based and anonymous components, both found from the project model
    - tag completion, completion of attributes and `@props`
    - goto to the class or view
    - PHP inside `:attr="…"`, using the engine
  - `@class`/`@style` arrays
  - Blade directive completion, including custom directives registered with `Blade::directive`

  Tests: caret fixtures in Blade files.

- [ ] Phase 8.8: Config, environment, translations and assets
      Add these reference kinds, each with completion, goto and an "undefined" inspection:
  - `configKey` (finishing it from 8.3): config arrays published by packages, value types for hover
  - `envKey`: `env('…')` against `.env`/`.env.example`, with an "add missing key to .env.example" quick-fix
  - `translationKey`: `__()`, `trans()`, `trans_choice()`, `@lang`, `Lang::get`, for PHP and JSON files and all locales. Hover shows the text in each locale. Include a "Create translation key" action from PHP and Blade, which asks for the text and writes it to the chosen locale files.
  - `viteAsset`: `@vite`, `Vite::asset`, using `vite.config.*` entry points and the manifest.

  Tests: caret fixtures and quick-fix tests.

- [ ] Phase 8.9: Validation
      Add the `validationRule` kind:
  - rules in Form Request `rules()`, `$request->validate()`, `Validator::make`, `validated()`
  - pipe strings and arrays
  - rule completion with parameters (`exists:table,column`, `in:…`), with table and column names from the schema
  - field-name completion for `required_if:field`
  - an "unknown rule" inspection

  Add these too:
  - **Request fields:** completion of `$request->input('…')`, `$request->field` and `validated('…')` from the rules
  - **Intentions:** convert a rule string to an array, convert all of them, and convert to a `Rule::` object (`unique`, `exists`, `in`, `dimensions`)
  - **Promote to a Form Request:** move the inline rules of a controller method into a new Form Request class and inject it
  - **Generate rules:** a Generate action that adds rule entries from the model's fields

  Tests: caret fixtures and refactoring tests.

- [ ] Phase 8.10: Eloquent completions everywhere
      Use the model schema (casts, migrations, accessors, relations) in these places:
  - column names in `where('…')`, `orderBy`, `select`, `pluck`, `whereIn`, `update([...])`, `create([...])` and `firstOrCreate`
  - nested relations in `with('…')`, `has`, `whereHas('…', fn($q) => …)` and `load`, where the closure's `$q` is typed with the related model, and dotted chains (`posts.comments`)
  - `$fillable`, `$guarded`, `$hidden`, `$casts` and `$appends` inside the model
  - `*_count` properties after `withCount`
  - typed collections (`Collection<Model>`) from `get()` and `all()`
  - factories: `Model::factory()->create()` returns the model, and `count(n)` returns a collection

  Add an "unknown column" inspection, only when the schema is known for certain. Tests: caret fixtures on the fixture app's models.

- [ ] Phase 8.11: Live database schema
      Optionally use a connection from `ide-db` as a schema source for models, the validation rules of 8.9 and the query builder (`DB::table('…')`). The user picks the connection in Settings › PHP › Laravel. Merge it with the migration data, with the database winning and the source shown in hover. Refresh it on demand and when the database tool reports a schema change. Text goes in `en.json` and `zh.json`. Tests: an in-memory SQLite connection through `ide-db`.

- [ ] Phase 8.12: Eloquent model view
      Add a panel for a model, opened from a gutter icon or code lens on the model class. It shows:
  - the table, primary key, and columns with types and where each comes from
  - relations, scopes and accessors
  - related factories, resources, policies, observers and migrations

  Clicking an item navigates, finds usages or renames. An **Add columns** button collects new columns, generates a migration for them, and adds them to `$fillable`. Frontend and engine queries, with text in `en.json` and `zh.json`. Tests: the engine query, and frontend component tests.

- [ ] Phase 8.13: Code generation framework and the New Model dialog
      Add a Laravel › Generate menu and a searchable list (search everywhere scope "Laravel generators"). Generators render file templates from `src/features/templates`, which users can edit. They respect the app namespace, modules, class suffixes, constructor promotion and type hints set in Settings › PHP › Laravel › Code generation.

  Add the **New Model** dialog:
  - fields with types and modifiers
  - relations
  - indexes
  - checkboxes for a migration, factory, seeder, controller (plain, resource or API), Form Request, JSON resource and policy

  Tests: generator snapshot tests (`insta`), and a dialog component test.

- [ ] Phase 8.14: The other generators
      Add generators, all on the 8.13 framework:
  - **Classes:** controller, resource controller, middleware, Form Request, JSON resource and resource collection, factory, seeder, migration (create or update a table), event, listener, job, mail, notification, observer, policy, rule, exception, HTTP exception, service provider, console command, Blade component (class and anonymous), view, view composer, broadcasting channel, enum, pivot table migration
  - **Tests:** feature tests and unit tests

  Inside a model, the Generate menu offers "JSON resource from model" and "Factory from model", which use the model's fields and relations, and "Add all fields" in `$fillable`. Tests: snapshot tests per generator.

- [ ] Phase 8.15: Laravel intentions
      Add these code actions (some rule ones come in 8.9):
  - convert a facade alias to a facade import
  - convert a facade call to an injected dependency, through the constructor or the method
  - move a method dependency to the constructor (promoted property)
  - convert a string controller reference to `[Controller::class, 'method']`, for one or all in the file
  - convert a `scopeX` method to a `#[Scope]` method, for one or all
  - in Blade:
    - switch `{{ }}` to `{!! !!}` and back
    - convert a `class` attribute to `@class([...])` or wrap it in one

  Tests: before/after fixtures per action.

- [ ] Phase 8.16: Gates, policies and auth
      Add the `gate` kind:
  - `Gate::allows/denies/authorize`, `$user->can/cannot`, `@can`, `authorize()`, `can:` middleware
  - completion of abilities from gates and the matching policy's methods (by model argument)
  - goto
  - an "unknown ability" inspection

  Also cover guards (`auth('…')`) and password brokers from `config/auth.php`. Tests: caret fixtures.

- [ ] Phase 8.17: Artisan
      Add an **Artisan command run configuration** with completion of command names and options from the project model (`ide-run`), plus:
  - a "Run Artisan command…" dialog listing the commands
  - a run gutter icon on console command classes
  - the `artisanCommand` kind for `Artisan::call('…')` and `$this->call('…')`

  Text goes in `en.json` and `zh.json`. Tests: the command table from the fixture, and a run-configuration test.

- [ ] Phase 8.18: ide.json support
      Read `ide.json` files from the project and from `vendor/*/*/ide.json`, using the documented JSON format: completion rules with complete types and conditions, view paths, Blade components and directives, code generations, and package settings. Map them onto the string-reference framework of 8.3 and the generators of 8.13. Unknown keys are ignored with a log line. Add JSON Schema completion for the file itself, using the schema the file names in `$schema` if the JSON support already loads remote schemas, or a bundled schema the project writes itself. Tests: rule-mapping unit tests and a fixture `ide.json`.

- [ ] Phase 8.19: Livewire and Inertia
      Turn these on when the package is installed:
  - **Livewire:**
    - component names in `@livewire('…')` and `<livewire:…>` tags, with attribute and property completion from the component class
    - `wire:model` and `wire:click` completion from public properties and methods
    - goto to the class or view, and a "Create Livewire component" generator
  - **Inertia:**
    - page names in `Inertia::render('…')` and `inertia('…')`, with completion and goto to the page file (Vue, React or Svelte) from configurable page directories (default `resources/js/Pages`)
    - an "undefined page" inspection with a "Create page" quick-fix

  Tests: caret fixtures with stub packages.

- [ ] Phase 8.20: Laravel inspections and settings page
      Bring every Laravel inspection added in 8.4–8.19 into the inspection profile under a "Laravel" group, with on/off switches and severities, through the phase 4.10 system. Add a Settings › PHP › Laravel page for:
  - detection override
  - module system
  - hints
  - the database connection
  - code-generation options
  - Inertia page directories

  Run batch Inspect Code over the fixture app and check there are no false positives. Text goes in `en.json` and `zh.json`. Tests: an inspection batch test on the fixture, and frontend tests for the page.

- [ ] Phase 8.21: Parity and performance check
      On the fixture app, plus a real Laravel application with `vendor/` when `LARAVEL_APP_DIR` is set:
  - a checklist test going through every reference kind (completion, goto, find usages, inspection) and every generator
  - performance budgets added to `perf/budgets.json`:
    - project model build on the real app under 2 s (cold) and 200 ms (warm)
    - string-reference completion under 50 ms
    - route hints for a route file under 100 ms

  Record the results in `docs/php-engine/laravel.md`, along with what is still missing compared with the feature list, as follow-up phases. Tests: the checklist test and the benches.

- [ ] Phase 8.22: Documentation
      Add a user guide, `docs/php-engine/laravel.md`, finishing the file started in 8.21. It covers each feature with a short example, the settings, `ide.json` support, and known limits. Update `THIRD_PARTY_LICENSES.md` if a phase bundled anything new (for example Laravel stubs). Tests: none beyond the usual gate.
