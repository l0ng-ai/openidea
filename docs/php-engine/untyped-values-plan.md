# Plan: untyped returns, closure parameters and loop variables

Status: carried out, 2026-11-13.

## Outcome

Unresolved calls: Bagisto 747 → **625** of 34,254 (root causes 580 → 476),
Monica 91 → **87** of 8,270 (73 → 69). The targets (under 450 root causes on
Bagisto, under 60 on Monica) were not reached.

Inspect Code: Monica unchanged (201). **Bagisto reports 190 problems instead
of 182**: 8 new `PhpUndefinedField` in the two `DataGridController`s, which
read `$column->options`. They are correct: no `Column` class declares that
property (only `MassAction` has `$options`). The engine can now tell that
`$column` is a `Column` (items B and D), so it sees the mistake.

Cost: the probe run (a goto on every method call of Bagisto) takes 104 s
against 98 s before, 6 % more, inside the 10 % limit.

What differs from the plan below:

- **Item 0 (count the causes) was not built.** I checked item A's premise
  instead and it was wrong: Bagisto has only ten `@param object`. The
  `object` types come from native hints (`object $requestedDate`) and from
  `new $class`. Item A was done for the hints; `new $class` stays `object`.
- **A bug in the previous feature turned up and is fixed:** a parameter
  nobody calls showed as `never` (the empty union of its callers'
  arguments), which also blocked the closure rules on it.
- **Item C found a blow-up before it shipped:** on a long chain of unknown
  calls the fallback typed each receiver twice, doubling the work at every
  link (the deep-nesting test hung). A call already found unknown is no
  longer asked again.
- **Item C covers methods only**, not free functions.
- **Item D's "collection" is a name test:** a class whose short name ends in
  `Collection`. The extractor can't see generics of other files at index
  time.
- **Item E:** more than four classes give nothing; the "common parent" rule
  was not built.

The plan as written follows.

## What is actually behind these three groups

After commit `e576a42e` Bagisto has 747 unresolved method calls from 580 root
causes; Monica has 91 from 73. I read the code behind Bagisto's untyped
variables again (232 of the 580), by where the variable comes from:

| Where the variable comes from                        | Root causes |
| ---------------------------------------------------- | ----------: |
| Assigned from a call whose result is unknown         |          97 |
| Parameter of a closure                               |          57 |
| Loop variable of a `foreach`                         |          37 |
| Parameter of a method (left over from the last plan) |          25 |
| Array element, property, other                       |          16 |

The three groups in the title are 191 root causes, but they are not three
problems. Reading the samples, they come down to six causes that cut across
the groups, plus a remainder nothing can type:

| #   | Cause                                                                         | Example                                                                                                                                                 | Est. root causes |
| --- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------: |
| A   | A parameter documented `@param object` is treated as known                    | `processFilter($queryBuilder, …)`, then `$queryBuilder->where(function ($scopeQueryBuilder) …)`                                                         |              ~45 |
| B   | A property filled with `$this->items[] = …` has no element type               | `$this->columns[] = Column::resolveType($column);`, then `collect($this->columns)->filter(fn ($column) => …)` and `foreach ($this->columns as $column)` |              ~30 |
| C   | A method without a return type whose body the index-time inference can't type | `resolveFileTypeQueryBuilder($product, …)` returning `$product->images()`                                                                               |              ~35 |
| D   | A parameter or return declared as a bare container                            | `walk(Collection $menuItems)`, `getColumns(): array`, `getItems(): Collection`                                                                          |              ~15 |
| E   | A class picked from an array of class names                                   | `app($this->typeHelpers[$type])`                                                                                                                        |              ~10 |
| F   | Closures of test fakes and of `when()` on collections and factories           | `Mail::assertQueued(Foo::class, fn ($mail) => …)`                                                                                                       |               ~8 |

Together about 140 of the 580. These are estimates from reading about half of
the samples; work item 0 replaces them with counts.

What stays untyped whatever is done: event listener closures whose payload is
only known where the event is fired (`Event::listen('…', function
($viewRenderEventManager) …)`), classes named by configuration
(`app($config['class'])`), values out of untyped arrays, and third-party SDKs.

## Work items

### 0. Count the causes

Extend the temporary root-cause probe: for each untyped variable, print the
expression it was assigned from, or the call its closure is passed to, or the
expression its loop iterates, with that expression's type. Group by it. This
confirms or corrects the table above before anything is built, and it is the
"before" for the final measurement. Drop any cause below ten root causes.

### A. `object` says as little as `mixed`

Bagisto documents many parameters as `@param object $queryBuilder`. The
engine treats `object` as a real type, so the rules for unknown receivers
(the query builder for a `where()` closure, the join clause, call-site
typing) don't apply, and nothing resolves on it either.

- In the Laravel provider's closure rules (`join_closure`, `query_closure`),
  a receiver that is exactly `object` counts as unknown.
- In call-site typing, a parameter whose declared type is exactly `object`
  (hint or `@param`) is refined by what its callers pass, under the same
  editor-only switch. `object` stays the type for inspections.
- Not a general "treat `object` as `mixed`": inspections rightly keep quiet
  on `object` today and that must not change.

Small, and probably the largest single gain. Do it first.

### B. Element types of properties filled by appending

- `summary/extract.rs`, `this_assignments`: besides `$this->prop = value`,
  record `$this->prop[] = value` and `$this->prop[$key] = value` as an
  element assignment.
- `CoreProvider::property`: element assignments give `list<T>` (or
  `array<K, T>` with a literal or typed key), joined with whole-value
  assignments. The existing limits stay: at most four different types, none
  unknown.
- A property with a default of `[]` and no `@var` is the common case; the
  rule must apply to it (today the literal default wins as `array`).
- Check that `collect($array)` carries the element type into the collection
  (`Collection<int, Column>`); Laravel documents it with templates, so this
  should already work once the array is typed.
- Schema bump; golden snapshots.

Risk: a wider element type makes inspections check calls on the elements.
The Inspect Code baselines decide, as for the untyped-property rule, which
changed nothing.

### C. Return types read from the body on demand

A method with no return type and no `@return` gets its type from the body at
index time (`inferred_return`). That inference sees one file, no flow
narrowing, and parameters as declared, so it gives up where the editor's own
analysis would not.

- When the stored answer is unknown, type the body with the full analysis:
  parse the declaring file, build its `ExprTypes`, and take the union of the
  `return` expressions (the `Returns` walker already does this for
  closures).
- New `Declarations::body_return(class, method)`, implemented by the engine
  like `call_site_types`, cached per modification count, with the same depth
  guard against methods that return each other's results.
- Under the editor-only switch (`with_call_sites`, to be renamed to say what
  it now covers, e.g. `with_guesses`): the body's type may itself rest on a
  call-site parameter. Inspections keep the stored answer.
- Functions as well as methods (the last plan left free functions out; the
  same walker covers them here and there).

Cost: one more file parsed per unknown return asked for. The call-site
feature measured no slowdown with the same pattern, but this one fires more
often; measure completion and hover on a file with many such calls.

### D. Bare containers refined by what is known

A declared `array`, `iterable` or `Collection` with no element type hides
what the code knows.

- **Returns:** when the hint is a bare container and there is no `@return`,
  keep the body's inferred type if it is the same container with element
  types (`list<Column>` for `array`, `Collection<int, MenuItem>` for
  `Collection`). The extractor already does exactly this for relations
  declared raw (`comments(): HasMany`); generalise that case.
- **Parameters:** under the editor switch, a parameter declared as a bare
  container takes the element types its callers pass, when they agree.
- Then `foreach` and collection callbacks over them are typed by what already
  exists.

### E. A class picked from an array of class names

`app($this->typeHelpers[$type])` where the property is a literal array of
`Foo::class` values.

- The element type of such a property is already a union of
  `class-string<…>`; make indexing it with an unknown key give that union.
- Laravel's container calls (`app()`, `make()`, `resolve()`) read their
  class from the syntax today. Add the resolve-time case: an argument whose
  type is a class-string (or a union of up to four) makes that class.
- With more than four classes, their common parent or interface when they
  have one; otherwise unknown.

### F. Closures of fakes and of `when()`

- `Mail::assertQueued(Foo::class, fn ($mail) => …)`, `assertSent`,
  `Event::assertDispatched`, `Bus::assertDispatched`, `Queue::assertPushed`,
  `Notification::assertSentTo`: the closure's first parameter is the class
  the first argument names. In the Laravel provider's `closure_parameters`,
  which now receives closures without a string key.
- `->when($cond, fn ($x) => …)` on a collection or a factory: the closure
  gets the receiver. Today only query builders do; extend to any receiver
  whose class uses `Conditionable`.

## Order

1. Item 0, and a baseline of the probe and Inspect Code on both apps.
2. A (small, largest gain), then F (small).
3. B, then D (D's loops and callbacks depend on B's arrays).
4. C, then E.
5. One schema bump for B and D; one final measurement.

One commit per item with tests that fail without it, next to the existing
ones (`types/provider/laravel_tests.rs`, `types/provider/tests.rs`,
`navigate/tests.rs`, `inspect/members_tests.rs`).

## Checks at the end

- `cargo test -p ide-php`, `cargo test -p ide-host php`, clippy.
- Inspect Code on Bagisto and Monica identical per inspection (182 and 201).
  A, C, the parameter half of D and E's guesses sit behind the editor switch
  and can't change it; B and the return half of D can, and are checked after
  each.
- The root-cause probe before and after. Target: under 450 root causes on
  Bagisto (from 580), under 60 on Monica (from 73).
- The probe's run time on Bagisto within 10 % of today's 98 s, as the
  measure of what C costs.
- `real_app_checklist` on both apps.
- Docs: `architecture.md` ("What nothing declares"), `laravel.md`,
  `docs/php.md`, a `PROGRESS.md` entry.

## Risks

- **B and D change what inspections see.** They are real inference, not
  guesses, so they are not behind the switch; a wrong element type would be a
  wrong warning. Mitigation: the same limits as the untyped-property rule,
  and the baselines after each item.
- **C's cost.** It parses other files while the user types. Mitigation: only
  when the stored answer is unknown, cached per modification count, depth
  guard; measured by the probe's run time. If it costs more than 10 %, limit
  it to methods of the file being edited and its class hierarchy.
- **`object` (item A).** Refining it from callers must stay editor-only, or
  Inspect Code starts checking calls it has always left alone.
- **The estimates.** About 140 root causes, from reading half the samples.
  Item 0 counts them. Even if all of it lands, roughly 440 root causes remain
  on Bagisto: this plan narrows the gap, it does not close it.

## Not in this plan

- Payloads of event listeners, from where the events are fired.
- Classes named by configuration values.
- Array shapes of untyped data (`$data['product']->…`).
- Third-party SDKs without types.
