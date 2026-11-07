# Native engine vs Intelephense: differential report

Phase 6.2 ran `crates/ide-php/tests/differential.rs` on the three corpora and on `fixtures/php-app`. This is the summary; the full per-sample reports are written to `target/php-differential/<name>.{md,json}` by each run.

```text
cargo test -p ide-php --test differential -- --ignored --exact fixture
PHP_DIFF_CORPUS=laravel-framework cargo test -p ide-php --test differential -- --ignored --exact corpus
```

Setup: 2026-11-07, Intelephense 1.18.5 (unlicensed), engine at this commit, PHP 8.5 stubs with every extension set, seed 1592590342, 200 identifier positions per project sampled uniformly from all names and variables (`PHP_DIFF_SAMPLES`, `PHP_DIFF_SEED`). The corpora are the pinned tags of `scripts/php-corpus.sh` (laravel/framework v13.40.0, symfony v8.1.11, WordPress 7.1.4), without `vendor/`.

## How answers are compared

- **Definition:** the engine agrees when it names some of the lines of the same files Intelephense names. Intelephense answers the class name in `new Foo(…)` with both the class and its constructor, and the engine, like PhpStorm's Ctrl+Click on the class name, gives the class. Targets outside the project root are built-ins: the two sides bundle different stub files (Intelephense's own and phpstorm-stubs), so built-ins agree when both go to a stub.
- **Hover:** the two sides format hovers differently, so the harness reads what each hover is about (`HoverKey`):
  - a declaration, by qualified name (`App\Foo::bar`, `App\Foo::$p`, case-insensitive);
  - or a variable or parameter, by name and type.

  Types are compared after normalization:
  - leading `\` removed, sorted unions, `?T` as `T|null`;
  - every array type as `array`;
  - refinements as their base type (`non-negative-int` → `int`, `non-empty-string` → `string`, `array-key` → `int|string`);
  - a lone `true`/`false` as `bool`, and `mixed|null` as `mixed`;
  - parameter names inside callable signatures dropped.

- **Agreement** counts the positions where both sides answered and at least one found something. Positions where neither found anything (keywords such as `string` in a hint, namespace segments, `declare` names) are left out.

## Results

Raw agreement is what the harness computes. "Matches or beats" adds the differences that were checked by hand and where the engine's answer is right and Intelephense's is missing or wrong. Each difference is listed in the review below.

| Project           | Query          | Agree | Differ | Only Intelephense | Only engine | Raw agreement |                                                                 Matches or beats |
| ----------------- | -------------- | ----: | -----: | ----------------: | ----------: | ------------: | -------------------------------------------------------------------------------: |
| php-app           | definition     |   157 |      0 |                 0 |           1 |         99.4% |                                                                   158/158 = 100% |
| php-app           | hover          |   156 |      1 |                 0 |           1 |         98.7% |                                                                  157/158 = 99.4% |
| laravel-framework | definition     |   159 |      0 |                 1 |           2 |         98.1% |                                                                  161/162 = 99.4% |
| laravel-framework | hover          |   158 |      1 |                 2 |           2 |         96.9% |                                                                  161/163 = 98.8% |
| symfony           | definition     |   163 |      3 |                 0 |           3 |         96.4% |                                                                  167/169 = 98.8% |
| symfony           | hover          |   163 |      3 |                 0 |           3 |         96.4% |                                                                  167/169 = 98.8% |
| wordpress         | definition     |   191 |      5 |                 0 |           0 |         97.4% | 191/196 = 97.4% (194/196 = 99.0% counting the variable-definition design choice) |
| wordpress         | hover          |   187 |      9 |                 0 |           0 |         95.4% |                                                                  190/196 = 96.9% |
| **corpora**       | **definition** |   513 |      8 |                 1 |           5 |         97.3% |                                                              519/527 = **98.5%** |
| **corpora**       | **hover**      |   508 |     13 |                 2 |           5 |         96.2% |                                                              518/528 = **98.1%** |

Both reach the 98% bar over the corpora. Phase 6.2 left hover at 96.8%; phase 6.2.b closed seven of its gaps (the fixes are listed below) and reran the corpora with the same seed. The remaining gaps are listed under Follow-ups.

Before phase 6.2 the hover comparison was a text comparison, so nothing could agree. The first run with the structural comparison gave 92.6%, 93.5% and 77.6% hover agreement on laravel, symfony and WordPress. The engine fixes of phase 6.2 brought those to 95.7%, 96.4% and 92.9%, and those of phase 6.2.b to 96.9%, 96.4% and 95.4%.

## Engine fixes made in phase 6.2

- **Inherited `@param`.** A method parameter without its own `@param` takes the type of the method it overrides or implements, the way `@return` already did, with template arguments mapped through `@extends`/`@implements`. It's matched by name, or by position for a renamed parameter, and constructors are excluded. This feeds the flow types of the body, hover and signatures. Example: the fixture's `BookRepository::save(object $entity)` sees `Book`.
- **Locals in inferred returns.** Summary-time inference of an untyped function's return now tracks local variables written only by plain `$x = value` assignments (`$r = new Repo(); …; return $r;`). Any other write makes the variable `mixed`. Summary schema 7.
- **Duplicate functions.** When a function is declared more than once, the declaration with a return type and parameters is used. WordPress's `@ignore`d no-ops in `wp-admin/includes/noop.php` had made `__()`, `get_option()` and others `void` everywhere.
- **`T|false` kept.** `false`/`true` stay in a union when literals are widened, so `strpos()` shows `int<0, max>|false` instead of `int|bool`.
- **Stub types per PHP version.** The bundled stubs' docblocks lose a `false` their version's native type no longer has (`substr()`'s `@return string|false` is `string` from 8.0). A PHPDoc-only `#[LanguageLevelTypeAware]` type such as `explode()`'s `string[]` becomes the `@return`.
- **Narrowing on `=== false`, `!== false`, `=== true`.**
- **Iteration over plain objects.** `foreach` over a plain object gives `string` keys. `foreach` skips the `false` member of an iterated `string[]|false`.
- **Assigning a `void` result** stores `null`.
- **Superglobals** are arrays everywhere.
- **Methods of anonymous classes** type their parameters from their native hints.

## Engine fixes made in phase 6.2.b

- **Hash notation.** A `@return`, `@param` or `@var` in WordPress's hash notation (`@return array { … }`) keeps the type in front of the `{` instead of becoming `mixed`. `WP_Http::processHeaders()` and `wpmu_validate_user_signup()` return `array`. Summary schema 8.
- **Assertion tags.** `@phpstan-assert`, `-assert-if-true`, `-assert-if-false` and the `@psalm-` variants on a function's parameters (`!T` negated) narrow the variable passed there: after the call, or in the outcome the tag names, with the negation in the other one, as PHPStan does. `is_wp_error()`'s `@phpstan-assert-if-true WP_Error $thing` makes `array|WP_Error` an `array` past `if (is_wp_error($x)) return;`. Assertions naming templates aren't applied.
- **Inline `@var`.** `/** @var T $x */` (or `/** @var T */` on an assignment or `foreach`) in front of a statement types `$x` from there, and the writes of `$x` in the statement store `T`.
- **Closure parameters from the expected callable.** An untyped parameter of a closure or arrow function passed as an argument takes its type from the `callable(…)`/`Closure(…)` the parameter expects, with the receiver's generic arguments bound (`$collection->keyBy(function ($user, $int) …)` gives `int`). Templates of the method itself and relative classes stay unknown.
- **`match (true)`.** Each arm sees its conditions true and the earlier arms' false.
- **By-reference arguments** keep the variable's type when it already fits the declared parameter type (`escape(string|array &$data)` on an `array`); literals and shapes still take the declared type, as `preg_match()`'s `$matches` does.

## Review of the remaining differences

Legend: **E** means the engine's answer is right and Intelephense's is missing or wrong. **I** means Intelephense is right or more precise: an engine gap. **D** means a design difference where neither is wrong.

### laravel-framework

| Position                                                           | Query | Intelephense                                 | Engine                         | Verdict                                                                                        |
| ------------------------------------------------------------------ | ----- | -------------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------- |
| `src/Illuminate/Session/Console/SessionTableCommand.php:10:15`     | hover | `unset $name`                                | —                              | E: an attribute's named argument; Intelephense's text is wrong                                 |
| `tests/Auth/AuthGuardTest.php:47:56`                               | both  | `SessionGuard::getName` and `Store::getName` | —                              | I: the shape of a returned array literal is lost through `[$guard, …] = $this->getRealGuard()` |
| `tests/Integration/Database/EloquentCursorPaginateTest.php:118:68` | hover | `Builder<Model> $query`                      | `mixed`                        | I: closure parameter from the expected `Closure(Builder): mixed`                               |
| `tests/Queue/QueuePauseResumeTest.php:155:46`                      | both  | —                                            | `QueueManager::getApplication` | E                                                                                              |
| `tests/Support/SupportFacadesHttpTest.php:79:42`                   | both  | —                                            | `Container::make`              | E                                                                                              |

### symfony

| Position                                                  | Query      | Intelephense                     | Engine                                         | Verdict                                                                                            |
| --------------------------------------------------------- | ---------- | -------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `…/SecretsGenerateKeysCommandTest.php:166:23`             | hover      | `?string $dir`                   | `mixed`                                        | I: `$this->prop` inside an anonymous class                                                         |
| `src/Symfony/Component/Cache/CacheItem.php:188:34`        | both       | —                                | `ValueWrapper`'s `$value` (class named `\xA9`) | E                                                                                                  |
| `…/Cache/Traits/RedisClusterProxy.php:737:41`, `:1142:77` | both       | —                                | `RedisCluster` stub                            | E: Intelephense has no redis stubs by default                                                      |
| `…/Builder/ArrayNodeDefinition.php:483:15`                | definition | this assignment                  | the first assignment                           | D: the engine goes to a variable's first assignment, as PhpStorm does                              |
| `src/Symfony/Component/Process/Process.php:1376:33`       | definition | the method parameter             | the closure's `use ($callback)`                | E: inside the closure the variable is the capture                                                  |
| `src/Symfony/Component/Process/Process.php:1376:33`       | hover      | `callable('out'\|'err', string)` | `callable(string, string)`                     | I: literal strings widened inside a callable signature                                             |
| `…/Validator/Constraints/FileValidator.php:55:65`         | definition | `@property int $maxSize`         | `protected $maxSize`                           | I: from outside the class the protected property is inaccessible, so the magic `@property` applies |
| `src/Symfony/Component/Workflow/Workflow.php:373:30`      | hover      | `mixed $arc`                     | `Arc\|string`                                  | E                                                                                                  |

### wordpress

| Position                                                   | Query      | Intelephense                | Engine               | Verdict                                                        |
| ---------------------------------------------------------- | ---------- | --------------------------- | -------------------- | -------------------------------------------------------------- |
| `wp-admin/includes/ajax-actions.php:4739:14`               | hover      | `array\|false`              | `mixed`              | I: `reset()`'s template through a by-reference array parameter |
| `wp-admin/includes/image.php:118:38`                       | hover      | `mixed`                     | `int`                | E                                                              |
| `wp-admin/includes/update.php:889:5`                       | hover      | `?string`                   | `string`             | E: both branches assign strings (`sprintf()`, `__()`)          |
| `wp-admin/user-new.php:218:9`                              | definition | this assignment             | the first assignment | D                                                              |
| `wp-includes/ID3/module.audio-video.asf.php:1350:60`       | hover      | a shape                     | `mixed`              | I: by-reference alias `$x = &$a['k']`                          |
| `wp-includes/ID3/module.audio-video.quicktime.php:1974:15` | definition | the `foreach`               | the first assignment | D                                                              |
| `wp-includes/ID3/module.audio-video.quicktime.php:1974:15` | hover      | `int\|string`               | `mixed`              | I: `foreach` over a nested array element                       |
| `wp-includes/ID3/module.audio-video.riff.php:700:22`       | hover      | `array{raw: array}`         | `mixed`              | I: by-reference alias                                          |
| `wp-includes/Requests/src/Cookie.php:289:31`               | hover      | `int\|string`               | `mixed`              | I: `foreach` keys over an untyped array property               |
| `wp-includes/SimplePie/src/Misc.php:224:43`                | definition | `@property ?string $scheme` | `protected $scheme`  | I: as `maxSize` above                                          |
| `wp-includes/class-wp-list-util.php:274:34`                | hover      | `int`                       | `int\|string`        | I                                                              |
| `wp-includes/comment.php:699:18`                           | definition | built-in `$_COOKIE`         | a local write        | I: superglobals should go to the stubs                         |
| `wp-login.php:595:10`                                      | definition | this assignment             | the first assignment | D                                                              |
| `wp-login.php:595:10`                                      | hover      | `?string`                   | `string`             | E: `admin_url()` is documented `@return string`                |

### php-app

| Position                               | Query | Intelephense           | Engine                                             | Verdict |
| -------------------------------------- | ----- | ---------------------- | -------------------------------------------------- | ------- |
| `src/Library.php:14:68`                | hover | the promoted parameter | the promoted property                              | D       |
| `tests/RepositoryDoubleTest.php:27:49` | both  | —                      | `Repository::find` through `Repository&MockObject` | E       |

## Follow-ups

The hover gaps left, by how many samples each would fix:

1. Array flow:
   - by-reference aliases (`$x = &$a['k']`), two WordPress samples;
   - `foreach` over array elements written earlier (`$a['k'] = array(); foreach ($a['k'] as $key => …)`);
   - shapes of returned array literals through destructuring (`[$guard, …] = $this->getRealGuard()`);
   - templates bound through by-reference array parameters (`reset()`, `end()`: PhpStorm's stubs mark these `@meta`).
2. Closure parameters whose expected type names a method template (`whereHas('posts', function ($query) …)` expects `Closure(Builder<TRelatedModel>)`): bind the template to its bound.
3. Members of anonymous classes for `$this->…`; literal types inside callable signatures; `foreach` keys over `ArrayAccess&IteratorAggregate|array` unions.
4. The magic `@property` wins when the real property isn't accessible from the caller, for goto and hover (two definition samples). Superglobal definitions going to the stubs.
5. Decide whether variable definitions should go to the nearest reaching assignment (Intelephense) or keep the first one (PhpStorm). Five samples are this design difference; the engine keeps PhpStorm's behaviour.
