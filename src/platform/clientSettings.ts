/** Settings model ownership: these UI preferences belong to the client, including their descendants.
 * Mixed sections deliberately list individual keys so project/tooling settings stay on the host.
 * Keep this module dependency-free: the transport also consumes this metadata.
 */
export const CLIENT_SETTINGS_KEYS = [
  "keymap",
  "keymapOverrides",
  "customKeymaps",
  "appearance",
  "notifications",
  "general.reopenLastProject",
  "general.confirmExit",
  "general.openProjectIn",
  "general.dateFormat",
  "editor.fontFamily",
  "editor.fontSize",
  "editor.lineHeight",
  "editor.ligatures",
  "editor.fallbackFont",
  "editor.fontWeight",
  "editor.boldFontWeight",
  "editor.colorScheme",
  "editor.colorOverrides",
  "editor.semanticHighlighting",
  "editor.rainbowBrackets",
  "editor.softWrap",
  "editor.showWhitespace",
  "editor.inlayHints",
  "editor.stickyScroll",
  "editor.appearance",
  "editor.breadcrumbs",
  "editor.folding",
  "editor.tabs",
  "editor.codeEditing",
  "editor.inlay",
  "editor.gutterIconsDisabled",
  "editor.showGutterIcons",
  "editor.general.wheelZoom",
  "editor.general.dragAndDrop",
  "editor.general.caretScroll",
  "editor.general.softWrapFiles",
  "editor.general.softWrapIndent",
  "editor.general.scrollPastEnd",
  "editor.general.richTextCopy",
  "editor.codeStyle.visualGuides",
  "terminal.tabName",
  "terminal.audibleBell",
  "terminal.closeOnExit",
  "terminal.mouseReporting",
  "terminal.copyOnSelection",
  "terminal.pasteOnMiddleClick",
  "terminal.overrideIdeShortcuts",
  "terminal.highlightHyperlinks",
  "terminal.optionAsMeta",
  "terminal.escapeToEditor",
  "terminal.cursorShape",
  "terminal.cursorBlink",
  "terminal.useEditorFont",
  "terminal.fontFamily",
  "terminal.fontSize",
  "terminal.lineHeight",
  "terminal.fallbackFontFamily",
  "terminal.columnWidth",
  "console.softWrap",
  "console.foldPatterns",
  "debugger.showOnBreakpoint",
  "debugger.focusAppOnBreakpoint",
  "debugger.hideOnTermination",
  "debugger.runToCursorInlay",
  "debugger.inlineValues",
  "debugger.sortValues",
  "debugger.valueTooltip",
  "debugger.valueTooltipOnSelection",
  "debugger.valueTooltipDelay",
  "run.confirmRerun",
  "run.confirmTerminate",
  "run.showOnStart",
  "vcs.showDirtyDirectories",
  "vcs.git.showPushDialog",
  "vcs.git.pushDialogOnlyProtected",
  "vcs.git.combineStashAndShelf",
  "vcs.commit.nonModal",
  "vcs.commit.showRightMargin",
] as const;

export function isClientSetting(key: string): boolean {
  return CLIENT_SETTINGS_KEYS.some((root) => key === root || key.startsWith(`${root}.`));
}

/** Overlay from local globals, never from the local window's project layer. Missing client keys
 * also replace remote values, so older local settings fall back to client defaults.
 */
export function overlayClientSettings<T>(remote: T, local: unknown): T {
  const object = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const copy = (target: unknown, source: unknown, path: string[]): unknown => {
    const [head, ...tail] = path;
    const value = object(source)[head!];
    return { ...object(target), [head!]: tail.length ? copy(object(target)[head!], value, tail) : value };
  };
  return CLIENT_SETTINGS_KEYS.reduce((settings, key) => copy(settings, local, key.split(".")) as T, remote);
}
