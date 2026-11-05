# Mago test-drive (phase 0.5)

**Verdict: use Mago.** It parsed all 16,628 corpus files with no panics, reported errors only in the two files that are broken on purpose, and runs at about 90 MiB/s on one thread. With `recover_incomplete` on, it keeps 89% of the declarations in front of a random cut. The licences are fine, and the API covers what the next phases need. The gaps are listed under [Limits](#limits); none of them blocks the plan.

## How to reproduce

```text
scripts/php-corpus.sh
cargo run --release -p ide-php --example parse_corpus            # all corpora under PHP_CORPUS_DIR
cargo run --release -p ide-php --example parse_corpus -- fixtures/php-app
```

The example reads every `.php` file into memory first, so the timings below leave out disk reads. A counting global allocator measures the heap. Truncation is deterministic: a fixed xorshift seed picks 200 error-free files that have at least one declaration, and cuts each at a random byte offset.

The probe (`ide_php::probe::outline`) runs the parser, `mago-names`, a `Walker` that collects classes, interfaces, traits, enums, functions and methods, docblock lookup and `mago-phpdoc-syntax` on each docblock. That's roughly the per-file work of phases 1.1 to 1.4.

## Results

Run on 2026-11-05: Windows 11, 16 logical cores, release build, Mago 1.59.0. Corpora pinned by `scripts/php-corpus.sh`.

| Corpus                     |      Files |          Size |
| -------------------------- | ---------: | ------------: |
| laravel/framework v13.40.0 |      3,177 |      18.2 MiB |
| symfony/symfony v8.1.11    |     11,551 |      96.0 MiB |
| WordPress 7.1.4            |      1,900 |      22.3 MiB |
| **Total**                  | **16,628** | **136.5 MiB** |

The script reports 16,629 `.php` entries. One of them (`symfony/…/Fixtures/NotAFile/en.php`) is a directory.

| Measure                             | Result                                                                                                                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Parse only, 1 thread                | 10,858 files/s, 89.1 MiB/s (1.53 s)                                                                                                                                       |
| Parse only, 16 threads              | 46,952 files/s, 385.5 MiB/s (0.35 s)                                                                                                                                      |
| Full probe, 1 thread                | 7,725 files/s, 63.4 MiB/s (2.15 s)                                                                                                                                        |
| Peak extra heap, one file at a time | 26.7 MiB parse only; 31.6 MiB for the full probe                                                                                                                          |
| Largest file                        | `laravel-framework/tests/Validation/ValidationValidatorTest.php`: 0.5 MiB of source needs 26.7 MiB at peak                                                                |
| Panics                              | 0                                                                                                                                                                         |
| Files with parse errors             | 2: `laravel-framework/tests/Foundation/Fixtures/bad-syntax-strategy.php` and `symfony/src/Symfony/Component/Config/Tests/Fixtures/ParseError.php`, both broken on purpose |
| Declarations / resolved names       | 116,403 / 473,995                                                                                                                                                         |
| Docblocks on declarations           | 41,309, of which 312 (0.76%) have PHPDoc parse errors                                                                                                                     |

Recovery on 200 truncated files. "Expected" means declarations whose name lies wholly before the cut.

| Parser setting             |  Declarations kept | Files fully kept | Unexpected declarations | Panics |
| -------------------------- | -----------------: | ---------------: | ----------------------: | -----: |
| default                    |    2 of 789 (0.3%) |        68 of 200 |                       0 |      0 |
| `recover_incomplete: true` | 704 of 789 (89.2%) |       172 of 200 |                       0 |      0 |

Timings vary by about 15% between runs. The counts don't change.

## Limits

- **The default setting drops unfinished bodies.** Without `recover_incomplete`, a class or namespace still open at EOF disappears with everything inside it. Phase 1.1 must parse editor documents with `recover_incomplete: true`. Indexing files from disk can use the same setting; it changes nothing for complete files.
- **An unterminated block comment swallows the rest of the file.** PHP behaves the same way. If the cut lands inside `/* …` or `/** …` at member level, even the enclosing class is lost. Inside a method body only that method is lost. Most of the remaining 11% comes from this, because docblocks make up a large share of corpus bytes. Phase 1.1 or 1.3 should keep the last good summary of an open document when a new parse loses declarations that are still in the text before the first error.
- **A declaration cut inside its header is dropped.** For example `public function b(int $a` with no closing parenthesis, or `public const X =` with no value. Its name is never reported. This is acceptable: it reappears as soon as the header is complete.
- **PHPDoc gaps.** All 312 failures in the sample are `Unexpected token in PHPDoc type`. There are two causes:
  - WordPress hash notation (`@param array $x {` followed by `@type …` lines, then `}`), which is most of them.
  - Variadic callable parameters with no name, such as `callable(...mixed): mixed` (Laravel `EnumeratesValues.php:283`), which PHPStan accepts.

  Phase 1.4 must handle errors per tag: keep the tags that parse, and turn a type that fails into `mixed` (or `array` when a WordPress hash follows). It should not drop the whole docblock. Report the callable case upstream.

- **Memory.** An arena takes about 50× the source size for the largest file. For typical files it's much less, since the total peak equals the largest file's. Only open documents should keep an AST. Indexing must turn each file into owned summaries and drop the arena straight away.

## API notes for later phases

Versions are pinned exactly (`=1.59.0`) in `crates/ide-php/Cargo.toml`, because Mago changes its CST between minor releases. `ide_php::mago::*` re-exports the crates, so callers use the same versions. Every crate is `MIT OR Apache-2.0`. The new transitive crates (blink-alloc, ariadne, codespan-reporting, ordered-float, strum, yansi, unicode-width, rand) are MIT and/or Apache-2.0, which `deny.toml` allows; this was checked by hand because cargo-deny isn't installed here. `mago-interner` isn't needed, since 1.x stores identifiers as `&'arena [u8]`.

- **Arenas (`mago-allocator`).**
  - `LocalArena::new()` is `Send` but not `Sync`, and is the fastest; use one per parse.
  - `SharedArena` with `.scoped()` is for rayon workers.
  - Everything lives as long as the arena borrow: `Program<'arena>` borrows it. So a cached `ParsedFile` (phase 1.1) has to own the arena and the program together. Either use a self-referential cell (`self_cell`, MIT/Apache) or keep the source and parse again on demand, which costs about 0.1 ms for an average file. `self_cell` is the recommendation, so that one parse serves a whole request.
- **Parsing (`mago-syntax`).** `parser::parse_file_content_with_settings(&arena, file_id, bytes, ParserSettings { recover_incomplete: true, ..Default::default() })` returns `&Program`. `Program` has:
  - `statements`
  - `trivia` (comments and whitespace, in order)
  - `errors: &[ParseError]`, where each error implements `Display` and `HasSpan`
  - `source_text`
  - `has_errors()`

  `FileId::new(logical_name)` hashes a name; the engine can derive it from `DocId` or the path. `LexerSettings::enable_short_tags` defaults to true; tie it to `short_open_tag` once settings exist. `elide_detached_whitespace` saves trivia memory and keeps docblock lookups working, so it's good for indexing.

- **Spans (`mago-span`).** `Span { file_id, start: Position { offset: u32 }, end }` holds **byte** offsets, with the end exclusive. Identifiers (`LocalIdentifier { span, value: &[u8] }`) are bytes rather than `str`, because PHP source may hold any bytes. Convert them with `from_utf8_lossy` at the summary boundary. The `ide-text` UTF-16 mapping goes on top of the byte offsets.
- **Traversal.** `walker::Walker<'ast, 'arena, C>` (and `MutWalker`) has `walk_in_<node>`, `walk_<node>` and `walk_out_<node>` for every node, with a caller-owned context `C`. Override `walk_<node>` without recursing to skip a subtree, for example function bodies when only summaries are needed.
- **Names (`mago-names`).**
  - `NameResolver::new(&arena).resolve(program)` returns `ResolvedNames`, keyed by the identifier's start offset.
  - `resolve(&pos)` gives the fully qualified name as `Option<&[u8]>`, and `is_imported(&pos)` tells whether it came from a `use`.
  - `at_offset(offset)` returns `(start, end, fqn, imported)` for the name under a cursor, `iter()` walks every resolved name, and `references_to(fqn, None)` lists the spans that resolve to a given name. These are handy for go-to-definition and for local references.
  - It handles namespaces, `use`, function and const imports and aliases. Phase 1.2 should wrap it and check whether it falls back to the global namespace for functions and constants. `is_never_namespaced_function` exists for this.
- **Docblocks.** `comments::docblock::get_docblock_for_node(program, node)` returns the `/** */` trivia directly in front of a node. `mago_phpdoc_syntax::PHPDocParser::parse_with_span(&arena, trivia.value, trivia.span)` returns a `Document { elements, errors }` whose spans are file offsets. `mago_phpdoc_syntax::parse_type` parses a standalone type expression, which is useful for `.phpstorm.meta.php` and settings.
