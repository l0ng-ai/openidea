import { describe, expect, it } from "vitest";
import { intellijMacos } from "./intellij-macos";
import { intellijWindows } from "./intellij-windows";

/** Bindings checked against IDEA's `$default.xml` (Windows) and `Mac OS X 10.5+.xml`. */
describe("IDEA keymap parity", () => {
  it.each([
    ["code.splitLine", ["Meta+Enter"], ["Ctrl+Enter"]],
    ["code.smartTypeCompletion", ["Ctrl+Shift+Space"], ["Ctrl+Shift+Space"]],
    ["editor.scrollToCenter", ["Ctrl+L"], ["Ctrl+M"]],
    ["editor.codeBlockStart", ["Meta+Alt+["], ["Ctrl+["]],
    ["editor.codeBlockEnd", ["Meta+Alt+]"], ["Ctrl+]"]],
    ["view.zoomIn", ["Ctrl+Alt+="], ["Alt+Shift+="]],
    ["view.zoomOut", ["Ctrl+Alt+-"], ["Alt+Shift+-"]],
    ["view.resetZoom", ["Ctrl+Alt+0"], ["Alt+Shift+0"]],
    ["editor.increaseFontSize", [], []],
    ["editor.decreaseFontSize", [], []],
    ["editor.increaseFontSizeAll", ["Ctrl+Shift+."], ["Alt+Shift+."]],
    ["editor.decreaseFontSizeAll", ["Ctrl+Shift+,"], ["Alt+Shift+,"]],
    ["vcs.changelist.move", ["Meta+Shift+M"], ["Alt+Shift+M"]],
    ["vcs.changelist.edit", ["F2", "Shift+F6"], ["F2", "Shift+F6"]],
    ["code.quickDocumentation", ["F1", "Ctrl+J"], ["Ctrl+Q"]],
    // Git.Branches: the macOS keymaps remove ⇧⌘` (it cycles windows there).
    ["vcs.branches", [], ["Ctrl+Shift+`"]],
    // Git.CreateNewBranch shares Inline's shortcut.
    ["vcs.newBranch", ["Meta+Alt+N"], ["Ctrl+Alt+N"]],
    // ChangesView.AddUnversioned; on Windows the diff viewer's Apply Right Side wins while a diff is focused.
    ["vcs.addToVcs", ["Meta+Alt+A"], ["Ctrl+Alt+A"]],
    ["refactor.inline", ["Meta+Alt+N"], ["Ctrl+Alt+N"]],
    ["debug.resume", ["Meta+Alt+R", "F9"], ["F9"]],
    ["code.quickDefinition", ["Alt+Space", "Meta+Y"], ["Ctrl+Shift+I"]],
    ["editor.copyPathReference", ["Meta+Shift+C"], ["Ctrl+Shift+C"]],
    ["project.open", ["F4", "Meta+Down"], ["F4"]],
    ["diff.compareFileWithEditor", [], []],
    // Diff.OpenInEditor copies EditSource's shortcuts.
    ["diff.jumpToSource", ["F4", "Meta+Down"], ["F4"]],
    ["project.delete", ["Delete", "Backspace", "Meta+Backspace"], ["Delete"]],
    ["file.reloadFromDisk", ["Meta+Alt+Y"], ["Ctrl+Alt+Y"]],
    ["project.reloadFromDisk", ["Meta+Alt+Y"], ["Ctrl+Alt+Y"]],
    ["project.expandAll", ["Meta+="], ["Ctrl+="]],
    ["project.collapseAll", ["Meta+-"], ["Ctrl+-"]],
    ["run.expandAllTests", ["Meta+="], ["Ctrl+="]],
    ["run.collapseAllTests", ["Meta+-"], ["Ctrl+-"]],
    ["navigate.searchText", ["Meta+Alt+Shift+E"], ["Ctrl+Alt+Shift+E"]],
    ["db.showDiagram", ["Meta+Alt+Shift+U"], ["Ctrl+Alt+Shift+U"]],
    // ShowUmlDiagramPopup shares Unshelve Silently's shortcut, which needs the Shelf to have focus.
    ["db.showDiagramPopup", ["Meta+Alt+U"], ["Ctrl+Alt+U"]],
    ["python.console.executeSelection", ["Alt+Shift+E"], ["Alt+Shift+E"]],
    ["window.next", ["Meta+Alt+`"], ["Ctrl+Alt+]"]],
    ["window.previous", ["Meta+Alt+Shift+`"], ["Ctrl+Alt+["]],
    ["code.commentBlock", ["Meta+Alt+/", "Ctrl+Shift+/"], ["Ctrl+Shift+/"]],
    ["navigate.typeDeclaration", ["Meta+Shift+B", "Ctrl+Shift+B"], ["Ctrl+Shift+B"]],
    ["navigate.implementation", ["Meta+Alt+B", "Meta+Alt+Button1"], ["Ctrl+Alt+B", "Ctrl+Alt+Button1"]],
    ["find.next", ["Meta+G"], ["F3", "Ctrl+L"]],
    ["find.previous", ["Meta+Shift+G"], ["Shift+F3", "Ctrl+Shift+L"]],
    // FindWordAtCaret / FindPrevWordAtCaret: the macOS keymaps remove ⌘F3 / ⇧⌘F3.
    ["find.wordAtCaret", [], ["Ctrl+F3"]],
    ["find.previousWordAtCaret", [], ["Ctrl+Shift+F3"]],
    ["project.copy", ["Meta+C"], ["Ctrl+C", "Ctrl+Insert"]],
    ["project.cut", ["Meta+X"], ["Ctrl+X", "Shift+Delete"]],
    ["project.paste", ["Meta+V"], ["Ctrl+V", "Shift+Insert"]],
    ["editor.matchBrace", ["Ctrl+M"], ["Ctrl+Shift+M"]],
    ["code.collapseRecursively", ["Meta+Alt+-"], ["Ctrl+Alt+-"]],
    ["code.expandRecursively", ["Meta+Alt+="], ["Ctrl+Alt+="]],
    ["editor.cloneCaretAbove", ["Alt Alt+Up"], ["Ctrl Ctrl+Up"]],
    ["editor.cloneCaretBelow", ["Alt Alt+Down"], ["Ctrl Ctrl+Down"]],
    // `Mac OS X 10.5+` removes the ⌘↑ / ⌘↓ it would inherit from `Mac OS X`.
    ["editor.scrollUp", [], ["Ctrl+Up"]],
    ["editor.scrollDown", [], ["Ctrl+Down"]],
    ["editor.scrollLeft", [], []],
    ["editor.scrollRight", [], []],
    ["editor.scrollUpAndMove", [], []],
    ["editor.scrollDownAndMove", [], []],
    ["editor.moveUpAndScroll", [], []],
    ["editor.moveDownAndScroll", [], []],
    ["editor.moveUpAndScrollWithSelection", [], []],
    ["editor.moveDownAndScrollWithSelection", [], []],
    // Only IDEA's Xcode keymap binds these (Home / End).
    ["editor.scrollToTop", [], []],
    ["editor.scrollToBottom", [], []],
    // `$default` Ctrl reads as ⌘ in the Mac keymaps that inherit it.
    ["editor.moveToPageTop", ["Meta+PageUp"], ["Ctrl+PageUp"]],
    ["editor.moveToPageBottom", ["Meta+PageDown"], ["Ctrl+PageDown"]],
    ["editor.moveToPageTopWithSelection", ["Meta+Shift+PageUp"], ["Ctrl+Shift+PageUp"]],
    ["editor.moveToPageBottomWithSelection", ["Meta+Shift+PageDown"], ["Ctrl+Shift+PageDown"]],
    ["editor.toggleInsertState", ["Insert"], ["Insert"]],
    // EditorCutLineEnd: only `Mac OS X 10.5+` binds it; EditorDeleteToLineStart / End and
    // EditorHungryBackSpace have no shortcut.
    ["code.cutLineEnd", ["Ctrl+K"], []],
    ["code.deleteToLineStart", [], []],
    ["code.deleteToLineEnd", [], []],
    ["code.hungryBackspace", [], []],
    // EditorKillToWordStart / End: only the Emacs keymap binds them.
    ["code.killToWordStart", [], []],
    ["code.killToWordEnd", [], []],
    // EditorTranspose has no shortcut.
    ["code.transpose", [], []],
    // EditorSwapSelectionBoundaries has no shortcut.
    ["editor.swapSelectionBoundaries", [], []],
    // EditorToggleStickySelection has no shortcut.
    ["editor.toggleStickySelection", [], []],
    // EditorSelectLine has no shortcut.
    ["editor.selectLine", [], []],
    // CopyAsPlainText / CopyAsRichText have no shortcut.
    ["code.copyAsPlainText", [], []],
    ["code.copyAsRichText", [], []],
    // ToggleZenMode has no shortcut.
    ["view.toggleZenMode", [], []],
    ["navigate.nextOccurrence", ["Meta+Alt+Down"], ["Ctrl+Alt+Down"]],
    ["navigate.prevOccurrence", ["Meta+Alt+Up"], ["Ctrl+Alt+Up"]],
    // Rerun in the Find / Find Usages tool windows uses the Rerun shortcut.
    ["find.rerun", ["Meta+R"], ["Ctrl+F5"]],
    ["usages.rerun", ["Meta+R"], ["Ctrl+F5"]],
    // ShowRecentFindUsagesGroup has no shortcut.
    ["find.recentUsages", [], []],
    // Vcs.Log.GoToRef: Find in the Git Log table.
    ["vcs.log.goToRef", ["Meta+F"], ["Ctrl+F"]],
    // Back / Forward also carry the mouse side buttons (`<mouse-shortcut keystroke="button4"/>`).
    ["editor.codeBlockStartWithSelection", ["Meta+Alt+Shift+["], ["Ctrl+Shift+["]],
    ["editor.codeBlockEndWithSelection", ["Meta+Alt+Shift+]"], ["Ctrl+Shift+]"]],
    // EditorForwardParagraph / EditorBackwardParagraph (and with Selection) have no shortcut.
    ["editor.paragraphForward", [], []],
    ["editor.paragraphBackward", [], []],
    ["editor.paragraphForwardWithSelection", [], []],
    ["editor.paragraphBackwardWithSelection", [], []],
    // The "in Different "CamelHumps" Mode" word moves and deletes have no shortcut.
    ["editor.nextWordInDifferentHumpsMode", [], []],
    ["editor.previousWordInDifferentHumpsMode", [], []],
    ["editor.nextWordInDifferentHumpsModeWithSelection", [], []],
    ["editor.previousWordInDifferentHumpsModeWithSelection", [], []],
    ["code.deleteToWordStartInDifferentHumpsMode", [], []],
    ["code.deleteToWordEndInDifferentHumpsMode", [], []],
    ["code.collapseBlock", ["Meta+Shift+."], ["Ctrl+Shift+."]],
    ["code.autoIndentLines", ["Ctrl+Alt+I"], ["Ctrl+Alt+I"]],
    ["code.showErrorDescription", ["Meta+F1"], ["Ctrl+F1"]],
    ["code.moveElementLeft", ["Meta+Alt+Shift+Left"], ["Ctrl+Alt+Shift+Left"]],
    ["code.moveElementRight", ["Meta+Alt+Shift+Right"], ["Ctrl+Alt+Shift+Right"]],
    ["code.surroundWithLiveTemplate", ["Meta+Alt+J"], ["Ctrl+Alt+J"]],
    ["code.saveAsLiveTemplate", [], []],
    ["navigate.customRegion", ["Meta+Alt+."], ["Ctrl+Alt+."]],
    ["navigate.showFilePath", ["Meta+Alt+F12"], ["Ctrl+Alt+F12"]],
    ["navigate.nextHighlightedUsage", ["Ctrl+Alt+Down"], ["Ctrl+Alt+Down"]],
    ["analyze.inspectFile", ["Alt+Shift+I"], ["Alt+Shift+I"]],
    ["project.copyElement", ["F5"], ["F5"]],
    ["debug.quickEvaluate", ["Meta+Alt+F8", "Alt+Button1"], ["Ctrl+Alt+F8", "Alt+Button1"]],
    ["run.chooseDebugConfig", ["Ctrl+Alt+D"], ["Alt+Shift+F9"]],
    ["editor.nextSplitter", ["Alt+Tab"], ["Alt+Tab"]],
    ["toolwindow.resizeLeft", ["Ctrl+Alt+Left"], ["Ctrl+Alt+Shift+Left"]],
    ["toolwindow.closeContent", ["Meta+W", "Ctrl+Shift+F4"], ["Ctrl+F4", "Ctrl+Shift+F4"]],
    ["layout.restoreCurrent", ["Shift+F12"], ["Shift+F12"]],
    ["workbench.stopBackgroundProcesses", ["Meta+Shift+F2"], ["Ctrl+Shift+F2"]],
    ["navigate.back", ["Meta+[", "Meta+Alt+Left", "Button4", "SwipeRight"], ["Ctrl+Alt+Left", "Button4"]],
    ["navigate.forward", ["Meta+]", "Meta+Alt+Right", "Button5", "SwipeLeft"], ["Ctrl+Alt+Right", "Button5"]],
    ["file.projectStructure", ["Meta+;"], ["Ctrl+Alt+Shift+S"]],
    ["build.compileFile", ["Meta+Shift+F9"], ["Ctrl+Shift+F9"]],
    ["build.buildModule", [], []],
  ])("%s", (id, mac, win) => {
    expect(intellijMacos[id]).toEqual(mac);
    expect(intellijWindows[id]).toEqual(win);
  });

  // Later entries win a shared key while their `when` / `keyWhen` holds.
  const order = (km: Record<string, string[]>, earlier: string, later: string) => {
    const ids = Object.keys(km);
    expect(ids.indexOf(earlier), `${earlier} before ${later}`).toBeLessThan(ids.indexOf(later));
  };

  it.each([intellijMacos, intellijWindows])("lets scoped actions win shared keys", (km) => {
    order(km, "code.splitLine", "http.runRequest");
    order(km, "code.splitLine", "db.execute");
    order(km, "editor.copyPathReference", "project.copyAbsolutePath");
    order(km, "file.reloadFromDisk", "project.reloadFromDisk");
    order(km, "code.unfold", "project.expandAll");
    order(km, "code.fold", "project.collapseAll");
    order(km, "code.unfold", "run.expandAllTests");
    order(km, "code.fold", "run.collapseAllTests");
    order(km, "navigate.nextError", "vcs.changelist.edit");
    order(km, "debug.setValue", "vcs.changelist.edit");
    order(km, "find.replaceInFile", "find.rerun");
    order(km, "navigate.nextOccurrence", "navigate.nextHighlightedUsage");
    order(km, "code.moveElementLeft", "toolwindow.resizeLeft");
    order(km, "find.inFile", "vcs.log.goToRef");
    // Inline (text editor only) wins over New Branch.
    order(km, "vcs.newBranch", "refactor.inline");
    order(km, "vcs.addToVcs", "diff.applyRightSide");
  });
});
