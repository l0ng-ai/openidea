/**
 * IntelliJ IDEA keymap XML (`.xml` under `<IDE config>/keymaps/` or exported
 * keymap schemes) parser and importer.
 *
 * Format:
 * ```xml
 * <keymap version="1" name="Mac OS X copy" parent="Mac OS X">
 *   <action id="CloseAllEditorsButActive">
 *     <keyboard-shortcut first-keystroke="shift meta w" />
 *   </action>
 *   <action id="GotoFile">
 *     <keyboard-shortcut first-keystroke="shift meta n" />
 *   </action>
 *   <action id="EditorUnSelectWord" />
 *   <action id="GotoDeclaration">
 *     <keyboard-shortcut first-keystroke="meta b" />
 *     <mouse-shortcut keystroke="meta button1" />
 *   </action>
 * </keymap>
 * ```
 */

import { defaultPreset, isValidBinding, normalizeBinding, PRESET_TITLES, PRESETS, type Keymap } from "./keymap";
import { withBindings, type CustomKeymap, type CustomKeymaps } from "@/features/settings/keymap/model";

export interface ParsedKeymapXml {
  keymap: CustomKeymap;
  /** Number of recognized `<action>` or shortcut entries applied from the XML. */
  applied: number;
  /** Number of unrecognized `<action>` IDs or unsupported shortcuts skipped. */
  skipped: number;
}

const MODIFIER_MAP: Record<string, "Ctrl" | "Alt" | "Shift" | "Meta"> = {
  ctrl: "Ctrl",
  control: "Ctrl",
  alt: "Alt",
  option: "Alt",
  shift: "Shift",
  meta: "Meta",
  cmd: "Meta",
  command: "Meta",
};

const KEY_MAP: Record<string, string> = {
  enter: "Enter",
  return: "Enter",
  escape: "Escape",
  esc: "Escape",
  space: "Space",
  tab: "Tab",
  back_space: "Backspace",
  backspace: "Backspace",
  delete: "Delete",
  insert: "Insert",
  home: "Home",
  end: "End",
  page_up: "PageUp",
  pageup: "PageUp",
  pgup: "PageUp",
  page_down: "PageDown",
  pagedown: "PageDown",
  pgdn: "PageDown",
  up: "Up",
  kp_up: "Up",
  down: "Down",
  kp_down: "Down",
  left: "Left",
  kp_left: "Left",
  right: "Right",
  kp_right: "Right",
  open_bracket: "[",
  close_bracket: "]",
  comma: ",",
  period: ".",
  slash: "/",
  back_slash: "\\",
  backslash: "\\",
  semicolon: ";",
  quote: "'",
  back_quote: "`",
  backquote: "`",
  minus: "-",
  equals: "=",
  equal: "=",
  plus: "+",
  add: "NumpadAdd",
  subtract: "NumpadSubtract",
  multiply: "NumpadMultiply",
  divide: "NumpadDivide",
};

/**
 * Maps IntelliJ IDEA action IDs to one or more OpenIDEA action IDs.
 * OpenIDEA action IDs (containing `.`) are also accepted directly when present in XML.
 */
const IDEA_ACTION_MAP: Record<string, readonly string[]> = {
  // General / Workbench / File
  ShowSettings: ["file.settings"],
  SearchEverywhere: ["navigate.searchEverywhere"],
  GotoAction: ["navigate.findAction"],
  TextSearchAction: ["navigate.searchText"],
  QuickChangeScheme: ["view.quickSwitchScheme"],
  RunAnything: ["runAnything.show"],
  HideActiveWindow: ["toolwindow.hideActive"],
  HideAllWindows: ["toolwindow.hideAll"],
  JumpToLastWindow: ["toolwindow.jumpToLast"],
  MaximizeToolWindow: ["toolwindow.maximize"],
  RestoreDefaultLayout: ["layout.restoreDefault"],
  ResizeToolWindowLeft: ["toolwindow.resizeLeft"],
  ResizeToolWindowRight: ["toolwindow.resizeRight"],
  ResizeToolWindowUp: ["toolwindow.resizeUp"],
  ResizeToolWindowDown: ["toolwindow.resizeDown"],
  FocusEditor: ["toolwindow.focusEditor"],
  ToggleZenMode: ["editor.toggleZen"],
  ToggleDistractionFreeMode: ["editor.toggleZen"],
  ToggleFullScreen: ["window.toggleFullScreen"],
  ZoomInIdeAction: ["view.zoomIn"],
  ZoomOutIdeAction: ["view.zoomOut"],
  ResetIdeScaleAction: ["view.resetZoom"],
  EditorIncreaseFontSize: ["editor.increaseFontSize"],
  EditorDecreaseFontSize: ["editor.decreaseFontSize"],
  EditorIncreaseFontSizeGlobal: ["editor.increaseFontSize"],
  EditorDecreaseFontSizeGlobal: ["editor.decreaseFontSize"],
  EditorResetFontSize: ["editor.resetFontSize"],
  EditorResetFontSizeGlobal: ["editor.resetFontSize"],
  NewElement: ["project.newFile", "db.new", "services.addService", "github.createPullRequest", "code.generate"],
  NewElementSamePlace: ["project.newInThisDirectory"],
  NewScratchFile: ["file.newScratchFile"],
  OpenFile: ["file.openProject"],
  SaveAll: ["file.save"],
  SaveDocument: ["file.save"],
  Synchronize: ["file.reloadFromDisk", "project.reloadFromDisk"],
  ReloadFromDisk: ["file.reloadFromDisk", "project.reloadFromDisk"],
  ToggleReadOnlyAttribute: ["file.toggleReadOnly"],
  CopyPaths: ["editor.copyPath", "project.copyAbsolutePath"],
  CopyAbsolutePath: ["editor.copyPath", "project.copyAbsolutePath"],
  CopyReference: ["editor.copyReference", "db.copyReference"],
  Switcher: ["navigate.switcher"],
  NextProjectWindow: ["window.next"],
  PreviousProjectWindow: ["window.previous"],
  NextWindow: ["window.next"],
  PreviousWindow: ["window.previous"],

  // Tool Windows
  ActivateProjectToolWindow: ["toolwindow.project"],
  ActivateBookmarksToolWindow: ["toolwindow.bookmarks"],
  ActivateFavoritesToolWindow: ["toolwindow.bookmarks"],
  ActivateFindToolWindow: ["toolwindow.find"],
  ActivateRunToolWindow: ["toolwindow.run"],
  ActivateDebugToolWindow: ["toolwindow.debug"],
  ActivateProblemsViewToolWindow: ["toolwindow.problems"],
  ActivateStructureToolWindow: ["toolwindow.structure"],
  ActivateServicesToolWindow: ["toolwindow.services"],
  ActivateVersionControlToolWindow: ["toolwindow.git"],
  ActivateCommitToolWindow: ["toolwindow.commit"],
  ActivateTerminalToolWindow: ["toolwindow.terminal"],
  ActivateDatabaseToolWindow: ["db.showToolWindow"],
  ActivateAIAssistantToolWindow: ["agents.showToolWindow"],
  CloseActiveTab: ["toolwindow.closeContent"],

  // Editor Tabs & Splits
  CloseContent: ["editor.closeTab", "toolwindow.closeContent"],
  CloseEditor: ["editor.closeTab"],
  CloseAllEditorsButActive: ["editor.closeOtherTabs"],
  CloseAllEditors: ["editor.closeAllTabs"],
  ReopenClosedTab: ["editor.reopenClosedTab"],
  NextTab: ["editor.nextTab"],
  PreviousTab: ["editor.prevTab"],
  PinActiveTab: ["editor.pinTab"],
  PinActiveEditorTab: ["editor.pinTab"],
  SplitVertically: ["editor.splitRight"],
  SplitHorizontally: ["editor.splitDown"],
  ChangeSplitOrientation: ["editor.changeSplitOrientation"],
  MoveEditorToOppositeTabGroup: ["editor.moveToOppositeGroup"],
  OpenElementInNewWindow: ["editor.openInOppositeGroup"],
  Unsplit: ["editor.unsplit"],
  UnsplitAll: ["editor.unsplitAll"],
  NextSplitter: ["editor.nextSplitter"],
  PrevSplitter: ["editor.prevSplitter"],

  // Navigation & Bookmarks
  GotoFile: ["navigate.gotoFile"],
  GotoClass: ["navigate.gotoClass"],
  GotoSymbol: ["navigate.gotoSymbol"],
  GotoLine: ["navigate.gotoLine"],
  ShowNavBar: ["navigate.navigationBar"],
  ViewNavigationBar: ["navigate.navigationBar"],
  RecentFiles: ["navigate.recentFiles"],
  RecentLocations: ["navigate.recentLocations"],
  RecentChanges: ["localHistory.recentChanges"],
  Back: ["navigate.back"],
  Forward: ["navigate.forward"],
  JumpToLastChange: ["navigate.lastEditLocation"],
  JumpToNextChange: ["navigate.nextEditLocation"],
  SelectIn: ["navigate.selectIn"],
  SelectInProjectView: ["navigate.selectIn"],
  ShowFilePath: ["navigate.showFilePath"],
  FileStructurePopup: ["navigate.fileStructure"],
  GotoNextError: ["navigate.nextError"],
  GotoPreviousError: ["navigate.prevError"],
  MethodDown: ["navigate.nextMethod"],
  MethodUp: ["navigate.previousMethod"],
  GotoDeclaration: ["navigate.declaration"],
  GotoDeclarationOnly: ["navigate.declaration"],
  GotoTypeDeclaration: ["navigate.typeDeclaration"],
  GotoImplementation: ["navigate.implementation"],
  GotoSuperMethod: ["navigate.superMethod"],
  GotoTest: ["navigate.gotoTest"],
  TypeHierarchy: ["navigate.typeHierarchy"],
  CallHierarchy: ["navigate.callHierarchy"],
  GotoCustomRegion: ["navigate.customRegion"],
  EditSource: ["project.open", "debug.jumpToSource", "diff.jumpToSource", "find.popup.openResult"],
  ToggleBookmark: ["navigate.toggleBookmark"],
  ToggleBookmarkWithMnemonic: ["navigate.toggleBookmarkWithMnemonic"],
  ShowBookmarks: ["navigate.showBookmarks"],
  ToggleBookmark0: ["navigate.toggleBookmark0"],
  ToggleBookmark1: ["navigate.toggleBookmark1"],
  ToggleBookmark2: ["navigate.toggleBookmark2"],
  ToggleBookmark3: ["navigate.toggleBookmark3"],
  ToggleBookmark4: ["navigate.toggleBookmark4"],
  ToggleBookmark5: ["navigate.toggleBookmark5"],
  ToggleBookmark6: ["navigate.toggleBookmark6"],
  ToggleBookmark7: ["navigate.toggleBookmark7"],
  ToggleBookmark8: ["navigate.toggleBookmark8"],
  ToggleBookmark9: ["navigate.toggleBookmark9"],
  GotoBookmark0: ["navigate.gotoBookmark0"],
  GotoBookmark1: ["navigate.gotoBookmark1"],
  GotoBookmark2: ["navigate.gotoBookmark2"],
  GotoBookmark3: ["navigate.gotoBookmark3"],
  GotoBookmark4: ["navigate.gotoBookmark4"],
  GotoBookmark5: ["navigate.gotoBookmark5"],
  GotoBookmark6: ["navigate.gotoBookmark6"],
  GotoBookmark7: ["navigate.gotoBookmark7"],
  GotoBookmark8: ["navigate.gotoBookmark8"],
  GotoBookmark9: ["navigate.gotoBookmark9"],

  // Search & Find / Replace / Occurrences
  Find: ["find.inFile", "agents.findInConversation", "vcs.log.goToRef"],
  Replace: ["find.replaceInFile"],
  FindNext: ["find.next", "find.popup.nextResult"],
  FindPrevious: ["find.previous", "find.popup.previousResult"],
  FindInPath: ["find.inPath"],
  ReplaceInPath: ["find.replaceInPath"],
  FindUsages: ["find.usages", "project.findUsages", "find.openInWindow"],
  ShowUsages: ["find.showUsages"],
  HighlightUsagesInFile: ["find.highlightUsages"],
  SelectNextOccurrence: ["code.addCaretNextOccurrence"],
  SelectAllOccurrences: ["code.selectAllOccurrences"],
  UnselectPreviousOccurrence: ["code.unselectOccurrence"],
  EditorAddCaretPerSelectedLine: ["code.addCaretsToLineEnds"],
  NextOccurence: ["navigate.nextOccurrence"],
  PreviousOccurence: ["navigate.prevOccurrence"],
  GotoNextElementUnderCaretUsage: ["navigate.nextHighlightedUsage"],
  GotoPrevElementUnderCaretUsage: ["navigate.prevHighlightedUsage"],

  // Code Intelligence, Generation & Folding
  CodeCompletion: ["code.completion"],
  CallInlineCompletionAction: ["editor.inlineCompletion.trigger"],
  InsertInlineCompletionAction: ["editor.inlineCompletion.accept"],
  NextInlineCompletionSuggestionAction: ["editor.inlineCompletion.next"],
  PrevInlineCompletionSuggestionAction: ["editor.inlineCompletion.previous"],
  ParameterInfo: ["code.parameterInfo"],
  QuickJavaDoc: ["code.quickDocumentation", "db.quickDoc"],
  QuickImplementations: ["code.quickDefinition"],
  ShowIntentionActions: ["code.showIntentions"],
  Generate: ["code.generate"],
  OverrideMethods: ["code.overrideMethods"],
  ImplementMethods: ["code.implementMethods"],
  SurroundWith: ["code.surroundWith"],
  Unwrap: ["code.unwrap"],
  HippieCompletion: ["code.cyclicExpandWord"],
  HippieBackwardCompletion: ["code.cyclicExpandWordBackward"],
  EditorCompleteStatement: ["code.completeStatement"],
  ExpressionTypeInfo: ["code.expressionTypeInfo"],
  ShowErrorDescription: ["code.showErrorDescription"],
  CommentByLineComment: ["code.commentLine"],
  CommentByBlockComment: ["code.commentBlock"],
  ReformatCode: ["code.reformat", "project.reformatCode"],
  ShowReformatFileDialog: ["code.reformatDialog"],
  AutoIndentLines: ["code.autoIndentLines"],
  OptimizeImports: ["code.optimizeImports", "project.optimizeImports"],
  MoveStatementUp: ["code.moveStatementUp"],
  MoveStatementDown: ["code.moveStatementDown"],
  MoveElementLeft: ["code.moveElementLeft"],
  MoveElementRight: ["code.moveElementRight"],
  MoveLineUp: ["code.moveLineUp"],
  MoveLineDown: ["code.moveLineDown"],
  EditorDuplicate: ["code.duplicateLine"],
  EditorDeleteLine: ["code.deleteLine"],
  EditorJoinLines: ["code.joinLines"],
  EditorSplitLine: ["code.splitLine"],
  EditorStartNewLine: ["code.startNewLine"],
  EditorStartNewLineBefore: ["code.startNewLineBefore"],
  EditorToggleCase: ["code.toggleCase"],
  EditorSortLines: ["code.sortLines"],
  EditorReverseLines: ["code.reverseLines"],
  EditorSelectWord: ["code.extendSelection"],
  EditorUnSelectWord: ["code.shrinkSelection"],
  CollapseRegion: ["code.fold"],
  ExpandRegion: ["code.unfold"],
  CollapseRegionRecursively: ["code.collapseRecursively"],
  ExpandRegionRecursively: ["code.expandRecursively"],
  CollapseAllRegions: ["code.foldAll"],
  ExpandAllRegions: ["code.unfoldAll"],
  CollapseBlock: ["code.collapseBlock"],
  CollapseSelection: ["code.foldSelection"],
  ExpandToLevel1: ["code.expandToLevel1"],
  ExpandToLevel2: ["code.expandToLevel2"],
  ExpandToLevel3: ["code.expandToLevel3"],
  ExpandToLevel4: ["code.expandToLevel4"],
  ExpandToLevel5: ["code.expandToLevel5"],
  ExpandAllToLevel1: ["code.expandAllToLevel1"],
  ExpandAllToLevel2: ["code.expandAllToLevel2"],
  ExpandAllToLevel3: ["code.expandAllToLevel3"],
  ExpandAllToLevel4: ["code.expandAllToLevel4"],
  ExpandAllToLevel5: ["code.expandAllToLevel5"],
  InsertLiveTemplate: ["code.insertLiveTemplate"],
  SurroundWithLiveTemplate: ["code.surroundWithLiveTemplate"],
  InspectCode: ["analyze.inspectFile"],
  RunInspection: ["analyze.inspectFile"],

  // Editor Caret / Selection / Scrolling
  EditorCodeBlockStart: ["editor.codeBlockStart"],
  EditorCodeBlockEnd: ["editor.codeBlockEnd"],
  EditorCodeBlockStartWithSelection: ["editor.codeBlockStartWithSelection"],
  EditorCodeBlockEndWithSelection: ["editor.codeBlockEndWithSelection"],
  EditorMatchBrace: ["editor.matchBrace"],
  EditorToggleInsertState: ["editor.toggleInsertState"],
  EditorToggleColumnMode: ["editor.toggleColumnSelection"],
  EditorToggleUseSoftWraps: ["editor.toggleSoftWrap"],
  EditorCloneCaretAbove: ["editor.cloneCaretAbove"],
  EditorCloneCaretBelow: ["editor.cloneCaretBelow"],
  EditorScrollToCenter: ["editor.scrollToCenter"],
  EditorContextInfo: ["editor.contextInfo"],
  PasteMultiple: ["code.pasteFromHistory"],
  EditorPasteSimple: ["code.pasteAsPlainText"],

  // Clipboard & Project Tree Operations
  $Cut: ["project.cut"],
  $Copy: ["project.copy"],
  $Paste: ["project.paste"],
  $Delete: ["project.delete", "db.drop"],

  // Refactoring
  "Refactorings.QuickListPopupAction": ["refactor.thisMenu"],
  RenameElement: ["refactor.rename", "project.rename", "vcs.changelist.edit", "db.rename"],
  ChangeSignature: ["refactor.changeSignature"],
  ExtractMethod: ["refactor.extractMethod"],
  IntroduceVariable: ["refactor.extractVariable"],
  IntroduceConstant: ["refactor.extractConstant"],
  IntroduceField: ["refactor.extractField"],
  IntroduceParameter: ["refactor.extractParameter"],
  Inline: ["refactor.inline"],
  SafeDelete: ["refactor.safeDelete"],
  Move: ["refactor.move", "project.move"],
  CopyElement: ["project.copyElement"],

  // Build / Run / Debug
  CompileDirty: ["build.buildProject"],
  CompileProject: ["build.rebuildProject"],
  MakeModule: ["build.buildModule"],
  Compile: ["build.buildModule"],
  ChooseRunConfiguration: ["run.chooseConfig"],
  ChooseDebugConfiguration: ["run.chooseDebugConfig"],
  EditRunConfigurations: ["run.editConfigs"],
  editRunConfigurations: ["run.editConfigs"],
  Run: ["run.run"],
  Debug: ["run.debug"],
  RunClass: ["run.runContext", "web.openInBrowser"],
  DebugClass: ["run.debugContext"],
  Rerun: ["run.rerun", "debug.rerun", "find.rerun", "usages.rerun"],
  Stop: ["run.stop", "db.disconnect"],
  StopBackgroundProcesses: ["workbench.stopBackgroundProcesses"],
  UpdateRunningApplication: ["run.updateApplication"],
  Resume: ["debug.resume"],
  StepOver: ["debug.stepOver"],
  StepInto: ["debug.stepInto"],
  SmartStepInto: ["debug.smartStepInto"],
  ForceStepOver: ["debug.forceStepOver"],
  ForceStepInto: ["debug.forceStepInto"],
  StepOut: ["debug.stepOut"],
  RunToCursor: ["debug.runToCursor"],
  ForceRunToCursor: ["debug.forceRunToCursor"],
  EvaluateExpression: ["debug.evaluate"],
  QuickEvaluateExpression: ["debug.quickEvaluate"],
  ShowExecutionPoint: ["debug.showExecutionPoint"],
  ToggleLineBreakpoint: ["debug.toggleBreakpoint"],
  ToggleTemporaryLineBreakpoint: ["debug.toggleTemporaryBreakpoint"],
  ViewBreakpoints: ["debug.viewBreakpoints"],
  "Debugger.SetValue": ["debug.setValue"],
  "XDebugger.SetValue": ["debug.setValue"],
  "XDebugger.AttachToProcess": ["debug.attachToProcess"],

  // VCS / Git / Diff
  "Vcs.QuickListPopupAction": ["vcs.operations"],
  CheckinProject: ["vcs.commit"],
  "Vcs.UpdateProject": ["vcs.update"],
  "Vcs.Push": ["vcs.push"],
  "ChangesView.Revert": ["vcs.rollback"],
  "Vcs.RollbackChangedLines": ["vcs.rollback"],
  VcsShowNextChangeMarker: ["vcs.nextChange"],
  VcsShowPrevChangeMarker: ["vcs.prevChange"],
  "Compare.SameVersion": ["vcs.showDiff", "project.compareWith"],
  Annotate: ["vcs.annotate"],
  "Git.Branches": ["vcs.branches"],
  "Git.CreateNewBranch": ["vcs.newBranch"],
  "ChangesView.Move": ["vcs.changelist.move"],
  "Vcs.MoveChangedLinesToChangelist": ["vcs.changelist.move"],
  "ChangesView.Rename": ["vcs.changelist.edit"],
  "Vcs.ShowMessageHistory": ["vcs.showMessageHistory"],
  "Vcs.CopyRevisionNumberAction": ["vcs.log.copyRevision"],
  "Vcs.Log.GoToRef": ["vcs.log.goToRef"],
  "Diff.ShowDiff": ["vcs.showDiff", "project.compareWith"],
  NextDiff: ["diff.nextDifference"],
  PreviousDiff: ["diff.prevDifference"],
  "Diff.ApplyLeftSide": ["diff.applyLeftSide"],
  "Diff.ApplyRightSide": ["diff.applyRightSide"],
  "Diff.NextChange": ["diff.nextFile"],
  "Diff.PrevChange": ["diff.prevFile"],

  // Terminal / Database / HTTP / Tree
  "Terminal.NewTab": ["terminal.new"],
  "Console.Jdbc.Execute": ["db.execute"],
  "Jdbc.OpenConsole.Any": ["db.openConsole"],
  "Jdbc.OpenConsole.New": ["db.openConsole"],
  "HTTPClient.RunAll": ["http.runRequest"],
  ExpandAll: ["project.expandAll"],
  CollapseAll: ["project.collapseAll"],
  Refresh: ["db.refresh", "github.refresh", "github.pullRequest.refresh", "github.pullRequest.timeline.refresh"],
};

/**
 * Resolves an IntelliJ keymap `parent` attribute to a bundled OpenIDEA preset ID.
 */
export function resolveIdeaParent(parentAttr: string | null | undefined, keymapName = ""): string {
  const raw = (parentAttr ?? "").trim();
  if (raw) {
    if (PRESETS[raw]) return raw;
    for (const [id, title] of Object.entries(PRESET_TITLES)) {
      if (title.toLowerCase() === raw.toLowerCase()) return id;
    }
    const lower = raw.toLowerCase();
    if (lower === "mac os x" || lower === "intellij classic" || lower === "intellij classic (macos)") {
      return "intellij-classic-macos";
    }
    if (lower === "mac os x 10.5+" || lower === "macos" || lower === "sublime text (mac os x)") {
      return "intellij-macos";
    }
    if (lower === "eclipse (mac os x)" || lower === "eclipse (macos)") {
      return "eclipse-macos";
    }
    if (lower === "eclipse") {
      return "eclipse-windows";
    }
    if (lower === "vscode osx" || lower === "vscode (macos)" || lower === "vs code (macos)") {
      return "vscode-macos";
    }
    if (lower === "vscode" || lower === "vs code" || lower === "vs code (windows)") {
      return "vscode-windows";
    }
    if (
      lower === "$default" ||
      lower === "default for xwin" ||
      lower === "default for gnome" ||
      lower === "default for kde" ||
      lower === "windows" ||
      lower === "sublime text"
    ) {
      return "intellij-windows";
    }
    if (/eclipse/i.test(raw)) {
      return /mac|osx|os x/i.test(raw) ? "eclipse-macos" : "eclipse-windows";
    }
    if (/vscode|vs code/i.test(raw)) {
      return /mac|osx|os x/i.test(raw) ? "vscode-macos" : "vscode-windows";
    }
    if (/classic/i.test(raw)) {
      return "intellij-classic-macos";
    }
    if (/mac|osx|os x/i.test(raw)) {
      return "intellij-macos";
    }
    return "intellij-windows";
  }

  if (/classic|^mac os x$/i.test(keymapName)) {
    return "intellij-classic-macos";
  }
  if (/mac|osx|os x/i.test(keymapName)) {
    return "intellij-macos";
  }
  return defaultPreset();
}

function resolveIdeaParentWithCustoms(
  parentAttr: string | null | undefined,
  keymapName: string,
  customs: CustomKeymaps = {},
): { parent: string; baseOverrides: Keymap } {
  const raw = (parentAttr ?? "").trim();
  if (raw) {
    const customMatch =
      customs[raw] ?? Object.values(customs).find((c) => c.name.toLowerCase() === raw.toLowerCase());
    if (customMatch) {
      const parent = PRESETS[customMatch.parent] ? customMatch.parent : defaultPreset();
      return { parent, baseOverrides: { ...customMatch.overrides } };
    }
  }
  return { parent: resolveIdeaParent(parentAttr, keymapName), baseOverrides: {} };
}

/**
 * Converts a single IntelliJ AWT keystroke string (e.g. `"shift meta n"`,
 * `"control alt s"`, `"ctrl pressed ENTER"`) into an OpenIDEA stroke (`"Meta+Shift+N"`).
 */
export function parseIdeaKeystroke(raw: string): string | null {
  const tokens = raw
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0 && t.toLowerCase() !== "pressed");
  if (!tokens.length) return null;
  if (tokens.some((t) => t.toLowerCase() === "released")) return null;

  // Bare modifier token (used in double-modifier gestures like `first-keystroke="shift" second-keystroke="shift"`).
  if (tokens.length === 1 && MODIFIER_MAP[tokens[0]!.toLowerCase()]) {
    return MODIFIER_MAP[tokens[0]!.toLowerCase()]!;
  }

  const mods: string[] = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    const mod = MODIFIER_MAP[tokens[i]!.toLowerCase()];
    if (!mod) return null;
    if (!mods.includes(mod)) mods.push(mod);
  }

  const keyToken = tokens[tokens.length - 1]!;
  const lowerKey = keyToken.toLowerCase();
  if (MODIFIER_MAP[lowerKey]) return null;

  let key: string | undefined = KEY_MAP[lowerKey];
  if (!key) {
    const numpadDigit = /^numpad(\d)$/.exec(lowerKey);
    if (numpadDigit) {
      key = numpadDigit[1]!;
    } else if (/^f([1-9]|1\d|2[0-4])$/.test(lowerKey)) {
      key = lowerKey.toUpperCase();
    } else if (/^[a-z0-9]$/.test(lowerKey)) {
      key = lowerKey.toUpperCase();
    } else if (/^[[\],./\\;'`\-=+]$/.test(keyToken)) {
      key = keyToken;
    } else {
      return null;
    }
  }

  const stroke = [...mods, key].join("+");
  return isValidBinding(stroke) ? normalizeBinding(stroke) : null;
}

/**
 * Converts an IntelliJ `<keyboard-shortcut>` element's `first-keystroke` and
 * optional `second-keystroke` attributes into a normalized OpenIDEA binding.
 */
export function parseIdeaKeyboardShortcut(
  firstKeystroke: string | null | undefined,
  secondKeystroke?: string | null,
): string | null {
  if (!firstKeystroke?.trim()) return null;
  const first = parseIdeaKeystroke(firstKeystroke);
  if (!first) return null;

  if (!secondKeystroke?.trim()) {
    return isValidBinding(first) ? normalizeBinding(first) : null;
  }
  const second = parseIdeaKeystroke(secondKeystroke);
  if (!second) return null;

  const combined = `${first} ${second}`;
  return isValidBinding(combined) ? normalizeBinding(combined) : null;
}

/**
 * Converts an IntelliJ `<mouse-shortcut keystroke="..." />` attribute into a
 * normalized OpenIDEA mouse binding (`"Meta+Button1"`, `"Button4"`, etc.).
 */
export function parseIdeaMouseShortcut(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;

  const mods: string[] = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    const mod = MODIFIER_MAP[tokens[i]!.toLowerCase()];
    if (!mod) return null;
    if (!mods.includes(mod)) mods.push(mod);
  }

  const last = tokens[tokens.length - 1]!.toLowerCase();
  const m = /^button(\d+)$/.exec(last);
  if (!m) return null;
  const button = Number(m[1]);
  // OpenIDEA supports side buttons (Button4/Button5) and Ctrl/Alt/Meta + left-click (Button1).
  const hasPrimaryMod = mods.includes("Ctrl") || mods.includes("Alt") || mods.includes("Meta");
  if (button === 1 ? !hasPrimaryMod : button !== 4 && button !== 5) return null;

  const stroke = [...mods, `Button${button}`].join("+");
  return isValidBinding(stroke) ? normalizeBinding(stroke) : null;
}

function resolveOpenIdeaActionIds(ideaActionId: string): readonly string[] | null {
  const mapped = IDEA_ACTION_MAP[ideaActionId];
  if (mapped) return mapped;
  // Also accept direct OpenIDEA action IDs (e.g. `navigate.gotoFile`).
  if (/^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9_]+)+$/.test(ideaActionId)) {
    return [ideaActionId];
  }
  return null;
}

/**
 * Parses an IntelliJ keymap `.xml` document into a `CustomKeymap`.
 * Throws `Error("Invalid IntelliJ keymap XML")` if the XML is malformed or not a `<keymap>`.
 */
export function parseKeymapXml(
  xml: string,
  options?: string | { fallbackName?: string; customs?: CustomKeymaps },
): ParsedKeymapXml {
  const opts = typeof options === "string" ? { fallbackName: options } : options;
  if (/<!doctype/i.test(xml)) throw new Error("Invalid IntelliJ keymap XML");
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.doctype || doc.querySelector("parsererror")) {
    throw new Error("Invalid IntelliJ keymap XML");
  }
  const root = doc.documentElement;
  if (!root || root.tagName !== "keymap") {
    throw new Error("Invalid IntelliJ keymap XML");
  }

  const rawName = (root.getAttribute("name") ?? opts?.fallbackName ?? "").trim();
  if (!rawName) {
    throw new Error("Invalid IntelliJ keymap XML");
  }

  const { parent, baseOverrides } = resolveIdeaParentWithCustoms(
    root.getAttribute("parent"),
    rawName,
    opts?.customs,
  );
  let overrides: Keymap = { ...baseOverrides };
  let applied = 0;
  let skipped = 0;

  const collectedBindings = new Map<string, string[]>();
  const clearedIds = new Set<string>();

  for (const el of Array.from(root.children)) {
    if (el.tagName !== "action") continue;
    const actionId = el.getAttribute("id")?.trim();
    if (!actionId) {
      skipped++;
      continue;
    }
    const targetIds = resolveOpenIdeaActionIds(actionId);
    if (!targetIds) {
      skipped++;
      continue;
    }

    const shortcutEls = Array.from(el.children).filter(
      (c) => c.tagName === "keyboard-shortcut" || c.tagName === "mouse-shortcut",
    );

    // In IntelliJ keymap XML, `<action id="Foo" />` with no shortcut children clears inherited bindings.
    if (shortcutEls.length === 0) {
      for (const targetId of targetIds) clearedIds.add(targetId);
      applied++;
      continue;
    }

    const bindings: string[] = [];
    for (const child of shortcutEls) {
      const parsed =
        child.tagName === "keyboard-shortcut"
          ? parseIdeaKeyboardShortcut(
              child.getAttribute("first-keystroke"),
              child.getAttribute("second-keystroke"),
            )
          : parseIdeaMouseShortcut(child.getAttribute("keystroke"));
      if (parsed) {
        if (!bindings.includes(parsed)) bindings.push(parsed);
        applied++;
      } else {
        skipped++;
      }
    }

    if (bindings.length > 0) {
      for (const targetId of targetIds) {
        const prev = collectedBindings.get(targetId) ?? [];
        for (const b of bindings) {
          if (!prev.includes(b)) prev.push(b);
        }
        collectedBindings.set(targetId, prev);
      }
    }
  }

  for (const [targetId, bindings] of collectedBindings) {
    overrides = withBindings({ preset: parent, overrides }, targetId, bindings);
  }
  for (const targetId of clearedIds) {
    if (!collectedBindings.has(targetId)) {
      overrides = withBindings({ preset: parent, overrides }, targetId, []);
    }
  }

  return {
    keymap: {
      name: rawName,
      parent,
      overrides,
    },
    applied,
    skipped,
  };
}
