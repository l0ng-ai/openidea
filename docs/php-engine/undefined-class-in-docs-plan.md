# Plan: undefined classes in `use` and PHPDoc

Status: carried out, 2026-11-14.

## Outcome

Inspect Code on Bagisto: 191 → **218** problems. The 27 new ones, all read:

- 4 undefined imports (`PhpUndefinedClass`): `Helpers\Source`, the
  `Product\Product\…` typo, `Attribute\Contracts\Group`, and Debugbar (not
  installed). The fifth the probe found, in `config/repository.php`, is in a
  folder Inspect Code's run doesn't cover.
- 23 undefined classes in PHPDoc (`PhpUndefinedDocClass`): renamed or
  misspelt namespaces (`\Webkul\Sale\Contracts\Order`), names used without
  an import (`Factory`, `Collection`, `RepositoryException`), and the three
  `Source` docs. None is a false report.

Monica: unchanged at 201. The three names the crude probe flagged there were
text, not types.

What differs from the plan below:

- **PHPDoc is its own inspection**, `PhpUndefinedDocClass`, not an option of
  `PhpUndefinedClass`: the inspections have no options, and a separate id can
  be switched off or suppressed on its own. Severity: information.
- **No "remove import" fix.** An undefined import that is also unused already
  gets "Remove unused import"; removing one that is used would break more.
  "Create class" is offered as for other undefined classes.
- **Names starting lower case or holding a `-` are skipped** in PHPDoc, as
  pseudo-types the parser may not know.
- **Inline `@var` comments in bodies are not checked** (work item 5, marked
  optional).
- A guard (`class_exists(Foo::class)`) anywhere in the file covers the import
  of that class, which comes before it.

The plan as written follows.

## Why

`PhpUndefinedClass` checks class names in code (`new`, `::`, type hints,
`extends`, …). It deliberately skips `use` lines and docblocks; the module
header of `inspect/undefined.rs` says so. That is how Bagisto's
`AbstractImporter` can import and document a class that does not exist
(`Webkul\DataTransfer\Helpers\Source`) with nothing reported, while every call
on a value typed with it stays unresolved.

## What it would report: measured

A throwaway probe ran both checks, in their crudest form, over the two apps'
own PHP files (not `vendor/`).

**`use` lines**

|         | Imports | Undefined |
| ------- | ------: | --------: |
| Bagisto |   7,037 |         5 |
| Monica  |   8,844 |         0 |

Bagisto's five, all read:

- `Webkul\DataTransfer\Helpers\Source` — does not exist (the class is
  `Helpers\Sources\AbstractSource`).
- `Product\Product\Contracts\ProductBundleOption` — a typo in the namespace.
- `Webkul\Attribute\Contracts\Group` — does not exist.
- `Barryvdh\Debugbar\Facades\Debugbar` and
  `League\Fractal\Serializer\DataArraySerializer` — packages that are not
  installed. The first is already reported where it is used.

Three real mistakes, two missing packages, no false report. This half is
cheap and clean.

**PHPDoc**

The existing helper that finds names in docblocks (`doc_type_names`, used by
Find Usages) is far too loose for an inspection: it takes the first word
after any tag. Of 4,055 names on Bagisto it called 3,052 undefined, almost
all of them `void`, `array`, `string`, words out of URLs after `@see`, and
description text. Monica: 992 of 1,795, including template names (`T`,
`TValue`) and the arguments of `@psalm-suppress`.

Read by hand, the real ones are about **25 on Bagisto** (15 distinct:
`Source`, `AbstractPriceIndex`, `ProductBundleOption`, `Inventory\Product`,
`\Webkul\Sale\Contracts\Order`, `\Webkul\Product\Type\CartItem`, …) and
**about 3 on Monica** (`Account`, `Users`, `Vaults`). Several are the same
kind of mistake: a namespace that was renamed, or a missing leading `\`.

So the PHPDoc half is worth having, but only with a precise source of names.
It must not be built on `doc_type_names`.

## Design

### `use` lines

- In `inspect/undefined.rs`, names with the role `Import` are checked like
  references, for class-like imports only (`use function` and `use const`
  follow the function and constant checks, in the same pass).
- A `use` may import a namespace (`use App\Models;` then `Models\User`). An
  import is defined when a class-like **or a namespace** of that name
  exists. The index has the namespace table (`namespace_children`).
- Group imports (`use App\{A, B}`) report the item, not the group.
- The same guards and ignored namespaces as today apply
  (`class_exists('X')` in the file, the namespaces in `IGNORED_NAMESPACES`).
- Message: `Undefined class 'X'`, the same inspection id, the same severity.
  Quick-fixes: remove the import; the existing "Create class".
- A name both imported and used would be reported twice (the `use` and each
  use). Report the import, and keep the usages reported as today: they are
  where the code breaks.

### PHPDoc

The summaries already hold every docblock parsed into tags, with the class
names resolved (`DocBlock`: `@param`, `@return`, `@var`, `@throws`,
`@property`, `@method`, `@mixin`, `@extends`, `@implements`, `@use`,
`@template … of`). Template parameters and type aliases stay as written
there, so they are not mistaken for classes. That is the source.

- For each declaration with a docblock (class-like, method, property,
  function, constant), take the class names in the types of its tags
  (`Type::from_doc`, then every `Type::Named`, generic arguments included).
- A name is defined when a class-like of that name exists, by the same rule
  as in code.
- The position: the summaries keep no offsets for names inside a docblock.
  Find the name as written in that docblock's text (the short name, or the
  qualified one), as a whole word after a tag; report that range. When it
  can't be found unambiguously, report the tag's line.
- Inline `/** @var Foo $x */` in bodies are not in the summaries. They are
  read by the flow analysis; take them from there, or leave them out of the
  first version and say so.
- Not checked: `@see`, `@link`, `@uses`, `@psalm-suppress`,
  `@phpstan-ignore`, text after the type, and anything in a tag the parser
  did not understand.
- Severity one step below the code check (a wrong PHPDoc type does not break
  the program): weak warning, same inspection id so one `@noinspection`
  covers both. An option on the inspection, "Check PHPDoc", on by default, in
  `src/platform/phpInspections.ts` with its `en` and `zh` text.
- Quick-fixes: import the class when exactly one class has that short name
  (the existing import action), and nothing else.

### What stays out

- `@method` and `@property` names (they are members, not classes); only
  their types are checked.
- Class names in strings and in `.phpstorm.meta.php`.
- Blade files.

## Work items

1. **`use` lines.** The role check, the namespace rule, the group items, the
   "remove import" fix. Tests in `inspect/undefined_tests.rs`: an undefined
   import, a namespace import, a group, `use function`, a guarded name, an
   import of an ignored namespace.
2. **Measure.** Inspect Code on both apps: expect +5 on Bagisto and 0 on
   Monica. Read every new report.
3. **PHPDoc from the summaries.** The collector over `DocBlock`, the
   position finder, the option and its settings text. Tests: each tag kind,
   a template, an alias, `self`/`static`, a generic argument, a name written
   twice in one docblock, an unknown name in `@see` (not reported).
4. **Measure.** Inspect Code on both apps: expect about +25 on Bagisto and
   about +3 on Monica. Read every new report; a false one is a bug in the
   collector, not something to tolerate.
5. **Inline `@var`** (optional): from the flow analysis.
6. Docs: the header of `inspect/undefined.rs`, `docs/php.md` (inspections),
   a `PROGRESS.md` entry.

One commit per work item.

## Checks at the end

- `cargo test -p ide-php`, `cargo test -p ide-host php`, clippy, and the
  frontend tests that list the inspections.
- Inspect Code on Bagisto and Monica: every new report read and listed as a
  true finding. The plan's numbers (+5, then about +25 and +3) are the
  expectation; anything far from them means the collector is wrong.
- Inspect Code's run time on Bagisto within 5 % of today's (the check walks
  summaries that are already in memory).
- `real_app_checklist` on both apps.

## Risks

- **Noise from docblocks.** The probe shows what a loose reader does: three
  thousand false reports. Mitigation: only tags the summary parsed, only
  names it resolved as classes, and the two measurements as gates. If the
  PHPDoc half can't be made clean, ship the `use` half alone.
- **Packages that are not installed.** A project that documents or imports
  classes of an optional package gets reports until it installs it.
  PhpStorm behaves the same. `@noinspection` and the ignored namespaces are
  the ways out.
- **Positions.** A name found by searching the docblock's text can land on
  the wrong occurrence when a docblock names two classes with the same short
  name. The fallback is the tag's line; the test list covers it.

## What this does not do

It does not resolve anything new: the 30 unresolved calls behind `Source` on
Bagisto stay unresolved, correctly. It tells the user why.
