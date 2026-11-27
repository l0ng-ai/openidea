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

const settings = {
  editor: { fontFamily: "JetBrains Mono", fontSize: 13, customSchemes: {}, colorOverrides: {} },
  customKeymaps: {},
};

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
    const plan = await planJetBrainsImport(webstorm, settings, fontHeight);
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
      "console.softWrap": true,
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
    expect(plan.skipped).toEqual(["Code Style options other than Tabs and Indents", "Inspections", "Plugins"]);
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
      settings,
      fontHeight,
    );
    expect(plan.writes).toEqual([
      // (14 + 4) × 1.5
      ["editor.lineHeight", 27],
      ["files.trimTrailingWhitespace", false],
      ["editor.softWrap", true],
      ["console.softWrap", true],
    ]);
    expect(plan.skipped).toEqual([]);
  });

  it("re-importing replaces the earlier copy of a scheme and drops its edits", async () => {
    const first = Object.fromEntries((await planJetBrainsImport(webstorm, settings, fontHeight)).writes);
    const customs = first["editor.customSchemes"] as typeof settings.editor.customSchemes;
    const [id] = Object.keys(customs);
    const again = await planJetBrainsImport(
      webstorm,
      {
        ...settings,
        editor: {
          ...settings.editor,
          customSchemes: customs,
          colorOverrides: { [id!]: { keyword: { bold: true } }, other: {} },
        },
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
      settings,
      () => undefined,
    );
    expect(plan.writes).toEqual([
      ["editor.fontSize", 20],
      ["editor.lineHeight", 29],
    ]);
  });

  it("imports the keymaps and makes the active one current", async () => {
    const keymap =
      '<keymap version="1" name="macOS copy" parent="Mac OS X 10.5+">' +
      '<action id="NextTab"><keyboard-shortcut first-keystroke="ctrl right" /></action>' +
      '<action id="GotoSuperMethod" /><action id="RunAnything" /></keymap>';
    const active =
      '<application><component name="KeymapManager"><active_keymap name="macOS copy" /></component></application>';
    const bundle = {
      entries: ["keymaps/macOS copy.xml", "keymaps/broken.xml"],
      files: {
        "keymaps/macOS copy.xml": keymap,
        "keymaps/broken.xml": "<nope",
        // The active keymap is stored per operating system; the host picks its own.
        "options/mac/keymap.xml": active,
        "options/windows/keymap.xml": active,
        "options/linux/keymap.xml": active,
      },
    };
    const plan = await planJetBrainsImport(bundle, settings);
    const expected = {
      name: "macOS copy",
      parent: "intellij-macos",
      overrides: { "editor.nextTab": ["Ctrl+Right"], "navigate.superMethod": [] },
    };
    expect(plan.writes).toEqual([
      ["customKeymaps", { "custom.macos-copy": expected }],
      ["keymap", "custom.macos-copy"],
    ]);
    expect(plan.rows).toEqual([
      { label: "Keymap", value: "macOS copy" },
      { label: "Current keymap", value: "macOS copy" },
    ]);
    expect(plan.unknownActions).toEqual(["RunAnything"]);
    expect(plan.invalid).toEqual(["broken.xml"]);

    // Importing again replaces the earlier copy and keeps the user's other keymaps.
    const mine = { name: "Mine", parent: "vscode-macos", overrides: {} };
    const again = await planJetBrainsImport(bundle, {
      ...settings,
      customKeymaps: { "custom.macos-copy": { ...expected, overrides: {} }, "custom.mine": mine },
    });
    expect(again.writes[0]).toEqual(["customKeymaps", { "custom.macos-copy": expected, "custom.mine": mine }]);
  });

  it("imports the terminal font", async () => {
    const plan = await planJetBrainsImport(
      {
        entries: [],
        files: {
          "options/terminal-font.xml": component("TerminalFontOptions", {
            VERSION: "1",
            FONT_SIZE: "17",
            FONT_SIZE_2D: "17.0",
            FONT_FAMILY: "MesloLGS NF",
            LINE_SPACING: "1.1",
          }),
        },
      },
      settings,
    );
    expect(plan.writes).toEqual([
      ["terminal.useEditorFont", false],
      ["terminal.fontFamily", "MesloLGS NF"],
      ["terminal.fontSize", 17],
      ["terminal.lineHeight", 1.1],
    ]);
  });

  it("imports tabs and indents of the current code style scheme onto the languages' own styles", async () => {
    const scheme = (name: string, body: string) => `<code_scheme name="${name}" version="173">${body}</code_scheme>`;
    const plan = await planJetBrainsImport(
      {
        entries: ["codestyles/Default.xml", "codestyles/Team.xml"],
        files: {
          "options/code.style.schemes.xml": component("CodeStyleSchemeSettings", { CURRENT_SCHEME_NAME: "Team" }),
          "codestyles/Default.xml": scheme(
            "Default",
            '<codeStyleSettings language="Python"><indentOptions><option name="INDENT_SIZE" value="8" /></indentOptions></codeStyleSettings>',
          ),
          "codestyles/Team.xml": scheme(
            "Team",
            '<option name="RIGHT_MARGIN" value="100" />' +
              '<option name="OTHER_INDENT_OPTIONS"><value><option name="TAB_SIZE" value="8" />' +
              '<option name="USE_TAB_CHARACTER" value="true" /></value></option>' +
              '<JSCodeStyleSettings version="0"><option name="USE_SEMICOLON_AFTER_STATEMENT" value="false" /></JSCodeStyleSettings>' +
              '<codeStyleSettings language="TypeScript"><option name="SPACE_WITHIN_BRACKETS" value="true" />' +
              '<indentOptions><option name="INDENT_SIZE" value="2" /><option name="CONTINUATION_INDENT_SIZE" value="2" />' +
              '<option name="TAB_SIZE" value="2" /></indentOptions></codeStyleSettings>' +
              '<codeStyleSettings language="HTML"><option name="LINE_COMMENT_AT_FIRST_COLUMN" value="false" />' +
              '<indentOptions><option name="USE_TAB_CHARACTER" value="true" /></indentOptions></codeStyleSettings>' +
              '<codeStyleSettings language="Brainfuck"><indentOptions><option name="INDENT_SIZE" value="3" /></indentOptions></codeStyleSettings>',
          ),
        },
      },
      {
        ...settings,
        editor: {
          ...settings.editor,
          codeStyle: { languages: { typescript: { hardWrapAt: 90 }, go: { tabSize: 8 } } },
        },
      },
    );
    expect(plan.writes).toEqual([
      ["editor.codeStyle.hardWrapAt", 100],
      ["editor.tabSize", 8],
      ["editor.insertSpaces", false],
      [
        "editor.codeStyle.languages",
        {
          typescript: { hardWrapAt: 90, indent: 2, tabSize: 2 },
          typescriptreact: { indent: 2, tabSize: 2 },
          html: { useTab: true, lineCommentAtFirstColumn: false },
          go: { tabSize: 8 },
        },
      ],
    ]);
    expect(plan.rows).toContainEqual({ label: "Code Style › TypeScript", value: "Indent 2, Tab size 2" });
    expect(plan.rows).toContainEqual({ label: "Use tab character", value: "On" });
    expect(plan.skipped).toEqual(["Code Style options other than Tabs and Indents"]);
  });

  it("imports the editor options that have a setting here", async () => {
    const xml =
      "<application>" +
      component("EditorSettings", {
        IS_SMOOTH_CARET_BLINKING: "true",
        IS_BLOCK_CURSOR: "true",
        ARE_LINE_NUMBERS_SHOWN: "false",
        LINE_NUMERATION: "HYBRID",
        SHOW_BREADCRUMBS_ABOVE: "true",
        CARET_BLINKING_PERIOD: "700",
        IS_ANIMATED_SCROLLING: "false",
      }).replace(/<\/?application>/g, "") +
      component("CodeInsightSettings", {
        AUTOINSERT_PAIR_QUOTE: "false",
        REFORMAT_ON_PASTE: "2",
        SMART_BACKSPACE: "1",
        PARAMETER_INFO_DELAY: "500",
        COMPLETION_CASE_SENSITIVE: "2",
      }).replace(/<\/?application>/g, "") +
      "</application>";
    const plan = await planJetBrainsImport({ entries: [], files: { "options/editor.xml": xml } }, settings);
    expect(Object.fromEntries(plan.writes)).toEqual({
      "editor.appearance.lineNumberMode": "hybrid",
      "editor.breadcrumbs.placement": "top",
      "editor.appearance.smoothCaretBlinking": true,
      "editor.appearance.blockCaret": true,
      "editor.appearance.lineNumbers": false,
      "editor.appearance.caretBlinkPeriod": 700,
      "editor.smartKeys.pairQuotes": false,
      "editor.completion.parameterInfoDelay": 500,
      "editor.smartKeys.reformatOnPaste": "indentBlock",
      "editor.smartKeys.backspaceUnindent": "nearest",
    });
    expect(plan.rows).toContainEqual({ label: "Unindent", value: "To nearest indent position" });
    expect(plan.rows).toContainEqual({ label: "Show line numbers", value: "Hybrid" });
  });

  it("skips colour schemes that cannot be read", async () => {
    const plan = await planJetBrainsImport({ entries: [], files: { "colors/broken.icls": "<nope" } }, settings);
    expect(plan.invalid).toEqual(["broken.icls"]);
    expect(plan.writes).toEqual([]);
  });
});
