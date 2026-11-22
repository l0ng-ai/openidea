import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import {
  ATTRIBUTES,
  CLEAR_COLOR,
  SCHEMES,
  _setSchemeSource,
  overrideDeclarations,
  resolvedAttribute,
  schemeAfterThemeChange,
  schemeCss,
  schemeTokens,
} from "./colorScheme";
import { fontWeightVars, validateEditorExtras } from "./editorSettings";
import type { Settings } from "./ipc";
import { useProject } from "./project";
import { installColorScheme } from "@/editor/core/colorSchemeRuntime";

describe("color schemes", () => {
  beforeAll(() => _setSchemeSource(readFileSync("src/styles/tokens.css", "utf8")));
  it("reads resolved scheme tokens from tokens.css", () => {
    expect(schemeTokens("light").get("--syn-keyword")).toBe("#0033b3");
    expect(schemeTokens("dark").get("--syn-keyword")).toBe("#cf8e6d");
    expect(schemeTokens("light").get("--bg-editor")).not.toMatch(/var\(/);
    const dark = schemeTokens("dark");
    expect(dark.get("--syn-python-builtin")).toBe("#8888c6");
    expect(dark.get("--syn-python-predefined-definition")).toBe("#b200b2");
    expect(dark.get("--syn-python-predefined-usage")).toBe("#b200b2");
    expect(dark.get("--syn-python-instance-attribute")).toBe("#bcbec4");
    expect(dark.get("--syn-python-fstring")).toBe("#a5c261");
    expect(dark.get("--syn-python-bytes")).toBe("#a5c261");
  });

  it.each(["light", "dark"] as const)("inherits new doc tokens for older %s custom schemes", (parent) => {
    const customs = { "custom-old": { name: "Old", parent, attributes: {} } };
    for (const id of ["docCommentTag", "docCommentTagValue", "docCommentMarkup"])
      expect(resolvedAttribute("custom-old", id, customs)).toEqual(resolvedAttribute(parent, id));
  });

  it("gives PHP variables and function calls their own colours, as PhpStorm (#1532)", () => {
    expect(schemeTokens("dark").get("--syn-php-variable")).toBe("#c77dbb");
    expect(schemeTokens("dark").get("--syn-php-function-call")).toBe("#56a8f5");
    expect(schemeTokens("light").get("--syn-php-variable")).toBe("#871094");
    expect(schemeTokens("light").get("--syn-php-function-call")).toBe("#00627a");
    const css = readFileSync("src/styles/tokens.css", "utf8");
    expect(css).toMatch(
      /\.cm-editor\[data-language="PHP"\],\s*\.cm-editor \[data-language="PHP"\] \{\s*--syn-variable: var\(--syn-php-variable\);/,
    );
    // An imported PHP_VAR still wins: language overrides are emitted for the same element, !important.
    const imported = schemeCss(
      "theme-default",
      { dark: { "php.identifier": { foreground: "#48d8ee" } } },
      document.documentElement,
    );
    expect(imported).toMatch(
      /\.cm-editor\[data-language="PHP"\], \.cm-editor \[data-language="PHP"\] \{\n {2}--syn-variable: #48d8ee !important;/,
    );
  });

  it("reports the italic static symbols and PHP static fields the editor draws by default (#4493)", () => {
    for (const scheme of ["dark", "light"]) {
      expect(resolvedAttribute(scheme, "staticSymbol").italic).toBe(true);
      expect(resolvedAttribute(scheme, "php.staticField").italic).toBe(true);
    }
  });

  it("keeps an imported scheme's gutter on its editor background unless it sets its own", () => {
    const customs = (gutter?: string) => ({
      "custom-a": {
        name: "A",
        parent: "dark" as const,
        attributes: { text: { background: "#2b2b2b" }, ...(gutter ? { gutter: { background: gutter } } : {}) },
      },
    });
    expect(schemeCss("custom-a", undefined, document.documentElement, customs())).toContain(
      "--bg-editor-gutter: #2b2b2b !important;",
    );
    expect(schemeCss("custom-a", undefined, document.documentElement, customs("#313335"))).toContain(
      "--bg-editor-gutter: #313335 !important;",
    );
  });

  it("offers a Go scheme page and scopes its overrides to Go editors", () => {
    expect(ATTRIBUTES.find((a) => a.id === "go.constant")?.path).toEqual(["Go"]);
    const css = schemeCss("dark", { dark: { "go.constant": { foreground: "#224466" } } });
    expect(css).toContain('.cm-editor[data-language="Go"]');
    // A Go code block in a Markdown editor (#3808).
    expect(css).toContain('.cm-editor [data-language="Go"]');
    expect(css).toContain("--syn-constant: #224466 !important");
  });

  it("offers a JavaScript and TypeScript page whose Decorator leaves other languages' Metadata alone (#4059)", () => {
    const page = ATTRIBUTES.filter((a) => a.path[0] === "JavaScript and TypeScript").map((a) => a.id);
    expect(page).toEqual(
      expect.arrayContaining(["javascript.decorator", "javascript.globalVariable", "javascript.globalFunction"]),
    );
    expect(page).not.toContain("javascript.metadata");
    const css = schemeCss("dark", {
      dark: { "javascript.decorator": { foreground: "#224466" }, "javascript.globalFunction": { italic: true } },
    });
    for (const editor of ["JavaScript", "JSX", "TypeScript", "TSX", "Angular TypeScript"])
      expect(css).toContain(`.cm-editor[data-language="${editor}"]`);
    expect(css).not.toContain('data-language="Kotlin"');
    expect(css).toContain("--syn-decorator: #224466 !important");
    expect(css).toContain("--syn-global-function-italic: italic !important");
    expect(css).not.toMatch(/:root \{[^}]*--syn-decorator/);
  });

  it("splits Predefined symbol into types and functions and keeps literals apart from Constant (#4059)", () => {
    for (const [child, parent] of [
      ["predefinedType", "predefined"],
      ["predefinedFunction", "predefined"],
      ["literalKeyword", "keyword"],
      ["kotlin.predefinedType", "kotlin.predefined"],
      ["kotlin.literalKeyword", "kotlin.keyword"],
    ] as const)
      expect(resolvedAttribute("dark", child)).toEqual(resolvedAttribute("dark", parent));
    expect(resolvedAttribute("dark", "kotlin.literalKeyword")).not.toEqual(
      resolvedAttribute("dark", "kotlin.constant"),
    );
    // A language's Predefined symbol still reaches unset types and functions: they are not set on :root.
    const css = schemeCss("dark", { dark: { "kotlin.predefined": { foreground: "#224466" } } });
    expect(css).not.toContain("--syn-builtin-type");
    const split = schemeCss("dark", {
      dark: {
        "kotlin.predefinedType": { foreground: "#bcbec4" },
        "kotlin.predefinedFunction": { foreground: "#56a8f5" },
      },
    });
    expect(split).toContain("--syn-builtin-type: #bcbec4 !important");
    expect(split).toContain("--syn-builtin-function: #56a8f5 !important");
  });

  it("shows an unset Global function in the function declaration style, then its own (#4059)", () => {
    const fn = resolvedAttribute("dark", "functionDeclaration");
    expect(resolvedAttribute("dark", "javascript.globalFunction")).toEqual(fn);
    const customs = {
      "custom-g": {
        name: "G",
        parent: "dark" as const,
        attributes: { functionDeclaration: { foreground: "#123456" }, "javascript.globalFunction": { italic: true } },
      },
    };
    expect(resolvedAttribute("custom-g", "javascript.globalFunction", customs)).toMatchObject({
      foreground: "#123456",
      italic: true,
    });
  });

  it("offers a C# scheme page and scopes its overrides to C# editors", () => {
    expect(ATTRIBUTES.find((a) => a.id === "csharp.className")?.path).toEqual(["C#"]);
    const css = schemeCss("dark", { dark: { "csharp.keyword": { foreground: "#224466" } } });
    expect(css).toContain('.cm-editor[data-language="C#"]');
    expect(css).toContain("--syn-keyword: #224466 !important");
  });

  it("offers a Julia scheme page and scopes Julia overrides to Julia editors", () => {
    expect(ATTRIBUTES.find((a) => a.id === "julia.functionCall")?.path).toEqual(["Julia"]);
    expect(ATTRIBUTES.find((a) => a.id === "julia.className")?.path).toEqual(["Julia"]);
    const css = schemeCss("dark", {
      dark: { "julia.functionCall": { foreground: "#224466" }, "julia.className": { italic: true } },
    });
    expect(css).toContain('.cm-editor[data-language="Julia"]');
    expect(css).toContain('.cm-editor [data-language="Julia"]');
    expect(css).toContain("--syn-function-call: #224466 !important");
    expect(css).toContain("--syn-type-italic: italic !important");
    expect(css.indexOf('.cm-editor[data-language="Julia"]')).toBeGreaterThan(css.indexOf(":root"));
  });

  it("groups Python attributes as PyCharm's color settings page does", () => {
    const python = (name: string) => ATTRIBUTES.find((a) => a.id === `py${name}`)!;
    expect(python("Number").name).toBe("Number");
    expect(python("Keyword").name).toBe("Keyword");
    expect(python("LineComment").name).toBe("Line comment");
    expect(python("String").name).toBe("String › Text (unicode)");
    expect(python("ValidEscape").name).toBe("String › Escape sequence › Valid");
    expect(python("InvalidEscape").name).toBe("String › Escape sequence › Invalid");
    expect(python("FString").name).toBe("String › f-string › Expression braces");
    expect(python("Bytes").name).toBe("String › Binary (bytes)");
    expect(python("Docstring").name).toBe("Docstring › Text");
    expect(python("OperationSign").name).toBe("Braces and Operators › Operation sign");
    expect(python("Parentheses").name).toBe("Braces and Operators › Parentheses");
    expect(python("FunctionDeclaration").name).toBe("Functions › Function definition");
    expect(python("FunctionCall").name).toBe("Functions › Function call");
    expect(python("MethodCall").name).toBe("Functions › Method call");
    expect(python("NestedFunction").name).toBe("Functions › Nested function definition");
    expect(python("Parameter").name).toBe("Parameters › Parameter");
    expect(python("Self").name).toBe("Parameters › 'self' parameter");
    expect(python("KeywordArg").name).toBe("Keyword argument");
    expect(python("PredefinedDefinition").name).toBe("Special names › Definition");
    expect(python("PredefinedUsage").name).toBe("Special names › Usage");
    expect(python("Builtin").name).toBe("Special names › Built-in name");
    expect(python("Decorator").name).toBe("Special names › Decorator");
    expect(python("ClassDefinition").name).toBe("Classes › Class definition");
    expect(python("LocalVariable").name).toBe("Identifiers › Local variables");
    expect(python("GlobalVariable").name).toBe("Identifiers › Global variable");
    // Attribute ids (the override and .icls keys) keep their old, stable names.
    for (const a of ATTRIBUTES.filter((a) => a.path[0] === "Python")) {
      expect(a.id).toMatch(/^py[A-Z]/);
      expect(a.language).toBe("Python");
    }
  });

  it("scopes Python overrides to Python editors and falls back to the shared token like JetBrains", () => {
    // Shared token: a Python override lands in the language block, not on :root.
    expect(ATTRIBUTES.find((a) => a.id === "pyKeyword")?.token).toBe("keyword");
    const css = schemeCss("dark", { dark: { pyKeyword: { foreground: "#224466" } } });
    expect(css).toContain('.cm-editor[data-language="Python"]');
    expect(css).toContain("--syn-keyword: #224466 !important");
    expect(css.indexOf('.cm-editor[data-language="Python"]')).toBeGreaterThan(css.indexOf(":root"));
    // Unset values resolve through the shared scheme token, as JetBrains' fallback keys do.
    expect(resolvedAttribute("dark", "pyKeyword")).toMatchObject({ foreground: "#cf8e6d" });
  });

  it("re-resolves Python fallback tokens inside the Python block, as PY.METHOD_CALL falls back to PY.FUNCTION_CALL", () => {
    const block = (css: string) => css.slice(css.indexOf('.cm-editor[data-language="Python"]'));
    // `--syn-python-method-call: var(--syn-function-call)` is computed on :root; the Python block re-declares it.
    const call = block(schemeCss("dark", { dark: { pyFunctionCall: { foreground: "#d56075" } } }));
    expect(call).toContain("--syn-function-call: #d56075 !important");
    expect(call).toContain("--syn-python-method-call: var(--syn-function-call) !important");
    expect(call).not.toContain("--syn-python-nested-function");
    // PY.NESTED_FUNC_DEFINITION falls back to PY.FUNC_DEFINITION.
    const definition = block(schemeCss("dark", { dark: { pyFunctionDeclaration: { foreground: "#123456" } } }));
    expect(definition).toContain("--syn-python-nested-function: var(--syn-function) !important");
    // A Method call colour of its own wins.
    const own = block(
      schemeCss("dark", {
        dark: { pyFunctionCall: { foreground: "#d56075" }, pyMethodCall: { foreground: "#abcdef" } },
      }),
    );
    expect(own).toContain("--syn-python-method-call: #abcdef !important");
    expect(own).not.toContain("--syn-python-method-call: var(");
    // Font style alone leaves the colour following Function call.
    const bold = block(
      schemeCss("dark", { dark: { pyFunctionCall: { foreground: "#d56075" }, pyMethodCall: { bold: true } } }),
    );
    expect(bold).toContain("--syn-python-method-call: var(--syn-function-call) !important");
    // The other shared-token fallbacks follow too.
    const shared = block(
      schemeCss("dark", {
        dark: { pyOperationSign: { foreground: "#111111" }, pyClassDefinition: { foreground: "#222222" } },
      }),
    );
    for (const token of ["parentheses", "brackets", "braces"])
      expect(shared).toContain(`--syn-python-${token}: var(--syn-punct) !important`);
    for (const token of ["type-parameter", "annotation"])
      expect(shared).toContain(`--syn-python-${token}: var(--syn-type) !important`);
    // Only fallbacks the scheme declares: dark's f-string braces have a colour of their own, light's follow strings.
    const string = { pyString: { foreground: "#333333" } };
    expect(block(schemeCss("dark", { dark: string }))).not.toContain("--syn-python-fstring");
    expect(block(schemeCss("light", { light: string }))).toContain(
      "--syn-python-fstring: var(--syn-string) !important",
    );
    // Language Defaults overrides stay on :root, where the fallbacks already see them.
    expect(schemeCss("dark", { dark: { functionCall: { foreground: "#d56075" } } })).not.toContain("data-language");
  });

  it("applies an imported scheme's Python Function call to method calls", () => {
    const customs = {
      "custom-pycharm": {
        name: "PyCharm",
        parent: "dark" as const,
        attributes: { pyFunctionCall: { foreground: "#d56075" } },
      },
    };
    const css = schemeCss("custom-pycharm", undefined, undefined, customs);
    expect(css.slice(css.indexOf('.cm-editor[data-language="Python"]'))).toContain(
      "--syn-python-method-call: var(--syn-function-call) !important",
    );
    expect(resolvedAttribute("custom-pycharm", "pyMethodCall", customs).foreground).toBe("#d56075");
    expect(resolvedAttribute("dark", "pyMethodCall").foreground).toBe(
      resolvedAttribute("dark", "pyFunctionCall").foreground,
    );
  });

  it("lets derived tokens follow the overrides of a scheme that isn't the theme's own", () => {
    const root = (css: string) => css.slice(0, css.indexOf("}"));
    const customs = {
      "custom-pycharm": {
        name: "PyCharm",
        parent: "dark" as const,
        attributes: { functionCall: { foreground: "#6dacff" }, identifier: { foreground: "#112233" } },
      },
    };
    const imported = root(schemeCss("custom-pycharm", undefined, undefined, customs));
    expect(imported).toContain("--syn-function-call: #6dacff !important");
    expect(imported).toContain("--syn-python-method-call: #6dacff !important");
    expect(imported).toContain(`--syn-php-function-call: ${schemeTokens("dark").get("--syn-function")} !important`);
    // Through a chain of fallbacks: Python globals follow globals, which follow local variables.
    expect(imported).toContain("--syn-global: #112233 !important");
    expect(imported).toContain("--syn-python-global-variable: #112233 !important");
    expect(resolvedAttribute("custom-pycharm", "pyMethodCall", customs).foreground).toBe("#6dacff");
    expect(resolvedAttribute("custom-pycharm", "functionCall", customs).foreground).toBe("#6dacff");

    // A derived token with a colour of its own keeps it, whether the scheme or the user sets it,
    // and the tokens derived from it follow that colour.
    const own = { ...customs["custom-pycharm"].attributes, globalVariable: { foreground: "#abcdef" } };
    const withOwn = { "custom-pycharm": { ...customs["custom-pycharm"], attributes: own } };
    const scheme = root(schemeCss("custom-pycharm", undefined, undefined, withOwn));
    expect(scheme).toContain("--syn-global: #abcdef !important");
    expect(scheme).toContain("--syn-python-global-variable: #abcdef !important");
    expect(resolvedAttribute("custom-pycharm", "globalVariable", withOwn).foreground).toBe("#abcdef");
    expect(resolvedAttribute("custom-pycharm", "pyGlobalVariable", withOwn).foreground).toBe("#abcdef");
    const user = { "custom-pycharm": { globalVariable: { foreground: "#fedcba" } } };
    const userOwn = root(schemeCss("custom-pycharm", user, undefined, customs));
    expect(userOwn).toContain("--syn-global: #fedcba !important");
    expect(userOwn).toContain("--syn-python-global-variable: #fedcba !important");

    // The user's Language Defaults overrides under an explicitly chosen built-in scheme.
    const light = root(schemeCss("light", { light: { functionCall: { foreground: "#d56075" } } }));
    expect(light).toContain("--syn-python-method-call: #d56075 !important");
    expect(light.match(/--syn-function-call:/g)).toHaveLength(1);

    // The theme's own scheme writes no tokens: tokens.css derives them on :root itself.
    expect(schemeCss("dark", { dark: { functionCall: { foreground: "#d56075" } } })).not.toContain(
      "--syn-python-method-call",
    );
  });

  it("resolves scheme attribute state and editor defaults", () => {
    expect(resolvedAttribute("light", "lineComment")).toMatchObject({
      foreground: "#8c8c8c",
      italic: true,
    });
    expect(resolvedAttribute("dark", "lineComment")).toMatchObject({
      foreground: "#7a7e85",
      italic: false,
    });
    expect(resolvedAttribute("dark", "mdHeading")).toMatchObject({ bold: true });

    const customs = {
      "custom-test": {
        name: "Test",
        parent: "dark" as const,
        attributes: {
          todo: { foreground: "#139839", background: "#101010", bold: true, italic: false, effect: "wave" as const },
        },
      },
    };
    expect(resolvedAttribute("custom-test", "todo", customs)).toMatchObject({
      foreground: "#139839",
      background: "#101010",
      bold: true,
      italic: false,
      effect: "wave",
    });
  });

  it("resolves package references from the editor foreground and emits their overrides", () => {
    for (const theme of ["light", "dark", "dark-hc"] as const) {
      expect(resolvedAttribute(theme, "packageReference").foreground).toBe(schemeTokens(theme).get("--fg-editor"));
    }
    const css = schemeCss("dark", { dark: { packageReference: { foreground: "#446688", italic: true } } });
    expect(css).toContain("--syn-namespace: #446688 !important");
    expect(css).toContain("--syn-namespace-italic: italic !important");
  });

  it("emits scheme and override declarations", () => {
    const root = document.documentElement;
    root.dataset.theme = "light";
    expect(schemeCss("theme-default", undefined, root)).toBe("");
    const dark = schemeCss("dark", undefined, root);
    expect(dark).toContain("--syn-keyword: #cf8e6d !important");
    const over = schemeCss("theme-default", { light: { keyword: { foreground: "#ff0000", bold: true } } }, root);
    expect(over).toContain("--syn-keyword: #ff0000 !important");
    // Explicit Bold / regular follow Typography Settings' bold / main weight.
    expect(over).toContain("--syn-keyword-bold: var(--fw-code-bold, 700) !important");
    const regular = schemeCss("theme-default", { light: { keyword: { bold: false } } }, root);
    expect(regular).toContain("--syn-keyword-bold: var(--fw-code, 400) !important");
    const cleared = schemeCss("theme-default", { light: { keyword: { background: CLEAR_COLOR } } }, root);
    expect(cleared).toContain("--syn-keyword-bg: transparent !important");
    // An unticked Foreground falls back to the default text colour instead of hiding the text.
    const noForeground = schemeCss("theme-default", { light: { predefined: { foreground: CLEAR_COLOR } } }, root);
    expect(noForeground).toContain("--syn-builtin: var(--fg-editor) !important");
    const upright = schemeCss("theme-default", { light: { staticSymbol: { italic: false } } }, root);
    expect(upright).toContain("--syn-static-italic: normal !important");
    const pythonItalic = schemeCss("theme-default", { light: { pyStaticSymbol: { italic: true } } }, root);
    expect(pythonItalic).toContain("--syn-python-static-italic: italic !important");
  });

  it("mirrors Console Colors ANSI overrides to the terminal palette (#2698)", () => {
    expect(ATTRIBUTES.filter((a) => a.path[0] === "Console Colors")).toHaveLength(17);
    const root = document.documentElement;
    root.dataset.theme = "light";
    const css = schemeCss(
      "theme-default",
      {
        light: {
          ansiRed: { foreground: "#aa0000" },
          consoleBackground: { background: "#101010" },
        },
      },
      root,
    );
    expect(css).toContain("--ansi-red: #aa0000 !important");
    expect(css).toContain("--terminal-ansi-red: #aa0000 !important");
    expect(css).toContain("--bg-console: #101010 !important");
  });

  it("leaves selected text in syntax colours until a selection foreground is set (#2446)", () => {
    expect(ATTRIBUTES.find((a) => a.id === "selectionForeground")).toMatchObject({
      name: "Selection foreground",
      path: ["General", "Editor"],
      fg: "--fg-editor-selection",
    });
    // The `inherit` default is not a colour: the settings page shows no foreground.
    expect(resolvedAttribute("light", "selectionForeground")).toEqual({});
    expect(resolvedAttribute("dark", "selectionForeground")).toEqual({});
    const customs = {
      "custom-sel": {
        name: "Sel",
        parent: "dark" as const,
        attributes: { selectionForeground: { foreground: "#112233" } },
      },
    };
    expect(resolvedAttribute("custom-sel", "selectionForeground", customs)).toMatchObject({
      foreground: "#112233",
    });
    expect(schemeCss("dark", { dark: { selectionForeground: { foreground: "#112233" } } })).toContain(
      "--fg-editor-selection: #112233 !important",
    );
  });

  it.each([
    ["identifierUnderCaret", "--fg-identifier-under-caret"],
    ["identifierUnderCaretWrite", "--fg-identifier-under-caret-write"],
  ])("lets %s set a foreground over the syntax colours (#4109)", (id, token) => {
    expect(ATTRIBUTES.find((a) => a.id === id)?.fg).toBe(token);
    // The `inherit` default is no colour: every built-in scheme keeps the syntax colours.
    for (const scheme of SCHEMES) expect(resolvedAttribute(scheme.id, id).foreground).toBeUndefined();
    expect(schemeCss("dark", { dark: { [id]: { foreground: "#112233" } } })).toContain(`${token}: #112233 !important`);
    // Unticked, the syntax colours show again rather than one flat default text colour.
    expect(schemeCss("dark", { dark: { [id]: { foreground: CLEAR_COLOR } } })).toContain(
      `${token}: inherit !important`,
    );
  });

  // #3851: the editor showed the red-green colours while Color Scheme showed the plain ones.
  it("resolves the red-green variant of the bundled schemes only", () => {
    const rg = (id: Parameters<typeof schemeTokens>[0], name: string) => schemeTokens(id, undefined, true).get(name);
    // The reporter's screenshot: keyword, string, function, number, constant.
    expect(
      ["--syn-keyword", "--syn-string", "--syn-function", "--syn-number", "--syn-constant"].map((n) => rg("dark", n)),
    ).toEqual(["#597cc2", "#94907f", "#d9af6c", "#66a6ff", "#828eba"]);
    expect(rg("light", "--syn-keyword")).toBe("#00428c");
    for (const id of ["dark-hc", "solarized-dark"] as const)
      expect(rg(id, "--syn-keyword")).toBe(schemeTokens(id).get("--syn-keyword"));
    // VCS colours follow the setting in every scheme.
    expect(rg("dark-hc", "--gutter-added")).not.toBe(schemeTokens("dark-hc").get("--gutter-added"));
    expect(schemeTokens("dark").get("--syn-keyword")).toBe("#cf8e6d");
    expect(resolvedAttribute("dark", "keyword", {}, true).foreground).toBe("#597cc2");
    const customs = { "custom-rg": { name: "Mine", parent: "dark" as const, attributes: {} } };
    expect(resolvedAttribute("custom-rg", "keyword", customs, true).foreground).toBe("#cf8e6d");
  });

  it("gives an explicit bundled scheme its red-green variant", () => {
    const root = document.documentElement;
    root.dataset.theme = "light";
    root.dataset.redGreen = "";
    try {
      expect(schemeCss("dark", undefined, root)).toContain("--syn-keyword: #597cc2 !important");
      delete root.dataset.redGreen;
      expect(schemeCss("dark", undefined, root)).toContain("--syn-keyword: #cf8e6d !important");
    } finally {
      delete root.dataset.redGreen;
    }
  });

  it("applies an explicit scheme over a plugin theme of the same base", () => {
    const root = document.documentElement;
    root.dataset.theme = "dark";
    root.dataset.pluginTheme = "theme-one/one-dark";
    try {
      // "Theme default" keeps the plugin theme's own editor colours.
      expect(schemeCss("theme-default", undefined, root)).toBe("");
      expect(schemeCss("dark", undefined, root)).toContain("--syn-keyword: #cf8e6d !important");
      delete root.dataset.pluginTheme;
      expect(schemeCss("dark", undefined, root)).toBe("");
    } finally {
      delete root.dataset.pluginTheme;
    }
  });

  it("re-applies the scheme when a plugin theme of the same base is selected", async () => {
    const root = document.documentElement;
    root.dataset.theme = "dark";
    const previous = useProject.getState().settings;
    useProject.setState({ settings: { editor: { colorScheme: "dark" } } as unknown as Settings });
    const dispose = installColorScheme();
    const sheet = () => document.getElementById("openidea-editor-color-scheme")?.textContent ?? "";
    try {
      expect(sheet()).toBe("");
      root.dataset.pluginTheme = "theme-one/one-dark";
      await Promise.resolve();
      expect(sheet()).toContain("--syn-keyword: #cf8e6d !important");
    } finally {
      dispose();
      delete root.dataset.pluginTheme;
      useProject.setState({ settings: previous });
    }
  });

  it("switches a chosen scheme of the other kind back to the theme's own when the theme turns light or dark", async () => {
    expect(schemeAfterThemeChange("solarized-dark", "light")).toBe("theme-default");
    expect(schemeAfterThemeChange("solarized-light", "light")).toBeNull();
    expect(schemeAfterThemeChange("theme-default", "light")).toBeNull();
    const customs = { "custom-night": { name: "Night", parent: "dark" as const, attributes: {} } };
    expect(schemeAfterThemeChange("custom-night", "light", customs)).toBe("theme-default");
    expect(schemeAfterThemeChange("custom-night", "dark", customs)).toBeNull();

    const root = document.documentElement;
    root.dataset.theme = "dark";
    const previous = useProject.getState().settings;
    const scheme = () => useProject.getState().settings?.editor?.colorScheme;
    useProject.setState({ settings: { editor: { colorScheme: "solarized-dark" } } as unknown as Settings });
    const dispose = installColorScheme();
    try {
      root.dataset.theme = "light";
      await Promise.resolve();
      expect(scheme()).toBe("theme-default");
      // A dark scheme chosen under the light theme stays until the theme changes again.
      useProject.setState({ settings: { editor: { colorScheme: "dark" } } as unknown as Settings });
      root.dataset.colorTheme = "solarized-light";
      await Promise.resolve();
      expect(scheme()).toBe("dark");
      root.dataset.theme = "dark";
      await Promise.resolve();
      expect(scheme()).toBe("dark");
      // A scheme chosen in the same change as the theme (one Apply) goes with it.
      await new Promise((r) => setTimeout(r));
      useProject.setState({ settings: { editor: { colorScheme: "solarized-dark" } } as unknown as Settings });
      root.dataset.theme = "light";
      await Promise.resolve();
      expect(scheme()).toBe("solarized-dark");
      // A later theme change on its own still switches it back.
      await new Promise((r) => setTimeout(r));
      root.dataset.theme = "dark";
      await Promise.resolve();
      root.dataset.theme = "light";
      await Promise.resolve();
      expect(scheme()).toBe("theme-default");
    } finally {
      dispose();
      delete root.dataset.colorTheme;
      useProject.setState({ settings: previous });
    }
  });

  it("keeps editor weights out of the schemes", () => {
    for (const id of ["light", "dark", "dark-hc"] as const) {
      expect(schemeTokens(id).has("--fw-code")).toBe(false);
      expect(schemeTokens(id).has("--syn-keyword-bold")).toBe(false);
    }
    // Dark schemes bold matched braces with the configured bold weight, even under the light theme.
    expect(schemeTokens("dark").get("--matched-brace-weight")).toBe("var(--fw-code-bold)");
    expect(schemeTokens("light").get("--matched-brace-weight")).toBe("inherit");
    const root = document.documentElement;
    root.dataset.theme = "light";
    expect(schemeCss("dark", undefined, root)).toContain("--matched-brace-weight: var(--fw-code-bold) !important");
  });

  it("sets the configured weights on the root and follows settings changes", () => {
    const root = document.documentElement;
    useProject.setState({ settings: { editor: { fontWeight: 300, boldFontWeight: 800 } } as unknown as Settings });
    const dispose = installColorScheme();
    expect([root.style.getPropertyValue("--fw-code"), root.style.getPropertyValue("--fw-code-bold")]).toEqual([
      "300",
      "800",
    ]);
    useProject.setState({ settings: { editor: {} } as unknown as Settings });
    expect([root.style.getPropertyValue("--fw-code"), root.style.getPropertyValue("--fw-code-bold")]).toEqual([
      "400",
      "700",
    ]);
    dispose();
    expect(root.style.getPropertyValue("--fw-code")).toBe("");
  });

  it("validates Typography Settings weights", () => {
    const d = validateEditorExtras({});
    expect([d.fontWeight, d.boldFontWeight]).toEqual([400, 700]);
    const v = validateEditorExtras({ fontWeight: 349, boldFontWeight: 1200 });
    expect([v.fontWeight, v.boldFontWeight]).toEqual([350, 900]);
    expect(validateEditorExtras({ fontWeight: "bold" }).fontWeight).toBe(400);
    expect(fontWeightVars(500, undefined)).toEqual({ "--fw-code": "500", "--fw-code-bold": "700" });
    expect(fontWeightVars(450, 650)).toEqual({ "--fw-code": "450", "--fw-code-bold": "650" });
  });

  it("coerces editor settings to their defaults' shape", () => {
    const v = validateEditorExtras({
      tabs: { tabLimit: "x", placement: "none" },
      codeStyle: { languages: { go: { useTab: true } } },
    });
    expect(v.tabs.tabLimit).toBe(30);
    expect(v.tabs.placement).toBe("none");
    expect(v.codeStyle.languages.go).toEqual({ useTab: true });
    expect(v.general.softWrapFiles).toContain("*.md");
  });

  it("styles Errors and Warnings attributes beyond colour", () => {
    const decls = overrideDeclarations({
      error: { bold: true, italic: true, effect: "strikeout", effectColor: "#ff0000" },
      unused: { italic: true },
    });
    const map = new Map(decls);
    expect(map.get("--wave-error-bold")).toBe("var(--fw-code-bold, 700)");
    expect(map.get("--wave-error-italic")).toBe("italic");
    expect(map.get("--wave-error-effect")).toBe("line-through #ff0000");
    expect(map.get("--editor-error-decoration")).toBe("line-through #ff0000");
    expect(map.get("--wave-error")).toBe("#ff0000");
    expect(map.get("--fg-unused-italic")).toBe("italic");
    const none = new Map(overrideDeclarations({ warning: { effect: "none" }, deprecated: { effect: "underline" } }));
    expect(none.get("--editor-warning-decoration")).toBe("none");
    expect(none.get("--fg-deprecated-effect")).toBe("underline var(--fg-deprecated)");
  });

  it("keeps the font style of Errors and Warnings in custom schemes", () => {
    const customs = {
      "custom-x": {
        name: "X",
        parent: "dark" as const,
        attributes: { error: { bold: true }, deprecated: { effect: "underline" as const } },
      },
    };
    const css = schemeCss("custom-x", undefined, null, customs);
    expect(css).toContain("--wave-error-bold: var(--fw-code-bold, 700)");
    expect(css).toContain("--fg-deprecated-effect: underline var(--fg-deprecated)");
  });

  it("lists typo and deprecated symbol under Errors and Warnings", () => {
    const ids = ATTRIBUTES.filter((a) => a.path.join("/") === "General/Errors and Warnings").map((a) => a.id);
    expect(ids).toEqual(["error", "warning", "weakWarning", "typo", "unused", "deprecated", "invalid"]);
    expect(resolvedAttribute("dark", "typo")).toMatchObject({ effect: "wave" });
    expect(resolvedAttribute("dark", "deprecated")).toMatchObject({ effect: "strikeout", effectColor: "#8c8f95" });
    expect(resolvedAttribute("dark", "deprecated").foreground).toBeUndefined();
    expect(resolvedAttribute("dark", "error")).toMatchObject({ effect: "wave", bold: false, italic: false });
  });
});
