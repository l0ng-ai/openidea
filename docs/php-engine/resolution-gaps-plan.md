# Plan: the remaining resolution gaps, in one pass

Status: carried out, 2026-11-13. Bagisto went from 1,318 unresolved calls to
**788** of 34,254, Monica from 128 to **99** of 8,270; Inspect Code reports
the same problems on both apps as before (182 and 201).

What was done, by work item:

| #   | Outcome                                                                                                                                                         |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0   | Done (`720aa734`).                                                                                                                                              |
| 1   | Done: the probe reports root causes with the receiver's kind and type. 1,318 calls were 1,013 root causes.                                                      |
| 2   | `test()` without arguments: done. Traits bound through `uses()`: not done; Bagisto binds its concerns with `use` in the test case classes, which item 3 covers. |
| 3   | Done, through traits using the trait too. A member resolves when any host has it (not "every host", as planned).                                                |
| 4   | Done for Go to Declaration and hover; not completion, Find Usages or Rename.                                                                                    |
| 5   | Done for nested queries, `when()`, validation rules. Event and bus fakes: not done (no such root causes left in the list).                                      |
| 6   | Done for the declaring class's own methods. Assignments in subclasses: not done.                                                                                |
| 7   | Already existed (`Resolver::inherited_param`).                                                                                                                  |
| 8   | `parent::find()`: done. `$this->model`: not done (4 root causes).                                                                                               |
| 9   | Done by the relation's name only; inverse relations and morph maps are not read (Bagisto has neither).                                                          |
| 10  | Done: the items' methods resolve; the call's type is still what the core says.                                                                                  |
| 11  | Done by the resource's name; not from where it is constructed.                                                                                                  |
| 12  | Done.                                                                                                                                                           |
| 13  | The closure parameter: done. The rest was already typed by Laravel's own docs once `test()` resolved.                                                           |
| 14  | Dropped: 3 root causes.                                                                                                                                         |
| 15  | No separate cause found: the chains break on untyped parameters (`$qb`, `$queryBuilder`).                                                                       |

The target of under 500 on Bagisto was not reached. Of the 602 root causes
left, 355 are variables without a type (untyped parameters and what is
derived from them), which this plan left out on purpose ("Not planned":
types from call sites). The rest: 89 properties (mostly assigned from untyped
values), 56 method results, 46 function results, 26 static results, 20 array
elements, 10 `$this`.

The plan as written follows.

## Where we are

The probe (goto definition on every `->method(` call of an app's own code) on
Bagisto: 9,023 unresolved calls at the start, **1,396 of 34,254** after commit
`883ea35b`. Monica was last measured at 128 of 8,270. Inspect Code reports 182
problems on Bagisto and 201 on Monica; that must not change.

Since then one more round is committed (work item 0: a factory's magic
`hasX()`/`forX()`, the query of a repository's `scopeQuery()` closure, join
closures after a table that isn't a string literal), which leaves **1,318**.
The table below was estimated on the 1,396 list.

The remaining calls are a long tail. The sizes below are estimates: the probe
prints one sample in nine, and I classified those 150 samples by hand, so each
figure is "samples × 9" and can be off by a third. Many calls are cascades (one
unknown receiver breaks every call after it), which is why work item 1 comes
first.

| #   | Gap                                                     |   Est. calls | Risk    |
| --- | ------------------------------------------------------- | -----------: | ------- |
| 1   | Probe reports root causes, not cascades                 |      tooling | none    |
| 2   | Pest `test()` and the traits of `uses()`                |         ~130 | low     |
| 3   | `$this` in a trait: the members of its hosts            |          ~85 | medium  |
| 4   | `$this` in an anonymous class                           |          ~35 | low     |
| 5   | Closure parameters without a declared callable          |         ~130 | low     |
| 6   | Untyped properties from their assignments               |          ~85 | medium  |
| 7   | Untyped parameters from the method they override        | part of ~280 | low     |
| 8   | Repository results (`parent::create()`, `$this->model`) |          ~45 | low     |
| 9   | `morphTo()` relations                                   |          ~45 | medium  |
| 10  | Higher-order collection proxies (`->each->delete()`)    |          ~30 | low     |
| 11  | API resources (`$this->…` in a `JsonResource`)          |          ~20 | medium  |
| 12  | Model factories found through `newFactory()`            |          ~15 | low     |
| 13  | Mockery and Laravel's `mock()`                          |          ~25 | low     |
| 14  | Faker provider methods                                  |          ~20 | low     |
| 15  | Query builder chains that break mid-way                 |         ~140 | unknown |

Together about 1,000 of the 1,396. What stays is listed under "Not planned".

## Work items

### 0. Commit the pending round

Done: factory `hasX()`/`forX()`, `scopeQuery()` closures, join closures with
a non-literal table (1,396 → 1,318 on Bagisto, Inspect Code unchanged).
Still to do: update `PROGRESS.md` (it says 1,570).

### 1. Make the probe report root causes

Today the probe counts every unresolved call, so one untyped `$qb` shows up as
ten `where`/`orderBy` lines and the list hides what to fix.

- In `scratchpad/probe_resolve.rs` (temporary, never committed): for each
  unresolved call, walk left along the chain and keep only the **first**
  unresolved link; print the receiver's expression and its hover type.
- Group by receiver kind: variable (parameter, loop, assignment), property,
  call result, `$this`.
- Run once before the work and once after. The grouped list also settles
  item 15 and corrects the estimates in the table.

### 2. Pest: `test()` and the traits of `uses()`

`test()->createSimpleProduct()`, `test()->setConfig(…)`, `test()->mock(…)`.

- `test()` called without arguments in a Pest file is the bound test case:
  answer it in `ExprTypes` beside `pest_class` (`types/expr.rs`), as
  `Resolver::pest_test_case(path)` gives it.
- The traits a `uses(TestCase::class, CreatesProducts::class)->in(…)` or
  `pest()->use(…)` binds add their members to `$this`. `PestUses.classes`
  already stores them in order; `pest_test_case` returns only the first class.
  Return the class plus the traits, and type `$this` as their intersection
  (`TestCase&CreatesProducts`), so completion, goto and Inspect Code see both.
- Tests: `navigate/tests/pest.rs`. Docs: the Pest section of
  `architecture.md` (removes its last "not done").

### 3. `$this` in a trait

`$this->postJson(…)` in `tests/Concerns/ProductTestBench.php`,
`$this->validateRow(…)` in a trait whose host declares it.

- When a member isn't found on a trait, look at the classes that use it:
  `Declarations::direct_subclasses` (check that the index's subclass table
  records trait uses; add them if not, with a schema bump), plus the Pest
  bindings of item 2.
- Use a member only when every host (or their common parent) has it; with no
  host, stay unknown. Cap the number of hosts looked at (say 16).
- This is resolution only. `PhpUndefinedMethod` already stays quiet on
  traits; confirm it still does and that nothing new is reported.
- Cache per trait in `TypeCache`: this is asked for on every `$this->` in a
  trait.

### 4. `$this` in an anonymous class

`$this->relocate(…)` inside `return new class extends Migration { … }`
doesn't resolve, although the method is declared a few lines below. Find out
why goto definition fails there (the type side has `anonymous_class` and
`anonymous_property` in `types/expr.rs`; `navigate` may not use them for
methods) and fix it for definition, hover, completion and Find Usages.
Probably a bug, not a feature.

### 5. Closure parameters without a declared callable

All through the existing `closure_parameters` hook of the Laravel provider.
The pending round makes it reach closures with no string before them.

- **Nested query closures:** `$query->where(function ($q) { … })`,
  `orWhere`, `whereNested`, `when`, `having`, `whereHas` without a known
  relation: `$q` is the receiver's own builder type. Also when the receiver
  is unknown and the method is one of the query builder's (then the plain
  query builder).
- **Validation rules:** `Rule::unique(…)->where(function ($query) { … })`
  and `Rule::exists(…)`: the query builder.
- **Collections:** `filter`, `map`, `each`, `first`, `contains`, `reject`,
  `sortBy`… on a collection whose item type is known already work through the
  documented callable. Check the cases that don't (Eloquent collections from
  relations of proxy models, fixed by `883ea35b`) with the new probe before
  adding anything.
- **Event and bus fakes:** `Event::assertDispatched(Foo::class, function
  ($event) { … })`: the event class named by the first argument. Same for
  `Bus::assertDispatched`, `Queue::assertPushed`, `Mail::assertSent`,
  `Notification::assertSentTo`.

### 6. Untyped properties from their assignments

`$this->queryBuilder`, `$this->reader`, `$this->customerGroups` — declared
without a type or PHPDoc, assigned in a method other than the constructor, or
in a subclass.

- The summary already records what a class's methods assign to its properties
  (`PropertySite.assigned`); the core uses the constructor, the PHPUnit
  provider `setUp()`. Extend the core rule: a property with no hint, no
  `@var` and no usable default takes the union of the assignments in any
  method of the declaring class, capped at four members.
- Then the subclasses: when the declaring class assigns nothing (Bagisto's
  `DataGrid::$queryBuilder`, set by each grid's `prepareQueryBuilder()`), the
  union of what its direct subclasses assign, only if they agree on one class.
- Risk: a wider type can make `PhpUndefinedMethod` or `PhpParams` report
  where they were silent. Types from this rule are "inferred, not declared":
  check how the inspections treat inferred-return types today and give these
  the same confidence. The Inspect Code baselines decide.

### 7. Untyped parameters from the method they override

`public function processFilter($queryBuilder, $requestedValues)` in a
subclass of a class or interface that types or documents the parameter.

- A parameter with no hint and no `@param` takes the type of the same
  position in the method it overrides or implements (nearest declaration
  with a type). The `TypeProvider::parameter` hook exists; do this in the
  core, in the class model, so it works without Laravel.
- Not planned here: inferring a parameter from its call sites (a whole-project
  analysis; too slow for a request path).

### 8. Repository results

- `parent::create($data)` and `$this->find($id)` inside a repository: the
  Prettus finder table needs the repository's model, which it takes from the
  receiver. For `parent::` the receiver is the abstract base, which has no
  `model()`. Resolve `parent`/`self`/`static`/`$this` receivers against the
  class the call is in (`Context::self_class`).
- `$this->model` in a Prettus repository is its model (it is declared
  `@var Model`). Needs a hook for a _declared_ property; `magic_property`
  only covers undeclared ones. Add a provider step that may refine a declared
  property's type by class, as `parameter` does for parameters.
- `$this->model::orderBy(…)`: a static call on an instance expression; check
  that it types as the instance's class.

### 9. `morphTo()` relations

`$orderItem->product` is `?Model` because `product()` is `morphTo()`.

- Candidates, in order: the models that declare the inverse
  (`morphMany(OrderItem::class, 'product')`, `morphOne`, `morphToMany`); the
  classes of `Relation::morphMap([...])` / `enforceMorphMap`; else the one
  model whose short name matches the relation (`product` → `Product`,
  through Concord's contract when there is one).
- The result is the union of the candidates, nullable. The name match is a
  heuristic: use it only when exactly one model matches, and say "by name" in
  hover, as hover already says where a column comes from.
- Extraction: inverse morph relations and morph maps are new Laravel facts
  (`summary/laravel.rs`, schema bump).

### 10. Higher-order collection proxies

`$sections->each->delete()`, `->map->count()`, `->filter->isActive()`.

- A property of a collection named like one of its proxied methods (`each`,
  `map`, `filter`, `reject`, `sum`, `sortBy`, `first`, `contains`…) is
  `HigherOrderCollectionProxy`. Carry the item type as a generic argument
  (as the guard name is carried for `auth()`), and list the item's members
  as magic members of the proxy; the call returns the collection for `each`,
  `filter`, `reject`, a collection of the method's return for `map`, and the
  natural scalar for the rest.

### 11. API resources

`$this->getTypeInstance()` and `$this->tax_rates` in a `JsonResource`.

- The resource's model, in order: its `@mixin` (already works); the type of
  the argument where the project constructs it (`new ProductResource($p)`,
  `ProductResource::collection($products)`) — new indexed facts; else the one
  model whose name the resource's name starts with (`ProductResource` →
  `Product`), marked "by name".
- Then `$this->x` forwards to that model for properties, methods and members,
  as the model contracts do.

### 12. Model factories through `newFactory()`

`CartItem::factory()->adjustProduct()`: Bagisto's models name their factory
in `newFactory()` (`return CartItemFactory::new();`) and its factories live in
package namespaces, so the naming convention doesn't find them.

- `LaravelProvider::factory_of`: first what `newFactory()` returns, then the
  factory whose `$model` property or `@extends Factory<Model>` names the
  model, then the convention.

### 13. Mockery and Laravel's `mock()`

- `$this->mock(Foo::class)`, `partialMock`, `spy` (and through `test()`, item
  2): `Foo&MockInterface`; their closure argument gets `MockInterface`.
- `Mockery::mock(Foo::class)`: the same.
- `shouldReceive('x')->andReturn(…)`: check the chain resolves once the mock
  is typed (Mockery documents these); add nothing if it does.

### 14. Faker provider methods

`fake()->state()`, `$this->faker->state()`: `Faker\Generator` documents only
part of its formatters. For a method the generator doesn't have, look for a
public method of that name in `Faker\Provider\*` (the base providers and
those of the locale in `config('app.faker_locale')`) and forward to it.

### 15. Query builder chains that break mid-way

About fifteen samples are a builder method in the middle of a chain
(`->select(DB::raw(1))`, `->from('product_categories')`, `->limit(1)`), with
no cause visible from the line. Don't guess: read the root causes from the
new probe (item 1). Expected culprits, to confirm: `when()`/`unless()`/`tap()`
returning an unbound template, `DB::table()` on a connection obtained through
a helper, sub-query closures, and receivers from item 6 or 7.

## Order and how to work

One branch state, one schema bump, measured at the ends rather than after
every item.

1. Item 0, then item 1 and a baseline run of the new probe on both apps.
2. Core, no framework knowledge: 4, 7, 6, 3.
3. Pest and tests: 2, 13, 14.
4. Laravel: 5, 8, 12, 10, 9, 11.
5. Item 15, from the probe's root-cause list after the rest.
6. One `SCHEMA_VERSION` bump for everything that changes summaries (3, 6, 9,
   11), golden snapshots updated once.

Each item gets unit tests that fail without it, next to the existing ones
(`types/provider/laravel_tests.rs`, `navigate/tests/pest.rs`,
`types/expr/tests.rs`, `frameworks/laravel/refs/eloquent_tests.rs`). One
commit per item, so a regression can be reverted alone.

## Checks at the end

- `cargo test -p ide-php`, `cargo test -p ide-host php`, clippy clean.
- The probe on Bagisto and Monica: target under 500 unresolved on Bagisto,
  under 100 on Monica.
- Inspect Code on both apps: the same problems as now (182 and 201), compared
  per inspection and per line, not only by count. Any new problem is either a
  true positive to list or a regression to fix before the commit stays.
- `real_app_checklist` on both apps.
- Performance: Inspect Code times on both apps within 10 % of today's
  (Bagisto about 8 s parallel, 44 s one by one), and `pnpm perf:rust` within
  budget. Items 3, 6 and 11 add index lookups on hot paths; cache them per
  modification count.
- In the running app: completion, hover and goto on one example of each item
  in Bagisto.
- Docs: `laravel.md` (features and limits), `architecture.md` (Pest, traits,
  untyped properties and parameters), one `PROGRESS.md` entry.

## Risks

- **False warnings.** Every new type gives the inspections more to check.
  Items 3, 6, 9 and 11 infer rather than read; a wrong inference becomes a
  wrong warning. Mitigation: unions instead of guesses, "exactly one
  candidate" for name matches, and the Inspect Code baselines as the gate.
- **Speed.** Host lookups for traits and subclass lookups for properties run
  on common paths. Mitigation: per-class caches in `TypeCache`, caps on the
  number of hosts and subclasses.
- **Heuristics by name** (items 9 and 11) can be wrong in a project that
  doesn't follow the convention. They apply only when nothing better exists
  and exactly one class matches, and hover says so.
- **The estimates.** They come from 150 samples. Item 1 replaces them with
  counts before the rest starts; drop any item that turns out to cover fewer
  than ten calls.

## Not planned

- Parameters typed from their call sites, and variables that are only ever
  assigned from untyped data (`$data['product']->inventories()`).
- Dynamic calls: `$model->{$relation}()`, `method_exists($x, 'getKey') ?
  $x->getKey()`.
- Third-party SDKs without types (Razorpay's magic properties, PayPal's
  response objects).
- Array shapes of event payloads (`$payload['invoice']->is(…)`).
