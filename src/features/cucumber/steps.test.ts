import { describe, expect, it } from "vitest";
import { definingKeyword, expressionRegExp, featureSteps, matchesStep, stepDefinitions, stepSnippet } from "./steps";

const STEPS = `import { Given, When, Then } from "@cucumber/cucumber";
import { createBdd } from "playwright-bdd";
const bdd = createBdd();

Given('an empty cart', async function () {});
When("I add {int} {string} to the cart", async (n: number, name: string) => {});
bdd.Then(/^the total is (\\d+(?:\\.\\d+)?) EUR$/, async () => {});
Then<World>(\`I see {word} item(s) in my basket/bag\`, () => {});
When(\`dynamic \${name}\`, () => {});
const isGiven = (x) => x; isGiven('not a step');
`;

const FEATURE = `# language: en
@cart
Feature: Cart

  Background:
    Given an empty cart

  Scenario: Add one
    When I add 2 "apples" to the cart
    Then the total is 3.50 EUR
    And I see 1 item in my bag
      """
      Given not a step
      """

  Scenario Outline: Add several
    When I add <count> "<fruit>" to the cart
    * I see <count> items in my basket

    Examples:
      | count | fruit |
      | 3     | pears |
      | 4     | plums |
`;

describe("Cucumber steps", () => {
  it("reads step definitions of @cucumber/cucumber and playwright-bdd", () => {
    const defs = stepDefinitions(STEPS);
    expect(defs.map((d) => d.source)).toEqual([
      "an empty cart",
      "I add {int} {string} to the cart",
      "^the total is (\\d+(?:\\.\\d+)?) EUR$",
      "I see {word} item(s) in my basket/bag",
    ]);
    // The range covers the literal, quotes included.
    expect(STEPS.slice(defs[0]!.from, defs[0]!.to)).toBe("'an empty cart'");
  });

  it("turns Cucumber expressions into anchored regular expressions", () => {
    const re = (e: string) => expressionRegExp(e)!;
    expect(re("I add {int} {string} to the cart").test('I add 12 "big apples" to the cart')).toBe(true);
    expect(re("I add {int} {string} to the cart").test('I add many "apples" to the cart')).toBe(false);
    expect(re("I have {float} cucumber(s)").test("I have 1.5 cucumbers")).toBe(true);
    expect(re("I have {float} cucumber(s)").test("I have 1 cucumber")).toBe(true);
    expect(re("my belly/stomach hurts").test("my stomach hurts")).toBe(true);
    expect(re("my belly/stomach hurts").test("my belly/stomach hurts")).toBe(false);
    expect(re("a {color} ball").test("a red ball")).toBe(true);
    expect(re("it costs \\(about\\) {int}$").test("it costs (about) 5$")).toBe(true);
    expect(re("a {} thing").test("a very odd thing")).toBe(true);
    expect(re("an empty cart").test("an empty cart today")).toBe(false);
    expect(expressionRegExp("broken {int")).toBeNull();
  });

  it("reads feature steps, skipping doc strings and filling outline placeholders", () => {
    const steps = featureSteps(FEATURE);
    expect(steps.map((s) => [s.keyword, s.matchText])).toEqual([
      ["Given", "an empty cart"],
      ["When", 'I add 2 "apples" to the cart'],
      ["Then", "the total is 3.50 EUR"],
      ["And", "I see 1 item in my bag"],
      ["When", 'I add 3 "pears" to the cart'],
      ["*", "I see 3 items in my basket"],
    ]);
    expect(FEATURE.slice(steps[4]!.from, steps[4]!.to)).toBe('I add <count> "<fruit>" to the cart');
  });

  it("matches every step to its definition", () => {
    const defs = stepDefinitions(STEPS);
    const matched = featureSteps(FEATURE).map((s) => defs.findIndex((d) => matchesStep(d, s)));
    expect(matched).toEqual([0, 1, 2, 3, 1, 3]);
  });
});

describe("stepSnippet", () => {
  const definitionOf = (snippet: { text: string }) => stepDefinitions(snippet.text)[0]!;
  const step = (text: string) => featureSteps(`Feature: f\n  Scenario: s\n    Given ${text}\n`)[0]!;

  it("turns strings and numbers into parameters and matches the step it was made for", () => {
    const snippet = stepSnippet("When", `I add 3 "red apples" for 2.5 EUR (each) to cart/basket`);
    expect(snippet.text.split("\n")[0]).toBe(
      `When('I add {int} {string} for {float} EUR \\\\(each\\\\) to cart\\\\/basket', async function (int, string, float) {`,
    );
    expect(snippet.text).toContain("return 'pending';");
    expect(snippet.text.split("\n")[snippet.body]).toBe("  return 'pending';");
    const definition = definitionOf(snippet);
    expect(matchesStep(definition, step(`I add 3 "red apples" for 2.5 EUR (each) to cart/basket`))).toBe(true);
    expect(matchesStep(definition, step(`I add 3 "red apples" for 2.5 EUR to cart`))).toBe(false);
  });

  it("numbers repeated parameter names and leaves digits inside words alone", () => {
    const snippet = stepSnippet("Given", "item2 costs 4 and 5 with 'it'");
    expect(snippet.text.split("\n")[0]).toBe(
      "Given('item2 costs {int} and {int} with {string}', async function (int, int2, string) {",
    );
    expect(matchesStep(definitionOf(snippet), step("item2 costs 4 and 5 with 'x'"))).toBe(true);
  });

  it("escapes quotes and keeps plain steps plain", () => {
    const snippet = stepSnippet("Then", "the user's cart is empty");
    expect(snippet.text.split("\n")[0]).toBe("Then('the user\\'s cart is empty', async function () {");
    expect(matchesStep(definitionOf(snippet), step("the user's cart is empty"))).toBe(true);
  });
});

describe("stepSnippet for playwright-bdd", () => {
  it("takes the fixtures first and has no pending return", () => {
    const snippet = stepSnippet("Then", "I see 2 items", "playwright-bdd");
    expect(snippet.text).toBe(
      "Then('I see {int} items', async ({}, int) => {\n  // Write code here that turns the phrase above into concrete actions\n});\n",
    );
    expect(snippet.body).toBe(1);
  });
});

describe("definingKeyword", () => {
  it("continues the previous primary keyword for And, But and *", () => {
    const steps = featureSteps(
      "Feature: f\n  Scenario: s\n    Given a\n    And b\n    When c\n    * d\n    Then e\n    But f\n",
    );
    expect(steps.map((s) => definingKeyword(steps, s))).toEqual(["Given", "Given", "When", "When", "Then", "Then"]);
  });
});
