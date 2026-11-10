import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import {
  _setSchemeSource,
  CLEAR_COLOR,
  customSchemes,
  effectiveScheme,
  listSchemes,
  SCHEMES,
  schemeCss,
} from "./colorScheme";
import { deleteScheme, exportIcls, importScheme, parseIcls } from "./icls";
import { validateSettings } from "@/features/settings/model/schema";
import { colorSchemeItems } from "@/workbench/quickSwitch";
import { useProject } from "./project";
import type { Settings } from "./ipc";
import { isClientSetting } from "./clientSettings";

const fixture = (name: string) => readFileSync(`src/platform/__fixtures__/colorSchemes/${name}.icls`, "utf8");
beforeAll(() => _setSchemeSource(readFileSync("src/styles/tokens.css", "utf8")));

describe(".icls schemes", () => {
  it("round trips Python docstring tags with the Python attribute key and keywords with an extension key", () => {
    const { scheme } = parseIcls(`<scheme name="Python docs"><attributes>
      <option name="PY.DOC_COMMENT_TAG"><value><option name="FOREGROUND" value="123456"/></value></option>
      <option name="OPENIDEA_pyDocstringKeyword"><value><option name="FOREGROUND" value="654321"/></value></option>
      </attributes></scheme>`);
    expect(scheme.attributes.pyDocstringTag?.foreground).toBe("#123456");
    expect(scheme.attributes.pyDocstringKeyword?.foreground).toBe("#654321");
    const xml = exportIcls("custom-python", { "custom-python": scheme });
    expect(xml).toContain('name="PY.DOC_COMMENT_TAG"');
    expect(xml).toContain('name="OPENIDEA_pyDocstringKeyword"');
    expect(xml).not.toContain("PY_DOC_COMMENT_TAG");
    expect(parseIcls(xml).scheme.attributes).toMatchObject(scheme.attributes);
  });

  it("round trips the selection foreground through SELECTION_FOREGROUND (#2446)", () => {
    const { scheme } = parseIcls(`<scheme name="Sel" parent_scheme="Default"><colors>
      <option name="SELECTION_BACKGROUND" value="214283"/>
      <option name="SELECTION_FOREGROUND" value="ffffff"/>
    </colors></scheme>`);
    expect(scheme.attributes.selection).toEqual({ background: "#214283" });
    expect(scheme.attributes.selectionForeground).toEqual({ foreground: "#ffffff" });
    const { id, customs } = importScheme({}, scheme);
    const xml = exportIcls(id, customs);
    expect(xml).toContain('<option name="SELECTION_FOREGROUND" value="ffffff" />');
    expect(parseIcls(xml).scheme.attributes.selectionForeground).toEqual({ foreground: "#ffffff" });
  });

  it("resolves explicit attribute inheritance independent of XML order and stops cycles", () => {
    const { scheme } = parseIcls(`<scheme name="Inherited"><attributes>
      <option name="PHP_PARAMETER" baseAttributes="PHP_VAR"/>
      <option name="PHP_VAR" baseAttributes="DEFAULT_IDENTIFIER"/>
      <option name="DEFAULT_IDENTIFIER"><value><option name="FOREGROUND" value="48d8ee"/></value></option>
      <option name="PHP_STRING" baseAttributes="PHP_NUMBER"/>
      <option name="PHP_NUMBER" baseAttributes="PHP_STRING"/>
      </attributes></scheme>`);
    expect(scheme.attributes["php.parameter"]).toEqual({ foreground: "#48d8ee", bold: false, italic: false });
    expect(scheme.attributes["php.identifier"]).toEqual(scheme.attributes["php.parameter"]);
    expect(scheme.attributes["php.string"]).toBeUndefined();
  });

  it("maps doc comment tags, tag values and markup per language", () => {
    const fg = (c: string) => `<value><option name="FOREGROUND" value="${c}"/></value>`;
    const { scheme } = parseIcls(`<scheme name="Docs" parent_scheme="Darcula"><attributes>
      <option name="DEFAULT_DOC_COMMENT_TAG">${fg("67a37c")}</option>
      <option name="DEFAULT_DOC_COMMENT_TAG_VALUE">${fg("abadb3")}</option>
      <option name="DEFAULT_DOC_MARKUP"><value><option name="BACKGROUND" value="e2ffe2"/></value></option>
      <option name="JAVA_DOC_TAG">${fg("111111")}</option>
      <option name="KDOC_LINK">${fg("222222")}</option>
      <option name="PHP_DOC_TAG">${fg("333333")}</option>
      <option name="PHP_DOC_VAR">${fg("444444")}</option>
      <option name="PHP_ATTRIBUTE">${fg("555555")}</option>
      </attributes></scheme>`);
    expect(scheme.attributes.docCommentTag?.foreground).toBe("#67a37c");
    expect(scheme.attributes.docCommentTagValue?.foreground).toBe("#abadb3");
    expect(scheme.attributes.docCommentMarkup?.background).toBe("#e2ffe2");
    expect(scheme.attributes["java.docCommentTag"]?.foreground).toBe("#111111");
    expect(scheme.attributes["kotlin.docCommentTagValue"]?.foreground).toBe("#222222");
    expect(scheme.attributes["php.docCommentTag"]?.foreground).toBe("#333333");
    expect(scheme.attributes["php.docCommentTagValue"]?.foreground).toBe("#444444");
    // PhpStorm's PHP 8 attributes, which PHP_DOC_TAG used to stand in for.
    expect(scheme.attributes["php.metadata"]?.foreground).toBe("#555555");
    const css = schemeCss("custom-docs", undefined, null, { "custom-docs": scheme });
    expect(css).toContain("--syn-doc-comment-tag: #67a37c !important");
    expect(css).toContain("--syn-doc-markup-bg: #e2ffe2 !important");
    const imported = parseIcls(exportIcls("custom-docs", { "custom-docs": scheme })).scheme;
    for (const id of [
      "docCommentTag",
      "docCommentTagValue",
      "docCommentMarkup",
      "java.docCommentTag",
      "kotlin.docCommentTagValue",
      "php.docCommentTag",
      "php.docCommentTagValue",
    ])
      expect(imported.attributes[id]).toMatchObject(scheme.attributes[id]!);
  });

  it("preserves PHP colours and regular styles separately from Java and language defaults", () => {
    const { scheme } = parseIcls(fixture("monokai-php"));
    expect(scheme.parent).toBe("dark");
    expect(scheme.attributes["php.identifier"]).toEqual({ foreground: "#48d8ee", bold: false, italic: false });
    expect(scheme.attributes["php.keyword"]).toEqual({ foreground: "#f92672", bold: false, italic: false });
    expect(scheme.attributes["php.string"]).toEqual({ foreground: "#ffe792", bold: false, italic: false });
    expect(scheme.attributes["php.docComment"]).toEqual({ foreground: "#75715e", bold: false, italic: false });
    expect(scheme.attributes["java.string"]).toEqual({ foreground: "#ffe792", bold: true, italic: false });
    expect(scheme.attributes.keyword?.foreground).toBe("#41abff");
    const customs = { "custom-php": scheme };
    const css = schemeCss("custom-php", undefined, null, customs);
    expect(css).toContain('.cm-editor[data-language="PHP"]');
    expect(css).toContain("--syn-variable: #48d8ee !important");
    const roundTrip = parseIcls(exportIcls("custom-php", customs)).scheme;
    expect(roundTrip.attributes["php.string"]).toEqual(scheme.attributes["php.string"]);
    expect(roundTrip.attributes["java.string"]).toEqual(scheme.attributes["java.string"]);
  });

  it("maps defaults, Java/Kotlin, editor surfaces, search and diagnostics with counts", () => {
    const { scheme, applied, skipped } = parseIcls(fixture("forest"));
    expect(scheme.name).toBe("Forest & Moss");
    expect(scheme.parent).toBe("dark");
    expect(scheme.attributes.keyword).toEqual({ foreground: "#aadd88", bold: false, italic: false });
    expect(scheme.attributes["java.keyword"]).toEqual({ foreground: "#99dd77", bold: true, italic: false });
    expect(scheme.attributes["kotlin.functionDeclaration"]).toEqual({
      foreground: "#e0c080",
      bold: false,
      italic: true,
    });
    expect(scheme.attributes.text).toEqual({ foreground: "#d8ebd8", background: "#18281e" });
    expect(scheme.attributes.caret?.foreground).toBe("#f0e080");
    expect(scheme.attributes.selection?.background).toBe("#406040");
    expect(scheme.attributes.gutter?.background).toBe("#142018");
    expect(scheme.attributes.searchResult?.background).toBe("#6a5530");
    expect(scheme.attributes.error).toEqual({ effect: "wave", effectColor: "#ff6655" });
    expect([applied, skipped]).toEqual([16, 2]);
  });

  it.each([
    "",
    "<scheme",
    '<scheme name="A"><attributes></scheme>',
    "<scheme/>",
    '<html name="x"/>',
    '<!DOCTYPE scheme [<!ENTITY a "red">]><scheme name="x"/>',
  ])("rejects malformed XML without mutating schemes: %s", (xml) => {
    const customs = importScheme({}, parseIcls(fixture("forest")).scheme).customs;
    const before = structuredClone(customs);
    expect(() => parseIcls(xml)).toThrow("Invalid .icls color scheme");
    expect(customs).toEqual(before);
  });

  it.each([
    ["0", undefined],
    ["1", "underline"],
    ["2", "wave"],
    ["3", "strikeout"],
    ["4", "underline"],
    ["5", "underline"],
    ["6", undefined],
  ] as const)("imports IntelliJ effect type %s as %s", (code, effect) => {
    const { scheme } = parseIcls(`<scheme name="Effects"><attributes>
      <option name="DEFAULT_KEYWORD"><value><option name="EFFECT_COLOR" value="aa1122"/><option name="EFFECT_TYPE" value="${code}"/></value></option>
    </attributes></scheme>`);
    expect(scheme.attributes.keyword?.effect).toBe(effect);
  });

  it("imports no effect without an effect colour, which IntelliJ does not draw", () => {
    const { scheme } = parseIcls(`<scheme name="Effects"><attributes>
      <option name="DEFAULT_KEYWORD"><value><option name="FOREGROUND" value="112233"/><option name="EFFECT_TYPE" value="3"/></value></option>
    </attributes></scheme>`);
    expect(scheme.attributes.keyword).toEqual({ foreground: "#112233", bold: false, italic: false });
  });

  it("exports effects with IntelliJ's codes and a colour IntelliJ draws them in", () => {
    const { id, customs } = importScheme({}, parseIcls(fixture("forest")).scheme);
    const xml = exportIcls(id, customs, {
      keyword: { effect: "underline" },
      number: { effect: "strikeout", effectColor: "#aa1122" },
    });
    const effect = (name: string) => {
      const value = new DOMParser().parseFromString(xml, "application/xml").querySelector(`option[name="${name}"]`);
      const option = (key: string) => value?.querySelector(`option[name="${key}"]`)?.getAttribute("value");
      return [option("EFFECT_TYPE"), option("EFFECT_COLOR")];
    };
    expect(effect("DEFAULT_KEYWORD")).toEqual(["1", "aadd88"]);
    expect(effect("ERRORS_ATTRIBUTES")).toEqual(["2", "ff6655"]);
    expect(effect("DEFAULT_NUMBER")).toEqual(["3", "aa1122"]);
    const attrs = parseIcls(xml).scheme.attributes;
    expect(attrs.keyword).toMatchObject({ effect: "underline", effectColor: "#aadd88" });
    expect(attrs.error).toEqual({ effect: "wave", effectColor: "#ff6655" });
  });

  it("exports no effect whose colour was cleared", () => {
    const { id, customs } = importScheme({}, parseIcls(fixture("forest")).scheme);
    const xml = exportIcls(id, customs, { error: { effectColor: CLEAR_COLOR } });
    expect(parseIcls(xml).scheme.attributes.error).toBeUndefined();
  });

  it("round trips the Islands Light doc comment tag underline", () => {
    const xml = exportIcls("light", {});
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    const tag = doc.querySelector('option[name="DEFAULT_DOC_COMMENT_TAG"]');
    expect(tag?.querySelector('option[name="EFFECT_TYPE"]')?.getAttribute("value")).toBe("1");
    expect(tag?.querySelector('option[name="EFFECT_COLOR"]')?.getAttribute("value")).toBe("999999");
    const scheme = parseIcls(xml).scheme;
    expect(scheme.attributes.docCommentTag).toMatchObject({ effect: "underline", effectColor: "#999999" });
    const imported = parseIcls(exportIcls("custom-docs", { "custom-docs": scheme })).scheme;
    expect(imported.attributes.docCommentTag).toEqual(scheme.attributes.docCommentTag);
  });

  it("round trips language effects and exports none without changing shared state", () => {
    const scheme = parseIcls(`<scheme name="Effects"><attributes>
      <option name="JAVA_DOC_TAG"><value><option name="FOREGROUND" value="112233"/><option name="EFFECT_COLOR" value="abcdef"/><option name="EFFECT_TYPE" value="2"/></value></option>
    </attributes></scheme>`).scheme;
    const customs = { "custom-effects": scheme };
    const overrides = {
      keyword: { effect: "underline" as const },
      number: { effect: "none" as const, effectColor: "#ff0000" },
      "java.string": { effect: "strikeout" as const },
    };
    const before = structuredClone({ customs, overrides });
    const xml = exportIcls("custom-effects", customs, overrides);
    expect({ customs, overrides }).toEqual(before);
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    expect(doc.querySelector('option[name="DEFAULT_NUMBER"] option[name="EFFECT_TYPE"]')).toBeNull();
    const imported = parseIcls(xml).scheme;
    expect(imported.attributes["java.docCommentTag"]).toMatchObject({ effect: "wave", effectColor: "#abcdef" });
    expect(imported.attributes["java.string"]).toMatchObject({ effect: "strikeout" });
    expect(imported.attributes.number?.effect).toBeUndefined();
    const roundTrip = parseIcls(exportIcls("custom-effects", { "custom-effects": imported })).scheme;
    expect(roundTrip.attributes["java.docCommentTag"]).toEqual(imported.attributes["java.docCommentTag"]);
    expect(roundTrip.attributes["java.string"]).toEqual(imported.attributes["java.string"]);
  });

  it("imports PyCharm dot keys after shared defaults without inherited font effects", () => {
    const xml = `<scheme name="Python"><attributes>
      <option name="PY.KEYWORD"><value><option name="FOREGROUND" value="112233"/></value></option>
      <option name="DEFAULT_KEYWORD"><value><option name="FOREGROUND" value="ff0000"/><option name="FONT_TYPE" value="1"/><option name="EFFECT_TYPE" value="1"/></value></option>
      <option name="JAVA_KEYWORD"><value><option name="FOREGROUND" value="00ff00"/></value></option>
      <option name="PY.NESTED_FUNC_DEFINITION"><value><option name="FOREGROUND" value="223344"/></value></option>
      <option name="PY.DOC_COMMENT"><value><option name="FOREGROUND" value="334455"/><option name="EFFECT_TYPE" value="1"/></value></option>
      <option name="PY.STRING.B"><value><option name="FOREGROUND" value="445566"/><option name="FONT_TYPE" value="1"/></value></option>
      <option name="PY.BUILTIN_NAME"><value><option name="FOREGROUND" value="abcd"/></value></option>
    </attributes></scheme>`;
    const attrs = parseIcls(xml).scheme.attributes;
    expect(attrs.keyword).toEqual({ foreground: "#112233", bold: false, italic: false, effect: "none" });
    expect(attrs.pyNestedFunction?.foreground).toBe("#223344");
    expect(attrs.pyDocstring?.foreground).toBe("#334455");
    expect(attrs.pyDocstring?.effect).toBe("none");
    expect(attrs.pyBytes?.foreground).toBe("#445566");
    expect(attrs.pyBytes?.bold).toBe(true);
    expect(attrs.pyBuiltin?.foreground).toBe("#00abcd");
    const imported = importScheme({}, parseIcls(xml).scheme);
    const roundTrip = parseIcls(exportIcls(imported.id, imported.customs)).scheme.attributes;
    expect(roundTrip.pyNestedFunction?.foreground).toBe("#223344");
    expect(roundTrip.pyBytes?.foreground).toBe("#445566");
  });

  it("round trips the Python identifier attributes independently", () => {
    const names = [
      ["pyLocalVariable", "101010"],
      ["pyGlobalVariable", "202020"],
      ["pyInstanceAttribute", "303030"],
      ["pyClassAttribute", "404040"],
      ["pyConstant", "505050"],
      ["pyProperty", "606060"],
      ["pyTypeParameter", "707070"],
    ] as const;
    const xml = `<scheme name="Python identifiers"><attributes>${names
      .map(
        ([id, value]) =>
          `<option name="OPENIDEA_${id}"><value><option name="FOREGROUND" value="${value}"/></value></option>`,
      )
      .join("")}</attributes></scheme>`;
    const { id, customs } = importScheme({}, parseIcls(xml).scheme);
    const attrs = parseIcls(exportIcls(id, customs)).scheme.attributes;
    for (const [name, value] of names) expect(attrs[name]?.foreground).toBe(`#${value}`);
  });

  it("imports the Python f-string colour", () => {
    const xml =
      '<scheme name="F"><attributes><option name="PY.STRING.F"><value>' +
      '<option name="FOREGROUND" value="808080"/></value></option></attributes></scheme>';
    const { id, customs } = importScheme({}, parseIcls(xml).scheme);
    expect(parseIcls(exportIcls(id, customs)).scheme.attributes.pyFString?.foreground).toBe("#808080");
  });

  it("imports the global variable colour", () => {
    const xml =
      '<scheme name="G" parent_scheme="Darcula"><attributes><option name="DEFAULT_GLOBAL_VARIABLE"><value>' +
      '<option name="FOREGROUND" value="9876aa"/><option name="FONT_TYPE" value="2"/></value></option></attributes></scheme>';
    expect(parseIcls(xml).scheme.attributes.globalVariable).toEqual({
      foreground: "#9876aa",
      bold: false,
      italic: true,
    });
  });

  it.each([
    ["Darcula", "ffffff", "light"],
    ["Default", "000000", "dark"],
    ["Other", "101820", "dark"],
    ["Other", "fefefe", "light"],
    ["", "0", "dark"],
  ])("maps parent %s and background %s to %s", (parent, bg, expected) => {
    expect(
      parseIcls(
        `<scheme name="Test" parent_scheme="${parent}"><attributes><option name="TEXT"><value><option name="BACKGROUND" value="${bg}"/></value></option></attributes></scheme>`,
      ).scheme.parent,
    ).toBe(expected);
  });

  it("ignores CSS injection on import and from edited settings", () => {
    const { scheme, applied, skipped } = parseIcls(
      '<scheme name="evil"><colors><option name="CARET_COLOR" value="fff;--bad:red"/></colors><attributes><option name="TEXT"><value><option name="BACKGROUND" value="fff}body{display:none"/></value></option></attributes></scheme>',
    );
    expect([applied, skipped]).toEqual([0, 2]);
    expect(scheme.attributes).toEqual({});
    const customs = {
      "custom-test": {
        name: "Test",
        parent: "dark",
        attributes: {
          keyword: { foreground: "red", background: "url(https://evil)", effectColor: "var(--bad)", effect: "wave" },
        },
      },
    };
    const valid = customSchemes(customs);
    expect(valid["custom-test"]?.attributes.keyword).toEqual({ effect: "wave" });
    const css = schemeCss("custom-test", undefined, null, valid);
    expect(css).not.toMatch(/evil|url\(|--bad/);
    expect(schemeCss("dark", { dark: { keyword: { foreground: "url(https://evil)" } } }, null)).not.toContain("evil");
  });

  it("keeps both, overwrites a custom, and never overwrites a built-in", () => {
    const parsed = parseIcls(fixture("forest")).scheme;
    const first = importScheme({}, parsed);
    const both = importScheme(first.customs, parsed);
    expect(both.customs[both.id]?.name).toBe("Forest & Moss (2)");
    const third = importScheme(both.customs, parsed);
    expect(third.customs[third.id]?.name).toBe("Forest & Moss (3)");
    const overwrite = importScheme(both.customs, { ...parsed, parent: "light" }, true);
    expect(overwrite.id).toBe(first.id);
    expect(overwrite.customs[first.id]?.parent).toBe("light");
    const builtin = importScheme({}, { ...parsed, name: SCHEMES[0]!.name }, true);
    expect(builtin.customs[builtin.id]?.name).toBe(`${SCHEMES[0]!.name} (2)`);
    expect(SCHEMES.some((s) => s.id === builtin.id)).toBe(false);
  });

  it("uses imported values under either theme, overrides them, and falls back after deletion", () => {
    const { id, customs } = importScheme({}, parseIcls(fixture("forest")).scheme);
    const overrides = { [id]: { keyword: { foreground: "#abcdef" } } };
    for (const theme of ["light", "dark"]) {
      const root = document.createElement("div");
      root.dataset.theme = theme;
      const css = schemeCss(id, overrides, root, customs);
      expect(css).toContain("--bg-editor: #18281e !important");
      expect(css.indexOf("--syn-keyword: #abcdef")).toBeGreaterThan(css.indexOf("--syn-keyword: #aadd88"));
      expect(css).toContain('.cm-editor[data-language="Java"]');
      expect(effectiveScheme("theme-default", root, customs)).toBe(theme);
      const deleted = deleteScheme(customs, overrides, id, id);
      expect(deleted).toEqual({ customs: {}, overrides: {}, selected: "theme-default" });
      expect(effectiveScheme(id, root, deleted.customs)).toBe(theme);
      expect(schemeCss(deleted.selected, deleted.overrides, root, deleted.customs)).toBe("");
      expect(deleteScheme(customs, overrides, "light", id).selected).toBe("light");
    }
  });

  it.each(["forest", "daylight"])("exports visible values and re-imports %s with overrides", (name) => {
    const { id, customs } = importScheme({}, parseIcls(fixture(name)).scheme);
    const override = {
      keyword: { foreground: "#123456", bold: false, italic: true },
      error: { effectColor: "#aa1122" },
    };
    const xml = exportIcls(id, customs, override);
    const imported = parseIcls(xml).scheme;
    expect(imported.name).toBe(customs[id]!.name);
    expect(imported.parent).toBe(customs[id]!.parent);
    expect(imported.attributes.keyword).toEqual(override.keyword);
    expect(imported.attributes.text).toEqual(customs[id]!.attributes.text);
    expect(imported.attributes.error?.effectColor).toBe("#aa1122");
  });

  it("exports shorthand colors as full RGB", () => {
    const { id, customs } = importScheme({}, parseIcls(fixture("forest")).scheme);
    expect(
      parseIcls(exportIcls(id, customs, { keyword: { foreground: "#abc" } })).scheme.attributes.keyword?.foreground,
    ).toBe("#aabbcc");
  });

  it("round trips custom settings and lists them without changing built-ins", () => {
    const { id, customs } = importScheme({}, parseIcls(fixture("forest")).scheme);
    const settings = validateSettings(
      JSON.parse(
        JSON.stringify({
          editor: {
            customSchemes: customs,
            colorScheme: id,
            colorOverrides: { [id]: { string: { foreground: "#123456" } } },
          },
        }),
      ),
    );
    expect(settings.editor.customSchemes).toEqual(customs);
    expect(settings.editor.colorScheme).toBe(id);
    expect(listSchemes(customs).at(-1)?.name).toBe("Forest & Moss");
    expect(listSchemes(customs)).toHaveLength(SCHEMES.length + 1);
    expect(isClientSetting("editor.customSchemes")).toBe(true);
    const previous = useProject.getState().settings;
    try {
      useProject.setState({ settings: settings as Settings });
      const items = colorSchemeItems(id);
      expect(items.find((s) => "id" in s && s.id === `scheme.${id}`)).toMatchObject({
        label: "Forest & Moss",
        checked: true,
      });
      expect(items.find((s) => "id" in s && s.id === "scheme.theme-default")).toMatchObject({ checked: false });
    } finally {
      useProject.setState({ settings: previous });
    }
  });
});
