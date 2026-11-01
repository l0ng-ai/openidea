/**
 * IntelliJ IDEA "IntelliJ Classic" (`Mac OS X`) keymap preset.
 *
 * Inherits the modern macOS preset's action order and overrides the bindings
 * where IntelliJ's legacy `Mac OS X.xml` differs from `Mac OS X 10.5+.xml`.
 */
import { intellijMacos } from "./intellij-macos";

export const intellijClassicMacos: Record<string, string[]> = {
  ...intellijMacos,

  // Navigate
  "navigate.gotoClass": ["Meta+N"],
  "navigate.gotoFile": ["Meta+Shift+N"],
  "navigate.gotoSymbol": ["Meta+Alt+Shift+N"],
  "navigate.navigationBar": ["Alt+Home"],
  "navigate.back": ["Meta+Alt+Left", "Button4"],
  "navigate.forward": ["Meta+Alt+Right", "Button5"],
  "navigate.gotoLine": ["Meta+G"],
  "navigate.typeDeclaration": ["Ctrl+Shift+B"],
  "navigate.toggleBookmark": ["F11"],
  "navigate.showBookmarks": ["Shift+F11"],
  "navigate.toggleBookmarkWithMnemonic": ["Meta+F11"],
  "navigate.nextMethod": ["Ctrl+Down"],
  "navigate.previousMethod": ["Ctrl+Up"],

  // Find
  "find.next": ["F3", "Ctrl+L"],
  "find.previous": ["Shift+F3", "Ctrl+Shift+L"],
  "find.inPath": ["Ctrl+Shift+F"],
  "find.replaceInPath": ["Ctrl+Shift+R"],

  // Code
  "code.quickDocumentation": ["Ctrl+J"],
  "code.quickDefinition": ["Meta+Shift+I"],
  "code.optimizeImports": ["Meta+Alt+O"],
  "code.commentBlock": ["Ctrl+Shift+/", "Meta+Shift+/"],
  "code.extendSelection": ["Meta+W"],
  "code.shrinkSelection": ["Meta+Shift+W"],
  "code.deleteLine": ["Meta+Y"],
  "editor.scrollToCenter": [],
  "editor.codeBlockStart": ["Meta+["],
  "editor.codeBlockEnd": ["Meta+]"],
  "editor.codeBlockStartWithSelection": ["Meta+Shift+["],
  "editor.codeBlockEndWithSelection": ["Meta+Shift+]"],
  "code.autoIndentLines": ["Meta+Alt+I"],
  "editor.matchBrace": ["Meta+Shift+M"],

  // Refactor
  "refactor.thisMenu": ["Meta+Alt+Shift+T"],

  // File / editor tabs
  "file.newScratchFile": ["Ctrl+Shift+N"],
  "editor.closeTab": ["Meta+F4"],
  "toolwindow.closeContent": ["Meta+F4", "Meta+Shift+F4"],
  "editor.nextTab": ["Ctrl+Right"],
  "editor.prevTab": ["Ctrl+Left"],
  "window.next": ["Meta+Alt+]"],
  "window.previous": ["Meta+Alt+["],

  // Project view
  "project.newFile": ["Ctrl+N", "Ctrl+Enter"],
  "project.open": ["F4"],
  "project.optimizeImports": ["Meta+Alt+O"],

  // Run / debug
  "run.run": ["Shift+F10"],
  "run.debug": ["Shift+F9"],
  "run.runContext": ["Ctrl+Shift+F10"],
  "web.openInBrowser": ["Ctrl+Shift+F10"],
  "run.debugContext": ["Ctrl+Shift+F9"],
  "run.rerun": ["Ctrl+F5"],
  "debug.rerun": ["Ctrl+F5"],
  "find.rerun": ["Ctrl+F5"],
  "usages.rerun": ["Ctrl+F5"],
  "run.chooseConfig": ["Alt+Shift+F10"],
  "run.chooseDebugConfig": ["Alt+Shift+F9"],
  "debug.resume": ["F9"],
  "debug.jumpToSource": ["F4"],

  // VCS / tool window resize
  "toolwindow.resizeLeft": ["Meta+Alt+Shift+Left"],
  "toolwindow.resizeRight": ["Meta+Alt+Shift+Right"],
  "toolwindow.resizeUp": ["Meta+Alt+Shift+Up"],
  "toolwindow.resizeDown": ["Meta+Alt+Shift+Down"],
  "vcs.changelist.move": [],

  // View › Font size
  "editor.increaseFontSize": ["Alt+Shift+."],
  "editor.decreaseFontSize": ["Alt+Shift+,"],

  // Editing extras / Database / GitHub
  "code.implementMethods": ["Meta+I"],
  "code.overrideMethods": ["Meta+O"],
  "db.openConsole": ["Meta+Shift+Q"],
  "db.new": ["Ctrl+N", "Ctrl+Enter"],
  "services.addService": ["Ctrl+N", "Ctrl+Enter"],
  "github.createPullRequest": ["Ctrl+N", "Ctrl+Enter"],
  "github.refresh": ["Ctrl+F5"],
  "github.pullRequest.refresh": ["Ctrl+F5"],
  "github.pullRequest.timeline.refresh": ["Ctrl+F5"],
  "db.refresh": ["Ctrl+F5"],
  "db.quickDoc": ["Ctrl+J"],

  // Last: Generate & Find in Files popup
  "code.generate": ["Ctrl+N", "Ctrl+Enter"],
  "find.popup.nextResult": ["F3", "Ctrl+L"],
  "find.popup.previousResult": ["Shift+F3", "Ctrl+Shift+L"],
  "find.popup.openResult": ["F4"],
};
