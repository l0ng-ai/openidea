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
| `authGuard`         | `auth('web')`                               | ✓          | ✓                  | ✓      | ✓ `PhpUnknownGuard`          |
| `passwordBroker`    | `Password::broker('users')`                 | ✓          | ✓                  | ✓      | ✓ `PhpUnknownPasswordBroker` |
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

- **The warm model build was the real problem.** On Monica, every keystroke rebuilt the whole model, most of it the 57,507 translations, and that took 1.15 s, nearly 6× the budget. Phase 8.22 fixed it (see "Incremental model" below).
- **Package-registered parts are missing.** Bagisto's views, routes and translations come from `loadViewsFrom`, `loadRoutesFrom` and `loadTranslationsFrom` in package service providers, and the model doesn't follow those yet. The route-hints bench also needs a route file that has routes.
- **Completion and route hints are fast** on both apps, well under budget.

To measure again (Git Bash):

```sh
bash scripts/laravel-apps.sh
LARAVEL_APP_DIR=../php-corpus/apps/monica cargo bench -p ide-php --bench engine -- php_laravel_real
LARAVEL_APP_DIR=../php-corpus/apps/monica cargo test -p ide-php --release --test laravel_parity -- --ignored --nocapture
```

### Incremental model (phase 8.22, 2026-11-09)

The parts read from single files are now kept per file (`crates/ide-php/src/engine/parts.rs`), next to the index in the engine's memory:

- configuration keys per `config/*.php`, per framework default and per `mergeConfigFrom` file, and the `mergeConfigFrom` calls of each provider
- translations per language file, PHP or JSON
- routes per route file, and middleware per `bootstrap/app.php` / `Kernel.php`
- the view namespaces each provider registers, and the views below each folder

A part is kept with the stamp of the text it was read from. For an open buffer, that's the BLAKE3 hash of its text, the hash the index uses for summaries. For a file on disk, it's the size and modification time, so checking it doesn't read the file. A watcher batch naming the file, or a folder above it, drops the part too. Folder listings, `.env`, the Vite files and the Inertia pages aren't PHP and are never open in the engine, so they're kept until the next watcher batch.

A build after an edit reads and parses only the files whose stamp moved. The configuration keys and translations keep each file's part as the same `Arc` the cache holds (`frameworks::laravel::Merged`), plus a sorted index of their own. When no part changed, that index is reused as well, so the 57,507 translations aren't copied or sorted again. JSON language files are also read in one pass now. Before, finding each key's literal searched the file from the start, which was quadratic and most of the old 1.15 s.

The parts live in memory, not in the index database. A new session builds them once, which the cold numbers below measure. `forget_laravel_model()` drops them too, so `model_cold` is a real cold build.

| Bench                                | Budget | Monica before | Monica after |
| ------------------------------------ | ------ | ------------- | ------------ |
| `php_laravel_real/model_cold`        | 2 s    | 1.19 s        | 283 ms       |
| `php_laravel_real/model_warm`        | 200 ms | **1.15 s ✗**  | 95 ms        |
| `php_laravel_real/string_completion` | 50 ms  | 15.1 ms       | 14.7 ms      |
| `php_laravel_real/route_hints`       | 100 ms | 13.2 ms       | 12.8 ms      |

The model's sizes are unchanged. The warm 95 ms is now mostly the parts built from PHP classes rather than from single files: Artisan commands (about 55 ms), Eloquent models (25 ms) and the project's route registrations (12 ms). Those follow the type resolver, which is rebuilt for each modification count.

### Package registrations (phase 8.23, 2026-11-09)

The model now follows the service providers that applications and packages register, not only `app/Providers` and the modules' own folders. The providers are listed once, when the project loads:

- the ones in `bootstrap/providers.php` (Laravel 11) or the `providers` of `config/app.php`
- the module providers in the `modules` of `config/concord.php` (`konekt/concord`)
- the providers packages list for package discovery (`extra.laravel.providers` in `vendor/composer/installed.json`)
- every provider those register with `$this->app->register(…)`

Classes are found through the autoload rules of the project and its packages. Each Concord module provider becomes a module named after its namespace (`Webkul\Shop` is `Shop`). Saving a provider, `bootstrap/providers.php`, `config/app.php` or `config/concord.php` lists the providers again.

From every provider the model reads:

- views: `loadViewsFrom`, with `resources/views/vendor/<ns>` first
- translations: `loadTranslationsFrom` (with or without a namespace) and `loadJsonTranslationsFrom`
- configuration: `mergeConfigFrom`
- middleware: `aliasMiddleware` and `middlewareGroup`
- `loadMigrationsFrom` and `publishes`, which are counted in the model summary

The gates, Blade directives and Livewire registrations of providers are now cached per file like the other parts, and so are the listings of language folders. Before, every build read each provider again.

Route files can now `require` or `include` other route files. Each included file is read as a route file of its own, loaded in the group around the `require`, so hints and lenses work in it. Routing also covers:

- `Route::resources()` and `apiResources()`
- `singleton()` and `apiSingleton()`, with `creatable()` and `destroyable()`
- `fallback()` and `->names('prefix')`
- `domain()` on groups and routes. Hints show the domain, and the URL uses it.

Bagisto's model before and after:

| Part              | Before | After   |
| ----------------- | ------ | ------- |
| service providers | —      | 131     |
| modules           | 0      | 35      |
| routes            | 72     | 528     |
| views             | 0      | 580     |
| Blade components  | —      | 228     |
| translations      | 3,519  | 184,945 |
| config keys       | 936    | 1,145   |
| middleware        | —      | 25      |

The `route_hints` bench now opens `routes/web.php` when it has routes, and otherwise the route file with the most routes: on Bagisto that's `packages/Webkul/Admin/src/Routes/web/sales-routes.php`. Release build, 2026-11-09:

| Bench                                | Budget | Bagisto | Monica  |
| ------------------------------------ | ------ | ------- | ------- |
| `php_laravel_real/model_cold`        | 2 s    | 1.09 s  | 358 ms  |
| `php_laravel_real/model_warm`        | 200 ms | 151 ms  | 101 ms  |
| `php_laravel_real/string_completion` | 50 ms  | 15.7 ms | 16.4 ms |
| `php_laravel_real/route_hints`       | 100 ms | 16.0 ms | 14.8 ms |

`real_app_checklist` now gets past the model check on Bagisto (it has routes, views and configuration keys). On both apps it still stops at `no completion for ["validationRule"]`, which phase 8.26 covers.

### Validation on real applications (phase 8.26)

The missing validation-rule completion wasn't the rule catalogue: the checklist's probe typed `$request` as the fixture's `App\Http\Requests\StorePostRequest`, which no real application has, so the `validate()` call had no receiver class. The probe now uses `Illuminate\Http\Request` and `Validator::make`, which every application has. Both complete on Monica and Bagisto.

Monica does have a real gap, though: almost none of its rules sit in Form Requests. Its 250 or so services return them from `rules()` and validate in `App\Services\BaseService` with `Validator::make($data, $this->rules())->validate()`. The file summaries now record the methods a class passes as the rules of `Validator::make`, `validator()`, `validate()` or `validateWithBag()` (`$this->rules()`), and what those methods return in the class and its subclasses is a rules array. `real_app_checklist` checks a service's `rules()` when the app has `App\Services\BaseService`.

`real_app_checklist` passes on Monica. On Bagisto it passed too, but at the time only with larger thread stacks (`RUST_MIN_STACK=67108864`): in a debug build an indexing thread overflowed its default 2 MB stack on one of Bagisto's files. Phase 8.29 fixed that (see below); no command needs `RUST_MIN_STACK` any more.

### Eloquent on real applications (phase 8.27, 2026-11-10)

`real_app_eloquent_columns` (ignored, `LARAVEL_APP_DIR`) builds the model view of every model, then runs the inspections on the application's own PHP files (`app/`, `packages/`, `database/`, `routes/`) and prints every `PhpUnknownEloquentColumn` problem. Its first runs found these false positives, now fixed:

- **`foreignIdFor(User::class)`** made the migration "not understood", so 64 of Monica's 70 models had no certain schema and weren't checked at all. It is `user_id` now, and `numericMorphs()` is read too.
- **`NestedSet::columns($table)`** (kalnoy/nestedset) passed for understood while it makes `_lft`, `_rgt` and `parent_id`. It makes those columns now, and any other call handed the blueprint makes the table uncertain.
- **Pivot columns:** `$account->currencies()->where('active', true)` names a `withPivot('active')` column. Unqualified names on a many-to-many or through relation aren't reported.
- **Select aliases:** `select(DB::raw('… as year'))->orderBy('year')`. `orderBy`, `groupBy`, `having` and the like aren't checked.
- **Translatable models:** `$translatedAttributes` (astrotomic/laravel-translatable) are attributes.
- **The model's own lists:** `$guarded = ['shipping_address']` names a method of the model. A method, or its snake case, is fine there.

Debug build (then with `RUST_MIN_STACK=67108864`, which phase 8.29 made unnecessary):

| Application | Models | Certain schema | Files inspected | Unknown-column problems |
| ----------- | ------ | -------------- | --------------- | ----------------------- |
| Monica      | 70     | 63             | 891             | 1                       |
| Bagisto     | 127    | 105            | 2,418           | 11                      |

Every model has a model view on both. Every remaining problem names a column that no migration makes:

- Monica: `Goal::create(['author_id' => …])`, while `goals` has no `author_id`.
- Bagisto: `CartRule::$fillable` lists `actions`. `ProductCustomizableOptionPrice::$fillable` lists `is_default`, `is_user_defined` and `qty`. `$guarded`/`$hidden` entries name `created_at`/`updated_at` of a table without timestamps, `token`, `_token` and `child`. A test calls `forceFill(['base_image' => …])` on an `OrderItem`.

To run it again:

```sh
LARAVEL_APP_DIR=../php-corpus/apps/monica cargo test -p ide-php --test laravel_parity -- --ignored real_app_eloquent_columns --nocapture
```

### Real-application check (phase 8.29, 2026-11-10)

**The stack overflow.** Bagisto's `vendor/aws/aws-sdk-php` has clients whose docblocks hold a union of some 300 string literals (`@method … array{set?: 'a'|'b'|…}`). Mago's PHPDoc parser and the summary's walk over the parsed type recurse once per union member, and in a debug build that overflowed an indexing thread's 2 MB stack. Looking further found more of the same kind, on thousands of nested arrays, closures, `if` blocks, anonymous classes or matches, and on long `&&` chains and method chains:

- Mago's parsers (PHP, PHPDoc, Twig) stop at their own limit of 512 nested levels, but in a debug build reaching it takes about 32 MB of stack. Every Mago parse now runs through `syntax::stack::parser_stack`, which moves to a fresh 64 MB stack segment (reserved, not committed) when less than 40 MB is left.
- Binary operators and member chains are parsed in a loop, so the tree can be deeper than Mago's limit (`'a' . 'b' . …` ten thousand times). `ParsedFile::parse` measures the depth without recursing (`syntax::stack::too_deep`) and drops a tree deeper than `MAX_TREE_DEPTH` (1,500 nodes). The file keeps its text, has the program of an empty file, and gets one syntax error at the node past the bound: "Code nested more than 1500 levels deep: this file is not analysed (split the expression up)".
- The bound comes from the corpora. The deepest tree among the 39,624 PHP files of Monica and Bagisto (`vendor/` included) has 334 nodes, Laravel's deepest 91 and WordPress's 346. Symfony's `FrameworkBundle/DependencyInjection/Configuration.php`, one fluent chain at three nodes per call, has 818, so an 800 bound would have dropped it. Only a generated fixture of Symfony's goes past 1,500 (a compiled URL matcher, 1,769).
- Within the bound, the walks that recurse once per level, such as expression typing, the flow builder's statements, expressions and conditions, and the type of a long `&&` chain, run each level through `syntax::stack::deep` (`stacker::maybe_grow`, rustc's `ensure_sufficient_stack`). It adds a 4 MB segment when less than 256 KB is left. Flow conditions over `&&`/`||` chains are walked in a loop, and `refactor::visit` is iterative.
- `deep_nesting_tests` runs on a 2 MB thread in a debug build. It parses and summarises 19 constructs 3,000 levels deep and at the deepest depth the engine accepts. It indexes them in a project, and asks for inspections, semantic tokens, symbols, inlay hints, types, hover, goto and completion at several places in each.

The engine's own threads keep their default stack sizes. `real_app_checklist` and every other real-application command run without `RUST_MIN_STACK` now.

**Checklist and benches.** `real_app_checklist` passes on Monica (51 s) and Bagisto (82 s) in a debug build. Release build, 2026-11-10:

| Bench                                | Budget | Bagisto | Monica  |
| ------------------------------------ | ------ | ------- | ------- |
| `php_laravel_real/model_cold`        | 2 s    | 1.51 s  | 542 ms  |
| `php_laravel_real/model_warm`        | 200 ms | 159 ms  | 106 ms  |
| `php_laravel_real/string_completion` | 50 ms  | 16.4 ms | 18.2 ms |
| `php_laravel_real/route_hints`       | 100 ms | 16.7 ms | 15.9 ms |

**Inspect Code.** The new ignored `real_app_inspect_code` runs batch Inspect Code over the application's own PHP files (`app/`, `packages/`, `database/`, `routes/`) and Blade templates (`resources/`, `packages/`), never `vendor/`. It prints the count per inspection and an even sample of 100 diagnostics with their source lines. With `INSPECT_ALL=1` it prints every diagnostic instead. Every diagnostic of both applications was reviewed, not only a sample of 100. The first run found these false positives, now fixed:

- **Routes under `if`.** Fortify registers `login`, `password.request`, `two-factor.login` and most of its other routes inside `if (Features::enabled(…))` / `if ($enableViews)`. The route reader skipped `if` statements; it now reads every branch. A path computed by a call (`RoutePath::for('login', '/login')`) takes the call's last literal starting with `/`, else `{?}`, so the route keeps its name.
- **Group attributes.** `Route::prefix('install/api')->withoutMiddleware([...])->group(…)` (Bagisto's installer) dropped the whole group. `withoutMiddleware` now removes middleware from the group. `can`, `missing`, `scopeBindings`, `withoutScopedBindings` and `where…` are accepted, since they change no path or name.
- **Configuration keys a file sets.** `config(['themes.shop.narrow' => …])` and `Config::set(…)` in Bagisto's tests were reported as undefined keys, and so were later reads of them. A key the file sets, and any key below it, is now defined in that file.
- **Increments whose value is used.** `'position' => ++$position` in a loop was an unused variable, because an increment counted only as a write. It is now a read too, unless its value is dropped (`$i++;`, the update part of a `for`).
- **A docblock that contradicts the native type.** `getAverageSales(): ?float` documented as `@return array` made `formatBasePrice($current)` an argument-type error. A documented return type that isn't a subtype of the native one now gives way to it (PHPStan's rule). Types with template parameters or `static` are kept, and any two classes count as related.
- Fixed while getting the checklist through Bagisto: Blade directives are matched case-insensitively (`@endpushOnce` closes `@pushOnce`, as PHP finds `compileEndpushOnce`). Global class aliases (`DB`, `\Str`, the `aliases` of packages' `extra.laravel` and of `config/app.php`) are classes for the undefined-class check and for typing. Guards a service provider sets (`config(['auth.guards.sanctum' => …])`) are known. A package's `files` entries also index the files they `require` (thecodingmachine/safe). Two classes that `@mixin` each other (Pest's expectations) see each other's members.

Debug build, own code only:

| Application | Files inspected | Diagnostics before | Diagnostics after |
| ----------- | --------------- | ------------------ | ----------------- |
| Monica      | 896             | 200                | 194               |
| Bagisto     | 2,983           | 227                | 181               |

What remains, by inspection:

- Monica: 175 `PhpUnusedParameter`, 7 `PhpUndefinedVariable`, 4 `PhpUndefinedTranslation`, 3 `PhpUnusedLocalVariable`, 2 `PhpUndefinedRoute`, 1 `PhpUnknownAbility`, 1 `PhpUnknownEloquentColumn`, 1 `PhpUnusedAlias`.
- Bagisto: 51 `PhpUnusedParameter`, 44 `PhpUndefinedTranslation`, 24 `PhpUnusedLocalVariable`, 15 `PhpDeprecation`, 11 `PhpUnknownEloquentColumn`, 7 `PhpUnusedAlias`, 7 `PhpUndefinedVariable`, 5 `PhpUndefinedView`, 3 each of `PhpParams`, `PhpUndefinedClass` and `PhpUndefinedField`, 2 each of `PhpIncompatibleReturnType`, `PhpUndefinedMethod` and `PhpUndefinedConfigKey`, 1 each of `PhpUndefinedRoute` and `PhpUndefinedEnvKey`.

Nearly all of them are real. Some examples:

- Monica: route `post.choose_template` and gate `slice-owner`, which nothing defines; translation keys missing from `lang/en.json`; unused imports.
- Bagisto: views that don't exist (`admin::catalog.products.create`, `shop::emails.customers.forget-password` next to `forgot-password`); `use Barryvdh\Debugbar\Facades\Debugbar`, which debugbar 4 renamed to `Fruitcake\LaravelDebugbar`; `\Swift_RfcComplianceException` from the removed SwiftMailer; `massDestroy(): JsonResponse` returning a redirect; `mail.mailers.smtp.encryption`, which `config/mail.php` doesn't have; `OMNIBUS_ENABLED`, which `.env.example` doesn't have; Symfony's deprecated `Request::get()`.
- Unused parameters are controller actions' `Request $request` and methods that override nothing.

The rest follow a wrong declaration or are limits of the analysis:

- Seven Bagisto diagnostics come from `bagisto/laravel-datafaker`. `Helpers\Category::factory()` is documented `Factory<static>`, but it returns the model's factory, so `->create()` is typed as the helper.
- `getOptionProductsPrices()` has no native return type and documents `@return float` while returning an array.
- Monica's `$timestamp` (four diagnostics in the CalDAV and CardDAV backends) is read only when an earlier condition set it (`if ($data) { $timestamp = …; } if (empty($data) || $timestamp …)`). The analysis doesn't relate the two conditions, and neither does PhpStorm's.
- Monica's `profile.show` is Jetstream's. Jetstream loads its routes from `__DIR__.'/../routes/'.config('jetstream.stack').'.php'`, a path the engine can't read without the configuration. Phase 8.29.b covers it.

To run them:

```sh
LARAVEL_APP_DIR=../php-corpus/apps/bagisto cargo test -p ide-php --test laravel_parity -- --ignored real_app_checklist real_app_inspect_code --nocapture
LARAVEL_APP_DIR=../php-corpus/apps/bagisto cargo bench -p ide-php --bench engine -- php_laravel_real
```

## Still missing

These gaps are tracked as phases 8.22–8.29 in [ROADMAP.md](ROADMAP.md).

These are the gaps against the feature list in LARAVEL-ROADMAP.md, gathered from the phases' own notes in PROGRESS.md. They are grouped as proposed follow-up phases.

1. **Real-application measurements and an incremental model.** Done in 8.21 and 8.22, as described above.
2. **Usages and rename from declarations and Blade.** Done in 8.24. Route-name and view usages in closed templates were already found through the word index; what 8.24 added is listed in PROGRESS.md. A discovered Livewire name (not a registered alias) still can't be renamed on its own, and searches read open Blade templates from disk.
   - Find usages and rename from:
     - a Livewire component class or its `Livewire::component` alias
     - an Inertia page file
     - a `.env` line
   - Rename of translation keys.
   - Route-name and view usages inside closed Blade templates, so renaming a route also edits `{{ route('…') }}`.
   - Running the undefined-view inspection in Blade templates.
3. **Routing coverage.** Done in 8.23.
   - Route registrations:
     - `Route::resources()`, `singleton()` and `fallback()`
     - `->names('prefix')`
     - the array form of `Route::group(['middleware' => …])`
   - `aliasMiddleware` in service providers.
   - Route files of vendor packages.
   - `domain()` in route hints, and lenses for controllers routed through module providers.
4. **Blade components.** Done in 8.25. Adding a missing constructor parameter to a class component (rather than a `@props` entry) isn't offered, and `@aware` entries don't complete from the parent component.
   - Class components' public properties as view variables.
   - `@aware`, `<x-slot>` names and `<x-dynamic-component>`.
   - `Blade::component()`, `componentNamespace()` and `anonymousComponentPath()` registrations.
   - Vendor components.
   - Checking bound attributes against parameter types.
   - Quick-fixes for template problems.
5. **Auth and validation.** Done in 8.26, along with the Monica validation gap described above.
   - `#[UsePolicy]`, `Gate::guessPolicyNamesUsing` and inherited policies.
   - `can:` abilities in the inspection and in gate usages.
   - `Gate::define('x', [Policy::class, 'm'])` going to the method.
   - Unknown-guard and unknown-broker inspections.
   - Completion of `in:` values and `Rule::` arguments.
   - Generated rules with `Rule::enum()` and `max:255`.
6. **Eloquent.** Done in 8.27. A `*_count` property is offered once some `withCount()`, `loadCount()` or `$withCount` of the project counts that relation. This is project-wide, not tracked along the query that loads the model.
   - Columns of the related model in the second argument of `whereRelation`/`withSum`.
   - `*_count` only after `withCount`.
   - A raw `Builder $query` scope's model.
   - Dropped and renamed columns.
   - Join and alias tables in `DB::table`.
   - Typed `Attribute::make(get: …)` accessors without `@return`.
7. **Generators.** Done in 8.28. A listener is registered only where an event service provider has a `$listen` array (Laravel 11 discovers listeners otherwise); a module's provider only in a `nwidart/laravel-modules` `module.json`. `ide.json` `inputFilter` is read as a chain of the `${…|filter}` filters, and `transformers` (the same filters) apply to `staticStrings` and `directoryFiles` rules only; a `dataFile` is read when the `ide.json` is.
   - Register observers (`#[ObservedBy]`), events and listeners, and module service providers.
   - Pivot tables for `belongsToMany` in New Model.
   - Livewire 2 paths.
   - A grouped Generate submenu.
   - Edited templates for the in-model actions.
   - `ide.json` `inputFilter`/`regex`, `transformers` and `dataFile`.
8. **Livewire.** Done in 8.28 (`BladeUnknownLivewireParameter`, under Settings › PHP › Inspections › Laravel). An unknown-parameter inspection for `@livewire(…, [...])` and `<livewire:…>` attributes.
