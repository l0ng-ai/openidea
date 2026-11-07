# PHP

OpenIDEA has a built-in PHP engine. It indexes the project itself, inside the app,
and answers completion, navigation, inspections and refactorings for PHP files.
It needs no language server, no Node.js and no PHP interpreter. The
[Intelephense](https://intelephense.com) language server is still available as an
optional fallback.

Open the folder that contains `composer.json` (or any folder with PHP files). The
engine starts as soon as the project contains PHP. While it builds its index the
status bar shows indexing; the index is kept in the project's cache folder, so
opening the project again is fast and only changed files are read again.

## Settings › PHP

| Setting                 | What it does                                                                                                                                                                                                                                                                                                                                  |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Code insight engine** | **Built-in** (the default) or **Intelephense**. Intelephense is started only when it is selected; install it with `npm i -g intelephense`. Switching stops one and starts the other, no restart needed.                                                                                                                                       |
| **PHP language level**  | The PHP version the code is checked against. Newer syntax and functions are reported, and only the built-in functions and classes of that version are offered. Refactorings and generated code use only syntax that version supports. **Auto** uses `config.platform.php` from `composer.json`, else the lowest version `require.php` allows. |
| **Include paths**       | Folders outside the project whose classes and functions are indexed too, such as the platform a module extends. Absolute, `~/…`, or relative to the project.                                                                                                                                                                                  |
| **Additional stubs**    | Stub sets loaded on top of the defaults: folder names of [phpstorm-stubs](https://github.com/JetBrains/phpstorm-stubs) such as `redis` or `mongodb`. Each `ext-*` in `require` or `require-dev` of `composer.json` adds its own set. Intelephense also knows `wordpress`.                                                                     |
| **PHP interpreter**     | The `php` executable that runs scripts, PHPUnit, Composer and artisan. Empty uses `php` on `PATH`. Code insight doesn't need it.                                                                                                                                                                                                              |

**Settings › PHP › Inspections** turns the engine's inspections on and off and sets
their severity. The same list is under **Editor › Inspections**, and both edit the
inspection profile in effect. These inspections run only with the built-in engine.

## What belongs to the project

The engine indexes:

- the project folder, without the folders excluded in the project settings;
- the `autoload` and `autoload-dev` rules of `composer.json` (`psr-4`, `psr-0`,
  `classmap`, `files`), and the packages in `vendor/` that
  `vendor/composer/installed.json` lists;
- the include paths above;
- the built-in declarations of PHP and its extensions, from the bundled
  phpstorm-stubs, for the language level and stub sets above.

Changes made outside the editor (a `git checkout`, `composer install`) are picked
up from the file watcher. A changed `composer.json` reloads the layout.

## Features

- **Completion:** members, variables, keywords, classes, functions and constants
  with automatic `use` imports, named arguments, enum cases, array shape keys and
  the values `.phpstorm.meta.php` expects for an argument.
- **Navigation:** Go to Declaration, Type Declaration and Implementation; Find
  Usages (including PHPDoc types and class names in strings); the Structure view
  and Navigate › Symbol; Call Hierarchy and Type Hierarchy.
- **Hover and parameter info:** the type and PHPDoc of what is under the caret,
  signature help, and inlay hints for parameter names and inferred types.
- **Types:** native type hints and PHPDoc as PHPStan and Psalm write it
  (generics with `@template`, array shapes, `class-string<T>`, conditional
  narrowing with `@phpstan-assert`), `@property`, `@method` and `@mixin`,
  `.phpstorm.meta.php` overrides, and PHPUnit test doubles. Variable types follow
  the code: assignments, `instanceof` and `is_*` checks, null checks, `assert()`,
  `match (true)` and inline `/** @var */`.
- **Inspections:** syntax errors; undefined classes, functions, constants,
  methods, properties and variables; wrong argument counts and type mismatches;
  unused imports, variables, parameters and private members; unreachable code
  and missing returns; deprecated symbols (struck through) and features newer
  than the language level. Quick-fixes import a name, create a missing method,
  property or class, add types and PHPDoc, and remove what is unused. Suppress one
  with `/** @noinspection Name */`. **Code › Inspect Code** runs the same checks
  over the whole project.
- **Editing:** Reformat Code (PSR-12, with the editor's indentation and line
  length), Optimize Imports, semantic highlighting.
- **Refactoring:** Rename (classes, functions, constants, methods across the
  hierarchy, properties, parameters and variables, with PHPDoc and `use`
  statements; a class whose file follows PSR-4 renames the file too), moving a
  file inside a PSR-4 root (its namespace and every reference follow), Extract
  Variable, Constant and Method, Inline, Change Signature, Pull Members Up and
  Push Members Down.
- **Generate:** implement and override methods, constructor (with promoted
  properties as an option), getters and setters, and a PHPDoc stub.

## Using Intelephense instead

Set **Settings › PHP › Code insight engine** to **Intelephense** to go back to the
language server: for example, if a project depends on Intelephense's own stubs
(`wordpress`) or on a feature of its premium licence. The language level, include
paths and stubs apply to it as well. The inspections under Settings › PHP ›
Inspections do not; Intelephense reports its own diagnostics.
