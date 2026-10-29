/**
 * Version Control, Build/Execution/Deployment and Tools settings as features
 * consume them: every field present and in range (mirrors
 * `ide-core::workflow_settings` defaults). Normalisation never throws.
 */
import { useProject } from "./project";
import { DEFAULT_REMOTE, validateRemote, type RemoteSettings } from "./remoteSettings";

export type UpdateMethod = "merge" | "rebase";
export type IncomingCheck = "auto" | "always" | "never";
export type VcsConfirm = "ask" | "silently" | "never";
export type PatchCreated = "ask" | "no" | "reveal";
export type CursorShape = "block" | "underline" | "bar";

export interface IssueLinkValid {
  pattern: string;
  link: string;
}

export interface GitSettingsValid {
  executable: string;
  updateMethod: UpdateMethod;
  autoUpdateOnPushRejected: boolean;
  warnCrlf: boolean;
  warnDetachedHead: boolean;
  incomingCheck: IncomingCheck;
  protectedBranches: string;
  signOff: boolean;
  warnLargeFiles: boolean;
  largeFileMb: number;
  warnBadFileNames: boolean;
  showPushDialog: boolean;
  pushDialogOnlyProtected: boolean;
  combineStashAndShelf: boolean;
}

export interface CommitSettingsValid {
  nonModal: boolean;
  clearInitialMessage: boolean;
  analyzeCode: boolean;
  checkTodo: boolean;
  reformat: boolean;
  optimizeImports: boolean;
  cleanup: boolean;
  blankLineAfterSubject: boolean;
  limitSubject: boolean;
  subjectLimit: number;
  limitBody: boolean;
  bodyLimit: number;
  showRightMargin: boolean;
  wrapAtMargin: boolean;
}

export interface VcsSettingsValid {
  showDirtyDirectories: boolean;
  limitHistory: boolean;
  historyLimit: number;
  git: GitSettingsValid;
  commit: CommitSettingsValid;
  confirmation: {
    onCreate: VcsConfirm;
    onDelete: VcsConfirm;
    showUpdateOptions: boolean;
    confirmDropCommits: boolean;
    onPatchCreated: PatchCreated;
  };
  shelf: { removeApplied: boolean };
  issueNavigation: IssueLinkValid[];
}

export interface ConsoleSettingsValid {
  softWrap: boolean;
  overrideBuffer: boolean;
  bufferKb: number;
  encoding: string;
  foldPatterns: string[];
}

export interface DebuggerSettingsValid {
  showOnBreakpoint: boolean;
  focusAppOnBreakpoint: boolean;
  hideOnTermination: boolean;
  breakpointsAnyFile: boolean;
  runToCursorInlay: boolean;
  inlineValues: boolean;
  sortValues: boolean;
  valueTooltip: boolean;
  valueTooltipOnSelection: boolean;
  valueTooltipDelay: number;
  skipLibraryCode: boolean;
  python: { attachSubprocess: boolean; gevent: boolean };
}

export interface RunSettingsValid {
  confirmRerun: boolean;
  confirmTerminate: boolean;
  showOnStart: boolean;
  terminationTimeoutMs: number;
}

export interface TerminalSettingsValid {
  startDirectory: string;
  env: Record<string, string>;
  shellPath: string;
  tabName: string;
  audibleBell: boolean;
  closeOnExit: boolean;
  mouseReporting: boolean;
  copyOnSelection: boolean;
  pasteOnMiddleClick: boolean;
  overrideIdeShortcuts: boolean;
  shellIntegration: boolean;
  highlightHyperlinks: boolean;
  optionAsMeta: boolean;
  escapeToEditor: boolean;
  cursorShape: CursorShape;
  cursorBlink: boolean;
  useEditorFont: boolean;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  fallbackFontFamily: string;
  columnWidth: number;
}

export interface ActionsOnSaveValid {
  optimizeImports: boolean;
  cleanup: boolean;
}

export interface ExternalToolValid {
  id: string;
  name: string;
  description: string;
  group: string;
  enabled: boolean;
  program: string;
  arguments: string;
  workingDirectory: string;
  synchronizeAfter: boolean;
  openConsole: boolean;
}

export interface WorkflowSettings extends RemoteSettings {
  vcs: VcsSettingsValid;
  console: ConsoleSettingsValid;
  debugger: DebuggerSettingsValid;
  run: RunSettingsValid;
  terminal: TerminalSettingsValid;
  actionsOnSave: ActionsOnSaveValid;
  externalTools: ExternalToolValid[];
}

export const WORKFLOW_LIMITS = {
  historyLimit: { min: 10, max: 100_000 },
  messageLimit: { min: 20, max: 500 },
  largeFileMb: { min: 1, max: 100_000 },
  bufferKb: { min: 16, max: 1_048_576 },
  tooltipDelay: { min: 0, max: 10_000 },
  terminationTimeoutMs: { min: 0, max: 600_000 },
  terminalFontSize: { min: 6, max: 72 },
  terminalLineHeight: { min: 0.5, max: 3 },
  terminalColumnWidth: { min: 0.5, max: 2 },
} as const;

export const DEFAULT_EXTERNAL_TOOL: ExternalToolValid = {
  id: "",
  name: "",
  description: "",
  group: "External Tools",
  enabled: true,
  program: "",
  arguments: "",
  workingDirectory: "$ProjectFileDir$",
  synchronizeAfter: true,
  openConsole: true,
};

export const DEFAULT_WORKFLOW: WorkflowSettings = {
  vcs: {
    // IDEA's VcsConfiguration.SHOW_DIRTY_RECURSIVELY is off by default.
    showDirtyDirectories: false,
    limitHistory: true,
    historyLimit: 1000,
    git: {
      executable: "",
      updateMethod: "merge",
      autoUpdateOnPushRejected: false,
      warnCrlf: true,
      warnDetachedHead: true,
      incomingCheck: "auto",
      protectedBranches: "master; main",
      signOff: false,
      warnLargeFiles: true,
      largeFileMb: 50,
      warnBadFileNames: true,
      showPushDialog: true,
      pushDialogOnlyProtected: false,
      combineStashAndShelf: false,
    },
    commit: {
      nonModal: true,
      clearInitialMessage: false,
      analyzeCode: true,
      checkTodo: true,
      reformat: false,
      optimizeImports: false,
      cleanup: false,
      blankLineAfterSubject: true,
      limitSubject: true,
      subjectLimit: 72,
      limitBody: false,
      bodyLimit: 72,
      showRightMargin: true,
      wrapAtMargin: false,
    },
    confirmation: {
      onCreate: "ask",
      onDelete: "ask",
      showUpdateOptions: true,
      confirmDropCommits: true,
      onPatchCreated: "ask",
    },
    shelf: { removeApplied: false },
    issueNavigation: [],
  },
  console: {
    softWrap: false,
    overrideBuffer: true,
    bufferKb: 1024,
    encoding: "UTF-8",
    foldPatterns: [
      "at java.base/jdk.internal.reflect.",
      "at java.base/java.lang.reflect.Method.invoke",
      "at org.junit.",
      "at node:internal/",
      "<frozen importlib._bootstrap",
    ],
  },
  debugger: {
    showOnBreakpoint: true,
    focusAppOnBreakpoint: false,
    hideOnTermination: false,
    breakpointsAnyFile: false,
    runToCursorInlay: true,
    inlineValues: true,
    sortValues: false,
    valueTooltip: true,
    valueTooltipOnSelection: true,
    valueTooltipDelay: 700,
    skipLibraryCode: true,
    python: { attachSubprocess: true, gevent: false },
  },
  run: { confirmRerun: true, confirmTerminate: true, showOnStart: true, terminationTimeoutMs: 3000 },
  terminal: {
    startDirectory: "",
    env: {},
    shellPath: "",
    tabName: "Local",
    audibleBell: true,
    closeOnExit: true,
    mouseReporting: true,
    copyOnSelection: false,
    pasteOnMiddleClick: true,
    overrideIdeShortcuts: true,
    shellIntegration: true,
    highlightHyperlinks: true,
    optionAsMeta: false,
    escapeToEditor: false,
    cursorShape: "block",
    cursorBlink: true,
    useEditorFont: true,
    fontFamily: "JetBrains Mono",
    fontSize: 13,
    lineHeight: 1,
    fallbackFontFamily: "",
    columnWidth: 1,
  },
  actionsOnSave: { optimizeImports: false, cleanup: false },
  externalTools: [],
  ...DEFAULT_REMOTE,
};

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
const text = (v: unknown, d: string) => (typeof v === "string" ? v : d);
const nonEmpty = (v: unknown, d: string) => (typeof v === "string" && v.trim() ? v : d);
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], d: T): T =>
  typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : d;
const num = (v: unknown, d: number, { min, max }: { min: number; max: number }, int = false) => {
  if (typeof v !== "number" || !Number.isFinite(v)) return d;
  const n = Math.min(max, Math.max(min, v));
  return int ? Math.round(n) : n;
};
const strings = (v: unknown, d: readonly string[]) =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()) : [...d];

export function validateVcs(raw: unknown): VcsSettingsValid {
  const d = DEFAULT_WORKFLOW.vcs;
  const v = obj(raw);
  const g = obj(v.git);
  const c = obj(v.commit);
  const conf = obj(v.confirmation);
  const L = WORKFLOW_LIMITS;
  const confirm = ["ask", "silently", "never"] as const;
  return {
    showDirtyDirectories: bool(v.showDirtyDirectories, d.showDirtyDirectories),
    limitHistory: bool(v.limitHistory, d.limitHistory),
    historyLimit: num(v.historyLimit, d.historyLimit, L.historyLimit, true),
    git: {
      executable: text(g.executable, d.git.executable).trim(),
      updateMethod: oneOf(g.updateMethod, ["merge", "rebase"] as const, d.git.updateMethod),
      autoUpdateOnPushRejected: bool(g.autoUpdateOnPushRejected, d.git.autoUpdateOnPushRejected),
      warnCrlf: bool(g.warnCrlf, d.git.warnCrlf),
      warnDetachedHead: bool(g.warnDetachedHead, d.git.warnDetachedHead),
      incomingCheck: oneOf(g.incomingCheck, ["auto", "always", "never"] as const, d.git.incomingCheck),
      protectedBranches: text(g.protectedBranches, d.git.protectedBranches),
      signOff: bool(g.signOff, d.git.signOff),
      warnLargeFiles: bool(g.warnLargeFiles, d.git.warnLargeFiles),
      largeFileMb: num(g.largeFileMb, d.git.largeFileMb, L.largeFileMb, true),
      warnBadFileNames: bool(g.warnBadFileNames, d.git.warnBadFileNames),
      showPushDialog: bool(g.showPushDialog, d.git.showPushDialog),
      pushDialogOnlyProtected: bool(g.pushDialogOnlyProtected, d.git.pushDialogOnlyProtected),
      combineStashAndShelf: bool(g.combineStashAndShelf, d.git.combineStashAndShelf),
    },
    commit: {
      nonModal: bool(c.nonModal, d.commit.nonModal),
      clearInitialMessage: bool(c.clearInitialMessage, d.commit.clearInitialMessage),
      analyzeCode: bool(c.analyzeCode, d.commit.analyzeCode),
      checkTodo: bool(c.checkTodo, d.commit.checkTodo),
      reformat: bool(c.reformat, d.commit.reformat),
      optimizeImports: bool(c.optimizeImports, d.commit.optimizeImports),
      cleanup: bool(c.cleanup, d.commit.cleanup),
      blankLineAfterSubject: bool(c.blankLineAfterSubject, d.commit.blankLineAfterSubject),
      limitSubject: bool(c.limitSubject, d.commit.limitSubject),
      subjectLimit: num(c.subjectLimit, d.commit.subjectLimit, L.messageLimit, true),
      limitBody: bool(c.limitBody, d.commit.limitBody),
      bodyLimit: num(c.bodyLimit, d.commit.bodyLimit, L.messageLimit, true),
      showRightMargin: bool(c.showRightMargin, d.commit.showRightMargin),
      wrapAtMargin: bool(c.wrapAtMargin, d.commit.wrapAtMargin),
    },
    confirmation: {
      onCreate: oneOf(conf.onCreate, confirm, d.confirmation.onCreate),
      onDelete: oneOf(conf.onDelete, confirm, d.confirmation.onDelete),
      showUpdateOptions: bool(conf.showUpdateOptions, d.confirmation.showUpdateOptions),
      confirmDropCommits: bool(conf.confirmDropCommits, d.confirmation.confirmDropCommits),
      onPatchCreated: oneOf(conf.onPatchCreated, ["ask", "no", "reveal"] as const, d.confirmation.onPatchCreated),
    },
    shelf: { removeApplied: bool(obj(v.shelf).removeApplied, d.shelf.removeApplied) },
    issueNavigation: Array.isArray(v.issueNavigation)
      ? v.issueNavigation
          .map((x) => obj(x))
          .map((x) => ({ pattern: text(x.pattern, ""), link: text(x.link, "") }))
          .filter((x) => x.pattern.trim())
      : [],
  };
}

export function validateConsole(raw: unknown): ConsoleSettingsValid {
  const d = DEFAULT_WORKFLOW.console;
  const v = obj(raw);
  return {
    softWrap: bool(v.softWrap, d.softWrap),
    overrideBuffer: bool(v.overrideBuffer, d.overrideBuffer),
    bufferKb: num(v.bufferKb, d.bufferKb, WORKFLOW_LIMITS.bufferKb, true),
    encoding: nonEmpty(v.encoding, d.encoding),
    foldPatterns: strings(v.foldPatterns, d.foldPatterns),
  };
}

export function validateDebugger(raw: unknown): DebuggerSettingsValid {
  const d = DEFAULT_WORKFLOW.debugger;
  const v = obj(raw);
  const py = obj(v.python);
  return {
    showOnBreakpoint: bool(v.showOnBreakpoint, d.showOnBreakpoint),
    focusAppOnBreakpoint: bool(v.focusAppOnBreakpoint, d.focusAppOnBreakpoint),
    hideOnTermination: bool(v.hideOnTermination, d.hideOnTermination),
    breakpointsAnyFile: bool(v.breakpointsAnyFile, d.breakpointsAnyFile),
    runToCursorInlay: bool(v.runToCursorInlay, d.runToCursorInlay),
    inlineValues: bool(v.inlineValues, d.inlineValues),
    sortValues: bool(v.sortValues, d.sortValues),
    valueTooltip: bool(v.valueTooltip, d.valueTooltip),
    valueTooltipOnSelection: bool(v.valueTooltipOnSelection, d.valueTooltipOnSelection),
    valueTooltipDelay: num(v.valueTooltipDelay, d.valueTooltipDelay, WORKFLOW_LIMITS.tooltipDelay, true),
    skipLibraryCode: bool(v.skipLibraryCode, d.skipLibraryCode),
    python: {
      attachSubprocess: bool(py.attachSubprocess, d.python.attachSubprocess),
      gevent: bool(py.gevent, d.python.gevent),
    },
  };
}

export function validateRun(raw: unknown): RunSettingsValid {
  const d = DEFAULT_WORKFLOW.run;
  const v = obj(raw);
  return {
    confirmRerun: bool(v.confirmRerun, d.confirmRerun),
    confirmTerminate: bool(v.confirmTerminate, d.confirmTerminate),
    showOnStart: bool(v.showOnStart, d.showOnStart),
    terminationTimeoutMs: num(
      v.terminationTimeoutMs,
      d.terminationTimeoutMs,
      WORKFLOW_LIMITS.terminationTimeoutMs,
      true,
    ),
  };
}

export function validateTerminal(raw: unknown): TerminalSettingsValid {
  const d = DEFAULT_WORKFLOW.terminal;
  const v = obj(raw);
  const env: Record<string, string> = {};
  for (const [k, val] of Object.entries(obj(v.env))) if (k.trim() && typeof val === "string") env[k] = val;
  return {
    startDirectory: text(v.startDirectory, d.startDirectory).trim(),
    env,
    shellPath: text(v.shellPath, d.shellPath).trim(),
    tabName: nonEmpty(v.tabName, d.tabName),
    audibleBell: bool(v.audibleBell, d.audibleBell),
    closeOnExit: bool(v.closeOnExit, d.closeOnExit),
    mouseReporting: bool(v.mouseReporting, d.mouseReporting),
    copyOnSelection: bool(v.copyOnSelection, d.copyOnSelection),
    pasteOnMiddleClick: bool(v.pasteOnMiddleClick, d.pasteOnMiddleClick),
    overrideIdeShortcuts: bool(v.overrideIdeShortcuts, d.overrideIdeShortcuts),
    shellIntegration: bool(v.shellIntegration, d.shellIntegration),
    highlightHyperlinks: bool(v.highlightHyperlinks, d.highlightHyperlinks),
    optionAsMeta: bool(v.optionAsMeta, d.optionAsMeta),
    escapeToEditor: bool(v.escapeToEditor, d.escapeToEditor),
    cursorShape: oneOf(v.cursorShape, ["block", "underline", "bar"] as const, d.cursorShape),
    cursorBlink: bool(v.cursorBlink, d.cursorBlink),
    useEditorFont: bool(v.useEditorFont, d.useEditorFont),
    fontFamily: nonEmpty(v.fontFamily, d.fontFamily),
    fontSize: num(v.fontSize, d.fontSize, WORKFLOW_LIMITS.terminalFontSize),
    lineHeight: num(v.lineHeight, d.lineHeight, WORKFLOW_LIMITS.terminalLineHeight),
    fallbackFontFamily: text(v.fallbackFontFamily, d.fallbackFontFamily).trim(),
    columnWidth: num(v.columnWidth, d.columnWidth, WORKFLOW_LIMITS.terminalColumnWidth),
  };
}

export function validateActionsOnSave(raw: unknown): ActionsOnSaveValid {
  const v = obj(raw);
  const d = DEFAULT_WORKFLOW.actionsOnSave;
  return { optimizeImports: bool(v.optimizeImports, d.optimizeImports), cleanup: bool(v.cleanup, d.cleanup) };
}

export function validateExternalTools(raw: unknown): ExternalToolValid[] {
  if (!Array.isArray(raw)) return [];
  const d = DEFAULT_EXTERNAL_TOOL;
  const seen = new Set<string>();
  const out: ExternalToolValid[] = [];
  raw.forEach((item, i) => {
    const t = obj(item);
    const name = text(t.name, "").trim();
    if (!name) return;
    let id = text(t.id, "").trim() || `tool${i + 1}`;
    while (seen.has(id)) id += "_";
    seen.add(id);
    out.push({
      id,
      name,
      description: text(t.description, d.description),
      group: nonEmpty(t.group, d.group),
      enabled: bool(t.enabled, d.enabled),
      program: text(t.program, d.program),
      arguments: text(t.arguments, d.arguments),
      workingDirectory: text(t.workingDirectory, d.workingDirectory),
      synchronizeAfter: bool(t.synchronizeAfter, d.synchronizeAfter),
      openConsole: bool(t.openConsole, d.openConsole),
    });
  });
  return out;
}

export function validateWorkflow(raw: unknown): WorkflowSettings {
  const root = obj(raw);
  return {
    vcs: validateVcs(root.vcs),
    console: validateConsole(root.console),
    debugger: validateDebugger(root.debugger),
    run: validateRun(root.run),
    terminal: validateTerminal(root.terminal),
    actionsOnSave: validateActionsOnSave(root.actionsOnSave),
    externalTools: validateExternalTools(root.externalTools),
    ...validateRemote(root),
  };
}

// ---------------------------------------------------------------------------
// Live, normalised view of the effective settings.

let cachedRaw: unknown = Symbol("unset");
let cached: WorkflowSettings = DEFAULT_WORKFLOW;

/** Normalised settings of the open project (defaults without one). Cached per settings object. */
export function workflowSettings(): WorkflowSettings {
  const raw = useProject.getState().settings;
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cached = validateWorkflow(raw);
  }
  return cached;
}

/** React hook over one section, e.g. `useWorkflowSettings((s) => s.terminal)`. */
export function useWorkflowSettings<T>(select: (s: WorkflowSettings) => T): T {
  return useProject((p) => {
    if (p.settings !== cachedRaw) {
      cachedRaw = p.settings;
      cached = validateWorkflow(p.settings);
    }
    return select(cached);
  });
}

/** Calls `listener` whenever a section changes (deep-compared by JSON), not initially. */
export function onWorkflowSettingsChange<T>(
  select: (s: WorkflowSettings) => T,
  listener: (value: T, prev: T) => void,
): () => void {
  let prev = select(workflowSettings());
  let prevJson = JSON.stringify(prev);
  return useProject.subscribe((s, old) => {
    if (s.settings === old.settings) return;
    const next = select(workflowSettings());
    const json = JSON.stringify(next);
    if (json === prevJson) return;
    const before = prev;
    prev = next;
    prevJson = json;
    listener(next, before);
  });
}

/** Macros usable in External Tools arguments / working directory (IDEA names). */
export const EXTERNAL_TOOL_MACROS: ReadonlyArray<{ name: string; description: string }> = [
  { name: "$FilePath$", description: "Absolute path of the current file" },
  { name: "$FileDir$", description: "Directory of the current file" },
  { name: "$FileName$", description: "Name of the current file" },
  { name: "$FileNameWithoutExtension$", description: "File name without extension" },
  { name: "$FileExt$", description: "Extension of the current file" },
  { name: "$FileRelativePath$", description: "Path of the current file relative to the project" },
  { name: "$FileDirRelativeToProjectRoot$", description: "Directory of the current file relative to the project" },
  { name: "$ProjectFileDir$", description: "Project root directory" },
  { name: "$ProjectName$", description: "Project name" },
  { name: "$LineNumber$", description: "Caret line number (1-based)" },
  { name: "$ColumnNumber$", description: "Caret column number (1-based)" },
  { name: "$SelectedText$", description: "Text selected in the editor" },
  { name: "$Prompt$", description: "Asks for a value when the tool runs" },
];
