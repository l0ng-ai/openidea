import { describe, expect, it } from "vitest";
import { normalizeBinding } from "@/platform/keymap";
import { fromSwingStroke, parseIdeaKeymap } from "./ideaKeymap";

describe("IntelliJ IDEA keymap import", () => {
  it("converts Swing keystrokes", () => {
    expect(fromSwingStroke("shift meta O")).toBe("Shift+Meta+O");
    expect(fromSwingStroke("ctrl pressed OPEN_BRACKET")).toBe("Ctrl+[");
    expect(fromSwingStroke("F12")).toBe("F12");
    expect(fromSwingStroke("alt BACK_SPACE")).toBe("Alt+Backspace");
    // As IDEA saves a user's keymap.
    expect(fromSwingStroke("ctrl right")).toBe("Ctrl+Right");
    expect(fromSwingStroke("shift ctrl alt s")).toBe("Shift+Ctrl+Alt+S");
    expect(fromSwingStroke("meta back_slash")).toBe("Meta+\\");
    expect(fromSwingStroke("meta NUMPAD5")).toBeNull();
    expect(fromSwingStroke("hyper A")).toBeNull();
  });

  it("maps listed actions over the parent preset", () => {
    const k = parseIdeaKeymap(`<?xml version="1.0"?>
      <keymap version="1" name="My Mac" parent="Mac OS X 10.5+">
        <action id="GotoClass">
          <keyboard-shortcut first-keystroke="meta shift N" />
          <keyboard-shortcut first-keystroke="meta K" second-keystroke="meta C" />
          <mouse-shortcut keystroke="alt button1" />
          <mouse-shortcut keystroke="control button143" />
          <mouse-shortcut keystroke="shift alt button142" />
          <mouse-shortcut keystroke="double button1" />
        </action>
        <action id="GotoDeclaration" />
        <action id="SomePluginAction"><keyboard-shortcut first-keystroke="meta J" /></action>
      </keymap>`);
    expect(k.name).toBe("My Mac");
    expect(k.parent).toBe("intellij-macos");
    expect(k.overrides["navigate.gotoClass"]).toEqual(
      ["Meta+Shift+N", "Meta+K Meta+C", "Alt+Button1", "Ctrl+WheelUp", "Alt+Shift+WheelDown"].map(normalizeBinding),
    );
    expect(k.overrides["navigate.declaration"]).toEqual([]);
    expect(k.applied).toBe(2);
    expect(k.unknownActions).toEqual(["SomePluginAction"]);
    expect(k.skippedShortcuts).toBe(1);
  });

  it("drops entries equal to the parent and picks the Windows preset for $default", () => {
    const k = parseIdeaKeymap(
      `<keymap name="W" parent="$default"><action id="GotoClass"><keyboard-shortcut first-keystroke="ctrl N"/></action></keymap>`,
    );
    expect(k.parent).toBe("intellij-windows");
    expect(k.overrides).toEqual({});
  });

  it("maps Duplicate Entire Lines, which has no shortcut in the presets", () => {
    const k = parseIdeaKeymap(
      `<keymap name="M" parent="Mac OS X 10.5+"><action id="EditorDuplicateLines"><keyboard-shortcut first-keystroke="shift meta D"/></action></keymap>`,
    );
    expect(k.overrides["code.duplicateEntireLines"]).toEqual([normalizeBinding("Shift+Meta+D")]);
    expect(k.unknownActions).toEqual([]);
  });

  it("maps Fill Paragraph, which has no shortcut in the presets", () => {
    const k = parseIdeaKeymap(
      `<keymap name="M" parent="Mac OS X 10.5+"><action id="FillParagraph"><keyboard-shortcut first-keystroke="alt meta Q"/></action></keymap>`,
    );
    expect(k.overrides["code.fillParagraph"]).toEqual([normalizeBinding("Alt+Meta+Q")]);
    expect(k.unknownActions).toEqual([]);
  });

  it("maps Remove All Breakpoints and Remove All Breakpoints In The Current File", () => {
    const k = parseIdeaKeymap(
      `<keymap name="M" parent="Mac OS X 10.5+"><action id="Debugger.RemoveAllBreakpoints"><keyboard-shortcut first-keystroke="shift meta F9"/></action><action id="Debugger.RemoveAllBreakpointsInFile"><keyboard-shortcut first-keystroke="alt meta F9"/></action></keymap>`,
    );
    expect(k.overrides["debug.removeAllBreakpoints"]).toEqual([normalizeBinding("Shift+Meta+F9")]);
    expect(k.overrides["debug.removeAllBreakpointsInFile"]).toEqual([normalizeBinding("Alt+Meta+F9")]);
    expect(k.unknownActions).toEqual([]);
  });

  it("maps Scroll Up / Scroll Down", () => {
    const k = parseIdeaKeymap(
      `<keymap name="M" parent="Mac OS X 10.5+"><action id="EditorScrollUp"><keyboard-shortcut first-keystroke="meta UP"/></action><action id="EditorScrollDown"><keyboard-shortcut first-keystroke="meta DOWN"/></action></keymap>`,
    );
    expect(k.overrides["editor.scrollUp"]).toEqual([normalizeBinding("Meta+Up")]);
    expect(k.overrides["editor.scrollDown"]).toEqual([normalizeBinding("Meta+Down")]);
    expect(k.unknownActions).toEqual([]);
  });

  it("maps Convert Indents to Spaces / to Tabs", () => {
    const k = parseIdeaKeymap(
      `<keymap name="M" parent="Mac OS X 10.5+"><action id="ConvertIndentsToSpaces"><keyboard-shortcut first-keystroke="shift meta 8"/></action><action id="ConvertIndentsToTabs"><keyboard-shortcut first-keystroke="shift meta 9"/></action></keymap>`,
    );
    expect(k.overrides["code.convertIndentsToSpaces"]).toEqual([normalizeBinding("Shift+Meta+8")]);
    expect(k.overrides["code.convertIndentsToTabs"]).toEqual([normalizeBinding("Shift+Meta+9")]);
    expect(k.unknownActions).toEqual([]);
  });

  it("maps Find Word at Caret / Find Previous Word at Caret", () => {
    const k = parseIdeaKeymap(
      `<keymap name="M" parent="Mac OS X 10.5+"><action id="FindWordAtCaret"><keyboard-shortcut first-keystroke="alt meta F3"/></action><action id="FindPrevWordAtCaret"><keyboard-shortcut first-keystroke="shift alt meta F3"/></action></keymap>`,
    );
    expect(k.overrides["find.wordAtCaret"]).toEqual([normalizeBinding("Alt+Meta+F3")]);
    expect(k.overrides["find.previousWordAtCaret"]).toEqual([normalizeBinding("Shift+Alt+Meta+F3")]);
    expect(k.unknownActions).toEqual([]);
  });

  it("rejects other XML", () => {
    expect(() => parseIdeaKeymap("<scheme name='x'/>")).toThrow(/keymap/);
  });
});
