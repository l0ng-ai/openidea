import { describe, expect, it } from "vitest";
import { planJetBrainsImport } from "../jetbrainsSettings";

const icls = (name: string) =>
  `<scheme name="${name}" version="142" parent_scheme="Darcula"><attributes>` +
  `<option name="DEFAULT_KEYWORD"><value><option name="FOREGROUND" value="cc856b" /></value></option>` +
  `</attributes></scheme>`;

const component = (name: string, options: Record<string, string>) =>
  `<application><component name="${name}">${Object.entries(options)
    .map(([k, v]) => `<option name="${k}" value="${v}" />`)
    .join("")}</component></application>`;

const editor = { fontFamily: "JetBrains Mono", fontSize: 13, customSchemes: {}, colorOverrides: {} };

/** JetBrains Maple Mono's metrics (ascent 1.02em, descent 0.3em), for any family. */
const fontHeight = (_family: string, size: number) => Math.ceil(size * 1.02) + Math.ceil(size * 0.3);

/** A WebStorm export, trimmed to what the import reads. */
const webstorm = {
  entries: [
    "IntelliJ IDEA Global Settings",
    "colors/_@user_Darcula.icls",
    "options/editor-font.xml",
    "options/colors.scheme.xml",
    "options/editor.xml",
    "options/ide.general.xml",
    "options/vcs.xml",
    "keymaps/macOS.xml",
    "codestyles/Default.xml",
    "inspection/Default.xml",
    "installed.txt",
  ],
  files: {
    "colors/_@user_Darcula.icls": icls("_@user_Darcula"),
    "options/colors.scheme.xml":
      '<application><component name="EditorColorsManagerImpl"><global_color_scheme name="_@user_Darcula" /></component></application>',
    "options/editor-font.xml": component("DefaultFont", {
      FONT_SIZE: "17",
      FONT_FAMILY: "JetBrains Maple Mono",
      USE_LIGATURES: "true",
    }),
    "options/editor.xml": component("EditorSettings", {
      USE_SOFT_WRAPS: "CONSOLE",
      STRIP_TRAILING_SPACES: "Whole",
      IS_ENSURE_NEWLINE_AT_EOF: "true",
      SHOW_STICKY_LINES: "false",
    }),
    "options/ide.general.xml": component("GeneralSettings", {
      showTipsOnStartup: "false",
      confirmExit: "false",
    }),
  },
};

describe("planJetBrainsImport", () => {
  it("maps a WebStorm export to the settings it has, and lists what is left out", async () => {
    const plan = await planJetBrainsImport(webstorm, editor, fontHeight);
    const writes = Object.fromEntries(plan.writes);
    const schemes = writes["editor.customSchemes"] as Record<string, { name: string; parent: string }>;
    const [id, scheme] = Object.entries(schemes)[0]!;
    expect(scheme).toMatchObject({ name: "Darcula", parent: "dark" });
    expect(writes).toEqual({
      "editor.customSchemes": schemes,
      "editor.colorScheme": id,
      "editor.fontFamily": "JetBrains Maple Mono",
      "editor.fontSize": 17,
      // (18 + 6) × the default spacing 1.2, rounded up, as WebStorm draws it.
      "editor.lineHeight": 29,
      "editor.ligatures": true,
      "files.trimTrailingWhitespace": true,
      "editor.general.stripTrailingScope": "all",
      "files.ensureFinalNewline": true,
      "editor.stickyScroll": false,
      "editor.softWrap": false,
      "general.confirmExit": false,
    });
    expect(plan.rows).toContainEqual({
      label: "Color Scheme",
      value: "Darcula",
    });
    expect(plan.rows).toContainEqual({ label: "Size", value: "17" });
    expect(plan.rows).toContainEqual({
      label: "Remove trailing spaces on:",
      value: "All lines",
    });
    expect(plan.skipped).toEqual(["Keymap", "Code Style", "Inspections", "Plugins"]);
    expect(plan.invalid).toEqual([]);
  });

  it("writes only the keys present, and derives the line height from IDEA's spacing", async () => {
    const plan = await planJetBrainsImport(
      {
        entries: [],
        files: {
          "options/editor-font.xml": component("DefaultFont", {
            LINE_SPACING: "1.5",
          }),
          "options/editor.xml": component("EditorSettings", {
            USE_SOFT_WRAPS: "MAIN_EDITOR,CONSOLE",
            STRIP_TRAILING_SPACES: "None",
          }),
        },
      },
      editor,
      fontHeight,
    );
    expect(plan.writes).toEqual([
      // (14 + 4) × 1.5
      ["editor.lineHeight", 27],
      ["files.trimTrailingWhitespace", false],
      ["editor.softWrap", true],
    ]);
    expect(plan.skipped).toEqual([]);
  });

  it("re-importing replaces the earlier copy of a scheme and drops its edits", async () => {
    const first = Object.fromEntries((await planJetBrainsImport(webstorm, editor, fontHeight)).writes);
    const customs = first["editor.customSchemes"] as typeof editor.customSchemes;
    const [id] = Object.keys(customs);
    const again = await planJetBrainsImport(
      webstorm,
      {
        ...editor,
        customSchemes: customs,
        colorOverrides: { [id!]: { keyword: { bold: true } }, other: {} },
      },
      fontHeight,
    );
    const writes = Object.fromEntries(again.writes);
    expect(Object.keys(writes["editor.customSchemes"] as object)).toEqual([id]);
    expect(writes["editor.colorOverrides"]).toEqual({ other: {} });
    expect(writes["editor.colorScheme"]).toBe(id);
  });

  it("falls back to the font size when the font cannot be measured", async () => {
    const plan = await planJetBrainsImport(
      { entries: [], files: { "options/editor-font.xml": component("DefaultFont", { FONT_SIZE: "20" }) } },
      editor,
      () => undefined,
    );
    expect(plan.writes).toEqual([
      ["editor.fontSize", 20],
      ["editor.lineHeight", 29],
    ]);
  });

  it("skips colour schemes that cannot be read", async () => {
    const plan = await planJetBrainsImport({ entries: [], files: { "colors/broken.icls": "<nope" } }, editor);
    expect(plan.invalid).toEqual(["broken.icls"]);
    expect(plan.writes).toEqual([]);
  });
});
