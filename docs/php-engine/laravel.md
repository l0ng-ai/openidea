# Laravel support

The native PHP engine's Laravel support (Plan 8 of [ROADMAP.md](ROADMAP.md), designed in [LARAVEL-ROADMAP.md](LARAVEL-ROADMAP.md)). Phase 8.30 turns this file into the user guide. For now it holds the parity and performance check of phase 8.21.

## Parity check (phase 8.21)

The checklist is `crates/ide-php/tests/laravel_parity.rs`. It runs on `fixtures/laravel-app`, copied with `fixtures/laravel-stubs` as its `vendor/` and with Livewire and Inertia installed, plus a Livewire component and an Inertia page. Outside route files, each goto probe is also written to `app/Parity/Uses.php` before indexing, so find usages has a usage in a second file to find.

- `every_reference_kind_completes_goes_to_finds_usages_and_inspects` covers every reference kind of `refs::kinds()`. The test fails if a kind is added without a check. For each kind it checks:
  - completion lists a known value
  - goto reaches the declaring file
  - find usages finds the value in another file
  - the kind's "undefined …" inspection reports an unknown value, for kinds that have one
- `every_generator_generates_files_that_parse` runs every generator of `laravel_generation_context()`:
  - New Model with all its companion files
  - the 31 class generators, Livewire included
  - the `ide.json` code generation

  It checks that each one creates files, and that the PHP among them parses.

- `real_app_checklist` (ignored, `LARAVEL_APP_DIR`) runs the name-independent parts on a real application with `vendor/`:
  - the project model is built and has routes, views and configuration keys
  - completion of configuration keys, route names, views, translations, environment keys, validation rules and Artisan commands
  - every generator, rendered in memory

Gaps go in the test's `GAPS` list. A gap that starts working fails the test until it is removed from `GAPS` and from this file. The list is empty: every kind passes every check.

| Kind                | Example                                     | Completion | Goto               | Usages | Inspection                   |
| ------------------- | ------------------------------------------- | ---------- | ------------------ | ------ | ---------------------------- |
| `configKey`         | `config('blog.feed.title')`                 | ✓          | ✓                  | ✓      | ✓ `PhpUndefinedConfigKey`    |
| `envKey`            | `env('BLOG_FEED_ENABLED')`                  | ✓          | ✓                  | ✓      | ✓ `PhpUndefinedEnvKey`       |
| `translationKey`    | `__('messages.welcome')`                    | ✓          | ✓                  | ✓      | ✓ `PhpUndefinedTranslation`  |
| `viteAsset`         | `Vite::asset('resources/js/app.js')`        | ✓          | ✓                  | ✓      | ✓ `PhpUndefinedViteAsset`    |
| `routeName`         | `route('home')`                             | ✓          | ✓                  | ✓      | ✓ `PhpUndefinedRoute`        |
| `controllerAction`  | `[PostController::class, 'index']`          | ✓          | ✓                  | ✓      | n/a                          |
| `resourceAction`    | `Route::resource(…)->only(['show'])`        | ✓          | ✓                  | ✓      | n/a                          |
| `middleware`        | `->middleware('author')`                    | ✓          | ✓                  | ✓      | n/a                          |
| `viewName`          | `view('posts.index')`                       | ✓          | ✓                  | ✓      | ✓ `PhpUndefinedView`         |
| `validationRule`    | `'exists:posts,title'`                      | ✓          | ✓ (parameters)     | ✓      | ✓ `PhpUnknownValidationRule` |
| `requestField`      | `$request->input('title')`                  | ✓          | ✓                  | ✓      | n/a                          |
| `eloquentField`     | `Post::where('title')`                      | ✓          | ✓                  | ✓      | ✓ `PhpUnknownEloquentColumn` |
| `eloquentRelation`  | `Post::with('comments')`                    | ✓          | ✓                  | ✓      | n/a                          |
| `dbTable`           | `DB::table('posts')`                        | ✓          | ✓                  | ✓      | n/a                          |
| `gate`              | `Gate::allows('publish-posts')`             | ✓          | ✓                  | ✓      | ✓ `PhpUnknownAbility`        |
| `authGuard`         | `auth('web')`                               | ✓          | ✓                  | ✓      | n/a                          |
| `passwordBroker`    | `Password::broker('users')`                 | ✓          | ✓                  | ✓      | n/a                          |
| `artisanCommand`    | `Artisan::call('posts:publish')`            | ✓          | ✓                  | ✓      | n/a                          |
| `livewireComponent` | `Livewire::test('counter')`                 | ✓          | ✓                  | ✓      | n/a                          |
| `livewireParameter` | `Livewire::test('counter', ['start' => 1])` | ✓          | ✓                  | ✓      | n/a                          |
| `inertiaPage`       | `Inertia::render('Dashboard')`              | ✓          | ✓                  | ✓      | ✓ `PhpUndefinedInertiaPage`  |
| `staticStrings`     | `feed_theme('dark')` (`ide.json`)           | ✓          | n/a (no locations) | ✓      | n/a                          |
| `directoryFiles`    | `stylesheet('app')` (`ide.json`)            | ✓          | ✓                  | ✓      | n/a                          |

All 33 generators produce files that parse: New Model, the 31 class generators and the fixture's `ide-json:acme.dto`.

## Performance (phase 8.21)

The criterion benches live in `crates/ide-php/benches/engine.rs` and run with `pnpm perf:rust`. Their budgets are in `perf/budgets.json`.

- `php_laravel_app/*` runs on the fixture app.
- `php_laravel_real/*` runs on the application in `LARAVEL_APP_DIR`. Without it, those benches and their budgets are skipped.

The engine runs with no inspections, so nothing builds the model in the background, and each timed request pays for what it rebuilds. The editor has `routes/web.php` open, and a keystroke adds a statement at its end.

| Bench               | What is timed                                                                                                                                     | Budget | Fixture app (2026-11-09) |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------ |
| `model_cold`        | `PhpEngine::laravel_model()` after `forget_laravel_model()`, which reads `composer.json`, `installed.json`, `ide.json` and module manifests again | 2 s    | 11.3 ms                  |
| `model_warm`        | `laravel_model()` right after a keystroke in the route file                                                                                       | 200 ms | 11.7 ms                  |
| `string_completion` | completion in `route('…')` right after a keystroke                                                                                                | 50 ms  | 1.5 ms                   |
| `route_hints`       | the route hints of the whole route file right after a keystroke                                                                                   | 100 ms | 1.8 ms                   |

`laravel_model()` builds every part of the project model and reports its size (`LaravelModelSummary`). On the fixture that is:

- 6 route files, 1 module, 12 routes and 14 middleware
- 11 views and 4 Blade components
- 43 configuration keys, 22 translations and 13 environment keys
- 2 Vite entries, 2 gates and 87 Artisan commands
- 4 models

### Real applications (2026-11-09)

`scripts/laravel-apps.sh` fetches two large open-source Laravel applications at pinned commits into `../php-corpus/apps`, with their `vendor/`. Their dependencies are installed with `--no-scripts --no-plugins`, so no code from them runs. When there's no PHP on the machine, the script uses a portable PHP and `composer.phar`, both checked against their SHA-256 sums.

- **Monica** (`monicahq/monica` `dab7427`, Laravel 12.22, AGPL-3.0): 1,656 PHP files of its own and 13,522 in `vendor/`. The model has:
  - 9 route files and 388 routes
  - 1,061 configuration keys and 57,507 translations
  - 132 Inertia pages and 70 models
  - 191 Artisan commands
- **Bagisto** (`bagisto/bagisto` `b740b83`, v2.5.1, Laravel 13.39, MIT): 3,119 PHP files of its own and 21,328 in `vendor/`. Most of the app lives in `packages/Webkul/*`, in packages that register their own routes, views and translations from service providers. The model has:
  - 14 route files and 72 routes
  - **0 views and 0 modules**
  - 936 configuration keys and 3,519 translations
  - 127 models

Release build, the same machine as above:

| Bench                                | Budget | Monica       | Bagisto                      |
| ------------------------------------ | ------ | ------------ | ---------------------------- |
| `php_laravel_real/model_cold`        | 2 s    | 1.19 s       | 158 ms                       |
| `php_laravel_real/model_warm`        | 200 ms | **1.15 s ✗** | 143 ms                       |
| `php_laravel_real/string_completion` | 50 ms  | 15.1 ms      | 7.9 ms                       |
| `php_laravel_real/route_hints`       | 100 ms | 13.2 ms      | **panics: "no route hints"** |

`real_app_checklist` fails on both:

- **Monica:** `no completion for ["validationRule"]`.
- **Bagisto:** the model has no views, so the check that it has routes, views and configuration keys fails.

What the numbers say:

- **The warm model build is the real problem.** On Monica, every keystroke rebuilds the whole model, most of it the 57,507 translations, and that takes 1.15 s, nearly 6× the budget. This is the incremental-model gap below, now measured.
- **Package-registered parts are missing.** Bagisto's views, routes and translations come from `loadViewsFrom`, `loadRoutesFrom` and `loadTranslationsFrom` in package service providers, and the model doesn't follow those yet. The route-hints bench also needs a route file that has routes.
- **Completion and route hints are fast** on both apps, well under budget.

To measure again (Git Bash):

```sh
bash scripts/laravel-apps.sh
LARAVEL_APP_DIR=../php-corpus/apps/monica cargo bench -p ide-php --bench engine -- php_laravel_real
LARAVEL_APP_DIR=../php-corpus/apps/monica cargo test -p ide-php --release --test laravel_parity -- --ignored --nocapture
```

Warm builds cost about as much as cold ones. Most parts are read from disk again whenever the modification count moves:

- routes
- views
- configuration
- translations

They aren't stored in the index, as LARAVEL-ROADMAP.md plans. On large applications this is where the warm budget is most at risk.

## Still missing

These gaps are tracked as phases 8.22–8.29 in [ROADMAP.md](ROADMAP.md).

These are the gaps against the feature list in LARAVEL-ROADMAP.md, gathered from the phases' own notes in PROGRESS.md. They are grouped as proposed follow-up phases.

1. **Real-application measurements and an incremental model.**
   - Run `php_laravel_real/*` and `real_app_checklist` on a real application.
   - Store the parts read from disk (config keys, translations, views, routes) in the index, keyed by content hash, so a keystroke only rebuilds what its file changed.
2. **Usages and rename from declarations and Blade.**
   - Find usages and rename from:
     - a Livewire component class or its `Livewire::component` alias
     - an Inertia page file
     - a `.env` line
   - Rename of translation keys.
   - Route-name and view usages inside closed Blade templates, so renaming a route also edits `{{ route('…') }}`.
   - Running the undefined-view inspection in Blade templates.
3. **Routing coverage.**
   - Route registrations:
     - `Route::resources()`, `singleton()` and `fallback()`
     - `->names('prefix')`
     - the array form of `Route::group(['middleware' => …])`
   - `aliasMiddleware` in service providers.
   - Route files of vendor packages.
   - `domain()` in route hints, and lenses for controllers routed through module providers.
4. **Blade components.**
   - Class components' public properties as view variables.
   - `@aware`, `<x-slot>` names and `<x-dynamic-component>`.
   - `Blade::component()`, `componentNamespace()` and `anonymousComponentPath()` registrations.
   - Vendor components.
   - Checking bound attributes against parameter types.
   - Quick-fixes for template problems.
5. **Auth and validation.**
   - `#[UsePolicy]`, `Gate::guessPolicyNamesUsing` and inherited policies.
   - `can:` abilities in the inspection and in gate usages.
   - `Gate::define('x', [Policy::class, 'm'])` going to the method.
   - Unknown-guard and unknown-broker inspections.
   - Completion of `in:` values and `Rule::` arguments.
   - Generated rules with `Rule::enum()` and `max:255`.
6. **Eloquent.**
   - Columns of the related model in the second argument of `whereRelation`/`withSum`.
   - `*_count` only after `withCount`.
   - A raw `Builder $query` scope's model.
   - Dropped and renamed columns.
   - Join and alias tables in `DB::table`.
   - Typed `Attribute::make(get: …)` accessors without `@return`.
7. **Generators.**
   - Register observers (`#[ObservedBy]`), events and listeners, and module service providers.
   - Pivot tables for `belongsToMany` in New Model.
   - Livewire 2 paths.
   - A grouped Generate submenu.
   - Edited templates for the in-model actions.
   - `ide.json` `inputFilter`/`regex`, `transformers` and `dataFile`.
8. **Livewire.** An unknown-parameter inspection for `@livewire(…, [...])` and `<livewire:…>` attributes.
