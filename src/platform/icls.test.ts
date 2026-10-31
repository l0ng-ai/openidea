import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { _setSchemeSource, customSchemes, effectiveScheme, listSchemes, SCHEMES, schemeCss } from "./colorScheme";
import { deleteScheme, exportIcls, importScheme, parseIcls } from "./icls";
import { validateSettings } from "@/features/settings/model/schema";
import { colorSchemeItems } from "@/workbench/quickSwitch";
import { useProject } from "./project";
import type { Settings } from "./ipc";
import { isClientSetting } from "./clientSettings";

const fixture = (name: string) => readFileSync(`src/platform/__fixtures__/colorSchemes/${name}.icls`, "utf8");
beforeAll(() => _setSchemeSource(readFileSync("src/styles/tokens.css", "utf8")));

describe(".icls schemes", () => {
  it("maps defaults, Java/Kotlin, editor surfaces, search and diagnostics with counts", () => {
    const { scheme, applied, skipped } = parseIcls(fixture("forest"));
    expect(scheme.name).toBe("Forest & Moss");
    expect(scheme.parent).toBe("dark");
    expect(scheme.attributes.keyword).toEqual({ foreground: "#99dd77", bold: true, italic: false });
    expect(scheme.attributes.functionDeclaration).toEqual({ foreground: "#e0c080", bold: false, italic: true });
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
    ["Darcula", "ffffff", "dark"],
    ["Default", "000000", "light"],
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
      expect(css.lastIndexOf("--syn-keyword: #abcdef")).toBeGreaterThan(css.indexOf("--syn-keyword: #99dd77"));
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
