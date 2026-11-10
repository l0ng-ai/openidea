# Laravel support

The native PHP engine understands Laravel applications: the strings that name routes, views, configuration keys, translations, validation rules, columns and the rest complete, go to their declaration, find their usages, rename, and are checked. It also generates code, runs Artisan commands and shows a model's schema. Everything is answered by the engine in `crates/ide-php` through the usual editor requests, so it works in PHP files and in Blade templates alike.

This file is the user guide (phases 8.1–8.29 of [ROADMAP.md](ROADMAP.md), designed in [LARAVEL-ROADMAP.md](LARAVEL-ROADMAP.md)). The second half, "Measurements", records the parity and performance checks on the fixture app and on two real applications.

- [Turning it on](#turning-it-on)
- [Features](#features)
- [Inspections](#inspections)
- [Settings](#settings)
- [ide.json](#idejson)
- [Known limits](#known-limits)
- [Measurements](#measurements)

## Turning it on

Laravel support turns on by itself when the project is a Laravel project: `composer.json` requires `laravel/framework`, `composer.lock` lists it, or there's an `artisan` file at a content root. Settings › PHP › Laravel › Laravel support forces it on or off.

It needs the native engine (Settings › PHP › Engine › Native, the default). It works without `vendor/`, but with `vendor/` installed it also knows the packages: their service providers, configuration, views, translations, Blade components, routes and `ide.json` files.

Livewire and Inertia support turn on when the package is installed (`composer.lock` or `vendor/composer/installed.json`). An `ide.json` can turn a package's support off with `packages.disabledPackages`.

What the engine reads to build its picture of the project (the "project model"):

| Part                 | Read from                                                                                                                                     |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Version, namespace   | `composer.lock`, the `composer.json` autoload rule for `app/`                                                                                 |
| Service providers    | `bootstrap/providers.php` or `config/app.php`, `config/concord.php`, packages' `extra.laravel.providers`, and every `$this->app->register(…)` |
| Routes               | `bootstrap/app.php` `withRouting(…)`, `RouteServiceProvider`, providers' `loadRoutesFrom`, files a route file `require`s, module route files  |
| Middleware           | `bootstrap/app.php`, `app/Http/Kernel.php`, providers' `aliasMiddleware` / `middlewareGroup`                                                  |
| Views and components | `resources/views`, providers' `loadViewsFrom`, `Blade::component()`, `componentNamespace()`, `anonymousComponentPath()`, `ide.json`           |
| Configuration        | `config/*.php`, the framework's defaults, providers' `mergeConfigFrom`                                                                        |
| Translations         | `lang/` (PHP and JSON, every locale), providers' `loadTranslationsFrom` / `loadJsonTranslationsFrom`                                          |
| Environment          | `.env` and `.env.example`                                                                                                                     |
| Assets               | `vite.config.*` inputs and `public/build/manifest.json`                                                                                       |
| Gates and policies   | `Gate::define`, `Gate::policy`, `$policies`, `#[UsePolicy]`, `Gate::guessPolicyNamesUsing`, Laravel's naming conventions                      |
| Guards and brokers   | `config/auth.php`, and guards providers set with `config([...])`                                                                              |
| Artisan commands     | classes with `$signature` / `$name`, the framework's and the packages' commands                                                               |
| Eloquent schema      | migrations (`create`, `table`, renames and drops), casts, accessors, relations, and optionally a live database                                |
| Livewire, Inertia    | components below `App\Livewire` (`App\Http\Livewire` on Livewire 2) and `Livewire::component(…)`; page files below the Inertia page folders   |

The model is rebuilt incrementally: an edit or a file change re-reads only the files it touched.

## Features

Most features work on string literals in known places. In each place the string completes, Ctrl+click (goto) opens its declaration, Find Usages lists every string naming the same thing, and where it makes sense, Rename edits the declaration and every caller. The examples below show one place each; the others are listed after them.

### Routes

```php
Route::middleware('auth')->name('posts.')->group(function () {
    Route::get('/posts/{post}', [PostController::class, 'show'])->name('show');
});

return redirect()->route('posts.show', $post);   // completes, goes to ->name('show'), renames
```

- **Route names** in `route()`, `to_route()`, `redirect()->route()`, `URL::route()`, `Route::has()` and `->name()`, with group name prefixes. Rename edits the route file and every caller, Blade templates included (open or not).
- **Controller actions:** `[PostController::class, 'show']`, `'PostController@show'` and invokable controllers. A controller method's usages include the routes pointing at it.
- **Middleware:** aliases and groups in `middleware()` chains and in `Route::middleware(…)`, including `can:` abilities.
- **Resources:** the actions in `Route::resource(…)->only([...])` and `except([...])`.
- Also understood: `Route::resources()`, `apiResources()`, `singleton()`, `apiSingleton()`, `fallback()`, `->names('prefix')`, `domain()`, the array form of `Route::group([...])`, groups with `withoutMiddleware`, routes registered inside `if` blocks, and route files at paths computed from `config('…')`.

**Route hints.** A code lens above each controller method lists the routes that reach it (method, URI, name), and an inlay hint after each `Route::get(…)` shows the full URI with group prefixes and domain. Clicking one offers to go to the route, copy its URL, open it in the browser (using `APP_URL` from `.env`) or create an HTTP client request (`.http` file). Settings › PHP › Laravel › Hints turns them off.

**Route search.** Search Everywhere has a **Routes** tab, searching by name or by part of the URI.

### Views and Blade

```php
return view('posts.index', ['posts' => $posts]);  // completes as a path tree, opens the template
```

```blade
@extends('layouts.app')
@section('content')            {{-- sections and stacks complete from the parent layout --}}
    @foreach ($posts as $post)  {{-- $posts is known here, typed from the controller --}}
        <x-post-card :post="$post" />
    @endforeach
@endsection
```

- **View names** in `view()`, `View::make()`, `Route::view()`, `response()->view()`, mailables' `view()`/`markdown()`, `@include`, `@extends`, `@each` and namespaced views (`shop::home`). Renaming a view moves its file and updates the strings. The undefined-view problem has a **Create view** quick-fix.
- **View variables:** what a controller passes (`view('x', [...])`, `compact()`, `with()`) completes and is typed inside the template.
- **Sections and stacks:** `@section`/`@yield` and `@push`/`@stack` complete and go across layouts.
- **Components:** `<x-…>` tags of class and anonymous components, of `Blade::component()` / `componentNamespace()` / `anonymousComponentPath()` registrations and of `vendor/` packages (`<x-pkg::alert>`). Tag and attribute completion, `@props`, `@aware`, `<x-slot>` / `<x-slot:name>`, `<x-dynamic-component>`. A class component's public properties and methods are variables in its view. The PHP in `:attr="…"` is analysed and checked against the constructor's parameter types.
- **Directives:** completion of Blade directives, including custom ones from `Blade::directive()` and `ide.json`. Directives are case-insensitive, as in Laravel.
- **Quick-fixes:** create a missing component or view, add a missing prop to `@props`.
- **Intentions:** switch `{{ }}` and `{!! !!}`; turn a `class` attribute into `@class([...])` or wrap it in one.

### Configuration, environment, translations and assets

```php
config('mail.mailers.smtp.host');   // completes segment by segment, goes to the array entry; hover shows the value's type
env('APP_URL');                     // checked against .env and .env.example
__('messages.welcome');             // hover shows the text in every locale
Vite::asset('resources/js/app.js'); // vite.config.* inputs and the build manifest
```

- **Configuration keys** in `config()`, `Config::get()` and `config()->get()`, nested segment by segment, including package configuration merged with `mergeConfigFrom`. Keys a file sets with `config([...])` or `Config::set()` count as defined.
- **Environment keys** in `env()`. A key missing from `.env.example` has a quick-fix that adds it. Find Usages and Rename also start from a `.env` line.
- **Translation keys** in `__()`, `trans()`, `trans_choice()`, `Lang::get()` and `@lang`, for PHP and JSON files, every locale and package namespaces (`shop::app.title`). Rename edits every locale file and every caller. The **Create Translation Key** action (on any translation string, in PHP or Blade) asks for the text in each locale and writes the chosen locale files.
- **Vite assets** in `@vite` and `Vite::asset()`.

### Validation

```php
$request->validate([
    'title'  => 'required|string|max:255|unique:posts,title',  // rules, parameters, tables and columns complete
    'status' => ['required', Rule::in(['draft', 'published'])],
]);
$request->input('title');  // fields complete from the rules
```

- **Rules** in a Form Request's `rules()`, `$request->validate()`, `validateWithBag()`, `Validator::make()`, `validator()`, and methods a class passes as its rules (`Validator::make($data, $this->rules())`). Pipe strings and arrays both work.
- **Parameters:** tables and columns of `exists:` and `unique:`, field names of `required_if:` and the like, the values of `in:` / `not_in:` (from the backing values of an enum the field is cast to, or constants like `STATUS_DRAFT`), and the arguments of `Rule::exists()`, `Rule::unique()` and `Rule::in()`.
- **Request fields:** `$request->input('…')`, `validated('…')` and `$request->field` properties, typed from the rules.
- **Intentions:** convert a rule string to an array (one or all), convert a rule to a `Rule::` object (`unique`, `exists`, `in`, `dimensions`), **Promote to Form Request** (moves a controller method's inline rules into a new Form Request and injects it), and **Generate rules** (rule entries from the model's columns, with `max:<length>` for string columns and `Rule::enum()` for enum casts).

### Eloquent

```php
Post::where('published_at', '<', now())          // columns of the posts table
    ->whereHas('comments', fn ($q) => $q->where('approved', true))  // $q is the Comment query
    ->withCount('comments')
    ->get()                                       // Collection<int, Post>
    ->each(fn (Post $p) => $p->comments_count);   // known after withCount
```

- **Columns** in `where()`, `orderBy()`, `select()`, `pluck()`, `whereIn()`, `update([...])`, `create([...])`, `firstOrCreate()` and the like, in a model's `$fillable`, `$guarded`, `$hidden`, `$casts` and `$appends`, and in the second argument of `whereRelation()`, `withSum()`, `withAvg()` and the other aggregates (the related model's columns).
- **Relations** in `with()`, `has()`, `whereHas()`, `load()` and dotted paths (`posts.comments`); the closure's query is typed with the related model.
- **Types:** collections from `get()` and `all()`, factories (`Post::factory()->create()` is a `Post`, `count(3)` makes a collection), `*_count` properties after a `withCount()`, local scopes (including a raw `Builder $query` parameter), and `Attribute::make(get: fn (): string => …)` accessors.
- **Query builder:** `DB::table('posts')` and `join()` tables, including aliases (`DB::table('posts as p')`, `p.title`).
- **Schema:** read from the migrations, including later `table()` changes, renamed and dropped columns, `foreignId()`, `foreignIdFor()`, `morphs()`, `timestamps()` and `softDeletes()`. A live database can be added (see Settings); its columns win, and hover says where a column comes from.
- **Model view:** a gutter icon and a code lens on a model class open a panel with the table, primary key, columns (type and source), relations, scopes, accessors, and the related factories, resources, policies, observers and migrations. Each item navigates, finds usages or renames. **Add columns** writes a migration for new columns and adds them to `$fillable`.

### Gates, policies and auth

```php
Gate::allows('publish-posts');      // gates and policy methods complete and go to their definition
$user->can('update', $post);        // the methods of PostPolicy
auth('admin')->user();              // guards of config/auth.php
Password::broker('users');          // brokers of config/auth.php
```

Abilities complete and resolve in `Gate::allows/denies/authorize`, `$user->can/cannot`, `authorize()`, `@can` and `can:` middleware. A policy is found the way Laravel finds it: registered for the model or a parent class, then `#[UsePolicy]`, then the `Gate::guessPolicyNamesUsing` callback, then the naming conventions. Inherited policy methods count. `Gate::define('x', [PostPolicy::class, 'publish'])` goes to the method.

### Artisan

- **Run Artisan Command…** lists the project's commands, with their arguments and options.
- An **Artisan command run configuration** completes command names and options.
- A run icon in the gutter of console command classes.
- Command names complete and go to their class in `Artisan::call('…')` and `$this->call('…')`.

### Livewire and Inertia

```blade
<livewire:counter :start="5" />          {{-- component names, mount() parameters and public properties --}}
@livewire('counter', ['start' => 5])
<input wire:model="count"> <button wire:click="increment">  {{-- public properties and methods --}}
```

```php
return Inertia::render('Posts/Index', [...]);   // page files below resources/js/Pages, Vue, React or Svelte
```

- **Livewire:** components found below the Livewire namespace or registered with `Livewire::component('alias', Class::class)`, in `@livewire(…)`, `<livewire:…>`, `Livewire::test()` and `Livewire::visit()`. Goto opens the class or its view; Find Usages and Rename also start from the class or the alias.
- **Inertia:** page names in `Inertia::render()`, `inertia()` and `Route::inertia()`. A missing page has a **Create page** quick-fix. Find Usages and Rename also start from a page file. The page folders come from the settings, else from `ide.json`, else `resources/js/Pages`.

### Code generation

The **Laravel › Generate** submenu (in the Project view, the editor and the New menus), the **Laravel Generators** tab of Search Everywhere and the **Laravel Generate…** action list the generators:

- **New Eloquent Model:** fields with types and modifiers, relations, indexes, and checkboxes for a migration (plus the pivot-table migrations of `belongsToMany` relations), factory, seeder, controller (plain, resource or API), Form Requests, JSON resource and policy.
- **Classes**, grouped in submenus: controller, resource controller, middleware, Form Request, JSON resource and collection, factory, seeder, migration (create or update a table), pivot-table migration, event, listener, job, mail, notification, observer, policy, rule, exception, HTTP exception, service provider, console command, Blade component (class or anonymous), view, view composer, broadcasting channel, enum, Livewire component (Livewire 2 or 3 layout), feature and unit tests.
- **`ide.json` code generations** of the project and its packages, with their own input fields.

Generators put files in the application or a chosen module, use the namespace and class suffixes of Settings › PHP › Laravel › Code generation, and register what they create: an observer in its model's `#[ObservedBy]`, a listener in the event service provider's `$listen`, a service provider in `bootstrap/providers.php` or the module's `module.json`.

The file contents come from the **Laravel …** templates in Editor › File and Code Templates, which can be edited. Inside a model, Generate also offers **JSON resource from model**, **Factory from model** and **Add all fields** to `$fillable`, which use the same edited templates.

### Intentions in PHP

- Facade alias (`\Cache::get`) to a facade import.
- Facade call to an injected dependency, through the constructor or the method.
- Move a method dependency to the constructor (promoted property).
- String controller reference (`'PostController@show'`) to `[PostController::class, 'show']`, one or all in the file.
- `scopeX` method to a `#[Scope]` method, one or all.
- The validation intentions listed under Validation.

### Modules and packages

Modules are read from `nwidart/laravel-modules` (`module.json`), from `konekt/concord` (`config/concord.php`, each module provider is a module) and from module folders (`modules/`, `app-modules/`, `app/Modules/`, `src/Modules/`). Their routes, views, translations, configuration and providers are part of the model, and generators can write into them.

Packages in `vendor/` are read through their service providers (package discovery), their `ide.json` and the class aliases they declare (`extra.laravel.aliases`); the aliases of `config/app.php` count too.

## Inspections

The Laravel inspections are in the inspection profile (Settings › PHP › Inspections, group "Laravel"; the route check is in "Frameworks"), each with an on/off switch and a severity. They run in the editor and in batch **Inspect Code**. Inspections that depend on a schema or a configuration file stay quiet when it isn't known for certain.

| Inspection                                     | Reports                                                                                                              | Quick-fix                     |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `PhpUndefinedRoute`                            | route names no route defines                                                                                         |                               |
| `PhpUndefinedView`                             | view names no template has (in PHP and Blade)                                                                        | create the view               |
| `PhpUndefinedConfigKey`                        | configuration keys no known configuration array has                                                                  |                               |
| `PhpUndefinedEnvKey`                           | `env()` keys neither `.env` nor `.env.example` sets, and keys missing from `.env.example`                            | add to `.env.example`         |
| `PhpUndefinedTranslation`                      | translation keys no locale has                                                                                       | create in every locale        |
| `PhpUndefinedViteAsset`                        | `@vite` / `Vite::asset()` paths that are no file, entry point or manifest entry                                      |                               |
| `PhpUnknownValidationRule`                     | rules neither built in nor registered with `Validator::extend()`                                                     |                               |
| `PhpUnknownEloquentColumn`                     | columns the model's table doesn't have, when the migrations are certain                                              |                               |
| `PhpUnknownAbility`                            | abilities no gate or policy defines, `can:` middleware included                                                      |                               |
| `PhpUnknownGuard`                              | guards `config/auth.php` doesn't declare (`auth()`, `Auth::guard()`, `@auth`, `auth:` middleware)                    |                               |
| `PhpUnknownPasswordBroker`                     | brokers `config/auth.php` doesn't declare                                                                            |                               |
| `PhpUndefinedController`                       | route actions naming a missing controller class or method (`'dream'`, `'Foo@bar'`)                                   | create controller, add method |
| `PhpUndefinedInertiaPage`                      | Inertia pages no page folder has                                                                                     | create the page               |
| `BladeUnclosedSection`, `BladeUnopenedSection` | `@section` / `@push` blocks never closed, and closing directives with nothing open                                   |                               |
| `BladeUndefinedComponent`                      | `<x-…>` tags no component defines                                                                                    | create the component          |
| `BladeUnknownLivewireParameter`                | `@livewire(…, [...])` keys and `<livewire:…>` attributes that are neither `mount()` parameters nor public properties |                               |

The engine's general PHP inspections (undefined classes and methods, argument types, unused variables and so on) use the Laravel model too: facades, container helpers, Eloquent forwarding and magic properties, and class aliases are all typed.

## Settings

Settings › PHP › Laravel, stored under `languages.php.laravel` (the engine receives them as one `LaravelSettings` struct, `crates/ide-core/src/settings.rs`):

| Setting              | Key                                                                                              | Default                                                 | What it does                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Laravel support      | `detection`                                                                                      | `auto`                                                  | `auto` (from `composer.json`, `composer.lock`, `artisan`), `enabled` or `disabled`                                                   |
| Modules              | `modules`                                                                                        | `auto`                                                  | `auto` (nwidart modules when installed, and module folders), `nwidart`, `directory` or `none`                                        |
| Show route hints     | `routeHints`                                                                                     | on                                                      | the route code lenses and URI inlay hints                                                                                            |
| Database             | `database`                                                                                       | none                                                    | a data source of the Database tool window whose live schema is merged with the migrations; refreshed on demand and on schema changes |
| Inertia page folders | `inertiaPages`                                                                                   | empty: `ide.json`, else `resources/js/Pages`            | folders of Inertia pages, relative to the project                                                                                    |
| Code generation      | `generation.namespace`                                                                           | the `composer.json` namespace of `app/`                 | the application's root namespace                                                                                                     |
|                      | `generation.module`                                                                              | the application                                         | the module new classes go to unless the dialog picks another                                                                         |
|                      | `generation.controllerSuffix`, `requestSuffix`, `resourceSuffix`, `policySuffix`, `seederSuffix` | `Controller`, `Request`, `Resource`, `Policy`, `Seeder` | class name suffixes                                                                                                                  |
|                      | `generation.constructorPromotion`                                                                | on                                                      | constructors promote their parameters                                                                                                |
|                      | `generation.typeHints`                                                                           | on                                                      | generated methods declare return types                                                                                               |

The inspections are set in the inspection profile, and the generator templates in Editor › File and Code Templates.

## ide.json

An `ide.json` file describes Laravel tooling for a project or a package, in the open format of `laravel-ide-v2.json`. The engine reads the project's own `ide.json` first, then every `vendor/*/*/ide.json`, so the project's rules win. Paths in a file are relative to its folder. Editing an `ide.json` file completes its keys: from the schema its `$schema` names, else from the schema the engine bundles. Keys the engine doesn't use are skipped with a log line (`ide.json ignored: …`).

```json
{
  "$schema": "https://laravel-ide.com/schema/laravel-ide-v2.json",
  "completions": [
    {
      "complete": "routeName",
      "condition": [{ "functionNames": ["nav_link"], "parameters": [2] }]
    },
    {
      "complete": "configKey",
      "condition": [{ "functionNames": ["blog_setting"] }],
      "options": { "prefix": "blog." }
    },
    {
      "complete": "staticStrings",
      "condition": [
        {
          "place": "arrayValueWithKey",
          "keys": ["theme"],
          "functionNames": ["feed_options"]
        }
      ],
      "options": { "strings": ["light", "dark"] }
    }
  ],
  "blade": {
    "directives": [
      {
        "name": "price",
        "prefix": "<?php echo number_format(",
        "suffix": ", 2); ?>"
      }
    ]
  }
}
```

What is read:

- **`completions`:** rules saying which strings complete what. The string then gets everything its kind has: completion, goto, usages and inspection.
  - `complete`: `routeName`, `routeAction`, `routeMiddleware`, `configKey`, `viewName`, `translationKey`, `validationRule(s)`, `gate`, `artisanCommandName`, `environmentVariable`, `eloquentFields`, `viteAsset`, `livewireComponent`, `inertiaPage`, `staticStrings` and `directoryFiles`.
  - `condition` (any one matches): `functionNames`, `functionFqn`, `methodNames`, `classNames`, `classFqn`, `classParentFqn`, `newClassNames`, `newClassFqn`, `newClassParentFqn`, `parameters` (1-based), `parameterNames`, `keys` and `place` (`parameter`, `arrayKey`, `arrayOnlyKey`, `arrayValue`, `arrayValueWithKey`, `arrayValueWithKeyArray`, `arrayInArrayKey`, `arrayInArrayOnlyKey`, `arrayInArrayValue`, `returnString`, `returnArrayValue`, `returnArrayKey`, `returnArrayOnlyKey`, `returnArrayValueWithKey`, `returnInArrayValueWithKey`).
  - `options`: `prefix`; for `staticStrings`, `strings`, `stringsWithLocation` and `dataFile` (a JSON array, a JSON object of strings and their places, or one string per line); for `directoryFiles`, `directory`/`directories`, `recursive` and `suffixToClear`.
  - `transformers` (`staticStrings` and `directoryFiles` only): the filters listed below.
- **`view.paths`:** more view folders, with an optional namespace.
- **`blade`:** `components.viewPaths` (with `prefix` and `namespace`), `components.list` (`name`, `namespace`, `className`), `directives` and `ifDirectives` (`name`, `prefix`, `suffix`).
- **`codeGenerations`:** each entry is a generator in the Laravel › Generate menu. `id`, `name`, `classSuffix`, `inputFilter`, `regex`, `parameters` (`string`, `checkbox`, `select` with `options`; `variable`, `defaultValue`, `optional`) and `files` (`appNamespace` or `directory`, `name`, `baseClass`, `fallbackBaseClass`, and a `template` of type `stub` with `path`, `fallbackPath` and `parameters`, or of type `fileTemplate` naming a template of Editor › File and Code Templates). Names and contents use `${VARIABLE|filter}` expressions; the filters are `className`, `namespace`, `camelCase`, `lowerCamelCase`, `pascalCase`, `studlyCase`, `upperCamelCase`, `snakeCase`, `kebabCase`, `lowerCase`, `upperCase` and `plural`.
- **`packages`:** `enabledPackages`, `disabledPackages`, `livewire.namespaces` (`classNamespace`, `viewPath`, `tagPrefix`), `inertia.pagePaths` (`path`, `prefix`, `suffix`) and `passport.scopes`.

Not read: `helperCode` and any other key not listed here.

## Known limits

- **Routes:** URLs copied or opened from a route hint keep their `{param}` placeholders. Route lenses show only in documents open in the engine. A route file path computed by `Config::get('…')` or `config()->get('…')`, rather than `config('…')`, isn't followed. Concord's convention-based registrations (views and routes of `BaseModuleServiceProvider` without explicit calls) aren't read. `PhpUndefinedController` leaves a missing class written `[Foo::class, 'bar']` to `PhpUndefinedClass`, and skips action strings with escapes (`'Admin\FooController@bar'`); applying its "Create controller" fixes doesn't yet open the new class at the method (phase 8.31.b). On the pinned Monica and Bagisto it reports 9 actions, all real dead routes (methods the controllers don't have).
- **Views and Blade:** variables passed to a template aren't carried through `@include` beyond one level, nor to `@each`'s item. A missing constructor parameter of a class component has no quick-fix (only a missing `@props` entry does), and `@aware` entries don't complete from the parent component. `Blade::component()` calls made outside a provider's code (`callAfterResolving`, `$blade->component`) aren't read.
- **Livewire:** a component found by its class (not registered with an alias) can't be renamed by its name; renaming the class doesn't edit `<livewire:…>` tags.
- **Translations:** Find Usages doesn't start from a JSON locale file.
- **Validation:** `in:` values come from attributes named like the field, not from the Form Request's own model. `Rule::in()` with variadic strings isn't completed. `unique`/`exists` with more than two parameters aren't converted to `Rule::` objects. Only the common shapes of `Gate::guessPolicyNamesUsing` callbacks are followed.
- **Eloquent:** `*_count` properties are offered once any `withCount()` of the project counts the relation, not along the query that loaded the model. Tables of a database schema other than the default one aren't used. A query builder's table is lost through a variable reassigned in a loop.
- **Artisan:** there is no "unknown command" inspection, and option keys in `Artisan::call('x', ['--opt' => …])` don't complete.
- **Generators:** a listener is registered only where an event service provider has a `$listen` array (Laravel 11 otherwise discovers listeners); a module provider only in a nwidart `module.json`. An `ide.json` `dataFile` is read again only when its `ide.json` is.
- **Model view:** it doesn't refresh by itself when files change while it's open, and Add columns has no length, default or index modifiers.
- **Analysis:** a file whose syntax tree is more than 1,500 levels deep isn't analysed (it gets one syntax error saying so); no hand-written code in the corpora comes near that.

## Measurements

The checks of phases 8.21–8.29, in the order they were made. Later sections supersede the numbers of earlier ones.

### Parity check (phase 8.21)

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
| `controllerAction`  | `[PostController::class, 'index']`          | ✓          | ✓                  | ✓      | ✓ `PhpUndefinedController`   |
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

### Performance (phase 8.21)

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

#### Real applications (2026-11-09)

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

#### Incremental model (phase 8.22, 2026-11-09)

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

#### Package registrations (phase 8.23, 2026-11-09)

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

#### Validation on real applications (phase 8.26)

The missing validation-rule completion wasn't the rule catalogue: the checklist's probe typed `$request` as the fixture's `App\Http\Requests\StorePostRequest`, which no real application has, so the `validate()` call had no receiver class. The probe now uses `Illuminate\Http\Request` and `Validator::make`, which every application has. Both complete on Monica and Bagisto.

Monica does have a real gap, though: almost none of its rules sit in Form Requests. Its 250 or so services return them from `rules()` and validate in `App\Services\BaseService` with `Validator::make($data, $this->rules())->validate()`. The file summaries now record the methods a class passes as the rules of `Validator::make`, `validator()`, `validate()` or `validateWithBag()` (`$this->rules()`), and what those methods return in the class and its subclasses is a rules array. `real_app_checklist` checks a service's `rules()` when the app has `App\Services\BaseService`.

`real_app_checklist` passes on Monica. On Bagisto it passed too, but at the time only with larger thread stacks (`RUST_MIN_STACK=67108864`): in a debug build an indexing thread overflowed its default 2 MB stack on one of Bagisto's files. Phase 8.29 fixed that (see below); no command needs `RUST_MIN_STACK` any more.

#### Eloquent on real applications (phase 8.27, 2026-11-10)

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

#### Real-application check (phase 8.29, 2026-11-10)

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

| Application | Files inspected | Diagnostics before | Diagnostics after       |
| ----------- | --------------- | ------------------ | ----------------------- |
| Monica      | 896             | 200                | 193 (194 before 8.29.b) |
| Bagisto     | 2,983           | 227                | 181                     |

What remains, by inspection:

- Monica: 175 `PhpUnusedParameter`, 7 `PhpUndefinedVariable`, 4 `PhpUndefinedTranslation`, 3 `PhpUnusedLocalVariable`, 1 `PhpUndefinedRoute`, 1 `PhpUnknownAbility`, 1 `PhpUnknownEloquentColumn`, 1 `PhpUnusedAlias`.
- Bagisto: 51 `PhpUnusedParameter`, 44 `PhpUndefinedTranslation`, 24 `PhpUnusedLocalVariable`, 15 `PhpDeprecation`, 11 `PhpUnknownEloquentColumn`, 7 `PhpUnusedAlias`, 7 `PhpUndefinedVariable`, 5 `PhpUndefinedView`, 3 each of `PhpParams`, `PhpUndefinedClass` and `PhpUndefinedField`, 2 each of `PhpIncompatibleReturnType`, `PhpUndefinedMethod` and `PhpUndefinedConfigKey`, 1 each of `PhpUndefinedRoute` and `PhpUndefinedEnvKey`.

Nearly all of them are real. Some examples:

- Monica: route `post.choose_template` and gate `slice-owner`, which nothing defines; translation keys missing from `lang/en.json`; unused imports.
- Bagisto: views that don't exist (`admin::catalog.products.create`, `shop::emails.customers.forget-password` next to `forgot-password`); `use Barryvdh\Debugbar\Facades\Debugbar`, which debugbar 4 renamed to `Fruitcake\LaravelDebugbar`; `\Swift_RfcComplianceException` from the removed SwiftMailer; `massDestroy(): JsonResponse` returning a redirect; `mail.mailers.smtp.encryption`, which `config/mail.php` doesn't have; `OMNIBUS_ENABLED`, which `.env.example` doesn't have; Symfony's deprecated `Request::get()`.
- Unused parameters are controller actions' `Request $request` and methods that override nothing.

The rest follow a wrong declaration or are limits of the analysis:

- Seven Bagisto diagnostics come from `bagisto/laravel-datafaker`. `Helpers\Category::factory()` is documented `Factory<static>`, but it returns the model's factory, so `->create()` is typed as the helper.
- `getOptionProductsPrices()` has no native return type and documents `@return float` while returning an array.
- Monica's `$timestamp` (four diagnostics in the CalDAV and CardDAV backends) is read only when an earlier condition set it (`if ($data) { $timestamp = …; } if (empty($data) || $timestamp …)`). The analysis doesn't relate the two conditions, and neither does PhpStorm's.
- Monica's `profile.show` is Jetstream's. Jetstream loads its routes from `__DIR__.'/../routes/'.config('jetstream.stack').'.php'`. Since phase 8.29.b a route file path keeps its `config('key')` and `config('key', 'default')` parts, and they are filled in from the project's configuration when the route files are resolved: the key's value (a string literal, or the default of `env('…', '…')`), else the call's default. A path whose part has neither is left out. Monica's `config/jetstream.php` says `'stack' => 'inertia'`, so `routes/inertia.php` is read and `profile.show` is defined; changing the stack picks `livewire.php`.

To run them:

```sh
LARAVEL_APP_DIR=../php-corpus/apps/bagisto cargo test -p ide-php --test laravel_parity -- --ignored real_app_checklist real_app_inspect_code --nocapture
LARAVEL_APP_DIR=../php-corpus/apps/bagisto cargo bench -p ide-php --bench engine -- php_laravel_real
```
