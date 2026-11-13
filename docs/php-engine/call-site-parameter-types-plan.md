# Plan: typing parameters from their call sites

Status: carried out, 2026-11-13.

## Outcome

Unresolved calls: Bagisto 788 → **747** of 34,254 (root causes 602 → 580),
Monica 99 → **91** of 8,270 (78 → 73). Of Bagisto's 72 untyped-parameter
root causes 47 are typed now, 25 are left (16 protected, 6 private, 1 public,
2 free functions); on Monica 6 of 11. Inspect Code reports the same on both
apps (182 and 201, per inspection), the checklist passes, and the probe run
(a goto on every method call of the app) takes the same time as before:
98 s against 99 s on Bagisto.

What differs from the plan below:

- **Item 0 (measure first) was folded into measuring the result.** The first
  two stages were cheap enough to build and measure directly.
- **Stage C does not record calls in the index.** A public method's callers
  are found in the files the existing word index lists for the method's name,
  read on demand, when there are at most 16 of them. No summary change, no
  new table, no schema bump; the price is that a method named in more files
  than that keeps its parameter `mixed`. On these apps that left 1 public
  parameter untyped on Bagisto and 3 on Monica, so the index version wasn't
  worth building.
- **The switch is on in fewer places than planned:** completion, `at_caret`
  (hover, Go to Declaration, the subject of Find Usages) and signature help.
  Not semantic tokens or inlay hints, which pass over the whole file on every
  edit and would read other files each time.
- **Free functions** are not covered (2 root causes).
- The remaining 25 parameters have callers that pass something untyped
  themselves, more than four types, or no caller the scan finds.

The plan as written follows.

## What this would and would not fix

A parameter with no type hint and no `@param` is `mixed` today, unless the
method it overrides types it. The idea: give it the types of the arguments its
callers pass.

Before planning I classified the untyped variables behind the unresolved calls
that are left (the root-cause probe after commit `e79ac531`), by reading the
code around each one:

| Where the untyped variable comes from                      | Bagisto (265) | Monica (35) |
| ---------------------------------------------------------- | ------------: | ----------: |
| Parameter of a method or function                          |            72 |          11 |
| Assigned from a call (own method, another value, a helper) |            98 |           9 |
| Parameter of a closure                                     |            39 |           1 |
| Loop variable of a `foreach`                               |            37 |          12 |
| Assigned from an array element or property                 |            11 |           2 |
| Other                                                      |             8 |           0 |

So this feature directly addresses **72 of Bagisto's 602 root causes** and 11
of Monica's 78, not the 355 "untyped variables" I quoted earlier: most of
those are untyped _returns_ and loop variables, which are different problems.
Some of them are downstream of an untyped parameter and would follow (a loop
over a parameter, a value returned from one), so the real gain is somewhere
between 72 and perhaps 130 on Bagisto. I can't narrow that without building
the measurement in stage 0.

Of the 72 parameters, by the visibility of their method: 15 private, 41
protected, 14 public, 2 plain functions. **56 of 72 can only be called from
their own class hierarchy**, which is what makes a cheap first stage possible.

## Design

### The rule

For parameter _i_ of a method or function that has no hint, no `@param`, and
nothing from the method it overrides or from a provider:

1. Collect the calls of that method.
2. Take the type of argument _i_ (or the argument named after the parameter)
   at each call.
3. Drop the unknown ones. If what is left is one to four different types, the
   parameter is their union. Otherwise it stays `mixed`.

`null` alone doesn't type a parameter; `Foo|null` does. A spread argument
(`...$args`) makes that call unusable. A variadic parameter takes the union of
all the arguments from its position on.

### Never used by inspections

A type from call sites is a guess: the callers found may not be all the
callers, and one wrong caller makes it wrong. It is used for completion,
hover, Go to Declaration, signature help and Find Usages. **Inspections keep
seeing `mixed`.** That is the gate against false warnings, and it is a
switch, not a threshold:

- `ExprTypes` gets a flag (`with_call_sites`), off by default.
- The editor features turn it on; `inspect/` never does.
- Hover says so: `Product $product` _— from 3 callers_.

This removes the main risk of the whole idea. It also means Inspect Code can't
regress, by construction.

### Where the callers come from: three stages

**Stage A — the same file.** Private methods, and functions called only in
the file that declares them. The file is already parsed for the request;
walk it for `$this->name(…)`, `self::name(…)`, `static::name(…)` inside the
class (or `name(…)` for a function) and type the arguments with the same
`ExprTypes`. No index, no new storage. Covers the 15 private parameters and
some of the protected ones.

**Stage B — the class hierarchy.** Protected methods: callers are in the
declaring class, its subclasses and the traits it uses. The files are those
of `Resolver::direct_subclasses`, followed transitively with a cap. Each is
parsed (the parse cache holds open and recently used files) and walked the
same way. Covers the 41 protected parameters.

**Stage C — the whole project.** Public methods. Reading every file on a
request is not possible, so the calls are recorded at index time, the way the
engine already works in two phases:

- At index time, each file's summary records its calls: the method name, the
  receiver's type and each argument's type, both as `LazyType` (what the
  extractor's own inference says, unresolved). Only calls with at least one
  argument that isn't unknown are kept, capped per file.
- A new index table maps a method name to the files that call it.
- At request time the resolver looks the name up, resolves the receiver
  lazies to keep the calls on the right class, resolves the argument lazies,
  and applies the rule.

Stage C costs the most (summary size, a schema bump, a new table) and covers
the fewest cases here (14 on Bagisto, 8 on Monica). Decide on it after
stages A and B are measured.

### Cycles and cost

- A parameter typed from a caller's argument that is itself an untyped
  parameter recurses. Guard with a visited set and a depth of three; beyond
  that the argument is unknown.
- Results are cached in `TypeCache` per (class, method, parameter), like every
  other resolved type, until the modification counter moves.
- Stage B reads at most 16 files per parameter; stage C at most 50 call sites
  per method. A method called from more places than that stays `mixed`: with
  that many callers the union would be too wide anyway.
- Nothing is computed until a feature asks for the type of that parameter.

## Work items

### 0. Measure first (throwaway, not committed)

A probe that, for every untyped parameter behind an unresolved call, finds its
callers with the existing Find Usages and types the argument. It answers what
this plan can't: how many of the 72 have at least one caller passing something
typed, how many unions come out wider than four, and how the three stages
split. **If fewer than half are typable, stop here.**

### 1. The switch

`ExprTypes::with_call_sites`, and the features that turn it on: completion
(4 sites), `at_caret` (definition, hover, references), signature help,
semantic tokens and inlay hints. A test that `inspect/` never does.

### 2. Stage A

- `ExprTypes::parameter`: after the declared type, the inherited one and the
  providers, the call-site step.
- A walker over the class body for calls of the method, reusing the argument
  matching of `types/resolve/operators.rs` (`argument_for`: positional and
  named).
- Tests in `types/expr/tests.rs`: one caller, two callers with different
  classes, a caller passing `null`, an unknown caller beside a typed one, five
  different types (stays `mixed`), a spread, a variadic, recursion.

### 3. Stage B

- The files of the hierarchy from `direct_subclasses`, capped; trait hosts
  through `Resolver::trait_hosts`.
- Each file needs its own `ExprTypes` (names, summary, parsed tree). The
  references scan already builds these per file (`navigate/references.rs`,
  `scan_parsed`); reuse that path.
- Tests in `navigate/tests/`: a protected method called from a subclass in
  another file.

### 4. Measure, then decide on stage C

The root-cause probe and the Inspect Code baselines on both apps, and timings
of completion and hover in a file with many untyped parameters.

### 5. Stage C (only if stage 4 says so)

- `summary`: `CallFact { name, receiver: LazyType, args: Vec<LazyType> }`,
  extraction in `summary/extract`, `SCHEMA_VERSION` bump, golden snapshots.
- `index/tables.rs`: the name → files table, kept up to date per file like the
  others.
- `Declarations::calls_of(name)`, engine implementation reading only those
  files (as `macros()` does), with open documents on top.
- Measure the index size and the indexing time before and after on both apps;
  the budgets in `perf/budgets.json` must hold.

### 6. Hover and docs

- Hover's "from N callers" note.
- `docs/php-engine/architecture.md` ("What nothing declares"), `docs/php.md`
  for the user-facing side, a `PROGRESS.md` entry.

## Checks at the end

- `cargo test -p ide-php`, `cargo test -p ide-host php`, clippy.
- Inspect Code on Bagisto and Monica: identical, per inspection and per line.
  With the switch this should hold trivially; the check is that the switch
  really is off there.
- The root-cause probe on both apps, before and after.
- `pnpm perf:rust` within budget; completion's p95 on the fixture unchanged.
- In the running app: hover and completion on one private, one protected and
  (if built) one public example in Bagisto.

## Risks

- **A wrong guess shown as fact.** A caller the engine didn't find, or one
  that passes the wrong thing, gives a wrong type in completion and hover.
  Mitigation: hover says where the type comes from; inspections never use it;
  more than four types means no type.
- **Speed in stage B.** Parsing up to 16 files for one hover. Mitigation: the
  parse cache, the per-generation type cache, and the cap. Measured in item 4.
- **Index growth in stage C.** Every call with a typed argument becomes a
  record. Mitigation: the per-file cap, and building stage C only if the
  first two stages leave enough behind to justify it.
- **The estimate.** 72 direct root causes on Bagisto is a count; the gain
  beyond that is a guess. Item 0 replaces it with a measurement before any
  code is kept.

## Not in this plan

These are most of what is left on Bagisto after this feature, and each is a
separate piece of work:

- **Untyped returns** (98 root causes): a method without a return type whose
  body returns something the engine can't type. Some depend on an untyped
  parameter and need a "type of parameter _i_" node in the stored return
  types to follow a call-site type through.
- **Closure parameters** (39): closures stored in arrays or passed to
  callables nobody documents.
- **`foreach` variables** (37): loops over untyped arrays and collections.
- **Array elements and properties** (11).
