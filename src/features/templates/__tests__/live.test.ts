import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { snippet } from "@codemirror/autocomplete";
import { languages } from "@codemirror/language-data";
import { completedSyntaxState } from "@/test/syntax";
import {
  applicableTemplates,
  bodyVariables,
  evaluateExpression,
  expandTemplate,
  formatDate,
  parseBody,
  type LiveTemplate,
} from "../live/model";
import { BUILTIN_TEMPLATES } from "../live/builtins";
import { mergeTemplates } from "../live/store";
import { enclosingName, suggestVariableName, templateFunctions } from "../editorContext";

/** Applies a snippet template to a state and returns the resulting text and selection. */
function apply(doc: string, tpl: string, from: number, to = from) {
  let state = EditorState.create({ doc, extensions: [EditorState.allowMultipleSelections.of(true)] });
  snippet(tpl)({ state, dispatch: (tr) => (state = tr.state) }, null, from, to);
  return { text: state.doc.toString(), sel: state.selection.ranges.map((r) => [r.from, r.to]) };
}

async function stateFor(lang: string, doc: string) {
  const desc = languages.find((l) => l.name === lang)!;
  const support = await desc.load();
  const state = completedSyntaxState(EditorState.create({ doc, extensions: [support] }));
  return state;
}

describe("template parsing", () => {
  it("splits variables, END, SELECTION and $$", () => {
    expect(parseBody("a $X$ $$ $END$ $SELECTION$ $ b")).toEqual([
      { t: "text", v: "a " },
      { t: "var", name: "X" },
      { t: "text", v: " $ " },
      { t: "end" },
      { t: "text", v: " " },
      { t: "selection" },
      { t: "text", v: " $ b" },
    ]);
    expect(bodyVariables("for ($I$ = 0; $I$ < $N$; $I$++) $END$")).toEqual(["I", "N"]);
  });
});

describe("expressions", () => {
  it("evaluates calls, literals and references", () => {
    const fns = { className: () => "UserService" };
    expect(evaluateExpression("className()", fns)).toBe("UserService");
    expect(evaluateExpression('capitalize("abc")', {})).toBe("Abc");
    expect(evaluateExpression("snakeCase(className())", fns)).toBe("user_service");
    expect(evaluateExpression("camelCase(NAME)", {}, { NAME: "foo-bar" })).toBe("fooBar");
    expect(evaluateExpression("unknownFn()", {})).toBe("");
    expect(evaluateExpression("broken(", {})).toBe("");
  });

  it("formats dates", () => {
    const d = new Date(2026, 0, 5, 9, 7, 3);
    expect(formatDate(d)).toBe("2026-01-05");
    expect(formatDate(d, "dd.MM.yy HH:mm:ss")).toBe("05.01.26 09:07:03");
  });
});

describe("expansion", () => {
  it("numbers stops, links repeats and ends at $END$", () => {
    const e = expandTemplate({
      body: "for (let $I$ = 0; $I$ < $N$; $I$++) {\n\t$END$\n}",
      variables: [{ name: "I", defaultValue: '"i"' }],
    });
    expect(e.snippet).toBe("for (let ${1:i} = 0; ${1:i} < ${2}; ${1:i}++) \\{\n\t${0}\n\\}");
    const r = apply("", e.snippet, 0);
    expect(r.text).toBe("for (let i = 0; i < ; i++) {\n  \n}");
    // All occurrences of the first field are selected together (linked editing).
    expect(r.sel).toEqual([
      [9, 10],
      [16, 17],
      [22, 23],
    ]);
  });

  it("appends the final caret when $END$ is missing", () => {
    expect(expandTemplate({ body: "console.log()" }).snippet).toBe("console.log()${0}");
  });

  it("inlines skipIfDefined values and keeps empty ones as stops", () => {
    const fns = { className: () => "Foo", methodName: () => "" };
    const e = expandTemplate(
      {
        body: 'System.out.println("$C$.$M$");',
        variables: [
          { name: "C", expression: "className()", skipIfDefined: true },
          { name: "M", expression: "methodName()", skipIfDefined: true },
        ],
      },
      { fns },
    );
    expect(e.snippet).toBe('System.out.println("Foo.${1}");${0}');
  });

  it("flags complete() on the first stop", () => {
    expect(expandTemplate({ body: "$T$ x", variables: [{ name: "T", expression: "complete()" }] }).completeFirst).toBe(
      true,
    );
  });

  it("flags completing stops in tab order", () => {
    const e = expandTemplate({
      body: "update $table$ set $col$ = $value$ where $END$",
      variables: [
        { name: "table", expression: "dbObjectName()" },
        { name: "col", expression: "complete()" },
        { name: "value" },
      ],
    });
    expect(e.completing).toEqual([true, true, false]);
  });

  it("indents $SELECTION$ lines relative to the template", () => {
    const e = expandTemplate(
      { body: "if ($C$) {\n\t$SELECTION$\n}$END$" },
      { selection: "foo();\n    if (x) {\n        bar();\n    }", selectionIndent: "    " },
    );
    const doc = "    foo();";
    const r = apply(doc, e.snippet, 4, doc.length);
    expect(r.text).toBe("    if () {\n      foo();\n      if (x) {\n          bar();\n      }\n    }");
  });

  it("escapes braces from selections and predefined values", () => {
    const e = expandTemplate({ body: "($EXPR$)$END$" }, { predefined: { EXPR: "{a: 1}" } });
    expect(apply("", e.snippet, 0).text).toBe("({a: 1})");
  });

  it("filters by context and scope", () => {
    const ts = applicableTemplates(BUILTIN_TEMPLATES, "typescript");
    expect(ts.some((t) => t.abbrev === "log")).toBe(true);
    expect(ts.some((t) => t.abbrev === "todo")).toBe(true);
    expect(ts.some((t) => t.abbrev === "psvm")).toBe(false);
    const inComment = applicableTemplates(BUILTIN_TEMPLATES, "typescript", { inCommentOrString: true });
    expect(inComment.map((t) => t.abbrev)).toContain("todo");
    expect(inComment.map((t) => t.abbrev)).not.toContain("log");
  });

  it("ships the requested built-ins", () => {
    const has = (lang: string, abbrev: string) =>
      applicableTemplates(BUILTIN_TEMPLATES, lang).some((t) => t.abbrev === abbrev);
    for (const a of ["fn", "test", "impl", "match", "ifl", "derive"]) expect(has("rust", a)).toBe(true);
    for (const a of ["log", "fori", "iter", "arrow", "imp", "describe", "it"])
      expect(has("typescriptreact", a)).toBe(true);
    for (const a of ["main", "def", "class", "ifmain", "with", "try"]) expect(has("python", a)).toBe(true);
    for (const a of ["iferr", "fori", "func", "test"]) expect(has("go", a)).toBe(true);
    for (const a of ["psvm", "sout", "fori", "iter", "main"]) expect(has("java", a)).toBe(true);
    for (const a of ["main", "fun", "val", "sout"]) expect(has("kotlin", a)).toBe(true);
    for (const a of ["todo", "fixme"]) expect(has("go", a)).toBe(true);
    for (const a of ["fore", "forek", "pubf", "prisf", "thr", "eco", "rqro"]) expect(has("php", a)).toBe(true);
    expect(has("java", "fore")).toBe(false);
  });

  it("writes PHP variables with their $", () => {
    const php = (abbrev: string) => BUILTIN_TEMPLATES.find((t) => t.id === `php.${abbrev}`)!;
    const fore = apply("", expandTemplate(php("fore")).snippet, 0);
    expect(fore.text).toBe("foreach ( as $value) {\n  \n}");
    // The caret starts on the iterable.
    expect(fore.sel[0]).toEqual([9, 9]);
    expect(apply("", expandTemplate(php("forek")).snippet, 0).text).toBe("foreach ( as $key => $value) {\n  \n}");
    expect(apply("", expandTemplate(php("prosf")).snippet, 0).text).toBe("protected static function ()\n{\n  \n}");
  });

  it("merges user edits, deletions and user templates", () => {
    const user: LiveTemplate = {
      id: "user.x",
      group: "User",
      abbrev: "zz",
      description: "",
      body: "z",
      contexts: ["any"],
    };
    const edited = { ...BUILTIN_TEMPLATES[0]!, body: "edited" };
    const merged = mergeTemplates(BUILTIN_TEMPLATES, {
      templates: { [edited.id]: edited, [user.id]: user },
      deleted: [BUILTIN_TEMPLATES[1]!.id],
    });
    expect(merged.find((t) => t.id === edited.id)?.body).toBe("edited");
    expect(merged.some((t) => t.id === BUILTIN_TEMPLATES[1]!.id)).toBe(false);
    expect(merged.at(-1)).toBe(user);
  });
});

describe("editor context", () => {
  it("finds enclosing class and method via the syntax tree", async () => {
    const java = "class Foo {\n  void bar() {\n    int x;\n  }\n}";
    const s = await stateFor("Java", java);
    const pos = java.indexOf("int x");
    expect(enclosingName(s, pos, "class")).toBe("Foo");
    expect(enclosingName(s, pos, "func")).toBe("bar");

    const rust = "struct A;\nimpl Display for A {\n    fn fmt(&self) {\n        x\n    }\n}";
    const r = await stateFor("Rust", rust);
    expect(enclosingName(r, rust.indexOf("x\n"), "class")).toBe("A");
    expect(enclosingName(r, rust.indexOf("x\n"), "func")).toBe("fmt");

    const py = "class Svc:\n    def run(self):\n        pass\n";
    const p = await stateFor("Python", py);
    expect(enclosingName(p, py.indexOf("pass"), "class")).toBe("Svc");
    expect(enclosingName(p, py.indexOf("pass"), "func")).toBe("run");
  });

  it("falls back to text scanning without a parser", () => {
    const s = EditorState.create({ doc: "class Widget {\n  fun draw() {\n    x\n" });
    expect(enclosingName(s, s.doc.length, "class")).toBe("Widget");
    expect(enclosingName(s, s.doc.length, "func")).toBe("draw");
  });

  it("binds file and comment functions", async () => {
    const s = await stateFor("Rust", "fn main() {\n    \n}");
    const fns = templateFunctions({ state: s, pos: 16, path: "/p/src/main.rs", language: "rust", user: "ann" });
    expect(fns.fileName!()).toBe("main.rs");
    expect(fns.fileNameWithoutExtension!()).toBe("main");
    expect(fns.user!()).toBe("ann");
    expect(fns.commentStart!()).toBe("// ");
  });

  it("suggests variable names", () => {
    expect(suggestVariableName("user.getName()", "java")).toBe("name");
    expect(suggestVariableName("new ArrayList<>()", "java")).toBe("arrayList");
    expect(suggestVariableName("self.items.iter()", "rust")).toBe("items");
    expect(suggestVariableName("loadUserProfile(id)", "python")).toBe("load_user_profile");
    expect(suggestVariableName("fetchUsers()", "typescript")).toBe("fetchUsers");
    expect(suggestVariableName("42", "typescript")).toBe("value");
  });
});
