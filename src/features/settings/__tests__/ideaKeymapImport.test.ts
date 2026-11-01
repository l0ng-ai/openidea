import { describe, expect, it } from "vitest";
import { normalizeBinding } from "@/platform/keymap";
import { fromSwingStroke, parseIdeaKeymap } from "../keymap/ideaKeymapImport";

describe("IntelliJ IDEA keymap import", () => {
  it("converts Swing keystrokes", () => {
    expect(fromSwingStroke("shift meta O")).toBe("Shift+Meta+O");
    expect(fromSwingStroke("ctrl pressed OPEN_BRACKET")).toBe("Ctrl+[");
    expect(fromSwingStroke("F12")).toBe("F12");
    expect(fromSwingStroke("alt BACK_SPACE")).toBe("Alt+Backspace");
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
          <mouse-shortcut keystroke="double button1" />
        </action>
        <action id="GotoDeclaration" />
        <action id="SomePluginAction"><keyboard-shortcut first-keystroke="meta J" /></action>
      </keymap>`);
    expect(k.name).toBe("My Mac");
    expect(k.parent).toBe("intellij-macos");
    expect(k.overrides["navigate.gotoClass"]).toEqual(
      ["Meta+Shift+N", "Meta+K Meta+C", "Alt+Button1"].map(normalizeBinding),
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

  it("rejects other XML", () => {
    expect(() => parseIdeaKeymap("<scheme name='x'/>")).toThrow(/keymap/);
  });
});
