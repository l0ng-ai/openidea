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

  it("maps New Scratch Buffer without requiring a preset shortcut", () => {
    const k = parseIdeaKeymap(
      `<keymap name="M" parent="Mac OS X 10.5+"><action id="NewScratchBuffer"><keyboard-shortcut first-keystroke="meta shift B"/></action></keymap>`,
    );
    expect(k.overrides["file.newScratchBuffer"]).toEqual([normalizeBinding("Meta+Shift+B")]);
    expect(k.unknownActions).toEqual([]);
  });

  it("maps Fill Paragraph, which has no shortcut in the presets", () => {
    const k = parseIdeaKeymap(
      `<keymap name="M" parent="Mac OS X 10.5+"><action id="FillParagraph"><keyboard-shortcut first-keystroke="alt meta Q"/></action></keymap>`,
    );
    expect(k.overrides["code.fillParagraph"]).toEqual([normalizeBinding("Alt+Meta+Q")]);
    expect(k.unknownActions).toEqual([]);
  });

  it("maps Expand Doc Comments and Collapse Doc Comments, which have no shortcut in the presets", () => {
    const k = parseIdeaKeymap(
      `<keymap name="M" parent="Mac OS X 10.5+"><action id="ExpandDocComments"><keyboard-shortcut first-keystroke="shift ctrl EQUALS"/></action><action id="CollapseDocComments"><keyboard-shortcut first-keystroke="shift ctrl MINUS"/></action></keymap>`,
    );
    expect(k.overrides["code.expandDocComments"]).toEqual([normalizeBinding("Shift+Ctrl+=")]);
    expect(k.overrides["code.collapseDocComments"]).toEqual([normalizeBinding("Shift+Ctrl+-")]);
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

  it("maps Compare File with Editor", () => {
    const k = parseIdeaKeymap(
      `<keymap name="C" parent="$default"><action id="CompareFileWithEditor"><keyboard-shortcut first-keystroke="ctrl alt D"/></action></keymap>`,
    );
    expect(k.overrides["diff.compareFileWithEditor"]).toEqual([normalizeBinding("Ctrl+Alt+D")]);
    expect(k.unknownActions).toEqual([]);
  });

  it("maps Increase / Decrease Font Size in All Editors", () => {
    const k = parseIdeaKeymap(
      `<keymap name="F" parent="Mac OS X 10.5+"><action id="EditorIncreaseFontSizeGlobal"><keyboard-shortcut first-keystroke="shift meta EQUALS"/></action><action id="EditorDecreaseFontSizeGlobal"><keyboard-shortcut first-keystroke="shift meta MINUS"/></action></keymap>`,
    );
    expect(k.overrides["editor.increaseFontSizeAll"]).toEqual([normalizeBinding("Meta+Shift+=")]);
    expect(k.overrides["editor.decreaseFontSizeAll"]).toEqual([normalizeBinding("Meta+Shift+-")]);
    expect(k.unknownActions).toEqual([]);
  });

  it("maps Scroll Left / Scroll Right", () => {
    const k = parseIdeaKeymap(
      `<keymap name="M" parent="Mac OS X 10.5+"><action id="EditorScrollLeft"><keyboard-shortcut first-keystroke="meta alt LEFT"/></action><action id="EditorScrollRight"><keyboard-shortcut first-keystroke="meta alt RIGHT"/></action></keymap>`,
    );
    expect(k.overrides["editor.scrollLeft"]).toEqual([normalizeBinding("Meta+Alt+Left")]);
    expect(k.overrides["editor.scrollRight"]).toEqual([normalizeBinding("Meta+Alt+Right")]);
    expect(k.unknownActions).toEqual([]);
  });

  it("maps Scroll Up / Scroll Down and Move if Necessary", () => {
    const k = parseIdeaKeymap(
      `<keymap name="E" parent="$default"><action id="EditorScrollUpAndMove"><keyboard-shortcut first-keystroke="alt UP"/></action><action id="EditorScrollDownAndMove"><keyboard-shortcut first-keystroke="alt DOWN"/></action></keymap>`,
    );
    expect(k.overrides["editor.scrollUpAndMove"]).toEqual([normalizeBinding("Alt+Up")]);
    expect(k.overrides["editor.scrollDownAndMove"]).toEqual([normalizeBinding("Alt+Down")]);
    expect(k.unknownActions).toEqual([]);
  });

  it("maps Move Up / Down and Scroll (with Selection)", () => {
    const k = parseIdeaKeymap(
      `<keymap name="E" parent="$default"><action id="EditorMoveUpAndScroll"><keyboard-shortcut first-keystroke="ctrl alt UP"/></action><action id="EditorMoveDownAndScroll"><keyboard-shortcut first-keystroke="ctrl alt DOWN"/></action><action id="EditorMoveUpAndScrollWithSelection"><keyboard-shortcut first-keystroke="ctrl alt shift UP"/></action><action id="EditorMoveDownAndScrollWithSelection"><keyboard-shortcut first-keystroke="ctrl alt shift DOWN"/></action></keymap>`,
    );
    expect(k.overrides["editor.moveUpAndScroll"]).toEqual([normalizeBinding("Ctrl+Alt+Up")]);
    expect(k.overrides["editor.moveDownAndScroll"]).toEqual([normalizeBinding("Ctrl+Alt+Down")]);
    expect(k.overrides["editor.moveUpAndScrollWithSelection"]).toEqual([normalizeBinding("Ctrl+Alt+Shift+Up")]);
    expect(k.overrides["editor.moveDownAndScrollWithSelection"]).toEqual([normalizeBinding("Ctrl+Alt+Shift+Down")]);
    expect(k.unknownActions).toEqual([]);
  });

  it("maps Scroll to Top / Scroll to Bottom", () => {
    const k = parseIdeaKeymap(
      `<keymap name="X" parent="Mac OS X 10.5+"><action id="EditorScrollTop"><keyboard-shortcut first-keystroke="HOME"/></action><action id="EditorScrollBottom"><keyboard-shortcut first-keystroke="END"/></action></keymap>`,
    );
    expect(k.overrides["editor.scrollToTop"]).toEqual([normalizeBinding("Home")]);
    expect(k.overrides["editor.scrollToBottom"]).toEqual([normalizeBinding("End")]);
    expect(k.unknownActions).toEqual([]);
  });

  it("maps Toggle Zen Mode", () => {
    const k = parseIdeaKeymap(
      `<keymap name="E" parent="Mac OS X 10.5+"><action id="ToggleZenMode"><keyboard-shortcut first-keystroke="control meta Z"/></action></keymap>`,
    );
    expect(k.overrides["view.toggleZenMode"]).toEqual([normalizeBinding("Ctrl+Meta+Z")]);
    expect(k.unknownActions).toEqual([]);
  });

  it("maps Save as Live Template, which has no shortcut in the presets", () => {
    const k = parseIdeaKeymap(
      `<keymap name="E" parent="$default"><action id="SaveAsTemplate"><keyboard-shortcut first-keystroke="ctrl alt shift T"/></action></keymap>`,
    );
    expect(k.overrides["code.saveAsLiveTemplate"]).toEqual([normalizeBinding("Ctrl+Alt+Shift+T")]);
    expect(k.unknownActions).toEqual([]);
  });

  it("maps Copy as Plain Text / Copy as Rich Text", () => {
    const k = parseIdeaKeymap(
      `<keymap name="E" parent="Mac OS X 10.5+"><action id="CopyAsPlainText"><keyboard-shortcut first-keystroke="control alt C"/></action><action id="CopyAsRichText"><keyboard-shortcut first-keystroke="control alt shift C"/></action></keymap>`,
    );
    expect(k.overrides["code.copyAsPlainText"]).toEqual([normalizeBinding("Ctrl+Alt+C")]);
    expect(k.overrides["code.copyAsRichText"]).toEqual([normalizeBinding("Ctrl+Alt+Shift+C")]);
    expect(k.unknownActions).toEqual([]);
  });

  it("maps Delete to Line Start / End and Cut up to Line End", () => {
    const k = parseIdeaKeymap(
      `<keymap name="E" parent="Mac OS X 10.5+"><action id="EditorDeleteToLineStart"><keyboard-shortcut first-keystroke="meta BACK_SPACE"/></action><action id="EditorDeleteToLineEnd"><keyboard-shortcut first-keystroke="shift meta DELETE"/></action><action id="EditorCutLineEnd"><keyboard-shortcut first-keystroke="control alt K"/></action></keymap>`,
    );
    expect(k.overrides["code.deleteToLineStart"]).toEqual([normalizeBinding("Meta+Backspace")]);
    expect(k.overrides["code.deleteToLineEnd"]).toEqual([normalizeBinding("Shift+Meta+Delete")]);
    expect(k.overrides["code.cutLineEnd"]).toEqual([normalizeBinding("Ctrl+Alt+K")]);
    expect(k.unknownActions).toEqual([]);
  });

  it("maps Recent Find Usages", () => {
    const k = parseIdeaKeymap(
      `<keymap name="R" parent="$default"><action id="ShowRecentFindUsagesGroup"><keyboard-shortcut first-keystroke="control alt shift F7"/></action></keymap>`,
    );
    expect(k.overrides["find.recentUsages"]).toEqual([normalizeBinding("Ctrl+Alt+Shift+F7")]);
    expect(k.unknownActions).toEqual([]);
  });

  it("maps Kill to Word Start / End", () => {
    const k = parseIdeaKeymap(
      `<keymap name="K" parent="$default"><action id="EditorKillToWordStart"><keyboard-shortcut first-keystroke="alt BACK_SPACE"/></action><action id="EditorKillToWordEnd"><keyboard-shortcut first-keystroke="alt D"/></action></keymap>`,
    );
    expect(k.overrides["code.killToWordStart"]).toEqual([normalizeBinding("Alt+Backspace")]);
    expect(k.overrides["code.killToWordEnd"]).toEqual([normalizeBinding("Alt+D")]);
    expect(k.unknownActions).toEqual([]);
  });

  it("maps Hungry Backspace", () => {
    const k = parseIdeaKeymap(
      `<keymap name="H" parent="$default"><action id="EditorHungryBackSpace"><keyboard-shortcut first-keystroke="control alt BACK_SPACE"/></action></keymap>`,
    );
    expect(k.overrides["code.hungryBackspace"]).toEqual([normalizeBinding("Ctrl+Alt+Backspace")]);
    expect(k.unknownActions).toEqual([]);
  });

  it("maps Move Caret Forward / Backward a Paragraph", () => {
    const k = parseIdeaKeymap(
      `<keymap name="P" parent="$default"><action id="EditorForwardParagraph"><keyboard-shortcut first-keystroke="alt shift CLOSE_BRACKET"/></action><action id="EditorBackwardParagraphWithSelection"><keyboard-shortcut first-keystroke="control alt shift OPEN_BRACKET"/></action></keymap>`,
    );
    expect(k.overrides["editor.paragraphForward"]).toEqual([normalizeBinding("Alt+Shift+]")]);
    expect(k.overrides["editor.paragraphBackwardWithSelection"]).toEqual([normalizeBinding("Ctrl+Alt+Shift+[")]);
    expect(k.unknownActions).toEqual([]);
  });

  it('maps the word moves and deletes in Different "CamelHumps" Mode', () => {
    const k = parseIdeaKeymap(
      `<keymap name="H" parent="$default"><action id="EditorNextWordInDifferentHumpsMode"><keyboard-shortcut first-keystroke="control alt RIGHT"/></action><action id="EditorPreviousWordInDifferentHumpsModeWithSelection"><keyboard-shortcut first-keystroke="control alt shift LEFT"/></action><action id="EditorDeleteToWordStartInDifferentHumpsMode"><keyboard-shortcut first-keystroke="control alt BACK_SPACE"/></action></keymap>`,
    );
    expect(k.overrides["editor.nextWordInDifferentHumpsMode"]).toEqual([normalizeBinding("Ctrl+Alt+Right")]);
    expect(k.overrides["editor.previousWordInDifferentHumpsModeWithSelection"]).toEqual([
      normalizeBinding("Ctrl+Alt+Shift+Left"),
    ]);
    expect(k.overrides["code.deleteToWordStartInDifferentHumpsMode"]).toEqual([normalizeBinding("Ctrl+Alt+Backspace")]);
    expect(k.unknownActions).toEqual([]);
  });

  it("maps Swap Selection Boundaries", () => {
    const k = parseIdeaKeymap(
      `<keymap name="S" parent="$default"><action id="EditorSwapSelectionBoundaries"><keyboard-shortcut first-keystroke="control X" second-keystroke="control X"/></action></keymap>`,
    );
    expect(k.overrides["editor.swapSelectionBoundaries"]).toEqual([normalizeBinding("Ctrl+X Ctrl+X")]);
    expect(k.unknownActions).toEqual([]);
  });

  it("maps Toggle Sticky Selection", () => {
    const k = parseIdeaKeymap(
      `<keymap name="S" parent="$default"><action id="EditorToggleStickySelection"><keyboard-shortcut first-keystroke="control SPACE"/></action></keymap>`,
    );
    expect(k.overrides["editor.toggleStickySelection"]).toEqual([normalizeBinding("Ctrl+Space")]);
    expect(k.unknownActions).toEqual([]);
  });

  it("maps Select Line at Caret", () => {
    const k = parseIdeaKeymap(
      `<keymap name="S" parent="$default"><action id="EditorSelectLine"><keyboard-shortcut first-keystroke="control alt L"/></action></keymap>`,
    );
    expect(k.overrides["editor.selectLine"]).toEqual([normalizeBinding("Ctrl+Alt+L")]);
    expect(k.unknownActions).toEqual([]);
  });

  it("maps Move Caret to Page Top / Bottom", () => {
    const k = parseIdeaKeymap(
      `<keymap name="W" parent="$default"><action id="EditorMoveToPageTop"><keyboard-shortcut first-keystroke="alt PAGE_UP"/></action><action id="EditorMoveToPageBottomWithSelection"><keyboard-shortcut first-keystroke="alt shift PAGE_DOWN"/></action></keymap>`,
    );
    expect(k.overrides["editor.moveToPageTop"]).toEqual([normalizeBinding("Alt+PageUp")]);
    expect(k.overrides["editor.moveToPageBottomWithSelection"]).toEqual([normalizeBinding("Alt+Shift+PageDown")]);
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

  it("maps Toggle Breakpoint Enabled, which has no shortcut in the presets", () => {
    const k = parseIdeaKeymap(
      `<keymap name="M" parent="Mac OS X 10.5+"><action id="ToggleBreakpointEnabled"><keyboard-shortcut first-keystroke="alt meta F8"/></action></keymap>`,
    );
    expect(k.overrides["debug.toggleBreakpointEnabled"]).toEqual([normalizeBinding("Alt+Meta+F8")]);
    expect(k.unknownActions).toEqual([]);
  });

  it("maps the Active Tool Window actions", () => {
    const k = parseIdeaKeymap(
      `<keymap name="M" parent="$default"><action id="HideSideWindows"><keyboard-shortcut first-keystroke="control alt shift F12"/></action><action id="HideActiveWindow"><keyboard-shortcut first-keystroke="alt ESCAPE"/></action><action id="MaximizeToolWindow"><keyboard-shortcut first-keystroke="control alt M"/></action><action id="JumpToLastWindow"><keyboard-shortcut first-keystroke="alt F12"/></action><action id="ResizeToolWindowLeft"><keyboard-shortcut first-keystroke="control alt LEFT"/></action><action id="ResizeToolWindowRight"><keyboard-shortcut first-keystroke="control alt RIGHT"/></action><action id="ResizeToolWindowUp"><keyboard-shortcut first-keystroke="control alt UP"/></action><action id="ResizeToolWindowDown"><keyboard-shortcut first-keystroke="control alt DOWN"/></action></keymap>`,
    );
    expect(k.overrides).toMatchObject({
      "toolwindow.hideSide": [normalizeBinding("Ctrl+Alt+Shift+F12")],
      "toolwindow.hideActive": [normalizeBinding("Alt+Escape")],
      "toolwindow.maximize": [normalizeBinding("Ctrl+Alt+M")],
      "toolwindow.jumpToLast": [normalizeBinding("Alt+F12")],
      "toolwindow.resizeLeft": [normalizeBinding("Ctrl+Alt+Left")],
      "toolwindow.resizeRight": [normalizeBinding("Ctrl+Alt+Right")],
      "toolwindow.resizeUp": [normalizeBinding("Ctrl+Alt+Up")],
      "toolwindow.resizeDown": [normalizeBinding("Ctrl+Alt+Down")],
    });
    expect(k.unknownActions).toEqual([]);
  });

  it("maps Delete Duplicate Lines", () => {
    const k = parseIdeaKeymap(
      `<keymap name="M" parent="Mac OS X 10.5+"><action id="EditorUniqueLines"><keyboard-shortcut first-keystroke="shift meta 7"/></action></keymap>`,
    );
    expect(k.overrides["code.uniqueLines"]).toEqual([normalizeBinding("Shift+Meta+7")]);
    expect(k.unknownActions).toEqual([]);
  });

  it("rejects other XML", () => {
    expect(() => parseIdeaKeymap("<scheme name='x'/>")).toThrow(/keymap/);
  });
});
