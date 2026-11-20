import { describe, expect, it } from "vitest";
import {
  definitionInsertions,
  matchesStep,
  snippetStyle,
  stepDefinitions,
  stepSnippet,
  type FeatureStep,
} from "./steps";

const step = (text: string): FeatureStep => ({
  from: 0,
  to: 0,
  keyword: "Given ",
  type: "Given",
  text,
  matchText: text,
});

const apply = (text: string, insertions: { at: number; text: string }[]) =>
  [...insertions].sort((a, b) => b.at - a.at).reduce((out, i) => out.slice(0, i.at) + i.text + out.slice(i.at), text);

describe("behave steps", () => {
  const BEHAVE = `from behave import given, then

@given('an empty cart')
def step_impl(context):
    pass

@given(u"a cart with {count:d} items")
def step_impl(context, count):
    pass

@then('the total is {amount:f} {currency}')
def step_impl(context, amount, currency):
    pass

use_step_matcher("re")

@when(r'^I remove (?P<count>\\d+) items?$')
def step_impl(context, count):
    pass

@step("""I check out""")
def step_impl(context):
    pass
`;

  it("reads parse formats, and regular expressions after use_step_matcher", () => {
    const defs = stepDefinitions(BEHAVE, "features/steps/cart_steps.py");
    expect(defs.map((d) => d.source)).toEqual([
      "an empty cart",
      "a cart with {count:d} items",
      "the total is {amount:f} {currency}",
      "^I remove (?P<count>\\d+) items?$",
      "I check out",
    ]);
    const [empty, count, total, remove, checkout] = defs;
    expect(BEHAVE.slice(count!.from, count!.to)).toBe('u"a cart with {count:d} items"');
    expect(matchesStep(empty!, step("an empty cart"))).toBe(true);
    expect(matchesStep(empty!, step("an empty cart now"))).toBe(false);
    expect(matchesStep(count!, step("a cart with 3 items"))).toBe(true);
    expect(matchesStep(count!, step("a cart with three items"))).toBe(false);
    expect(matchesStep(total!, step("the total is 3.50 EUR"))).toBe(true);
    expect(matchesStep(remove!, step("I remove 2 items"))).toBe(true);
    expect(matchesStep(remove!, step("I remove all items"))).toBe(false);
    // `use_step_matcher("re")` stays in effect: a plain string is a regular expression.
    expect(matchesStep(checkout!, step("I check out"))).toBe(true);
  });

  it("writes a pending step_impl and imports the decorator", () => {
    expect(snippetStyle("features/steps/cart_steps.py", BEHAVE)).toBe("behave");
    const snippet = stepSnippet("When", "I pay {gift} 'now'", "behave");
    expect(snippet.text).toBe(
      [
        "@when('I pay {{gift}} \\'now\\'')",
        "def step_impl(context):",
        "    raise NotImplementedError('STEP: When I pay {gift} \\'now\\'')",
        "",
      ].join("\n"),
    );
    const { insertions, select } = definitionInsertions(BEHAVE, "When", snippet, "behave");
    const out = apply(BEHAVE, insertions);
    expect(out.startsWith("from behave import given, then, when\n")).toBe(true);
    expect(out.endsWith(`    pass\n\n\n${snippet.text}`)).toBe(true);
    expect(out.split("\n")[select.line]!.slice(select.from, select.to)).toMatch(/^raise NotImplementedError/);
    const created = stepDefinitions(out, "steps.py").find((d) => d.source.startsWith("I pay"))!;
    expect(created).toBeDefined();
  });

  it("matches a created step's braces literally", () => {
    const text = `from behave import when\n\n${stepSnippet("When", "I pay {gift}", "behave").text}`;
    const [created] = stepDefinitions(text, "steps.py");
    expect(matchesStep(created!, step("I pay {gift}"))).toBe(true);
  });
});

describe("pytest-bdd steps", () => {
  const PYTEST_BDD = `from pytest_bdd import given, parsers, scenarios, when

scenarios("cart.feature")

@given("there are {count} cucumbers")
def literal():
    pass

@given(parsers.parse("I have {start:d} cucumbers"), target_fixture="cucumbers")
def start(start):
    return start

@when(parsers.re(r"I eat (?P<eat>\\d+) cucumbers"))
def eat(cucumbers, eat):
    pass
`;

  it("matches plain strings exactly and parsers by their kind", () => {
    const [literal, start, eat] = stepDefinitions(PYTEST_BDD, "tests/test_cart.py");
    expect(matchesStep(literal!, step("there are {count} cucumbers"))).toBe(true);
    expect(matchesStep(literal!, step("there are 5 cucumbers"))).toBe(false);
    expect(matchesStep(start!, step("I have 12 cucumbers"))).toBe(true);
    expect(matchesStep(eat!, step("I eat 5 cucumbers"))).toBe(true);
    expect(matchesStep(eat!, step("I eat 5 cucumbers today"))).toBe(false);
  });

  it("writes an anonymous pending step", () => {
    expect(snippetStyle("tests/test_cart.py", PYTEST_BDD)).toBe("pytest-bdd");
    const snippet = stepSnippet("Then", "I have {count} cucumbers", "pytest-bdd");
    expect(snippet.text).toBe(
      ["@then('I have {count} cucumbers')", "def _():", "    raise NotImplementedError", ""].join("\n"),
    );
    const { insertions } = definitionInsertions(PYTEST_BDD, "Then", snippet, "pytest-bdd");
    const out = apply(PYTEST_BDD, insertions);
    expect(out.startsWith("from pytest_bdd import given, parsers, scenarios, when, then\n")).toBe(true);
    const created = stepDefinitions(out, "tests/test_cart.py").at(-1)!;
    expect(matchesStep(created, step("I have {count} cucumbers"))).toBe(true);
  });
});
