import { describe, expect, it } from "vitest";
import { applicableTemplates, expandTemplate } from "../live/model";
import { parseJetBrainsTemplates, type TemplateLanguage } from "../live/jetbrains";

const languages: TemplateLanguage[] = [
  { id: "python", name: "Python", uiMode: "Python" },
  { id: "java", name: "Java", uiMode: "Java" },
  { id: "c", name: "C", uiMode: "C" },
  { id: "cpp", name: "C++", uiMode: "C++" },
  { id: "javascript", name: "JavaScript", uiMode: "JavaScript" },
  { id: "javascriptreact", name: "JavaScript JSX", uiMode: "JSX" },
  { id: "typescript", name: "TypeScript", uiMode: "TypeScript" },
  { id: "typescriptreact", name: "TypeScript JSX", uiMode: "TSX" },
  { id: "shellscript", name: "Shell Script", uiMode: "Shell" },
  { id: "json", name: "JSON", uiMode: "JSON" },
  { id: "jsonc", name: "JSON with Comments", uiMode: "JSON" },
  { id: "plaintext", name: "Plain Text", uiMode: null },
  { id: "properties", name: "Properties", uiMode: "Properties files" },
  { id: "ini", name: "INI", uiMode: "Properties files" },
];

const template = (name: string, value: string, contexts: string) =>
  `<template name="${name}" description="${name} description" value="${value}"><context>${contexts}</context></template>`;
const context = (name: string, value = "true") => `<option name="${name}" value="${value}" />`;

describe("JetBrains live-template XML", () => {
  it("imports Python templates with IDEA bodies, variables and language contexts", () => {
    const xml =
      '<templateSet name="Python">' +
      template(
        "iter",
        "for $ITEM$ in $ITEMS$:&#10;&#9;$END$",
        context("PYTHON") + context("JAVA", "false") + context("Brainfuck", "false"),
      ).replace(
        "</template>",
        '<variable name="ITEM" expression="suggestVariableName()" defaultValue="&quot;item&quot;" alwaysStopAt="false" />' +
          '<variable name="ITEMS" expression="completeSmart()" defaultValue="&quot;items&quot;" alwaysStopAt="true" />' +
          "</template>",
      ) +
      template("main", "if __name__ == &quot;__main__&quot;:$END$", context("Python")) +
      "</templateSet>";
    const parsed = parseJetBrainsTemplates({ "templates/Python.xml": xml }, languages);
    expect(parsed.invalid).toEqual([]);
    expect(parsed.skipped).toEqual([]);
    expect(parsed.unsupported).toEqual([]);
    expect(parsed.templates).toHaveLength(2);
    const iter = parsed.templates[0]!;
    expect(iter).toEqual({
      id: "jetbrains.Python.iter",
      group: "Python",
      abbrev: "iter",
      description: "iter description",
      body: "for $ITEM$ in $ITEMS$:\n\t$END$",
      contexts: ["python"],
      variables: [
        { name: "ITEM", expression: "suggestVariableName()", defaultValue: '"item"', skipIfDefined: true },
        { name: "ITEMS", expression: "completeSmart()", defaultValue: '"items"' },
      ],
    });
    expect(applicableTemplates(parsed.templates, "python").map((t) => t.abbrev)).toEqual(["iter", "main"]);
    expect(expandTemplate(iter, { fns: { suggestVariableName: () => "item" } }).preview).toBe("for item in items:\n\t");
  });

  it("trims template names for stable ids and abbreviations", () => {
    const parsed = parseJetBrainsTemplates(
      {
        "templates/Python.xml":
          '<templateSet name="Python">' + template(" iter ", "$END$", context("Python")) + "</templateSet>",
      },
      languages,
    );
    expect(parsed.templates[0]).toMatchObject({ id: "jetbrains.Python.iter", abbrev: "iter" });
  });

  it("maps common JetBrains context names through the language metadata", () => {
    const cases: [string, string[]][] = [
      ["C/C++", ["c", "cpp"]],
      ["JavaScript", ["javascript", "javascriptreact"]],
      ["TypeScript", ["typescript", "typescriptreact"]],
      ["JSON", ["json", "jsonc"]],
      ["Text", ["plaintext"]],
      ["JSX", ["javascriptreact"]],
      ["Shell", ["shellscript"]],
    ];
    const xml =
      '<templateSet name="Web">' +
      cases.map(([name], i) => template(`t${i}`, "$END$", context(name))).join("") +
      "</templateSet>";
    const parsed = parseJetBrainsTemplates({ "templates/Web.xml": xml }, languages);
    expect(parsed.skipped).toEqual([]);
    expect(parsed.templates.map((t) => t.contexts)).toEqual(cases.map(([, ids]) => ids));
  });

  it("maps the context ids IDEA writes to their languages", () => {
    const cases: [string, string[]][] = [
      ["JAVA_CODE", ["java"]],
      ["JAVA_STATEMENT", ["java"]],
      ["Python_Class", ["python"]],
      ["JAVA_SCRIPT", ["javascript", "javascriptreact"]],
      ["JS_STATEMENT", ["javascript", "javascriptreact"]],
      ["TS_EXPRESSION", ["typescript", "typescriptreact"]],
      ["SHELL_SCRIPT", ["shellscript"]],
      ["JSON_PROPERTY_KEYS", ["json", "jsonc"]],
      ["OC_STATEMENT", ["c", "cpp"]],
      ["OTHER", ["any"]],
    ];
    const xml =
      '<templateSet name="Ids">' +
      cases.map(([name], i) => template(`t${i}`, "$END$", context(name))).join("") +
      "</templateSet>";
    const parsed = parseJetBrainsTemplates({ "templates/Ids.xml": xml }, languages);
    expect(parsed.skipped).toEqual([]);
    expect(parsed.templates.map((t) => t.contexts)).toEqual(cases.map(([, ids]) => ids));
  });

  it("reads the group IDEA writes on templateSet", () => {
    const parsed = parseJetBrainsTemplates(
      {
        "templates/My_Java.xml":
          '<templateSet group="My Java">' + template("logd", "$END$", context("JAVA_STATEMENT")) + "</templateSet>",
      },
      languages,
    );
    expect(parsed.templates[0]).toMatchObject({ id: "jetbrains.My_Java.logd", group: "My Java" });
  });

  it("expands comment and string templates outside code and keeps deactivated ones disabled", () => {
    const xml =
      '<templateSet name="Java">' +
      template("todo", "// TODO $END$", context("JAVA_COMMENT")) +
      template("code", "$END$", context("JAVA_CODE")) +
      template("off", "$END$", context("JAVA_CODE")).replace("<template ", '<template deactivated="true" ') +
      "</templateSet>";
    const [todo, code, off] = parseJetBrainsTemplates({ "templates/Java.xml": xml }, languages).templates;
    expect(todo).toMatchObject({ contexts: ["java"], scope: "any" });
    expect(code!.scope).toBeUndefined();
    expect(code!.enabled).toBeUndefined();
    expect(off).toMatchObject({ abbrev: "off", enabled: false });
  });

  it("reports unknown, absent and disabled contexts instead of making them global", () => {
    const xml =
      '<templateSet name="Mixed">' +
      template("unknown", "$END$", context("Brainfuck")) +
      template("mixed", "$END$", context("Python") + context("Brainfuck")) +
      template("maven", "$END$", context("MAVEN")) +
      '<template name="absent" value="$END$" />' +
      template("disabled", "$END$", context("Python", "false")) +
      "</templateSet>";
    const parsed = parseJetBrainsTemplates({ "templates/Mixed.xml": xml }, languages);
    expect(parsed.templates).toHaveLength(1);
    expect(parsed.templates[0]).toMatchObject({ abbrev: "mixed", contexts: ["python"] });
    expect(parsed.templates[0]!.contexts).not.toContain("any");
    expect(parsed.skipped).toHaveLength(5);
    expect(parsed.skipped.join("\n")).toContain("Brainfuck");
    expect(parsed.skipped.join("\n")).toContain("MAVEN");
    expect(parsed.skipped.join("\n")).toContain("absent");
    expect(parsed.skipped.join("\n")).toContain("disabled");
  });

  it("reports malformed files and updates stable ids without duplicating templates", () => {
    const first = parseJetBrainsTemplates(
      {
        "templates/Python.xml":
          '<templateSet name="Python">' +
          template("same", "first $NAME$$END$", context("Python")) +
          template("same", "second $NAME$$END$", context("Python")) +
          "</templateSet>",
        "templates/broken.xml": "<templateSet>",
      },
      languages,
    );
    expect(first.invalid).toEqual(["templates/broken.xml"]);
    expect(first.templates).toHaveLength(1);
    expect(first.templates[0]).toMatchObject({ id: "jetbrains.Python.same", body: "second $NAME$$END$" });

    const again = parseJetBrainsTemplates(
      {
        "templates/Python.xml":
          '<templateSet name="Python">' + template("same", "updated $END$", context("Python")) + "</templateSet>",
      },
      languages,
    );
    expect(again.templates).toHaveLength(1);
    expect(again.templates[0]).toMatchObject({ id: first.templates[0]!.id, body: "updated $END$" });
  });

  it("preserves unsupported macro expressions and defaults, and reports that they cannot run", () => {
    const xml =
      '<templateSet name="Python">' +
      template("macro", "$VALUE$$END$", context("Python")).replace(
        "</template>",
        '<variable name="VALUE" expression="groovyScript(&quot;return 1&quot;)" defaultValue="&quot;fallback&quot;" />' +
          '<variable name="BROKEN" expression="broken(" />' +
          "</template>",
      ) +
      "</templateSet>";
    const parsed = parseJetBrainsTemplates({ "templates/Python.xml": xml }, languages);
    expect(parsed.templates[0]!.variables).toEqual([
      { name: "VALUE", expression: 'groovyScript("return 1")', defaultValue: '"fallback"' },
      { name: "BROKEN", expression: "broken(" },
    ]);
    expect(parsed.unsupported).toEqual([
      "templates/Python.xml › Python › macro › VALUE: groovyScript",
      "templates/Python.xml › Python › macro › BROKEN: broken(",
    ]);
    expect(expandTemplate(parsed.templates[0]!).preview).toBe("fallback");
  });
});
