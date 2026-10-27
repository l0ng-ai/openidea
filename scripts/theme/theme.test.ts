import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  convertIcls,
  convertIntellijTheme,
  ICLS_ATTRIBUTES,
  ICLS_COLORS,
  pluginManifest,
  UI_KEYS,
} from "./intellij.ts";
import { referenceMarkdown, stripJsonComments, themeTokenGroups, tokenSets, withReference } from "./tokens.ts";

const read = (p: string) => readFileSync(p, "utf8");
const css = read("src/styles/tokens.css");
const groups = themeTokenGroups(css);
const sets = tokenSets(groups);
const TEMPLATE = "templates/theme-plugin";
const themeSrc = read(`${TEMPLATE}/themes/harbor-night.theme.json`);
const schemeSrc = read(`${TEMPLATE}/themes/harbor-night.scheme.json`);
const theme = JSON.parse(stripJsonComments(themeSrc)) as { id: string; kind: string; tokens: Record<string, string> };
const scheme = JSON.parse(stripJsonComments(schemeSrc)) as { tokens: Record<string, string> };

const sorted = (xs: Iterable<string>) => [...xs].sort();

describe("theme token reference", () => {
  it("reads every variable of the Islands Light block, grouped", () => {
    const lightBlock = /:root\[data-theme="light"\] \{([\s\S]*?)\n\}/.exec(css)![1]!;
    const declared = new Set([...lightBlock.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]!));
    expect(sorted([...sets.ui, ...sets.scheme])).toEqual(sorted(declared));
    expect(groups.map((g) => g.title)).toEqual(
      expect.arrayContaining(["surfaces", "syntax", "editor", "ANSI palette"]),
    );
    expect(sets.scheme.every((t) => !sets.ui.includes(t))).toBe(true);
  });

  it("requires a section comment for every chunk of the light block", () => {
    const bad = ':root { --a: #000; }\n:root[data-theme="light"] {\n  /* ok */\n  --a: #fff;\n\n  --b: #fff;\n}';
    expect(() => themeTokenGroups(bad)).toThrow(/--b .*section comment/);
  });

  it("is current in docs/plugins/themes.md (run pnpm gen:theme-docs)", () => {
    const doc = read("docs/plugins/themes.md");
    expect(withReference(doc, referenceMarkdown(groups))).toBe(doc);
  });
});

describe("theme plugin template", () => {
  it("sets every UI token in the theme file and every editor token in the scheme file", () => {
    // A failure here means tokens.css gained (or lost) a themeable token:
    // add it to templates/theme-plugin/themes/*.json, then run pnpm gen:theme-docs.
    expect(sorted(Object.keys(theme.tokens))).toEqual(sorted(sets.ui));
    expect(sorted(Object.keys(scheme.tokens))).toEqual(sorted(sets.scheme));
  });

  it("groups tokens under the section comments of tokens.css", () => {
    for (const g of groups) {
      const src = g.scheme ? schemeSrc : themeSrc;
      const heading = `// ${g.title.charAt(0).toUpperCase()}${g.title.slice(1)}`;
      expect(src, heading).toContain(heading);
      const at = src.indexOf(heading);
      for (const t of g.tokens) expect(src.indexOf(`"${t.name}"`), t.name).toBeGreaterThan(at);
    }
  });

  it("uses only values the plugin host accepts", () => {
    for (const [k, v] of Object.entries({ ...theme.tokens, ...scheme.tokens })) {
      expect(/[;{}<>\\\n]|url\(|image\(/i.test(v), `${k}: ${v}`).toBe(false);
    }
    expect(theme.kind).toBe("dark");
  });

  it("is referenced by its manifest", () => {
    const manifest = read(`${TEMPLATE}/plugin.toml`);
    expect(manifest).toContain('path = "themes/harbor-night.theme.json"');
    expect(manifest).toContain('editor-scheme = "themes/harbor-night.scheme.json"');
    expect(manifest).not.toMatch(/^wasm\s*=/m);
  });
});

describe("IntelliJ theme import", () => {
  const themeJson = `{
    // comment
    "name": "Deep Sea",
    "dark": true,
    "author": "Someone",
    "colors": { "base": "#101820", "accent": "#33AAFF" },
    "ui": {
      "*": { "background": "base", "foreground": "#c0c8d0", "selectionBackground": "#203040" },
      "Button": { "default": { "startBackground": "accent" } },
      "Popup.background": "#181f28",
      "Label.infoForeground": "#80888F80",
      "Tree": { "rowHeight": 24 }
    }
  }`;
  const icls = `<scheme name="Deep Sea" version="142" parent_scheme="Darcula">
  <colors>
    <option name="CARET_COLOR" value="ffcc00" />
    <option name="LINE_NUMBERS_COLOR" value="0" />
    <option name="UNKNOWN_KEY" value="123456" />
  </colors>
  <attributes>
    <option name="DEFAULT_KEYWORD">
      <value>
        <option name="FOREGROUND" value="cc7832" />
        <option name="FONT_TYPE" value="1" />
      </value>
    </option>
    <option name="DEFAULT_LINE_COMMENT">
      <value>
        <option name="FOREGROUND" value="808080" />
        <option name="FONT_TYPE" value="2" />
      </value>
    </option>
    <option name="TEXT">
      <value>
        <option name="FOREGROUND" value="a9b7c6" />
        <option name="BACKGROUND" value="2b2b2b" />
      </value>
    </option>
    <option name="ERRORS_ATTRIBUTES">
      <value>
        <option name="EFFECT_COLOR" value="ff0000" />
        <option name="EFFECT_TYPE" value="2" />
      </value>
    </option>
    <option name="DEFAULT_CONSTANT" baseAttributes="DEFAULT_IDENTIFIER" />
  </attributes>
</scheme>`;

  it("maps ui keys, named colours and wildcards", () => {
    const { theme: t, scheme: s } = convertIntellijTheme(themeJson);
    expect(t).toMatchObject({ id: "deep-sea", name: "Deep Sea", kind: "dark" });
    expect(t.tokens["--bg-app"]).toBe("#101820"); // *.background → named colour
    expect(t.tokens["--accent"]).toBe("#33aaff");
    expect(t.tokens["--bg-popup"]).toBe("#181f28");
    expect(t.tokens["--bg-selected"]).toBe("#203040");
    expect(t.tokens["--fg-muted"]).toBe("#80888f80");
    expect(t.tokens["--fg"]).toBe("#c0c8d0");
    expect(s).toBeNull();
  });

  it("only targets tokens that exist in tokens.css", () => {
    const declared = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]!));
    // Read with a fallback by the editor (no tokens.css default), still themeable.
    declared.add("--border-method-separator");
    const targets = [
      ...Object.keys(UI_KEYS),
      ...Object.values(ICLS_COLORS).flat(),
      ...Object.values(ICLS_ATTRIBUTES).flatMap((parts) => parts.map(([, token]) => token)),
    ];
    expect(targets.filter((t) => !declared.has(t))).toEqual([]);
  });

  it("maps .icls colours and attributes", () => {
    const s = convertIcls(icls);
    expect(s.name).toBe("Deep Sea");
    expect(s.dark).toBe(true);
    expect(s.tokens).toMatchObject({
      "--caret": "#ffcc00",
      "--fg-line-number": "#000000",
      "--syn-keyword": "#cc7832",
      "--syn-comment": "#808080",
      "--syn-comment-style": "italic",
      "--fg-editor": "#a9b7c6",
      "--bg-editor": "#2b2b2b",
      "--bg-editor-gutter": "#2b2b2b",
      "--wave-error": "#ff0000",
      "--editor-error-decoration": "underline wavy #ff0000",
    });
    expect(s.tokens["--syn-constant"]).toBeUndefined();
  });

  it("produces an installable package", () => {
    const c = convertIntellijTheme(themeJson.replace('"dark": true,', ""), icls.replace("Darcula", "Default"), "sea");
    expect(c.theme.kind).toBe("light");
    expect(c.theme.id).toBe("sea");
    expect(c.theme.tokens["--bg-island"]).toBe("#101820"); // ToolWindow ← *.background wins over the editor
    const toml = pluginManifest(c, "Someone", "DeepSea.theme.json");
    expect(toml).toContain('id = "theme-sea"');
    expect(toml).toContain('editor-scheme = "themes/sea.scheme.json"');
  });
});
