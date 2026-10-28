import { describe, expect, it } from "vitest";
import { intellijMacos } from "./intellij-macos";
import { intellijWindows } from "./intellij-windows";

/** Bindings checked against IDEA's `$default.xml` (Windows) and `Mac OS X 10.5+.xml`. */
describe("IDEA keymap parity", () => {
  it.each([
    ["code.splitLine", ["Meta+Enter"], ["Ctrl+Enter"]],
    ["editor.scrollToCenter", ["Ctrl+L"], ["Ctrl+M"]],
    ["editor.codeBlockStart", ["Meta+Alt+["], ["Ctrl+["]],
    ["editor.codeBlockEnd", ["Meta+Alt+]"], ["Ctrl+]"]],
    ["view.zoomIn", ["Ctrl+Alt+="], ["Alt+Shift+="]],
    ["view.zoomOut", ["Ctrl+Alt+-"], ["Alt+Shift+-"]],
    ["view.resetZoom", ["Ctrl+Alt+0"], ["Alt+Shift+0"]],
    ["editor.increaseFontSize", ["Alt+Shift+."], ["Alt+Shift+."]],
    ["editor.decreaseFontSize", ["Alt+Shift+,"], ["Alt+Shift+,"]],
    ["vcs.changelist.move", ["Meta+Shift+M"], ["Alt+Shift+M"]],
    ["vcs.changelist.edit", ["F2", "Shift+F6"], ["F2", "Shift+F6"]],
    ["code.quickDocumentation", ["F1", "Ctrl+J"], ["Ctrl+Q"]],
    // Git.Branches: the macOS keymaps remove ⇧⌘` (it cycles windows there).
    ["vcs.branches", [], ["Ctrl+Shift+`"]],
    // Git.CreateNewBranch shares Inline's shortcut.
    ["vcs.newBranch", ["Meta+Alt+N"], ["Ctrl+Alt+N"]],
    ["refactor.inline", ["Meta+Alt+N"], ["Ctrl+Alt+N"]],
    ["debug.resume", ["Meta+Alt+R", "F9"], ["F9"]],
    ["code.quickDefinition", ["Alt+Space", "Meta+Y"], ["Ctrl+Shift+I"]],
    ["editor.copyPath", ["Meta+Shift+C"], ["Ctrl+Shift+C"]],
    ["project.open", ["F4", "Meta+Down"], ["F4"]],
    ["project.delete", ["Delete", "Backspace", "Meta+Backspace"], ["Delete"]],
    ["file.reloadFromDisk", ["Meta+Alt+Y"], ["Ctrl+Alt+Y"]],
    ["project.reloadFromDisk", ["Meta+Alt+Y"], ["Ctrl+Alt+Y"]],
    ["project.expandAll", ["Meta+="], ["Ctrl+="]],
    ["project.collapseAll", ["Meta+-"], ["Ctrl+-"]],
    ["navigate.searchText", ["Meta+Alt+Shift+E"], ["Ctrl+Alt+Shift+E"]],
    ["window.next", ["Meta+Alt+`"], ["Ctrl+Alt+]"]],
    ["window.previous", ["Meta+Alt+Shift+`"], ["Ctrl+Alt+["]],
    ["code.commentBlock", ["Meta+Alt+/", "Ctrl+Shift+/"], ["Ctrl+Shift+/"]],
    ["navigate.typeDeclaration", ["Meta+Shift+B", "Ctrl+Shift+B"], ["Ctrl+Shift+B"]],
    ["find.next", ["Meta+G"], ["F3", "Ctrl+L"]],
    ["find.previous", ["Meta+Shift+G"], ["Shift+F3", "Ctrl+Shift+L"]],
    ["project.copy", ["Meta+C"], ["Ctrl+C", "Ctrl+Insert"]],
    ["project.cut", ["Meta+X"], ["Ctrl+X", "Shift+Delete"]],
    ["project.paste", ["Meta+V"], ["Ctrl+V", "Shift+Insert"]],
    ["editor.matchBrace", ["Ctrl+M"], ["Ctrl+Shift+M"]],
    ["code.collapseRecursively", ["Meta+Alt+-"], ["Ctrl+Alt+-"]],
    ["code.expandRecursively", ["Meta+Alt+="], ["Ctrl+Alt+="]],
    ["editor.cloneCaretAbove", ["Alt Alt+Up"], ["Ctrl Ctrl+Up"]],
    ["editor.cloneCaretBelow", ["Alt Alt+Down"], ["Ctrl Ctrl+Down"]],
    ["editor.toggleInsertState", ["Insert"], ["Insert"]],
    ["navigate.nextOccurrence", ["Meta+Alt+Down"], ["Ctrl+Alt+Down"]],
    ["navigate.prevOccurrence", ["Meta+Alt+Up"], ["Ctrl+Alt+Up"]],
    // Rerun in the Find / Find Usages tool windows uses the Rerun shortcut.
    ["find.rerun", ["Meta+R"], ["Ctrl+F5"]],
    ["usages.rerun", ["Meta+R"], ["Ctrl+F5"]],
    // Vcs.Log.GoToRef: Find in the Git Log table.
    ["vcs.log.goToRef", ["Meta+F"], ["Ctrl+F"]],
    // Back / Forward also carry the mouse side buttons (`<mouse-shortcut keystroke="button4"/>`).
    ["editor.codeBlockStartWithSelection", ["Meta+Alt+Shift+["], ["Ctrl+Shift+["]],
    ["editor.codeBlockEndWithSelection", ["Meta+Alt+Shift+]"], ["Ctrl+Shift+]"]],
    ["code.collapseBlock", ["Meta+Shift+."], ["Ctrl+Shift+."]],
    ["code.autoIndentLines", ["Ctrl+Alt+I"], ["Ctrl+Alt+I"]],
    ["code.showErrorDescription", ["Meta+F1"], ["Ctrl+F1"]],
    ["code.moveElementLeft", ["Meta+Alt+Shift+Left"], ["Ctrl+Alt+Shift+Left"]],
    ["code.moveElementRight", ["Meta+Alt+Shift+Right"], ["Ctrl+Alt+Shift+Right"]],
    ["code.surroundWithLiveTemplate", ["Meta+Alt+J"], ["Ctrl+Alt+J"]],
    ["navigate.customRegion", ["Meta+Alt+."], ["Ctrl+Alt+."]],
    ["navigate.showFilePath", ["Meta+Alt+F12"], ["Ctrl+Alt+F12"]],
    ["navigate.nextHighlightedUsage", ["Ctrl+Alt+Down"], ["Ctrl+Alt+Down"]],
    ["analyze.inspectFile", ["Alt+Shift+I"], ["Alt+Shift+I"]],
    ["project.copyElement", ["F5"], ["F5"]],
    ["debug.quickEvaluate", ["Meta+Alt+F8"], ["Ctrl+Alt+F8"]],
    ["run.chooseDebugConfig", ["Ctrl+Alt+D"], ["Alt+Shift+F9"]],
    ["editor.nextSplitter", ["Alt+Tab"], ["Alt+Tab"]],
    ["toolwindow.resizeLeft", ["Ctrl+Alt+Left"], ["Ctrl+Alt+Shift+Left"]],
    ["toolwindow.closeContent", ["Meta+W", "Ctrl+Shift+F4"], ["Ctrl+F4", "Ctrl+Shift+F4"]],
    ["layout.restoreDefault", ["Shift+F12"], ["Shift+F12"]],
    ["workbench.stopBackgroundProcesses", ["Meta+Shift+F2"], ["Ctrl+Shift+F2"]],
    ["navigate.back", ["Meta+[", "Meta+Alt+Left", "Button4"], ["Ctrl+Alt+Left", "Button4"]],
    ["navigate.forward", ["Meta+]", "Meta+Alt+Right", "Button5"], ["Ctrl+Alt+Right", "Button5"]],
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
    order(km, "editor.copyPath", "project.copyAbsolutePath");
    order(km, "file.reloadFromDisk", "project.reloadFromDisk");
    order(km, "code.unfold", "project.expandAll");
    order(km, "code.fold", "project.collapseAll");
    order(km, "navigate.nextError", "vcs.changelist.edit");
    order(km, "debug.setValue", "vcs.changelist.edit");
    order(km, "find.replaceInFile", "find.rerun");
    order(km, "navigate.nextOccurrence", "navigate.nextHighlightedUsage");
    order(km, "code.moveElementLeft", "toolwindow.resizeLeft");
    order(km, "find.inFile", "vcs.log.goToRef");
    // Inline (text editor only) wins over New Branch.
    order(km, "vcs.newBranch", "refactor.inline");
  });
});
