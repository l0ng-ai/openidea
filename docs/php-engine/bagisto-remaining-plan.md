# Plan: what is left on Bagisto

Status: carried out, 2026-11-13.

## Outcome

Unresolved calls: Bagisto 625 → **482** of 34,254 (root causes 476 → **348**,
target under 350), Monica 87 → **81** of 8,270 (69 → 65). The probe run on
Bagisto takes 104 s, as before.

Inspect Code: Monica unchanged (201). Bagisto 190 → **191**. The new report
is correct: `InvoiceRepository` passes `order_address_id` to
`$this->model->create([...])`, and no migration gives the `invoices` table
that column (only `shipments` has it). It showed up because `$this->model` in
a repository is now its model.

All five items were built. What differs from the plan below:

- **A:** Go to Declaration and the call's type; completion does not list the
  subclasses' members.
- **B:** the anonymous class is a class the summary holds and `new class`
  has its type, so objects of it have their members (and a `: object`
  function returning one returns it). The class's own methods still see
  `$this` through the earlier syntax-tree path: their frames were left as
  they are, so nothing changed for inspections inside anonymous classes, and
  completion, Find Usages and Rename on `$this` there are still not done.
  `: object` is refined only to an anonymous class; refining it to whatever
  the body returns broke existing behaviour (`stdClass` for `object`) and
  was dropped.
- **C:** as planned, with one marker in the summary to tell what a class
  assigns from a literal default.
- **D:** returns and parameters of free functions, and `getFacadeRoot()`.
- **E:** all five, including a new provider step for declared properties
  (`TypeProvider::declared_property`).
- **The missing class is not reported.** `Webkul\DataTransfer\Helpers\Source`
  appears only in a `use` and in PHPDoc (`@var`, `@param`, `@return`), which
  the undefined-class inspection does not read. Left as a follow-up:
  checking PHPDoc types is its own change, with its own false-warning risk.

The plan as written follows.

## Where it stands

After commit `ee6f7526`: 625 unresolved method calls of 34,254, from **476
root causes**. 106 of the 476 are in test files. Monica has 87 from 69.

I went through the 476 by what the receiver is and checked the larger groups
against the code, because the last plan's biggest estimate rested on a guess
that turned out wrong.

| Receiver                                                        | Root causes |
| --------------------------------------------------------------- | ----------: |
| A variable the engine types as unknown                          |         165 |
| A variable or property with a known class that lacks the method |         ~75 |
| A property that is unknown or declared `mixed`                  |         ~65 |
| The result of a method, function or static call                 |         119 |
| A variable typed `object`                                       |          22 |
| An array element                                                |          16 |
| `$this`                                                         |          10 |

## What can be fixed

Five causes, about 150 root causes together. The estimates come from the
groups above plus reading the code; each item starts by confirming its own
premise on two or three real cases before anything is built.

| #   | Cause                                                                                     | Example                                                                                                                                      | Est. |
| --- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---: |
| A   | The method exists only on subclasses of the receiver's class                              | `$this->getTypeImporter()->queueImageDownload()`, `$product->getTypeInstance()->getPriceIndexer()`, a model's method called on `Model`       |  ~40 |
| B   | Objects of anonymous classes have no members                                              | `function svgSanitizer(): object { return new class { … }; }`, `$this->forgetter = new class { use ForgetsPages; };`                         |  ~35 |
| C   | A property declared `mixed`, or inherited untyped, and assigned in the class that uses it | `protected mixed $reader;` in the parent, `$this->reader = $factory->getActiveSheet();` in `XLSX`                                            |  ~30 |
| D   | Free functions: untyped returns and parameters, and `Facade::getFacadeRoot()`             | `function two_factor_authentication() { return TwoFactorAuthenticationFacade::getFacadeRoot(); }`                                            |  ~20 |
| E   | Small Laravel gaps                                                                        | `Storage::disk()->download()`, `auth()->user()`, `Category::factory()->hasTranslations()`, `fake()->state()`, `$this->model` in a repository |  ~25 |

### A. Members declared only on subtypes

The receiver is typed with a base class or interface, and the method is
declared on the classes that extend it. PHP runs it; the engine finds nothing.

- When a method or property isn't found on the receiver's class, look in its
  subclasses and implementors (`direct_subclasses`, followed transitively,
  capped at 32 classes).
- Go to Declaration offers all the declarations found; completion lists
  them after the class's own members; the call's type is the union of their
  return types when they are at most four.
- A guess: behind the editor switch (`with_call_sites`). Inspections keep
  reporting or staying silent exactly as today.
- Not when the class is `final`, and not for `mixed` or `object` receivers
  (that would be every method of that name in the project).

### B. Anonymous classes as classes

Today an anonymous class is not in the file's summary; only `$this` inside
its own methods is handled, by reading the syntax tree.

- The extractor emits a class-like for each anonymous class, under a name
  nothing can type by hand (`class@anonymous` plus the file and offset),
  with its parent, interfaces, traits and members.
- `new class { … }` has that type. Its members, including the traits', then
  work everywhere a named class's do, and the special cases for `$this` in
  an anonymous class (definition and hover only) go away in favour of the
  normal path, which adds completion, Find Usages and Rename.
- A function or method declared `: object` whose body returns such an object
  returns it (the same refinement as for bare containers; the anonymous
  class can't be named in a hint).
- These classes must stay out of class-name completion, Go to Class,
  the "unused class" checks and the hierarchy views.
- Schema bump; golden snapshots change wherever a fixture has one.

This one changes what inspections see (members of anonymous classes become
checkable). Expect new true positives; the baselines decide.

### C. `mixed` is no declaration, and assignments where the property is used

Two gaps in the untyped-property rule:

- A property hinted or documented `mixed` is skipped as "declared". Treat it
  like an untyped one: it takes what its class assigns.
- A property the class inherits untyped (or `mixed`) and assigns itself: in
  that class and below, `$this->reader` has the type assigned there. The
  parent's declaration stays `mixed` for everyone else. In the summary, as a
  refinement on the subclass, not a redeclaration.
- The same limits as now: at most four types, none unknown.

Inspections see this; it is real inference.

### D. Free functions

The last two plans covered methods only.

- **Returns:** a function without a return type whose stored inferred return
  is unknown is typed from its body on demand, like methods (the walker is
  the same; it needs the function's frames instead of a method's).
- **Parameters:** call-site typing for functions, from the calls in the file
  and in the files the word index lists for the name (same cap of 16).
- **`Facade::getFacadeRoot()`** is the facade's service, as `Facade::method()`
  already is.
- Behind the editor switch, like the method versions.

### E. Small Laravel gaps

Each is a few lines in the Laravel provider; none is worth a plan of its own.

- `Storage::disk()` and `Storage::drive()` return the filesystem adapter
  (`FilesystemAdapter`), which has `download()`, `url()` and the rest, not
  the bare contract.
- `auth()->user()` and `auth()->logout()`: find out why the union `auth()`
  returns doesn't resolve these, and fix that.
- `Category::factory()->hasTranslations()`: the type already works; make Go
  to Declaration land on the relation the name stands for (`translations()`).
- `fake()->state()`: Faker's provider methods (dropped twice for being three
  root causes; here it rides along).
- `$this->model` in a Prettus repository is its model, including
  `$this->model::query()`.

## What cannot be fixed

- **30 root causes are a mistake in Bagisto.** `AbstractImporter` imports and
  type-hints `Webkul\DataTransfer\Helpers\Source`, a class that does not
  exist (the real one is `Helpers\Sources\AbstractSource`). Every call on a
  `$source` typed with it is unresolved, correctly. The one thing to check
  here is that Inspect Code reports the missing class at the `use` and the
  hints; if it doesn't, that is a gap in the undefined-class inspection and
  goes into item E.
- Untyped locals fed by untyped data: values out of arrays
  (`$data['product']->…`), `new $class`, classes named by configuration
  (`app($config['class'])`), event listener payloads.
- Third-party SDKs without types (Razorpay, PayPal).

## Order

1. A (largest, behind the switch, no inspection risk).
2. C (small, inspections see it: baseline after).
3. D and E (small, mostly behind the switch).
4. B last: the largest change to the summaries, the only schema bump, and
   the one that can move Inspect Code most. If time runs out, B is the item
   to leave for its own pass.

One commit per item, with tests that fail without it. Before building each
item, hover on two or three of its real cases in Bagisto with the temporary
probe, to confirm the cause is what this plan says.

## Checks at the end

- `cargo test -p ide-php`, `cargo test -p ide-host php`, clippy.
- Inspect Code on both apps, compared line by line. A and D can't change it.
  B, C and parts of E can: every new report is read and classed as a true
  finding or a regression before its commit stays.
- The root-cause probe before and after. Target: under 350 root causes on
  Bagisto (from 476). The probe's run time within 10 % of 104 s.
- `real_app_checklist` on both apps.
- Docs: `architecture.md`, `laravel.md`, a `PROGRESS.md` entry, and this
  file's outcome.

## Honest expectation

If all five items land as estimated, about 325 root causes remain on Bagisto,
roughly 440 unresolved calls of 34,254 (1.3 %). Most of what remains is in
the "cannot be fixed" list, plus a long tail of one-off cases. After this
plan the next gain would have to come from Bagisto's code (types on its
parameters and properties), not from the engine. I would treat this as the
last pass of its kind and judge further work by what people hit in the
editor rather than by this probe.
