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
  - `PhpSettings.engine` (`Native | Intelephense`) chooses between the two. It defaulted to Intelephense until phase 6.4 and defaults to Native since. The architecture as built is described in [architecture.md](architecture.md).
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
      Add `fixtures/php-library`, modelled on the other fixtures and listed in `fixtures/README.md`. It has:
  - `composer.json` with PSR-4 autoloading `App\\` → `src/` and `Tests\\` → `tests/`, and `require.php: ^8.2`
  - classes, an interface, an abstract class, a trait and an enum
  - a generic `Collection<T>` written with `@template`
  - a function file, constants
  - a `.phpstorm.meta.php` with `override` and `map`
  - `tests/` with PHPUnit tests
  - one file with a deliberate error for diagnostics

  Keep it small: about 15 files.

- [x] Phase 0.4: Intelephense baseline smoke test
      Add a `php` case to `crates/ide-host/tests/language_smoke.rs` using the existing `Checks` table: definition, references, hover, completion, diagnostic, rename (if the free tier supports it; otherwise mark it as unsupported the way other languages do), format, signature and structure, on `fixtures/php-library`. It runs with `cargo test -p ide-host --test language_smoke -- --ignored --exact php` and must pass with Intelephense installed. This is the baseline the engine has to match.

- [x] Phase 0.5: Mago test-drive and `ide-php` skeleton
  1. Create `crates/ide-php`: workspace member, `ide-core` dependency, crate docs.
  2. Add pinned Mago crate dependencies (`mago-syntax`, `mago-names`, `mago-phpdoc-syntax`, plus whichever span and interner crates they need).
  3. Add an ignored test or example, `crates/ide-php/examples/parse_corpus.rs`. It parses every `.php` file in the corpora and reports files per second, peak memory, the number of files with errors, and how well parsing recovers on 200 files cut short at random offsets.
  4. Write the results and the API notes the later phases need in `docs/php-engine/spike.md`.

  If Mago can't be used (licence, API or recovery problems), block the phase and explain why.

- [x] Phase 0.6: Comparison harness
      Add `crates/ide-php/tests/differential.rs` (ignored; needs Intelephense and the corpora). Over N sampled identifier positions in a corpus, it asks Intelephense (through `ide-lsp`) and the engine (through its public API, once that exists) for definition and hover. It writes a JSON and Markdown report of agreements and differences to `target/php-differential/`. Until the engine answers, only the Intelephense side and the report format run. Test: the report is produced on `fixtures/php-library`.

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

  Each summary is serializable with postcard and records a schema version. Tests: golden snapshots of summaries for `fixtures/php-library`.

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

- [x] Phase 6.2: Comparison harness on the corpora
      Run `differential.rs` on laravel/framework, symfony/symfony and WordPress. Fix engine differences until it matches Intelephense or beats it (checking by hand where they disagree) on at least 98% of definition and hover samples. Commit the summary report to `docs/php-engine/differential.md`. If more fixing is needed, split it into follow-up phases.

- [x] Phase 6.2.b: Close the remaining hover gaps
      Phase 6.2 left definition at 98.5% and hover at 96.8% ("matches or beats", 200 samples per corpus; see the review in `docs/php-engine/differential.md`). Fix the engine gaps listed there under Follow-ups:
  - closure and arrow function parameters typed from the callable they are passed to
  - `@phpstan-assert(-if-true|-if-false)` and the `@psalm-` variants
  - inline `/** @var T $x */`
  - the magic `@property` when the real property isn't accessible
  - array flow: by-reference aliases, `foreach` over elements, returned array-literal shapes through destructuring, templates through by-reference parameters
  - `$this->…` in anonymous classes, `match (true)` narrowing, literal types in callable signatures, superglobal definitions

  Rerun the corpora with the same seed and update `docs/php-engine/differential.md` until hover also reaches 98%. Test each fix with unit tests.

- [x] Phase 6.3: Performance budgets
      Criterion benches for:
  - cold index of laravel/framework under 30 s
  - warm start under 2 s
  - completion and hover p95 under 50 ms
  - diagnostics after an edit under 300 ms

  Add them to `perf/budgets.json` and the `pnpm perf:rust` runner, then optimise until they pass. Also measure memory against Intelephense.

- [x] Phase 6.4: Switch to the native engine
      This needed a product decision (`needs-decision`): keep Intelephense as an optional fallback, or remove it.
      **Decided (2026-11-07, by the project owner): make the native engine the default and keep Intelephense as an optional fallback.** Users can still pick Intelephense in `PhpSettings.engine`; it is no longer the default. Do not remove it.
  1. Default `PhpSettings.engine` to Native, for new and existing settings that never chose an engine.
  2. Update `languages/php.toml` so Intelephense stays available as the fallback server, used only when the engine setting selects it. Remove phpactor unless something still depends on it.
  3. Adapt `crates/ide-sdk/src/php.rs`, keeping the Intelephense settings the fallback needs.
  4. Update the tool registry and the smoke tests: the PHP smoke runs on Native by default, and a test covers switching to the Intelephense fallback.

- [x] Phase 6.5: Documentation close-out
      Update the user docs (Settings › PHP, features) and the README's language table. Write an architecture note for contributors (`docs/php-engine/architecture.md`).

## Plan 7: Beyond Intelephense

- [x] Phase 7.1: Laravel providers
      Type providers for:
  - facades → their underlying service (from `getFacadeAccessor` and the container bindings in service providers)
  - Eloquent: magic `where*`, query builder forwarding, relations, `@property` from casts and migrations where they're simple
  - the `app()` and `resolve()` container helpers

  Turn them on when `laravel/framework` is installed. Tests: snippets with stubs.

- [x] Phase 7.1.b: Laravel casts, migrations and service-provider bindings
      Phase 7.1 types facades, the container helpers with core aliases, and Eloquent forwarding, scopes, relations and accessors. What it left needs data from other files, so it needs new summary fields and an index:
  - `@property` types of models from `$casts` and `casts()` (the array values are widened in summaries today) and from simple `Schema::create` migrations (table name → model by Laravel's naming convention)
  - container bindings registered in service providers (`bind`, `singleton`, `scoped`, `instance`, `alias`) for `app('id')`, `make('id')` and facade accessors that name them
  - completion and hover for facade methods, builder forwarding and relation properties (today only the types are known)

  Tests: snippets with stubs, and summaries recording the new data.

- [x] Phase 7.1.c: Completion and hover for Laravel's magic members
      Phase 7.1.b types model attributes (casts, migrated columns), relation properties and the bindings service providers register, but only as types. Make them visible in the editor:
  - completion after `Facade::` lists the service's methods (as static), after `Model::` and on a builder or relation the builder's and query builder's methods, the model's local scopes (`active()` for `scopeActive()`) and nothing for dynamic `where*`
  - completion after `$model->` lists the relation properties, accessors, casts and migrated columns
  - hover on those members shows the forwarded method's signature and docs, or the attribute's type and where it comes from (the cast, the migration column)
  - goto definition on a cast attribute or column goes to the cast entry or the migration line (needs the locations in `LaravelFacts`)

  Tests: completion and hover fixtures with a `/*|*/` caret on the Laravel stubs of `laravel_tests.rs`.

- [x] Phase 7.2: Symfony providers
  - Service container `get()` typed by service id from `config/services.yaml` and autowiring.
  - Route names in `path()` and `generateUrl()`, completed and validated.
  - Doctrine repository `find*` types.

  Turn them on when `symfony/framework-bundle` is present. Tests: snippets.

- [x] Phase 7.2.b: Symfony services.yaml ids and route names
      Phase 7.2 types `get()` for class ids (autowiring), `getRepository()` (through the entity's `repositoryClass`) and the repository finders, all from PHP summaries. What it left needs files that aren't PHP, so it needs an index of the project's Symfony config (rebuilt on watcher batches, like the Laravel facts):
  - service ids from `config/services.yaml` (and `services_*.yaml`, imports): `id: { class: … }`, `id: '@other'` aliases, `App\Foo: ~` and resource-loaded classes, so `$container->get('mailer.default')` is typed
  - route names from `#[Route(name: …)]` attributes on controllers and from `config/routes*.yaml`: completion of the name argument of `path()`, `url()`, `generateUrl()` and `redirectToRoute()`, and an inspection for unknown names
  - repositories without generics: the entity whose mapping names the repository class (or the `parent::__construct($registry, Product::class)` of a `ServiceEntityRepository`)

  Tests: snippets with stubs and a fixture project with config files.

- [x] Phase 7.3: Twig
      Add a `twig` language: `languages/twig.toml`, highlighting, and outline through `mago-twig-syntax` or a tree-sitter grammar if one is better. Completion of variables, filters and functions, and goto definition for templates (`{% extends %}`, `include`). Tests: unit tests.

- [x] Phase 7.4: Blade
      Add a `blade` language. Highlight directives and echo statements, and treat the PHP inside directives and `{{ }}` as embedded PHP using the engine's analysis. Add goto for `@include` and `@extends` views and components. Tests: unit tests.

- [x] Phase 7.5: SQL in strings
      Highlight SQL inside PHP strings recognised by a heuristic or a `/** @lang SQL */` comment, with completion against the connected `ide-db` data source when there is one. Tests: unit tests.

- [x] Phase 7.6: PHPStan and Psalm diagnostics
      When `phpstan` or `psalm` is in `vendor/bin`, optionally run it on save and publish its diagnostics under its own source, removing duplicates of the engine's own diagnostics. Has a settings toggle (text in `en` and `zh`). Tests: parser tests on recorded JSON output.

## Plan 8: Laravel support

Runs after Plan 7. Before any 8.x phase, read [LARAVEL-ROADMAP.md](LARAVEL-ROADMAP.md): it holds the design (the Laravel project model, the string-reference framework, the reused OpenIDEA pieces, the `fixtures/laravel-app` fixture) and the clean-room rules for this plan. The feature list comes only from Laravel Idea's public documentation; never decompile or copy from Laravel Idea, PhpStorm or any closed-source product, and call the feature "Laravel support" in the product.

- [x] Phase 8.1: Laravel fixture app
      Create `fixtures/laravel-app` as described in the design, with a short README listing what each file exercises. Add `crates/ide-php/tests/laravel_app.rs`, which opens it with the engine and checks it indexes with no diagnostics except deliberate ones. Add a `laravel` case to `language_smoke` (ignored like the PHP one) that checks hover and completion on a model attribute. Tests: the new integration test.

- [x] Phase 8.2: Laravel project model
      Build `LaravelProject` (see the design):
  - detection and version
  - base paths and app namespace
  - route files and their group attributes, from `RouteServiceProvider` or `bootstrap/app.php`
  - modules, both directory-based and `nwidart/laravel-modules`

  It is stored in the index, updated from watcher batches, and exposed as `PhpEngine::laravel()`. Tests: unit tests on snippets, plus the fixture app (route files found, prefixes right, modules listed).

- [x] Phase 8.3: String reference framework
      Add `refs`, the framework from the design:
  - place patterns
  - the reference-kind trait (complete, resolve, find usages, rename, validate)
  - a lookup from the caret's string literal to its kind, which works in partial strings while typing

  Hook it into completion, goto, references, rename and document highlights. Implement it first for one kind, `configKey` (`config('app.name')`, `Config::get`, `config()->get`), with completion of nested keys segment by segment, goto to the array entry, and find usages. Tests: caret fixtures in partial and complete strings, and a pattern-matching table test.

- [x] Phase 8.4: Routes: names, actions and middleware
      Add the `routeName` kind:
  - `route()`, `to_route()`, `redirect()->route()`, `URL::route`, `Route::has`, `->name()` prefixes in groups
  - completion, goto to the `->name()` call, find usages, rename across route files and callers, and an "undefined route" inspection

  Add the `controllerAction` kind:
  - `[Controller::class, 'method']`, `'Controller@method'` and invokable controllers
  - completion, goto, and usages of controller methods counted as route references

  Add the `middleware` kind (aliases, groups, `middleware()` chains), and completion of the `only`/`except` actions in `Route::resource`.

  Tests: caret fixtures on the fixture app.

- [x] Phase 8.5: Route hints and route search
      Add these hints:
  - a code lens on controller methods listing the routes that point to them (method, URI, name)
  - an inlay hint after each `Route::get(...)` and similar call showing the full URI with group prefixes

  Clicking a lens or hint offers:
  - go to the declaration
  - copy the URL
  - open it in the browser, using `APP_URL` from `.env`
  - create an HTTP client request (`.http` file through `ide-http`)

  Add a Route Search dialog (search everywhere scope "Routes", by name or URI part). Add a setting to turn the hints off. User-visible text goes in `en.json` and `zh.json`. Tests: engine unit tests for the route table, and frontend tests for the dialog.

- [x] Phase 8.6: Views
      Add the `viewName` kind:
  - `view()`, `View::make`, `Route::view`, `@include`/`@extends`/`@each`, `return view(...)`, `markdown()` in mailables, namespaced views (`pkg::name`)
  - completion as a path tree, goto to the file, find usages from a view file, rename (moves the file and updates the strings), and an "undefined view" inspection with a "Create view" quick-fix

  Add completion of the variables passed to a view (`view('x', ['user' => …])`, `compact()`, `with()`) inside the Blade file, using the embedded PHP analysis of phase 7.4. Tests: caret fixtures, a rename test, and a quick-fix test.

- [x] Phase 8.7: Blade: layouts, sections, stacks and components
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

- [x] Phase 8.8: Config, environment, translations and assets
      Add these reference kinds, each with completion, goto and an "undefined" inspection:
  - `configKey` (finishing it from 8.3): config arrays published by packages, value types for hover
  - `envKey`: `env('…')` against `.env`/`.env.example`, with an "add missing key to .env.example" quick-fix
  - `translationKey`: `__()`, `trans()`, `trans_choice()`, `@lang`, `Lang::get`, for PHP and JSON files and all locales. Hover shows the text in each locale. Include a "Create translation key" action from PHP and Blade, which asks for the text and writes it to the chosen locale files.
  - `viteAsset`: `@vite`, `Vite::asset`, using `vite.config.*` entry points and the manifest.

  Tests: caret fixtures and quick-fix tests.

- [x] Phase 8.8.b: Create translation key dialog
      Phase 8.8 added the engine query `PhpEngine::laravel_create_translation(key, [(locale, text)])` (and `laravel_locales()`) and a quick-fix that writes a default text to every locale. Add the asking UI on top: a code action (PHP and Blade, on any `translationKey` string, known or not) running a client command that opens a dialog asking for the text per locale and which locales to write, then applies the query's edit. Expose the query as a Tauri/remote command (regenerate bindings). Dialog text in `en` and `zh`. Tests: engine test of the code action, a host test of the command, and frontend tests for the dialog.

- [x] Phase 8.9: Validation
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

- [x] Phase 8.9.b: Validation refactorings and request properties
      Phase 8.9 added the `validationRule` and `requestField` kinds (`refs/validation_rule.rs`, rules in `rules()`, `validate()`, `Validator::make`, `validator()`; rule and parameter completion; the "unknown rule" inspection; `$request->input('…')`/`validated('…')` fields) and the "convert rule string to array" intentions. Add the rest:
  - `$request->field` magic properties typed from the rules (a Form Request's `rules()`, `validate()` calls in the method)
  - the intention converting a rule to a `Rule::` object (`unique`, `exists`, `in`, `dimensions`), adding the `use`
  - **Promote to a Form Request:** move the inline rules of a controller method into a new Form Request class and inject it
  - **Generate rules:** a Generate action that adds rule entries from the model's fields

  Tests: caret fixtures and refactoring tests.

- [x] Phase 8.10: Eloquent completions everywhere
      Use the model schema (casts, migrations, accessors, relations) in these places:
  - column names in `where('…')`, `orderBy`, `select`, `pluck`, `whereIn`, `update([...])`, `create([...])` and `firstOrCreate`
  - nested relations in `with('…')`, `has`, `whereHas('…', fn($q) => …)` and `load`, where the closure's `$q` is typed with the related model, and dotted chains (`posts.comments`)
  - `$fillable`, `$guarded`, `$hidden`, `$casts` and `$appends` inside the model
  - `*_count` properties after `withCount`
  - typed collections (`Collection<Model>`) from `get()` and `all()`
  - factories: `Model::factory()->create()` returns the model, and `count(n)` returns a collection

  Add an "unknown column" inspection, only when the schema is known for certain. Tests: caret fixtures on the fixture app's models.

- [x] Phase 8.11: Live database schema
      Optionally use a connection from `ide-db` as a schema source for models, the validation rules of 8.9 and the query builder (`DB::table('…')`). The user picks the connection in Settings › PHP › Laravel. Merge it with the migration data, with the database winning and the source shown in hover. Refresh it on demand and when the database tool reports a schema change. Text goes in `en.json` and `zh.json`. Tests: an in-memory SQLite connection through `ide-db`.

- [x] Phase 8.12: Eloquent model view
      Add a panel for a model, opened from a gutter icon or code lens on the model class. It shows:
  - the table, primary key, and columns with types and where each comes from
  - relations, scopes and accessors
  - related factories, resources, policies, observers and migrations

  Clicking an item navigates, finds usages or renames. An **Add columns** button collects new columns, generates a migration for them, and adds them to `$fillable`. Frontend and engine queries, with text in `en.json` and `zh.json`. Tests: the engine query, and frontend component tests.

- [x] Phase 8.13: Code generation framework and the New Model dialog
      Add a Laravel › Generate menu and a searchable list (search everywhere scope "Laravel generators"). Generators render file templates from `src/features/templates`, which users can edit. They respect the app namespace, modules, class suffixes, constructor promotion and type hints set in Settings › PHP › Laravel › Code generation.

  Add the **New Model** dialog:
  - fields with types and modifiers
  - relations
  - indexes
  - checkboxes for a migration, factory, seeder, controller (plain, resource or API), Form Request, JSON resource and policy

  Tests: generator snapshot tests (`insta`), and a dialog component test.

- [x] Phase 8.14: The other generators
      Add generators, all on the 8.13 framework:
  - **Classes:** controller, resource controller, middleware, Form Request, JSON resource and resource collection, factory, seeder, migration (create or update a table), event, listener, job, mail, notification, observer, policy, rule, exception, HTTP exception, service provider, console command, Blade component (class and anonymous), view, view composer, broadcasting channel, enum, pivot table migration
  - **Tests:** feature tests and unit tests

  Inside a model, the Generate menu offers "JSON resource from model" and "Factory from model", which use the model's fields and relations, and "Add all fields" in `$fillable`. Tests: snapshot tests per generator.

- [x] Phase 8.15: Laravel intentions
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

- [x] Phase 8.16: Gates, policies and auth
      Add the `gate` kind:
  - `Gate::allows/denies/authorize`, `$user->can/cannot`, `@can`, `authorize()`, `can:` middleware
  - completion of abilities from gates and the matching policy's methods (by model argument)
  - goto
  - an "unknown ability" inspection

  Also cover guards (`auth('…')`) and password brokers from `config/auth.php`. Tests: caret fixtures.

- [x] Phase 8.17: Artisan
      Add an **Artisan command run configuration** with completion of command names and options from the project model (`ide-run`), plus:
  - a "Run Artisan command…" dialog listing the commands
  - a run gutter icon on console command classes
  - the `artisanCommand` kind for `Artisan::call('…')` and `$this->call('…')`

  Text goes in `en.json` and `zh.json`. Tests: the command table from the fixture, and a run-configuration test.

- [x] Phase 8.18: ide.json support
      Read `ide.json` files from the project and from `vendor/*/*/ide.json`, using the documented JSON format: completion rules with complete types and conditions, view paths, Blade components and directives, code generations, and package settings. Map them onto the string-reference framework of 8.3 and the generators of 8.13. Unknown keys are ignored with a log line. Add JSON Schema completion for the file itself, using the schema the file names in `$schema` if the JSON support already loads remote schemas, or a bundled schema the project writes itself. Tests: rule-mapping unit tests and a fixture `ide.json`.

- [x] Phase 8.18.b: ide.json code generations and schema association
      Phase 8.18 added `frameworks::laravel::ide_json` (`IdeJson` on `LaravelProject`: completion rules mapped onto the reference kinds, view paths, Blade components and directives, package settings) and a bundled schema (`IDE_JSON_SCHEMA`); `codeGenerations` entries are kept as written (`IdeJson::code_generations`) but not used yet. Add the rest:
  - **Code generations:** map each entry onto the 8.13 framework as a generator (`laravel_generators()` lists it with its `parameters` as input fields; `laravel_generate` renders its `files` from the template the entry names, relative to its `ide.json`, with the input variables, `appNamespace`, `directory`, `classSuffix`), and let the generator dialog show the custom input fields. Text in `en.json` and `zh.json`.
  - **Schema for files without `$schema`:** associate `ide.json` files with the bundled schema in the JSON support (vscode-json-language-server's `json.schemas`), so completion works without a `$schema` line. Files naming a `$schema` already get completion from it, since the JSON server loads remote schemas.

  Tests: generator snapshot tests from a fixture `ide.json` code generation, a dialog component test, and a test of the schema association.

- [x] Phase 8.19: Livewire and Inertia
      Turn these on when the package is installed:
  - **Livewire:**
    - component names in `@livewire('…')` and `<livewire:…>` tags, with attribute and property completion from the component class
    - `wire:model` and `wire:click` completion from public properties and methods
    - goto to the class or view, and a "Create Livewire component" generator
  - **Inertia:**
    - page names in `Inertia::render('…')` and `inertia('…')`, with completion and goto to the page file (Vue, React or Svelte) from configurable page directories (default `resources/js/Pages`)
    - an "undefined page" inspection with a "Create page" quick-fix

  Tests: caret fixtures with stub packages.

- [x] Phase 8.19.b: Livewire generator and the rest of Livewire
      Phase 8.19 added `frameworks::laravel::livewire` (`LivewireComponents` from the subclasses of `Livewire\Component` below `App\Livewire`, `App\Http\Livewire` and the `ide.json` namespaces, with their views), the `livewireComponent` kind (`@livewire('…')`, `Livewire::test/visit`), `<livewire:…>` tags and `wire:model`/`wire:click` values in Blade, and `frameworks::laravel::inertia` with the `inertiaPage` kind and `PhpUndefinedInertiaPage`. Add the rest:
  - a **Create Livewire component** generator on the 8.13 framework (class below the Livewire namespace and its view below `livewire/`, Livewire 3 layout), listed in the Generate menu only when Livewire is installed; text in `en.json` and `zh.json`
  - components registered with `Livewire::component('alias', Class::class)` in service providers, and completion of the keys of `@livewire('counter', [...])` from the component's properties and `mount()` parameters

  Tests: a generator snapshot test and caret fixtures with the stub package.

- [x] Phase 8.20: Laravel inspections and settings page
      Bring every Laravel inspection added in 8.4–8.19 into the inspection profile under a "Laravel" group, with on/off switches and severities, through the phase 4.10 system. Add a Settings › PHP › Laravel page for:
  - detection override
  - module system
  - hints
  - the database connection
  - code-generation options
  - Inertia page directories

  Run batch Inspect Code over the fixture app and check there are no false positives. Text goes in `en.json` and `zh.json`. Tests: an inspection batch test on the fixture, and frontend tests for the page.

- [x] Phase 8.21: Parity and performance check
      On the fixture app, plus a real Laravel application with `vendor/` when `LARAVEL_APP_DIR` is set:
  - a checklist test going through every reference kind (completion, goto, find usages, inspection) and every generator
  - performance budgets added to `perf/budgets.json`:
    - project model build on the real app under 2 s (cold) and 200 ms (warm)
    - string-reference completion under 50 ms
    - route hints for a route file under 100 ms

  Record the results in `docs/php-engine/laravel.md`, along with what is still missing compared with the feature list, as follow-up phases. Tests: the checklist test and the benches.

- [x] Phase 8.22: Incremental Laravel model
      Phase 8.21 measured the warm model build on a real application, and it misses its budget badly: Monica rebuilds its whole model after every keystroke in 1.15 s, against a 200 ms budget. Most of that time is its 57,507 translations, read again from disk (see `docs/php-engine/laravel.md`, "Real applications"). Make the model incremental:
  - Store the parts read from files in the PHP index, keyed by content hash like the file summaries:
    - configuration keys per `config/*.php`
    - translations per language file
    - views per directory
    - routes per route file
  - A watcher batch or an edit rebuilds only the parts of the files it touched.
  - Merging the parts into `LaravelModel` must not copy the large tables. Share them, for example with `Arc` per file.

  Tests:
  - Unit tests: an edit to one config file doesn't re-read the others, and deleting a language file removes its keys.
  - The `php_laravel_real/model_warm` bench on Monica (`scripts/laravel-apps.sh`, `LARAVEL_APP_DIR`) under 200 ms, and `model_cold` still under 2 s. Record both in `laravel.md`.

- [x] Phase 8.23: Package registrations and routing coverage
      Bagisto keeps most of the application in `packages/Webkul/*`. Its packages register routes, views, translations and migrations from service providers, so the model finds 0 views and only 72 routes, and the `route_hints` bench panics. Follow, in every service provider of the app and of `vendor/`:
  - `loadRoutesFrom`, `loadViewsFrom`, `loadTranslationsFrom`, `loadJsonTranslationsFrom`, `loadMigrationsFrom`, `mergeConfigFrom` and `publishes`, with package view and translation namespaces (`shop::`, `admin::`)
  - module systems that use them: `nwidart/laravel-modules` and `konekt/concord`, which Bagisto uses (count them as modules)

  Also cover the routing forms phase 8.21 listed as missing:
  - `Route::resources()`, `singleton()`, `fallback()` and `->names('prefix')`
  - the array form of `Route::group(['middleware' => …, 'prefix' => …])`
  - `aliasMiddleware` and `middlewareAliases` in providers
  - `domain()` in route hints
  - code lenses for controllers routed through module and package providers

  The `route_hints` bench picks a route file that has routes instead of assuming `routes/web.php`. Tests:
  - Unit tests on snippets.
  - Bagisto's model has views, package routes and modules.
  - The `php_laravel_real/*` benches pass on Bagisto. Record the numbers in `laravel.md`.

- [x] Phase 8.24: Usages and rename from declarations and Blade
      Make find usages and rename work in both directions:
  - from a Livewire component class or its `Livewire::component` alias, an Inertia page file and a `.env` line
  - rename of translation keys, in every locale file and caller

  Index route-name and view references inside Blade templates that aren't open, so that renaming a route also edits `{{ route('…') }}` in closed templates and find usages lists them. Run the undefined-view inspection in Blade templates. Tests: rename and usages fixtures on the fixture app.

- [x] Phase 8.25: Blade components, complete
      Complete the Blade component support:
  - class components' public properties and methods as variables in their view
  - `@aware`, `<x-slot>` / `<x-slot:name>` names, and `<x-dynamic-component>`
  - `Blade::component()`, `componentNamespace()` and `anonymousComponentPath()` registrations, and components of `vendor/` packages (namespaced `<x-pkg::…>`)
  - checking bound `:attr` values against the constructor parameter types
  - quick-fixes for template problems: create the missing component or view, and add a missing prop

  Tests: caret fixtures in Blade files, and quick-fix tests.

- [x] Phase 8.26: Auth and validation, complete
      Fix the real-application gap first: `real_app_checklist` gets no validation-rule completion on Monica. Find why, for example the rule catalogue or the place patterns not matching Monica's Form Requests, and fix it. Then add:
  - **Policies:** `#[UsePolicy]`, `Gate::guessPolicyNamesUsing`, inherited policies, and `Gate::define('x', [Policy::class, 'm'])` going to the method.
  - **`can:` abilities:** checked in the unknown-ability inspection and listed in gate usages.
  - **Inspections:** unknown-guard and unknown-broker.
  - **Validation completion:** `in:` values (from enums and constants where they're simple) and `Rule::` arguments.
  - **Generated rules:** use `Rule::enum()` for enum casts and `max:<length>` from string column lengths.

  Tests: caret fixtures, plus the Monica check in `real_app_checklist`.

- [x] Phase 8.27: Eloquent, complete
      Close the Eloquent gaps phase 8.21 listed:
  - columns of the related model in the second argument of `whereRelation`, `withSum`, `withAvg` and similar
  - `*_count` properties only after a matching `withCount`
  - the model of a raw `Builder $query` scope parameter
  - dropped and renamed columns in later migrations
  - join and alias tables in `DB::table()` chains
  - typed `Attribute::make(get: …)` accessors without `@return`

  Check the model view and the unknown-column inspection against Monica's 70 models and Bagisto's 127, and fix any false positives. Tests: caret fixtures, plus an ignored real-application inspection count recorded in `laravel.md`.

- [x] Phase 8.28: Generators and Livewire, complete
      **Generators:**
  - register what they create: observers (`#[ObservedBy]`), events and listeners, module service providers
  - pivot tables for `belongsToMany` in New Model
  - Livewire 2 paths
  - a grouped Generate submenu
  - the user's edited templates for the in-model actions
  - the `ide.json` generation features `inputFilter`/`regex`, `transformers` and `dataFile`

  **Livewire:** an unknown-parameter inspection for `@livewire(…, [...])` and `<livewire:…>` attributes.

  Tests: generator snapshot tests and inspection fixtures.

- [x] Phase 8.29: Real-application check
      Run the real-application checks on Monica and Bagisto again (`scripts/laravel-apps.sh`):
  - `real_app_checklist` passes on both
  - every `php_laravel_real/*` budget passes on both
  - batch Inspect Code over each app's own code (not `vendor/`) has no false positives in a reviewed sample of 100 diagnostics per app

  Also fix a crash risk first. In a debug build, an indexing thread overflows its default 2 MB stack on one of Bagisto's files (see `laravel.md`: the real-application tests run only with `RUST_MIN_STACK=67108864`). A stack overflow aborts the whole editor process, and a slightly deeper file could do the same in a release build. Find the file and the recursive walk that overflows. Make the walk iterative, or bound its depth (with a diagnostic past the bound), instead of only enlarging thread stacks. Add a unit test with deeply nested PHP (thousands of nested arrays, expressions and closures) that passes on a default 2 MB stack in a debug build. Then drop `RUST_MIN_STACK` from the real-application commands in `laravel.md`.
  Fix what fails. Anything too big to fix becomes a new follow-up phase right after this one. Record the final numbers and the review in `laravel.md`. Tests: the ignored real-application tests and benches. Their results go in `PROGRESS.md`.

- [x] Phase 8.29.b: Route files at computed paths
      Jetstream loads its routes with `$this->loadRoutesFrom(__DIR__.'/../routes/'.config('jetstream.stack').'.php')`. The summary keeps only paths made of literals and `__DIR__`, so Monica's `redirect()->route('profile.show')` is an undefined route (the one false positive of 8.29's review that isn't a limit of the analysis). Keep such a path with its `config('…')` parts, and fill them in from the project's configuration keys (with the call's default, else the key's value) when the route files are resolved, so a changed `config/jetstream.php` picks the other file. Tests: a provider fixture with a `config()` part in its route path, and `real_app_inspect_code` on Monica without `PhpUndefinedRoute` for `profile.show`.

- [x] Phase 8.30: Documentation
      Add a user guide, `docs/php-engine/laravel.md`, finishing the file started in 8.21 and extended up to 8.29. It covers each feature with a short example, the settings, `ide.json` support, and known limits. Update `THIRD_PARTY_LICENSES.md` if a phase bundled anything new (for example Laravel stubs). Tests: none beyond the usual gate.

- [x] Phase 8.31: Undefined controller actions and "Create controller"
      Reported from the running app: in `Route::get('123', 'dream')->name('dream.come.true')`, Alt+Enter on `'dream'` offers nothing. The `controllerAction` kind (`refs/controller_action.rs`) has completion, goto and usages, but no `undefined()` hook, so there is no inspection and no quick-fix. Add `PhpUndefinedController`, in the Laravel inspection group with en/zh text, through `ReferenceKind::undefined` like `PhpUndefinedView`. It reports:
  - **a missing class:** in `'Foo@bar'`, `[Foo::class, 'bar']` (only when the undefined-class inspection doesn't already report the same range) and a plain `'Foo'` action, which Laravel resolves as an invokable controller class under the group's namespace. A plain string that is no class at all, like `'dream'`, gets "Controller class 'dream' does not exist".
  - **a missing method:** in `'Foo@bar'` and `[Foo::class, 'bar']`. A plain `'Foo'` action needs `__invoke`.

  Quick-fixes, all through the code generation framework of 8.13/8.14:
  - Their output respects the app namespace, controller suffix, modules and the user's edited `controller.php.ft` template.
  - Each returns a `WorkspaceEdit` that creates the file and rewrites the route string when the class name changes. Each opens the new class at the method.

  The fixes:
  - **"Create controller 'FooController' with method 'bar'".**
  - **For a plain action:** "Create invokable controller …". For a lowercase non-class string like `'dream'`, it proposes `DreamController` and rewrites the action to `DreamController::class`.
  - **"Add method 'bar' to Foo"** for a missing method: public, with a `Request $request` parameter and route parameters from the URI (`{id}` becomes `$id`).
  - **"Convert to [Controller::class, 'method']"** on string actions whose class exists. It reuses the 8.15 intention.

  Tests:
  - Caret fixtures for each case, with the generated file compared as a snapshot.
  - A host test: Alt+Enter code actions on the fixture app's route file list the fixes, and applying one creates the controller.
  - No new diagnostics in `fixtures/laravel-app`, nor in Monica's or Bagisto's routes (`real_app_checklist`).

- [x] Phase 8.31.b: Open the created controller at its method
      Phase 8.31's "Create controller …" and "Add method …" quick-fixes return plain `WorkspaceEdit`s, and the front end opens nothing after applying a quick-fix's edit (`runInteractiveCodeAction` only opens files a command reports created). Let a code action name the location to open after its edit (for example an optional `open: Location` on `CodeAction`, filled by the PHP engine's quick-fixes and kept through `lsp_execute_code_action`), and open the new or edited controller with the caret in the new method's body. Run `pnpm gen:bindings` for the changed type. Tests: an engine test that the fixes carry the method's location, a host test that applying one returns it, and a frontend test that `applyCodeAction` opens it.

## Plan 9: Hardening

The gaps that the follow-ups in `PROGRESS.md`, the review in `differential.md` and the known limits in `laravel.md` left after Plans 0–8, most important first: safety of refactorings, type inference that real Laravel code depends on, speed, the remaining Laravel gaps and fuller refactorings. The same rules apply. Every phase re-checks the corpora or the real applications it touches (`scripts/php-corpus.sh`, `scripts/laravel-apps.sh`) and records numbers in the document it names.

- [x] Phase 9.1: Safe rename
      Rename (`navigate::rename`, phase 3.3) applies edits without checking that the new name is free. Add conflict checks, reported in `prepare_rename` or as a refusal with the reason (en/zh text):
  - a method, property or constant of that name already in the class, its parents, children or used traits, with the right visibility
  - a class, function or constant of that name already in the namespace
  - an import in an affected file that already uses the short name, which is resolved by writing the name fully qualified there
  - a variable of that name already in scope

  Also:
  - Find and rename `define('X', …)` constants.
  - List dynamic uses that can't be renamed safely (`$o->$m`, `$f()`, `call_user_func('f')`, string callables) as "possible usages", without editing them.
  - Scope the docblock `$name` scan to the function's own docblocks, not nested closures.

  Tests: a fixture per conflict, define constants, dynamic uses, a nested closure with a same-named variable.

- [x] Phase 9.1.b: Rename of define() constants and possible usages
      What 9.1 left (it did the conflict checks and the docblock scoping):
  - Find and rename `define('X', …)` constants: the name inside the string literal (without its quotes) at the declaration, `X` and `\X` uses, `defined('X')` and `constant('X')` strings; with 9.1's conflict check against existing constants.
  - List dynamic uses that can't be renamed safely (`$o->$m`, `$f()`, `call_user_func('f')`, string callables like `'f'` or `[$o, 'm']` passed where a callable is expected) as "possible usages", without editing them. Rename's result gets them (a new optional field next to `incomplete`, bindings regenerated), and the front end shows them in the rename preview as a warning (en/zh text).
  - A trait method's conflict check also looks at the classes using the trait (9.1 checks the trait, the classes declaring the member and their subclasses).

  Tests: a fixture renaming a `define()` constant from its declaration and from a use, a fixture per kind of dynamic use, a host test that the rename result carries them, and a frontend test that the preview shows them.

- [x] Phase 9.2: Closure parameters and array flow
      Close the type-inference gaps listed under "Follow-ups" in `docs/php-engine/differential.md`:
  - **Closure parameters:** typed from an expected callable whose type names a method template. In `whereHas('posts', function ($query) …)`, `Closure(Builder<TRelatedModel>)` binds `TRelatedModel` to its bound, or better to the relation's model when the provider knows it. This is the most common untyped variable in Laravel code.
  - **By-reference aliases:** `$x = &$a['k']`.
  - **`foreach` over array elements written earlier.**
  - **Shapes through destructuring:** `[$a, $b] = $this->f()`.
  - **By-reference templates:** `reset()`/`end()` style `@meta` templates bound through by-reference parameters.
  - **`$this` in anonymous classes.**
  - **Literal types inside callable signatures.**
  - **Inaccessible properties:** the magic `@property` wins for goto and hover when the real property isn't accessible from the caller.

  Run the comparison harness on the three corpora again. Hover must not drop below 98.1% or definition below 98.5%, and the new numbers go in `differential.md`. Tests: caret fixtures per case.

- [x] Phase 9.2.b: Inaccessible properties and the corpus rerun
      What 9.2 left (it did the closure parameters, the array flow, `$this` in anonymous classes and literal callable parameters):
  - **Inaccessible properties:** the magic `@property` wins for goto and hover when the real property isn't accessible from the caller (Symfony's `FileValidator` `$maxSize`, SimplePie's `$scheme`).
  - **Closures passed to forwarded static calls:** `Post::whereHas('x', fn ($q) …)` goes through `Model::__callStatic`, so no signature binds the closure's parameter when the relation isn't known (the builder's `whereHas` does).
  - Run the comparison harness on the three corpora again with 9.2's changes. Hover must not drop below 98.1% or definition below 98.5%, and the new numbers go in `differential.md`, with the 9.2 gaps that closed taken off its Follow-ups.

  Tests: caret fixtures for goto and hover on a protected property with a `@property` tag, from outside and inside the class.

- [x] Phase 9.3: Type operators and mixins
      The type model approximates (`PROGRESS.md` 2.1/2.6):
  - `key-of`/`value-of`
  - indexed access `T[K]`
  - `int-mask`
  - object shapes
  - conditional return types (`($x is string ? A : B)`)
  - type aliases (`@phpstan-type`, `@psalm-type`, `@phpstan-import-type`)
  - `@mixin Foo<T>` arguments
  - `@template` on closures

  Evaluate them where their arguments are known. Keep the current widening when they aren't. Check against the corpora as in 9.2 and record the change. Tests: type unit tests and caret fixtures.

- [x] Phase 9.3.b: Closure templates and alias leftovers
      What 9.3 left (it did `key-of`/`value-of`, `T[K]`, `int-mask`, object shapes, conditional return types, type aliases in member types and parameters, and `@mixin Foo<T>` arguments):
  - **`@template` on closures:** a closure's own docblock (`@template T`, `@param T $x`, `@return T`) gives its `Closure` type template parameters, bound when it is called (`$f(1)` is `int`) or passed where a callable is expected.
  - **Type aliases in inline `@var` tags** inside a class's methods (`/** @var Row $row */`), which still read the alias name as a class.
  - **Object shape completion:** `obj()->` lists an `object{…}` type's properties, and goto/hover on them answer.

  Tests: caret fixtures per case.

- [x] Phase 9.4: Speed: cold model and Inspect Code
      Two speed items:
  - **Monica's cold model build** rose from 358 ms (8.23) to 542 ms (8.29), and nobody looked into why. Profile it, fix what regressed, and store the per-file Laravel model parts of 8.22 in the index database (keyed by content hash), so a new session doesn't rebuild them.
  - **Inspect Code** checks engine files one after another on a single blocking thread (4.10). Run it in parallel (rayon, respecting `CancellationToken`), with progress.

  Add budgets to `perf/budgets.json`:
  - cold model on Monica under 400 ms
  - a warm start under 150 ms with stored parts
  - Inspect Code over Monica's own code under 20 s in a release build

  Record the numbers in `laravel.md` and `performance.md`.

- [x] Phase 9.4.b: Inspect Code scaling
      What 9.4 left (it fixed the cold model, stored the model's parts in the index database and made Inspect Code parallel): Inspect Code over Monica's own code takes 24.3 s in a release build (74 s one file after another), over the 20 s budget. The work has no long tail (the slowest file takes 0.7 s) but scales only about 3× on 16 threads (2.4× on 4), so something shared serializes it: find it with a profiler (candidates: the index database's read transaction per declaration lookup, `FileSummary` decoding of the same summaries in every thread, the allocator, the locks on open documents and stubs), fix it, and record the numbers in `laravel.md` and `performance.md`. Tests: `real_app_inspect_code` still finds the same diagnostics in parallel and one by one; `php_laravel_real/inspect_code` within its budget.

- [x] Phase 9.5: Laravel gaps
      From "Known limits" in `laravel.md`:
  - **Artisan:**
    - an "unknown Artisan command" inspection, only when `vendor/` is present so package commands are known
    - completion of option keys in `Artisan::call('x', ['--opt' => …])`
  - **Livewire:** renaming a component class or alias edits `<livewire:…>` tags and `@livewire(…)` names. Discovered (unaliased) names can be renamed.
  - **Views:** variables passed to a template are carried through nested `@include` and to `@each`'s item variable.
  - **Eloquent:** `*_count` properties follow the query that loaded the model (flow-sensitive), not project-wide `withCount` calls.
  - **Translations:** find usages starting from a JSON locale file.
  - **Blade components:** an "add constructor parameter" quick-fix for class components, and `@aware` completion from the parent.

  Tests: caret, rename and inspection fixtures, plus `real_app_checklist` on Monica and Bagisto with no new false positives.

- [x] Phase 9.5.b: Laravel gaps, the rest
      What 9.5 left (it did the Artisan items: `PhpUnknownArtisanCommand` with `vendor/` installed, and the `artisanOption` kind for the keys of `Artisan::call('x', ['--opt' => …])`):
  - **Livewire:** renaming a component class or alias edits `<livewire:…>` tags and `@livewire(…)` names. Discovered (unaliased) names can be renamed.
  - **Views:** variables passed to a template are carried through nested `@include` and to `@each`'s item variable.
  - **Eloquent:** `*_count` properties follow the query that loaded the model (flow-sensitive), not project-wide `withCount` calls.
  - **Translations:** find usages starting from a JSON locale file.
  - **Blade components:** an "add constructor parameter" quick-fix for class components, and `@aware` completion from the parent.

  Tests: caret, rename and inspection fixtures, plus `real_app_checklist` on Monica and Bagisto with no new false positives.

- [x] Phase 9.5.c: Laravel gaps, views, Eloquent and components
      What 9.5.b left (it did the Livewire rename both ways and find usages and rename from JSON locale files):
  - **Views:** variables passed to a template are carried through nested `@include` and to `@each`'s item variable.
  - **Eloquent:** `*_count` properties follow the query that loaded the model (flow-sensitive), not project-wide `withCount` calls.
  - **Blade components:** an "add constructor parameter" quick-fix for class components, and `@aware` completion from the parent.
  - **Livewire in Blade:** rename starting from a `<livewire:…>` tag or `@livewire('…')` in a template (the Blade service answers no rename yet).

  Tests: caret, rename and inspection fixtures, plus `real_app_checklist` on Monica and Bagisto with no new false positives.

- [x] Phase 9.5.d: Laravel gaps, Eloquent, components and Livewire in Blade
      What 9.5.c left (it carried view variables through nested `@include` and to `@each`'s item):
  - **Eloquent:** `*_count` properties follow the query that loaded the model (flow-sensitive), not project-wide `withCount` calls.
  - **Blade components:** an "add constructor parameter" quick-fix for class components, and `@aware` completion from the parent (the `@props` of the components whose tags enclose this one's in some template).
  - **Livewire in Blade:** rename starting from a `<livewire:…>` tag or `@livewire('…')` in a template (the Blade service answers no rename yet).

  Tests: caret, rename and inspection fixtures, plus `real_app_checklist` on Monica and Bagisto with no new false positives.

- [x] Phase 9.5.e: Laravel gaps, Eloquent and components
      What 9.5.d left (it did rename from Blade templates: `<livewire:…>` tag names and the string references of the template's PHP, `@livewire('…')` among them):
  - **Eloquent:** `*_count` properties follow the query that loaded the model (flow-sensitive), not project-wide `withCount` calls.
  - **Blade components:** an "add constructor parameter" quick-fix for class components, and `@aware` completion from the parent (the `@props` of the components whose tags enclose this one's in some template).

  Tests: caret and inspection fixtures, plus `real_app_checklist` on Monica and Bagisto with no new false positives.

- [x] Phase 9.6: Extract method and inline, complete
      Extract method (5.3):
  - a dialog (frontend, en/zh) for name, parameters (rename, reorder, include or exclude), visibility, static and return type, built on an engine query in the style of the other refactoring dialogs
  - detection of duplicates of the extracted code in the class, with an option to replace them
  - closures and arrow functions as the enclosing scope

  Inline (5.4): "inline all usages and remove the declaration" for variables, methods and functions, and inlining inside closures. Tests: refactoring fixtures, plus frontend dialog tests.

- [x] Phase 9.7: Change signature, move class and generate, complete
      **Change signature (5.5):**
  - update callable strings and arrays (`'f'`, `[$o, 'm']`, `[Foo::class, 'm']`), `new static`/`new self` and `$this->__construct()`
  - reorder, add and remove `@param` lines
  - visibility and name in the dialog

  **Move class:** move one class out of a file that holds several into its own PSR-4 file, and check that the new path matches the class name.

  **Generate (5.7):**
  - a member chooser dialog for getters/setters, constructor and overrides
  - `__toString` and equals generators
  - accessors of untyped properties take their `@var` type

  Tests: refactoring and generator snapshot fixtures, plus frontend tests.

- [x] Phase 9.8: Final verification
      Run the checks that Plans 1–8 deferred, and fix what they find:
  - `cargo nextest run --workspace`
  - every ignored PHP test that the corpora and apps allow (`language_smoke php`, the comparison harness, `real_app_checklist`, the memory comparison)
  - `pnpm test`, `pnpm e2e` for PHP flows if they exist, and `pnpm perf:rust`

  Failures that come from this machine's `core.autocrlf` (`known-failures.txt`) are reported, not fixed here. Anything too large to fix becomes a follow-up phase. Record the results in `PROGRESS.md` and in a short "Status" section at the top of `laravel.md` and `performance.md`.

- [x] Phase 9.8.b: Monica's warm model start
      What 9.8 left (it ran every deferred check and fixed what they found: PHPDoc parses mapping a 64 MB stack segment on request threads, Symfony container ids matched to classes ignoring case, and three Rust results that depended on serde_json's `preserve_order`): `php_laravel_real/model_warm_start` takes 155 ms on Monica, over its 150 ms budget (129 ms in 9.4). Find what grew since 9.4 (the stored model parts' decoding, the parts that are rebuilt, the summaries' schema 22), fix it, and record the number in `laravel.md` and `performance.md`. Tests: `pnpm perf:rust --package ide-php` with `LARAVEL_APP_DIR` on Monica within budget, and `real_app_checklist` unchanged.
