# laravel-app

A small Laravel 11 blog: the test fixture of the engine's Laravel support
(`docs/php-engine/LARAVEL-ROADMAP.md`, Plan 8). The skeleton files (`artisan`,
`bootstrap/`, `public/index.php`, `config/app.php`, the users migration, `User`) follow
the MIT `laravel/laravel` skeleton; the rest is hand-written.

It has no `vendor/`. Tests copy it to a temporary folder with
[`../laravel-stubs`](../laravel-stubs) as its `vendor/`: a Composer vendor directory
(`composer/installed.json` plus `laravel/framework` and `nwidart/laravel-modules`) with
minimal stand-ins for the framework classes and helpers the app uses, so no network or Composer is needed. For
manual QA, do the same or run `composer install` on a copy.

- `crates/ide-php/tests/laravel_app.rs` indexes it with the engine and inspects every
  PHP file: no problems except the deliberate one below.
- `crates/ide-php/src/frameworks/laravel/tests.rs` (`the_fixture_app_model`) checks the
  Laravel project model: version, app namespace, route files with their prefixes, name
  prefixes and middleware, and the module.
- `crates/ide-host/tests/language_smoke.rs` (`laravel`) checks hover and completion on a
  model attribute through the app's `ops`.

**Deliberate problem:** `PostController::destroy()` calls the undefined method
`forgetCachedFeed()` (`app/Http/Controllers/PostController.php`).

## What each file exercises

| File                                                        | Exercises                                                                                                          |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `composer.json`                                             | detection (`laravel/framework` required), PSR-4 app namespace `App\`, `nwidart/laravel-modules` and `Modules\`      |
| `artisan`, `public/index.php`                               | entry points (skeleton)                                                                                            |
| `bootstrap/app.php`                                         | `withRouting(web:, api:, commands:, health:, then:)` route files (`then:` loads `routes/admin.php` in a group), middleware alias `author` |
| `bootstrap/providers.php`                                   | registered service providers                                                                                       |
| `routes/web.php`                                            | route names, an invokable controller, `Route::view`, `Route::resource()->only()`, a group with prefix, name prefix and middleware, `[Controller::class, 'method']` actions, a `Route::controller()` group with a method-name action and middleware parameters |
| `routes/api.php`                                            | the `api` route file (prefix from `withRouting`)                                                                   |
| `routes/admin.php`                                          | a route file loaded with prefix `admin`, name prefix `admin.` and `web`/`auth` middleware                          |
| `routes/console.php`                                        | `Artisan::command` closure command, `Schedule::command`                                                            |
| `Modules/Billing/*`, `modules_statuses.json`                | an nwidart module (`module.json`, enabled): its `RouteServiceProvider` loads `Routes/web.php` and `Routes/api.php` through `module_path()` with prefixes and name prefixes |
| `app/Models/Post.php`                                       | `$casts` (enum, `datetime`, `array`), relations (`belongsTo`, `hasMany`, `belongsToMany`), a local scope, an `Attribute` accessor, `SoftDeletes` |
| `app/Models/User.php`                                       | `casts()` method, `Authenticatable`, relations with a custom foreign key                                           |
| `app/Models/Comment.php`, `Tag.php`                         | more relations, `$timestamps = false`                                                                              |
| `app/Enums/PostStatus.php`                                  | a backed enum cast, `__()` translation keys built from a prefix                                                    |
| `app/Http/Controllers/PostController.php`                   | `view()` names and data (`compact`), `config()`, `route()`/`redirect()->route()`/`to_route()`, `Gate::authorize`, model attributes |
| `app/Http/Controllers/HomeController.php`                   | an invokable controller                                                                                            |
| `app/Http/Controllers/Api/PostController.php`               | a controller in a sub-namespace, `route()` with a model parameter                                                  |
| `app/Http/Middleware/EnsureUserIsAuthor.php`                | a middleware class with an alias                                                                                   |
| `app/Http/Requests/StorePostRequest.php`                    | Form Request: string and array validation rules, `Rule::unique`/`Rule::enum`, custom messages                      |
| `app/Policies/PostPolicy.php`                               | a policy found by convention (`Post` → `PostPolicy`)                                                               |
| `app/Providers/AppServiceProvider.php`                      | a container binding (`blog.feed`), `Gate::define` abilities                                                        |
| `app/Services/FeedBuilder.php`                              | the bound service, a nested `config()` key                                                                         |
| `app/Console/Commands/PublishScheduledPosts.php`            | an Artisan command: `$signature` with an option, `$description`, `option()`                                        |
| `app/View/Components/Alert.php`                             | a class-based Blade component                                                                                      |
| `config/app.php`, `config/blog.php`                         | config keys, nested arrays, `env()` keys                                                                           |
| `lang/en/messages.php`, `lang/en.json`                      | PHP (nested) and JSON translation keys                                                                             |
| `database/migrations/*`                                     | `Schema::create` and `Schema::table`, `foreignId()->constrained()`, `timestamps`, `softDeletes`, a pivot table     |
| `database/seeders/DatabaseSeeder.php`                       | relation `create()`                                                                                                |
| `resources/views/layouts/app.blade.php`                     | `@yield`, `@stack`, `@vite`, `<x-alert>` with a bound attribute, `route()`/`__()`/`config()` in echoes             |
| `resources/views/posts/*.blade.php`                         | `@extends`/`@section`/`@push`, `@include` with data, `@forelse`, `@can`, `@error`, view variables                  |
| `resources/views/components/alert.blade.php`, `badge.blade.php` | the class component's view, an anonymous component with `@props` and `@class`                                  |
| `resources/views/welcome.blade.php`, `about.blade.php`      | views named from a controller and from `Route::view`                                                               |
| `vite.config.js`, `resources/css/app.css`, `resources/js/app.js` | Vite entry points                                                                                             |
| `.env.example`                                              | environment keys                                                                                                   |
