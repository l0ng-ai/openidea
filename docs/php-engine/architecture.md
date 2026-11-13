# PHP engine architecture

A guide for contributors to the built-in PHP engine, `crates/ide-php`. It was
built phase by phase along the [roadmap](ROADMAP.md); the roadmap's design
section says why, this note says where things are. The user-facing side is in
[docs/php.md](../php.md).

The engine is clean-room. Its design inputs were public documentation (the
IntelliJ Platform SDK pages on PSI stubs, indexes and type providers, PhpStorm's
advanced metadata, the PHPStan and Psalm type docs) and open-source code with
compatible licences. Don't read or copy closed-source products
([RULES.md](RULES.md)).

## The request path

```
frontend ── IPC ──▶ ide-host ops/lsp.rs ──▶ LanguageService (php.rs: PhpService) ──▶ PhpEngine
                                       └──▶ LspManager (when the service says "not handled")
```

- `crates/ide-host/src/language_service.rs` defines `LanguageService`: one
  method per `LspManager` feature `ops/lsp.rs` uses, each returning an
  `Answer` that defaults to "not handled". `ops/lsp.rs` asks the service
  registered for the document's language first and falls back to LSP. Local and
  remote development go through the same path, so the frontend and IPC don't
  know which one answered.
- `crates/ide-host/src/php.rs` adapts the engine to that trait (`PhpService`)
  and converts its results to the `ide-lsp` types the frontend already renders.
  `PhpEngineSlot` holds the project's `PhpEngine` while
  `PhpSettings.engine == Native` (the default) and starts or stops it when the
  setting changes. `PhpObserver` forwards open documents, `files_changed`
  forwards watcher batches, and `IndexStates` merges the engine's dumb mode
  with the project index's.
- `crates/ide-host/src/twig.rs` registers `TwigService` for `twig`. It needs
  no engine: `ide_php::twig` answers the outline, completion and template
  goto from the open document's text and the project's template directories.
- `crates/ide-host/src/blade.rs` registers `BladeService` for `blade`
  (`*.blade.php`). Directive completion and view/component goto need no
  engine. For the PHP inside echoes, directives and `@php` blocks it asks the
  engine: `ide_php::blade::compile` turns the view into PHP with an offset
  map, `PhpEngine::embedded_document` holds it under the view's id (never
  inspected, ignored by `document_changed`), and the `blade_*` methods map
  positions in and answers out. `PhpObserver` drops it when the view closes.
- `crates/ide-host/src/php_analyzers.rs` runs PHPStan and Psalm from the
  project's `vendor/bin` on each saved PHP file of a trusted project when
  `PhpSettings.analyzers_on_save` is on, and publishes their problems under
  the sources `phpstan` and `psalm`. `ide_php::analyzers` detects the tools,
  parses their JSON reports and drops the problems the engine's latest
  inspection of the file already reports.
- With `Intelephense` selected, the slot is empty, the service answers
  nothing, and `ide_sdk::apply::language_servers` starts the server from
  `languages/php.toml`. Only one of the two runs at a time.
- Batch Inspect Code (`crates/ide-host/src/ops/analysis.rs`) and the
  refactorings with their own commands (`ops/refactor.rs`: file moves, change
  signature, pull up/push down) call the engine directly.

Coordinates at the crate edge are 0-based lines and UTF-16 columns
(`ide-core::text`). Mago works in byte offsets; `syntax::LineIndex` converts.

## Layers

From the bottom up. Each module's `//!` header is the detailed reference.

| Module                                          | What it holds                                                                                                                                                                                                                                                     |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `syntax`                                        | `ParsedFile` (Mago AST, errors, `LineIndex`) and the parse cache keyed by `(DocId, version)`. Mago is pinned and re-exported as `ide_php::mago`.                                                                                                                  |
| `names`                                         | PHP name resolution: namespaces, `use` (function, const, grouped), aliases, the global fallback for functions and constants, `self`/`static`/`parent` markers.                                                                                                    |
| `summary`                                       | `FileSummary`: what other files can see of one file (class-likes with members and signatures, functions, constants, PHPDoc as unresolved type expressions, ranges). Serialized with postcard and stamped with `SCHEMA_VERSION`; golden snapshots in `snapshots/`. |
| `project`                                       | `ProjectLayout`: which files belong to the project (the folder minus excludes, Composer autoload and `installed.json`, include paths) and the PSR-4/PSR-0 `AutoloadMap`.                                                                                          |
| `index`                                         | `PhpIndex`: one redb database in the project cache folder. Summaries by content hash, FQN, short name, direct subclasses, namespace children, `.phpstorm.meta.php` files and a word index for find usages. Built in parallel, updated per changed file.           |
| `stubs`                                         | `BundledStubs`: phpstorm-stubs, checked in as `stubs/phpstorm-stubs.zip` and embedded; summarised once per process and filtered per project by PHP version and stub sets (`StubFilter`).                                                                          |
| `engine`                                        | `PhpEngine`: the worker thread that keeps the index up to date, dumb-mode and readiness events, open documents as overlays on the disk, and the modification counter.                                                                                             |
| `types`                                         | The `Type` model and PHPDoc parsing, `LazyType` and the `Resolver` (with its cache), `ClassModel` (own and inherited members), expression types and the per-function flow graph (`types/expr/flow.rs`), and `TypeProvider`s.                                      |
| `meta`                                          | `.phpstorm.meta.php`: return-type overrides and exit points (through a type provider), expected arguments for completion.                                                                                                                                         |
| `complete`, `signature`, `semantic`, `navigate` | Completion; signature help and inlay hints; semantic tokens; symbols, definition, hover, references, hierarchies, rename and file moves.                                                                                                                          |
| `imports`, `format`                             | Auto-import, Optimize Imports, `use` insertion; Reformat Code through `mago-formatter`.                                                                                                                                                                           |
| `inspect`                                       | The `Inspection` trait, the built-in checks, `@noinspection`, quick-fixes and intentions, the debounced background `runner` that publishes `IdeEvent::Diagnostics { source: "php" }`, and `inspect_file` for Inspect Code.                                        |
| `refactor`                                      | Extract variable/constant/method, inline, change signature, pull up/push down, generate code. Edits are `ide-workspace` `WorkspaceEdit`s.                                                                                                                         |

### Types in two phases

At index time a summary can't look at other files, so any type that depends on
one is stored as a `LazyType` (`FnReturn("\foo")`, `MethodReturn { recv, name }`,
an unannotated return inferred from the body, …). At request time the `Resolver`
completes it against the indexes, member by member for unions, with `visited`
and `depth` guards against cycles. Resolved types and class models are cached
until the engine's modification counter moves: every document edit and watcher
batch bumps it.

Variable types come from the flow graph of the enclosing function: assignments,
narrowing (`instanceof`, `is_*`, null and `false` checks, `assert`, `match
(true)`, `@phpstan-assert`), inline `@var`, by-reference arguments, and closure
parameters typed from the callable they're passed to. The same `ExprTypes` is
shared by every inspection of one run.

### Type providers

`types::provider::TypeProvider` lets a framework add types without touching the
core: a key, local steps for a call site or an untyped property (`call`,
`property`, which return a `LazyType::Provided` payload) and a resolve step
(`resolve`, with the indexes). PHPUnit test doubles, `setUp()` fields and
`.phpstorm.meta.php` are built in; Laravel and Symfony are next on the roadmap
(plan 7). Register a new provider in `TypeProviders::default`.

### Pest

`$this` in the closures of a Pest test file (`test()`, `it()`, `todo()`,
`beforeEach()`, `afterEach()`, and the closures of `describe()` blocks, through
chained calls) is the test case Pest binds them to, with that class's member
access: the first class (not trait) of the file's own `uses(…)`, else of the
`uses(…)->in(…)` or `pest()->extend(…)->use(…)->in(…)` whose folder (relative
to the configuring file, usually `tests/Pest.php`) holds the file most
closely, else PHPUnit's `TestCase`. The calls are indexed as Laravel facts
(`PestUses`); `ExprTypes::at_path` gives the analysis the file's path, which
the editor features, Inspect Code and Find Usages pass.

Custom expectations (`expect()->extend('toBeX', function (…) { … })`) are
indexed as macros of `Pest\Expectation` returning the expectation, and `$this`
in their closure is the expectation. A property of `$this` the test case
doesn't declare has the type the file's `beforeEach()` closures assign to it
(`$this->manager = app(Manager::class);`, also inside `describe()` blocks).
Higher-order expectations work through the PHPUnit provider: a method of the
expected value called on the expectation (`expect($order)->canRefund()`)
resolves to the value's method and stays an expectation, and so does a
property of the value (`->state->toBe(…)`, without the value's type from
then on). `test()` without arguments is the test case of the file
(`test()->createProduct()` in a helper function). Not done: members the
`uses()` traits add beyond the test case class.

### What nothing declares

These rules type code that carries no declaration, each from the code around
it. The first three are inference every feature uses, inspections included;
the last three are guesses only what the editor shows uses
(`ExprTypes::with_call_sites`):

- **An untyped property** (no hint, no `@var`) has the union of what the
  methods of its class assign to it, when that is at most four different
  things and none of them unknown (`CoreProvider::property`; a test case's
  `setUp()` assignments come first, through the PHPUnit provider). The type
  is stored in the summary as the property's default type. Elements count
  too: `$this->items[] = $item;` and `$this->byName[$key] = $item;` make it a
  list (an array) of what is added, and refine a property declared no more
  than `array` (the hint, or `@var array`); a documented element type wins.
- **A method declared a bare container** (`: array`, or a class whose name
  ends in `Collection`) without a `@return` returns what its body does, when
  that is the same container with its element types
  (`Resolver::refines_container`). The extractor stores the body's type for
  these as it does for a method without a return type.
- **`$this` in a trait** is also an object of the classes using the trait
  (`Resolver::trait_hosts`: up to three, in name order), as an intersection,
  so what the trait expects of its host resolves. The index's subclass table
  records trait uses for this.
- **`$this` in an anonymous class**, which no summary holds, reaches the
  members the class declares (read from the syntax tree, in the file) and
  those of the class it extends, for Go to Declaration and hover; not for
  completion, Find Usages or Rename.
- **An untyped parameter** (no hint, no `@param`, nothing from the method it
  overrides or from a provider) takes the types its callers pass, when
  the analysis asks for it: `ExprTypes::with_call_sites`, which completion,
  `at_caret` (hover, Go to Declaration, the subject of Find Usages) and
  signature help turn on. **Inspections, semantic tokens, inlay hints and
  the references scan never do:** the type is a guess (a caller may be
  missing or wrong), and the whole-file passes would read other files on
  every edit. The callers are the calls of the method on `$this`, `self::`,
  `static::`, `parent::` or a receiver typed with the class or a subclass
  (`types::expr::call_site_arguments`, which finds them by the method's name
  in the text and types them with the file's own `ExprTypes`): in the file
  itself; for a method that isn't private, in the files of the class and
  its subclasses; for a public one, also in the indexed files containing the
  method's name when they are few (`Declarations::call_site_types`, at most
  16 files in all, cached per modification count). Unknown arguments are
  left out; one to four different types make the union, more make nothing;
  a caller whose argument is itself an untyped parameter is followed three
  levels deep. Hover adds where the type comes from. A parameter declared
  `object` is refined the same way, and one declared a bare container when
  every caller passes that container with its elements. Not done: free
  functions, and methods called from more files than the cap.
- **A method call nothing types** (no return type, no `@return`, and the
  index-time inference of the body gave up, often because the result
  depends on an untyped parameter) is typed from the body with the full
  analysis: `ExprTypes::body_return`, in the file itself or, through
  `Declarations::body_return`, in the file declaring the class (parsed on
  demand, cached per modification count). A call on a receiver already
  found unknown isn't asked again, which keeps long chains linear.

## Threads and cancellation

- Indexing runs on the engine's worker thread and rayon. It can be cancelled
  and reports `IdeEvent::IndexState` while it runs. The engine also reports
  itself as a language server (`starting` → `busy` → `ready`) so the frontend's
  availability logic (`src/editor/lsp/availability.ts`) treats it like one.
- Requests run on the host's blocking pool, never on a Tauri command thread, and
  take a `CancellationToken` where the work is large (references, rename,
  workspace symbols, implementations).
- Background inspections wait 120 ms after the last change to a document; a
  newer change cancels the run in progress.

## Adding to the engine

- **An inspection:** implement `inspect::Inspection` in the module of its family,
  register it in `Inspections::builtin`, and add it to `PHP_INSPECTIONS` in
  `src/platform/phpInspections.ts`, which the settings pages list (its name and
  description in `en` and `zh`). Write unit tests with an inline fixture and a `/*|*/`
  caret, plus a before/after test for each quick-fix.
- **A feature of an existing request:** change the engine module, then the
  conversion in `ide-host/src/php.rs` if the result shape changed.
- **A new request:** add the method to `LanguageService` with a "not handled"
  default, call it from `ops/lsp.rs` before the LSP path, and implement it in
  `PhpService`.
- **A summary field:** bump `summary::SCHEMA_VERSION` (old indexes are then
  rebuilt) and update the golden snapshots.

## Testing and measuring

- Unit tests sit next to each module (`tests.rs`, `*_tests.rs`):
  `cargo nextest run -p ide-php` or `cargo test -p ide-php`.
- `crates/ide-host/tests/language_smoke.rs`: `php_native` runs the full smoke
  table on `fixtures/php-app` with the engine; the ignored `php` case runs it on
  the Intelephense fallback.
- `crates/ide-php/tests/differential.rs` (ignored; needs Intelephense and the
  corpora from `scripts/php-corpus.sh`) compares definition and hover with
  Intelephense. The last report is in [differential.md](differential.md).
- `crates/ide-php/benches/engine.rs` holds the performance budgets, run by
  `pnpm perf:rust` against `perf/budgets.json`; see
  [performance.md](performance.md). `tests/memory.rs` compares memory with
  Intelephense.
- `examples/parse_corpus.rs` measures the parser on the corpora
  ([spike.md](spike.md)).
