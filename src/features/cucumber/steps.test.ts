import { describe, expect, it } from "vitest";
import {
  definingKeyword,
  definitionInsertions,
  expressionRegExp,
  featureSteps,
  gherkinLanguage,
  matchesStep,
  snippetStyle,
  stepDefinitions,
  stepSnippet,
} from "./steps";

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

describe("cucumber-jvm", () => {
  const step = (text: string) => featureSteps(`Feature: f\n  Scenario: s\n    Given ${text}\n`)[0]!;
  const JAVA = `package shop;

import io.cucumber.java.en.Given;
import io.cucumber.java.en.Then;

public class CartSteps {
    @Given("an empty cart")
    public void emptyCart() {}

    @Then("^the total is (\\\\d+\\\\.\\\\d+) EUR$")
    public void total(String amount) {}
}
`;

  it("reads annotation patterns, anchored strings as regular expressions", () => {
    const definitions = stepDefinitions(JAVA);
    expect(definitions.map((d) => d.source)).toEqual(["an empty cart", "^the total is (\\d+\\.\\d+) EUR$"]);
    expect(matchesStep(definitions[1]!, step("the total is 3.50 EUR"))).toBe(true);
    expect(matchesStep(definitions[0]!, step("an empty cart"))).toBe(true);
  });

  it("writes a Java method into the class with the keyword's import", () => {
    const snippet = stepSnippet("When", `I pay 12 "EUR" for 2.5 kg (net)`, "java");
    expect(snippet.text).toBe(
      [
        '    @When("I pay {int} {string} for {double} kg \\\\(net\\\\)")',
        "    public void i_pay_for_kg_net(Integer int1, String string, Double double1) {",
        "        // Write code here that turns the phrase above into concrete actions",
        "        throw new io.cucumber.java.PendingException();",
        "    }",
        "",
      ].join("\n"),
    );
    const { insertions, select } = definitionInsertions(JAVA, "When", snippet, "java");
    let out = JAVA;
    for (const i of [...insertions].sort((a, b) => b.at - a.at)) out = out.slice(0, i.at) + i.text + out.slice(i.at);
    expect(out).toContain("import io.cucumber.java.en.Then;\nimport io.cucumber.java.en.When;\n");
    expect(
      out.endsWith("    public void total(String amount) {}\n\n" + snippet.text.replace(/\n$/, "") + "\n}\n"),
    ).toBe(true);
    expect(out.split("\n")[select.line]!.slice(select.from, select.to)).toBe(
      "throw new io.cucumber.java.PendingException();",
    );
    const created = stepDefinitions(out).find((d) => d.source.startsWith("I pay"))!;
    expect(matchesStep(created, step(`I pay 12 "EUR" for 2.5 kg (net)`))).toBe(true);
  });

  it("writes Kotlin in camel case and escapes $", () => {
    const snippet = stepSnippet("Given", "a $5 coupon", "kotlin");
    expect(snippet.text.split("\n").slice(0, 2)).toEqual([
      '    @Given("a \\${int} coupon")',
      "    fun aCoupon(int1: Int) {",
    ]);
    expect(snippetStyle("src/test/kotlin/CartSteps.kt", "")).toBe("kotlin");
    expect(snippetStyle("steps/cart.steps.ts", "createBdd()")).toBe("playwright-bdd");
  });
});

describe("Gherkin languages", () => {
  it("reads the steps of a feature in its # language", async () => {
    const { GHERKIN_DIALECTS } = await import("./gherkinDialects");
    const zh = `# language: zh-CN
功能: 购物车

  场景大纲: 添加
    假如我有一个空购物车
    当我添加<数量>个苹果
    而且 价格是 3.50
    那么总数是<数量>

    例子:
      | 数量 |
      | 2    |
`;
    expect(gherkinLanguage(zh)).toBe("zh-CN");
    const steps = featureSteps(zh, GHERKIN_DIALECTS["zh-CN"]);
    expect(steps.map((s) => [s.keyword, s.type, s.text, s.matchText])).toEqual([
      ["假如", "Given", "我有一个空购物车", "我有一个空购物车"],
      ["当", "When", "我添加<数量>个苹果", "我添加2个苹果"],
      ["而且", "And", "价格是 3.50", "价格是 3.50"],
      ["那么", "Then", "总数是<数量>", "总数是2"],
    ]);
    expect(zh.slice(steps[0]!.from, steps[0]!.to)).toBe("我有一个空购物车");
    expect(steps.map((s) => definingKeyword(steps, s))).toEqual(["Given", "When", "When", "Then"]);

    const fr =
      "# language: fr\nFonctionnalité: Panier\n  Scénario: vide\n    Soit un panier vide\n    Et que j'ajoute 2 pommes\n";
    expect(featureSteps(fr, GHERKIN_DIALECTS.fr).map((s) => [s.type, s.text])).toEqual([
      ["Given", "un panier vide"],
      ["And", "j'ajoute 2 pommes"],
    ]);
  });

  it("finds no language in plain English files", () => {
    expect(gherkinLanguage("Feature: Cart\n# language: fr\n")).toBeNull();
    expect(gherkinLanguage("# a comment\n\n#language:de\nFunktionalität: x\n")).toBe("de");
  });
});
