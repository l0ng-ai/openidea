# Native PHP engine roadmap

This roadmap builds a native, in-process PHP code-intelligence engine (`crates/ide-php`) in the style of PhpStorm. Over the phases it replaces Intelephense. The execution rules are in [RULES.md](RULES.md), and finished phases are logged in [PROGRESS.md](PROGRESS.md).

## How to track

- Each phase is a line: `- [ ] Phase N.M: Title`. The paragraph under it says what to build and how to prove it works.
- Boxes: `- [x]` means done, `- [!]` means blocked (the reason follows a dash).
- The first `- [ ]` line in file order is the next phase to do.
- If a phase is too large for one session, add a follow-up `- [ ] Phase N.M.b` line directly under it.

## Design

Clean room. These public descriptions shaped the design:

- [PhpStorm type providers](https://plugins.jetbrains.com/docs/intellij/php-open-api-php-type-providers.html)
- [Indexing and PSI stubs](https://plugins.jetbrains.com/docs/intellij/indexing-and-psi-stubs.html)
- [Stub indexes](https://plugins.jetbrains.com/docs/intellij/stub-indexes.html)
- [File-based indexes](https://plugins.jetbrains.com/docs/intellij/file-based-indexes.html)
- [Code inspections](https://plugins.jetbrains.com/docs/intellij/code-inspections.html)
- [Advanced metadata](https://www.jetbrains.com/help/phpstorm/ide-advanced-metadata.html)
- [rust-analyzer architecture](https://rust-analyzer.github.io/book/contributing/guide.html)

The design:

- **Syntax:** the Mago crates (`mago-syntax`, `mago-names`, `mago-phpdoc-syntax`, and others; MIT/Apache) parse each file. Each open document is parsed again for every version. Offsets are mapped to UTF-16 through `ide-text`.
- **File summaries** (PhpStorm calls these stubs): a `FileSummary` per file holds the declarations that other files can see:
  - classes, interfaces, traits and enums, with their members and signatures
  - functions and constants
  - PHPDoc types
  - lazy types for anything that can only be resolved with other files

  Summaries are serialized with postcard.

- **Indexes:** redb tables keyed by content hash, rebuilt only for changed files, following `crates/ide-index/src/worker.rs`. The tables are:
  - FQN → declaration
  - short name → FQNs
  - class → direct subclasses
  - namespace → members
  - word → files

  While indexing runs the engine reports dumb mode (`IdeEvent::IndexState`).

- **Two-phase types:**
  - At index time, a type that depends on another file is stored as a `LazyType`, for example `FnReturn("\foo")` or `MethodReturn{recv, name}`.
  - At resolve time it's completed against the indexes. Unions are resolved member by member, with `visited` and `depth` guards.
  - Resolved types are cached. The cache is dropped whenever a global modification counter goes up; document edits and watcher batches bump it.
- **Type providers:** a `TypeProvider` trait (key, a local step, a resolve step). Through it PHPUnit, `.phpstorm.meta.php`, Laravel and Symfony add types without changing the core.
- **Flow:** a flow graph per function gives variable types after each assignment, narrowing (`instanceof`, `is_*`, null checks, `assert`), undefined and unused variables, and unreachable code.
- **Inspections:** visitors that check one file at a time and offer quick-fixes that return a `WorkspaceEdit`. They run in the background after edits and support cancellation. Results are pushed as `IdeEvent::Diagnostics { source: "php" }`. The same checks run in batch Inspect Code.
- **Integration:**
  - `Project` (`crates/ide-host/src/project.rs`) owns an `Arc<PhpEngine>`, registers a `DocumentObserver`, and forwards watcher batches to it.
  - A `LanguageService` trait in `ide-host` is consulted before LSP in `crates/ide-host/src/ops/lsp.rs`, so local and remote development both work with no frontend or IPC changes.
  - `PhpSettings.engine` (`Native | Intelephense`) chooses between the two. It defaults to Intelephense until phase 6.4.
- **Reuse:**
  - `crates/ide-sdk/src/php.rs` for the language level, include paths and stubs.
  - `crates/ide-sdk/src/discover.rs` `php()` for interpreter discovery.
  - `ide-workspace` `WorkspaceEdit`.
  - Built-in function and class signatures from [phpstorm-stubs](https://github.com/JetBrains/phpstorm-stubs) (Apache-2.0).

## Plan 0: Groundwork

- [x] Phase 0.1: Roadmap harness
      Add `docs/php-engine/{RULES,ROADMAP,PROGRESS}.md` and `scripts/php-engine-loop.sh`. The loop runs one headless session per phase, logs to `logs/php-engine/`, and stops when stuck or when tests fail after a commit.

- [x] Phase 0.2: Tools and corpora
      Add `scripts/php-corpus.sh`, which needs nothing beyond git. It shallow-clones pinned tags of laravel/framework, symfony/symfony and WordPress/WordPress into `${PHP_CORPUS_DIR:-../php-corpus}`, and skips any that are already there. Document in RULES.md how to install Intelephense (`npm i -g intelephense`) and `cargo-nextest`. Run the script, and check that Intelephense starts with `intelephense --stdio` and a scripted `initialize`. Test: a shell check, plus a mention in PROGRESS.md.

- [x] Phase 0.3: PHP fixture project
      Add `fixtures/php-app`, modelled on the other fixtures and listed in `fixtures/README.md`. It has:
  - `composer.json` with PSR-4 autoloading `App\\` → `src/` and `Tests\\` → `tests/`, and `require.php: ^8.2`
  - classes, an interface, an abstract class, a trait and an enum
  - a generic `Collection<T>` written with `@template`
  - a function file, constants
  - a `.phpstorm.meta.php` with `override` and `map`
  - `tests/` with PHPUnit tests
  - one file with a deliberate error for diagnostics

  Keep it small: about 15 files.

- [x] Phase 0.4: Intelephense baseline smoke test
      Add a `php` case to `crates/ide-host/tests/language_smoke.rs` using the existing `Checks` table: definition, references, hover, completion, diagnostic, rename (if the free tier supports it; otherwise mark it as unsupported the way other languages do), format, signature and structure, on `fixtures/php-app`. It runs with `cargo test -p ide-host --test language_smoke -- --ignored --exact php` and must pass with Intelephense installed. This is the baseline the engine has to match.

- [x] Phase 0.5: Mago test-drive and `ide-php` skeleton
  1. Create `crates/ide-php`: workspace member, `ide-core` dependency, crate docs.
  2. Add pinned Mago crate dependencies (`mago-syntax`, `mago-names`, `mago-phpdoc-syntax`, plus whichever span and interner crates they need).
  3. Add an ignored test or example, `crates/ide-php/examples/parse_corpus.rs`. It parses every `.php` file in the corpora and reports files per second, peak memory, the number of files with errors, and how well parsing recovers on 200 files cut short at random offsets.
  4. Write the results and the API notes the later phases need in `docs/php-engine/spike.md`.

  If Mago can't be used (licence, API or recovery problems), block the phase and explain why.

- [x] Phase 0.6: Comparison harness
      Add `crates/ide-php/tests/differential.rs` (ignored; needs Intelephense and the corpora). Over N sampled identifier positions in a corpus, it asks Intelephense (through `ide-lsp`) and the engine (through its public API, once that exists) for definition and hover. It writes a JSON and Markdown report of agreements and differences to `target/php-differential/`. Until the engine answers, only the Intelephense side and the report format run. Test: the report is produced on `fixtures/php-app`.

## Plan 1: Syntax, summaries, index

- [x] Phase 1.1: Syntax adapter
      Add an `ide_php::syntax` module:
  - Parse with Mago and convert between byte offsets and `ide-text` UTF-16 positions.
  - Add a `ParsedFile` with the AST, errors and line index.
  - Add a parse cache keyed by `(DocId, version)`.

  Tests: multibyte text such as emoji in strings, CRLF, files mixing HTML and PHP, and broken input.

- [x] Phase 1.2: Name resolution
      Resolve names the way PHP does:
  - namespaces, including several per file and braced blocks
  - `use`, `use function`, `use const`, grouped `use`
  - aliases
  - functions and constants falling back to the global namespace
  - `self`, `static` and `parent` as markers to be resolved later

  Use `mago-names` where it fits. Tests are table-driven over snippets.

- [x] Phase 1.3: File summaries for declarations
      Add `FileSummary` and its extraction:
  - classes, interfaces, traits and enums (cases and backing type)
  - extends and implements, trait uses with `insteadof` and `as`
  - methods (modifiers, parameters with types, defaults, by-ref, variadic, promoted constructor properties)
  - properties (types, readonly), class constants
  - functions, `define()` and `const` constants
  - attributes (names only)
  - ranges for name and declaration

  Each summary is serializable with postcard and records a schema version. Tests: golden snapshots of summaries for `fixtures/php-app`.

- [x] Phase 1.4: PHPDoc in summaries
      Parse doc blocks with `mago-phpdoc-syntax`:
  - `@var`, `@param`, `@return`, `@throws`, `@deprecated`
  - `@property(-read|-write)`, `@method`, `@mixin`
  - `@template(-covariant)`, `@extends`, `@implements`, `@use`
  - the `@psalm-*` and `@phpstan-*` variants, which take priority

  Store them as unresolved type expressions in the summary. Tests: golden summaries.

- [x] Phase 1.5: Persistent indexes
      Add `ide_php::index`:
  - redb tables (FQN → decl id, lower-case short name → FQNs, class → direct subclasses, namespace → children) and summaries keyed by content hash, stored under the project cache directory with a schema stamp.
  - The first build runs in parallel with rayon and can be cancelled. Later changes only re-index changed or removed files.

  Tests: build, change, delete and restart against a temporary directory, and check that nothing is re-parsed when nothing changed.

- [x] Phase 1.6: Composer and include paths
      Work out which files belong to the project:
  - `composer.json` autoload and autoload-dev (`psr-4`, `psr-0`, `classmap`, `files`)
  - `vendor/composer/installed.json` when present
  - include paths from Settings › PHP (reuse `ide_sdk::php::include_paths`)
  - honour the project's excluded folders

  Use a mapping from PSR-4 namespace to directory, which later phases need for moves and new classes. Tests use temporary Composer projects.

- [x] Phase 1.7: Bundled phpstorm-stubs
  1. Check the licence (Apache-2.0, plus CC-BY for the PHP manual text) and add the notice to the repo's third-party notices.
  2. Fetch a pinned phpstorm-stubs release at build time or check it in. Pick whichever matches how the repo handles bundled assets, and record why.
  3. Index it into a ready-made summary set that's embedded in or shipped with the app.
  4. Filter by `#[PhpStormStubsElementAvailable]` and `#[LanguageLevelTypeAware]` for the project's PHP version (`ide_sdk::php::language_level`), and by the enabled extensions (`ide_sdk::php::intelephense_stubs`, which should be generalised).

  Tests: `strlen` and `ArrayIterator` are present, and a PHP 8.3-only function is hidden at 8.1.

- [x] Phase 1.8: Engine in the project
      Add `PhpEngine` (with `open`, `shutdown` and `status`) as a field of `Project` in `crates/ide-host/src/project.rs`:
  - Register a `DocumentObserver` so open buffers override disk contents.
  - Forward watcher batches so the indexes are updated.
  - Emit `IdeEvent::IndexState` while indexing and readiness compatible with the LSP status the frontend expects (see `src/editor/lsp/availability.ts`).
  - Start the engine only for projects that contain PHP and when `PhpSettings.engine` asks for it.

  Tests: an ide-host test that opens a temporary PHP project and waits until it's ready.

- [x] Phase 1.9: LanguageService dispatch
  1. In `ide-host`, define a `LanguageService` trait whose methods match the `LspManager` feature methods used by `ops/lsp.rs`, with default "not handled" implementations.
  2. In `ops/lsp.rs`, call the service registered for a document's language first, and fall back to LSP when it doesn't handle the request.
  3. Add `PhpSettings.engine: PhpEngineKind { Intelephense, Native }`, default Intelephense, with a settings row (text in `en` and `zh`).
  4. When Native is chosen, don't start the PHP language server.

  Tests: dispatch with a mock service, and that the LSP path is unchanged when no service is registered.

- [x] Phase 1.10: Symbols and class/function navigation
      Answer these requests natively:
  - document symbols, which feed `doc_outline`
  - workspace symbols, using the short-name index with fuzzy matching (reuse nucleo as `ide-index` does)
  - goto definition for class, interface, function and constant names, and in `use` statements

  Tests: unit tests, and a `language_smoke` php run with the engine set to Native for the structure and definition checks of class names.

## Plan 2: Types

- [x] Phase 2.1: Type model
      Add `ide_php::types::Type`:
  - scalars and literals, `array`, lists and shapes, `iterable`
  - objects with generic arguments, `static`, `self`, `$this`
  - unions, intersections and nullable types
  - `callable` and `Closure` with signatures
  - `mixed`, `never`, `void`, `class-string<T>`, template parameters

  Also add display (PHP syntax), parsing from native type hints and from PHPDoc type expressions, and subtyping and union simplification. Reuse Mago's `algebra` and `codex` type representations if they fit; otherwise write it in-house and note why. Tests: parse, display and subtyping tables.

- [x] Phase 2.2: Lazy types and resolver
      Add `LazyType`, created at summary time for unannotated returns, property defaults and constant values. Add a `Resolver` that completes lazy types against the indexes, with:
  - a cache invalidated by the modification counter
  - `visited` and `depth` guards
  - per-member union resolution
  - `mixed` as the fallback

  Tests: chains across files, cycles that end, and the cache being dropped on edit.

- [x] Phase 2.3: Class model
      Combine each class's members from its parents, interfaces and traits:
  - follow the rules for trait conflicts (`insteadof`/`as`), visibility and overriding
  - include magic `@property`/`@method` and `@mixin`
  - enums with their `cases()`, `from()` and `tryFrom()`
  - `static`/`self`/`parent` handled in context

  Tests: diamond interfaces, trait aliasing, and enum methods.

- [x] Phase 2.4: Expression types
      Infer the type of every expression, using local information and resolving lazy types when needed:
  - literals, `new`, calls (function, method, static, nullsafe)
  - property and constant access, array access and shapes
  - arithmetic and string operators, the ternary and `??` operators
  - `match`, `instanceof`, `clone`
  - closures and arrow functions with `use` captures, first-class callables

  Tests: a table of snippet → type at the caret.

- [x] Phase 2.5: Flow graph and local variables
      Build a flow graph per function or method. From it, get each variable's type at a given point:
  - assignments, list() and array destructuring, foreach key and value
  - `catch` variables, `global` and `static` variables
  - narrowing: `instanceof`, `is_*`, null checks, `assert`, early return, `??=`

  Tests: snippet tables, including loops and branches.

- [x] Phase 2.6: Generics
      Support one level of generics (no nesting needed):
  - `@template` on classes and functions, with bounds and defaults
  - `@extends`, `@implements` and `@use` binding
  - inference from arguments, including `class-string<T>`
  - generic `Traversable`, `iterable` and `array<K,V>` in `foreach`
  - `static` return types through generic parents

  Tests: the fixture's `Collection<T>`, and Laravel-style `Collection::map`.

- [x] Phase 2.7: Type providers
      Add a `TypeProvider` trait with a key, a local step that returns a type or a lazy payload, and a resolve step. Add a registry with ordering. Built-in providers:
  - core, for what the resolver already does
  - PHPUnit: `createMock(X::class)` returns `X&MockObject`, and fields assigned in `setUp` are typed

  Tests: the PHPUnit cases in the fixture.

- [x] Phase 2.8: .phpstorm.meta.php
      Read the metadata directives in any `.phpstorm.meta.php` file or directory:
  - `override` with `map`, `type` and `elementType`
  - `expectedArguments`, `expectedReturnValues`, `registerArgumentsSet` / `argumentsSet`
  - `exitPoint`

  Apply them through a provider, and expose the expected values for completion. Tests: the fixture's meta file.

- [x] Phase 2.9: Hover and goto (members and variables)
  - **Hover:** the declaration signature, the resolved type, and PHPDoc rendered as Markdown (inherited docs included).
  - **Goto definition:** members, variables (first assignment or parameter), `parent::`, `self::`, named arguments.
  - **Goto type definition.**

  Map to the IDE types in `ide_lsp::types`. Tests: unit tests, and Native `language_smoke` hover and definition checks.

- [x] Phase 2.10: Completion
      Completion is context-aware:
  - members after `->`, `?->` and `::`, filtered by visibility from the caller's context
  - variables in scope, keywords by context
  - class names from the index, with an auto-import edit
  - named arguments, `expectedArguments` values
  - array shape keys, `match` and enum cases

  Results are ranked by relevance, and documentation is resolved lazily (resolve support). Budget: p95 under 50 ms on the fixture. Tests: unit tests, and the Native `language_smoke` completion check.

- [x] Phase 2.11: Signature help and inlay hints
  - **Signature help:** for function, method and constructor calls, with the active parameter and named arguments.
  - **Inlay hints:** parameter names (skip the obvious ones, the way IDEA does) and types of variables and closure returns whose type isn't obvious, behind settings.

  Tests: unit tests and the Native `language_smoke` signature check.

- [x] Phase 2.12: Semantic tokens
      Semantic tokens: classes, interfaces, enums, functions, methods, properties, constants, parameters and variables. Modifiers: static, readonly, deprecated, declaration. Use the legend the frontend already maps (`src/editor/lsp/semantic.ts`). Tests: a golden token list.

## Plan 3: References and navigation

- [x] Phase 3.1: Find usages
  - Add a word index (identifier → files) to the redb indexes.
  - References: look up candidate files, parse and resolve each candidate, and keep the true matches (including PHPDoc type references and string class names `'App\\Foo'`, marked separately).
  - Respect `includeDeclaration`.
  - Hook into `Project::reference_candidates` if that helps.

  Tests: unit tests and the Native `language_smoke` references check.

- [x] Phase 3.2: Implementations and hierarchies
  - Goto implementation (interfaces and abstract methods, through the subclass index, transitively).
  - Type hierarchy: supertypes and subtypes.
  - Call hierarchy: incoming calls through the references, outgoing calls through the method body.

  Tests: unit tests.

- [x] Phase 3.3: Rename
  - Prepare rename and rename for variables, parameters (including named-argument call sites), properties (including promoted ones), methods across the hierarchy, classes, functions and constants.
  - Update PHPDoc and `use` statements.
  - Return a `WorkspaceEdit`.
  - A class rename that matches its PSR-4 file name also renames the file.

  Tests: unit tests and the Native `language_smoke` rename check.

- [x] Phase 3.4: Move file or class
      When a PHP file is moved or renamed inside a PSR-4 root, update its namespace and all references and imports. Use the `willRenameFiles` path in `crates/ide-host/src/ops/refactor.rs` with an engine-provided edit. Tests: an ide-host test that moves a fixture file.

- [x] Phase 3.5: Imports
  - Auto-import code action for unresolved class, function or constant names.
  - Optimize Imports: remove unused imports, sort them, and group them by kind.
  - Insert imports respecting the existing grouping style.

  Tests: unit tests, and the Native `language_smoke` auto-import and optimize-imports checks.

## Plan 4: Inspections

- [x] Phase 4.1: Inspection framework
  - An `Inspection` trait: id, default severity, a visitor over the parsed file and types, and quick-fixes producing a `WorkspaceEdit`.
  - A background run after document changes, debounced and cancellable, publishing `IdeEvent::Diagnostics { source: "php" }`.
  - Code actions return the quick-fixes that apply at a range.
  - Suppression with `/** @noinspection Id */`.
  - Syntax errors are reported from the parser.

  Tests: framework unit tests and the Native `language_smoke` diagnostic check.

- [x] Phase 4.2: Undefined symbols
      Inspections for undefined classes, interfaces, traits, functions and constants. They respect `class_exists` / `function_exists` guards and `@noinspection`. Avoid false positives on the corpora: run the comparison harness, and record the false-positive count in PROGRESS.

- [x] Phase 4.3: Undefined members
      Inspections for undefined methods, properties and class constants. They respect `__call`, `__callStatic`, `__get`, `__set`, `@method`, `@property`, `@mixin`, `stdClass`, and `mixed` receivers (no warning). Tests: unit tests, and a false-positive count on the corpora.

- [x] Phase 4.4: Variables
      Inspections for undefined, possibly undefined and unused variables, from the flow graph. Handle `compact`/`extract`, `$$var` (which turns the check off), references, `global` and `static`. Tests: unit tests.

- [x] Phase 4.5: Calls and types
  - Wrong argument count, unknown named argument, argument type mismatch, return type mismatch.
  - A property assignment that doesn't match its type.
  - The rules can be strict or lenient, the lenient default only reporting certain mismatches.

  Tests: unit tests, and a false-positive count on the corpora.

- [x] Phase 4.6: Unused code
      Inspections for unused imports, private methods, properties and constants, and unused parameters (excluding overrides and interface implementations). Tests: unit tests.

- [x] Phase 4.7: Control flow
      Inspections for unreachable code, missing return in a non-void function, `void` returning a value, and `never` returning. Tests: unit tests.

- [x] Phase 4.8: Language level and deprecation
  - Use of a feature newer than the project's PHP version: enums, readonly, match, nullsafe, first-class callables, typed class constants, and so on.
  - Use of `@deprecated` and `#[\Deprecated]` symbols, shown struck through via the diagnostic tag.

  Tests: unit tests at several language levels.

- [x] Phase 4.9: Quick-fixes
      Quick-fixes:
  - import a class or function
  - create a missing method, property or class (the class in the PSR-4 location)
  - add a return or parameter type from what's inferred
  - add or update the PHPDoc
  - make a variable defined, remove an unused import or variable

  Each one comes with a test of the before and after text.

- [x] Phase 4.10: Inspect Code and settings
  - Batch Inspect Code over a scope through the engine, next to `crates/ide-lsp/src/inspect.rs`, with the same result shape.
  - Settings › PHP › Inspections: enable or disable each inspection and set its severity, with text in `en` and `zh`.

  Tests: ide-host batch test, and frontend tests for the settings page.

## Plan 5: Formatting and refactorings

- [x] Phase 5.1: Formatting
      Document and range formatting through `mago-formatter`, with PSR-12 defaults. The options map from the editor settings (indent and line length). Tests: unit tests and the Native `language_smoke` format check.

- [x] Phase 5.2: Extract variable and constant
      `refactor.extract.variable` and `refactor.extract.constant` code actions with name suggestions; reuse the conventions of `src/editor/refactor/names.ts` on the Rust side. They hook into `src/editor/refactor/catalog.ts`. Tests: before and after text.

- [x] Phase 5.3: Extract method
      `refactor.extract.function` / method. It finds the parameters and return values from the flow graph, handles `$this` and static context, and adds the return type. Tests: before and after text, including multiple outputs (returned as an array or a list()) and early returns, which are refused.

- [x] Phase 5.4: Inline
      Inline a variable (single assignment) and inline a method or function, handling parameters and returns. Tests: before and after text.

- [x] Phase 5.5: Change signature
      Add, remove, reorder and rename parameters, change defaults, and update call sites across the hierarchy. This needs the UI the catalog already maps; check `src/editor/refactor/catalog.ts` and add a dialog if none exists (text in `en` and `zh`). Tests: before and after text, and a frontend test for the dialog.

- [x] Phase 5.6: Pull members up / push members down
      Use the existing `lsp_hierarchy_members` / `lsp_hierarchy_refactor` flow (as used for Java), with the engine as the provider for PHP classes. Tests: before and after text.

- [x] Phase 5.7: Generate code
      Implement or override methods, generate the constructor (with promoted properties as an option), getters and setters, and a PHPDoc stub. Hook these into the editor's Generate menu. Tests: before and after text.

## Plan 6: Parity gate and switch-over

- [x] Phase 6.1: Full Native smoke parity
      Every check in the php `language_smoke` case passes with `engine = Native`. Fix the gaps found. Run it both ways and record both results in PROGRESS.

- [ ] Phase 6.2: Comparison harness on the corpora
      Run `differential.rs` on laravel/framework, symfony/symfony and WordPress. Fix engine differences until it matches Intelephense or beats it (checking by hand where they disagree) on at least 98% of definition and hover samples. Commit the summary report to `docs/php-engine/differential.md`. If more fixing is needed, split it into follow-up phases.

- [ ] Phase 6.3: Performance budgets
      Criterion benches for:
  - cold index of laravel/framework under 30 s
  - warm start under 2 s
  - completion and hover p95 under 50 ms
  - diagnostics after an edit under 300 ms

  Add them to `perf/budgets.json` and the `pnpm perf:rust` runner, then optimise until they pass. Also measure memory against Intelephense.

- [ ] Phase 6.4: Switch to the native engine
      This needs a product decision (`needs-decision`): keep Intelephense as an optional fallback for one release, or remove it. If the decision isn't recorded in this paragraph, block the phase. Once decided:
  1. Default `PhpSettings.engine` to Native.
  2. Update `languages/php.toml`.
  3. Adapt `crates/ide-sdk/src/php.rs`, removing the Intelephense-only settings or keeping them for the fallback.
  4. Update the tool registry and the smoke tests.

- [ ] Phase 6.5: Documentation close-out
      Update the user docs (Settings › PHP, features) and the README's language table. Write an architecture note for contributors (`docs/php-engine/architecture.md`).

## Plan 7: Beyond Intelephense

- [ ] Phase 7.1: Laravel providers
      Type providers for:
  - facades → their underlying service (from `getFacadeAccessor` and the container bindings in service providers)
  - Eloquent: magic `where*`, query builder forwarding, relations, `@property` from casts and migrations where they're simple
  - the `app()` and `resolve()` container helpers

  Turn them on when `laravel/framework` is installed. Tests: snippets with stubs.

- [ ] Phase 7.2: Symfony providers
  - Service container `get()` typed by service id from `config/services.yaml` and autowiring.
  - Route names in `path()` and `generateUrl()`, completed and validated.
  - Doctrine repository `find*` types.

  Turn them on when `symfony/framework-bundle` is present. Tests: snippets.

- [ ] Phase 7.3: Twig
      Add a `twig` language: `languages/twig.toml`, highlighting, and outline through `mago-twig-syntax` or a tree-sitter grammar if one is better. Completion of variables, filters and functions, and goto definition for templates (`{% extends %}`, `include`). Tests: unit tests.

- [ ] Phase 7.4: Blade
      Add a `blade` language. Highlight directives and echo statements, and treat the PHP inside directives and `{{ }}` as embedded PHP using the engine's analysis. Add goto for `@include` and `@extends` views and components. Tests: unit tests.

- [ ] Phase 7.5: SQL in strings
      Highlight SQL inside PHP strings recognised by a heuristic or a `/** @lang SQL */` comment, with completion against the connected `ide-db` data source when there is one. Tests: unit tests.

- [ ] Phase 7.6: PHPStan and Psalm diagnostics
      When `phpstan` or `psalm` is in `vendor/bin`, optionally run it on save and publish its diagnostics under its own source, removing duplicates of the engine's own diagnostics. Has a settings toggle (text in `en` and `zh`). Tests: parser tests on recorded JSON output.
