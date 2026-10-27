/**
 * `~/.openideavimrc` / `~/.ideavimrc`: the safe subset IdeaVim users keep in
 * their rc file — `set` options, `map` variants, `let mapleader` — plus
 * IdeaVim's `:action <id>` / `<Action>(id)` mappings, which run OpenIDEA
 * actions. Everything else is reported as ignored, never executed.
 */

/** codemirror-vim mapping context; undefined = Normal, Visual and Operator-pending. */
export type MapMode = "normal" | "insert" | "visual" | "operatorPending" | undefined;

export type RcCommand =
  | { kind: "set"; name: string; value: string | boolean }
  | { kind: "map"; mode: MapMode; noremap: boolean; lhs: string; rhs: string }
  /** A key mapped to one Ex command, e.g. `<Action>(ReformatCode)` → `action ReformatCode`. */
  | { kind: "mapEx"; mode: MapMode; lhs: string; ex: string };

export interface RcIgnored {
  line: number;
  text: string;
  reason: string;
}

export interface RcParseResult {
  commands: RcCommand[];
  ignored: RcIgnored[];
}

export const RC_FILES = [".openideavimrc", ".ideavimrc"] as const;

const MAP_RE = /^(n|v|x|i|o)?(map|noremap)$/;
const MAP_MODES: Record<string, MapMode> = {
  "": undefined,
  n: "normal",
  v: "visual",
  x: "visual",
  i: "insert",
  o: "operatorPending",
};
/** Options the Vim engine implements (others, e.g. IdeaVim's `ideajoin`, are reported as ignored). */
const SUPPORTED_OPTIONS = new Set(["textwidth", "tw", "pcre", "insertModeEscKeysTimeout", "langmap", "lmap"]);
const MAP_FLAGS = /^<(silent|unique|nowait|buffer|expr|script)>$/i;

function leaderKeys(value: string): string {
  if (value === " " || /^\\?<space>$/i.test(value)) return "<Space>";
  return value;
}

/** `let mapleader = ","` / `"\<Space>"` / `' '`: the quoted value, or null. */
function parseLetValue(rest: string): string | null {
  const m = /^=\s*(["'])(.*)\1\s*$/.exec(rest.trim());
  if (!m) return null;
  return m[1] === '"' ? m[2]!.replace(/\\(<[^>]+>)/g, "$1").replace(/\\\\/g, "\\") : m[2]!;
}

function splitArgs(s: string): string[] {
  return s.trim().split(/\s+/).filter(Boolean);
}

/** `<Action>(id)` or `:action id<CR>` (also `:<C-u>action`) as an Ex command line. */
export function exOfRhs(rhs: string): string | null {
  const action = /^<Action>\(([^)\s]+)\)$/i.exec(rhs);
  if (action) return `action ${action[1]}`;
  const ex = /^:(?:<C-u>)?([^<]+)<CR>$/i.exec(rhs);
  return ex ? ex[1]!.trim() : null;
}

export function parseVimrc(text: string): RcParseResult {
  const commands: RcCommand[] = [];
  const ignored: RcIgnored[] = [];
  let leader = "\\";
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('"')) return;
    const ignore = (reason: string) => ignored.push({ line: i + 1, text: line, reason });
    const [word = "", ...restWords] = splitArgs(line);
    const rest = line.slice(line.indexOf(word) + word.length);

    if (word === "set" || word === "se") {
      if (!restWords.length) return ignore("set without options");
      for (const opt of restWords) {
        const eq = /^([a-zA-Z]+)=(.*)$/.exec(opt);
        const cmd: RcCommand | null = eq
          ? { kind: "set", name: eq[1]!, value: eq[2]! }
          : /^[a-zA-Z]+$/.test(opt)
            ? !SUPPORTED_OPTIONS.has(opt) && opt.startsWith("no") && SUPPORTED_OPTIONS.has(opt.slice(2))
              ? { kind: "set", name: opt.slice(2), value: false }
              : { kind: "set", name: opt, value: true }
            : null;
        if (!cmd) ignore(`unsupported option syntax: ${opt}`);
        else if (!SUPPORTED_OPTIONS.has(cmd.name)) ignore(`option not supported: ${cmd.name}`);
        else commands.push(cmd);
      }
      return;
    }

    if (word === "let") {
      const m = /^let\s+(g:)?mapleader\s*(=.*)$/.exec(line);
      const value = m ? parseLetValue(m[2]!) : null;
      if (value === null || value === "") return ignore("only `let mapleader` is supported");
      leader = leaderKeys(value);
      return;
    }

    const map = MAP_RE.exec(word);
    if (map) {
      const args = splitArgs(rest).filter((a) => !MAP_FLAGS.test(a));
      if (args.length < 2) return ignore("mapping needs a left and right side");
      const withLeader = (keys: string) => keys.replace(/<leader>/gi, leader);
      const lhs = withLeader(args[0]!);
      const rhs = withLeader(args.slice(1).join(" "));
      const mode = MAP_MODES[map[1] ?? ""];
      const ex = exOfRhs(rhs);
      if (ex) commands.push({ kind: "mapEx", mode, lhs, ex });
      else commands.push({ kind: "map", mode, noremap: map[2] !== "map", lhs, rhs });
      return;
    }

    ignore(`unsupported command: ${word}`);
  });
  return { commands, ignored };
}

/**
 * IdeaVim (IntelliJ) action ids → OpenIDEA action ids, for `:action` and
 * `<Action>()`. Our own ids (`code.reformat`) work as well.
 */
export const IDEA_ACTIONS: Readonly<Record<string, string>> = {
  GotoDeclaration: "navigate.declaration",
  GotoImplementation: "navigate.implementation",
  GotoTypeDeclaration: "navigate.typeDeclaration",
  GotoSuperMethod: "navigate.superMethod",
  GotoTest: "navigate.gotoTest",
  GotoClass: "navigate.gotoClass",
  GotoFile: "navigate.gotoFile",
  GotoSymbol: "navigate.gotoSymbol",
  GotoAction: "navigate.findAction",
  GotoLine: "navigate.gotoLine",
  SearchEverywhere: "navigate.searchEverywhere",
  RecentFiles: "navigate.recentFiles",
  RecentLocations: "navigate.recentLocations",
  Back: "navigate.back",
  Forward: "navigate.forward",
  FileStructurePopup: "navigate.fileStructure",
  GotoNextError: "navigate.nextError",
  GotoPreviousError: "navigate.prevError",
  MethodDown: "navigate.nextMethod",
  MethodUp: "navigate.previousMethod",
  CallHierarchy: "navigate.callHierarchy",
  TypeHierarchy: "navigate.typeHierarchy",
  ToggleBookmark: "navigate.toggleBookmark",
  ShowBookmarks: "navigate.showBookmarks",
  SelectIn: "navigate.selectIn",
  Find: "find.inFile",
  Replace: "find.replaceInFile",
  FindInPath: "find.inPath",
  ReplaceInPath: "find.replaceInPath",
  FindUsages: "find.usages",
  ShowUsages: "find.showUsages",
  HighlightUsagesInFile: "find.highlightUsages",
  ReformatCode: "code.reformat",
  OptimizeImports: "code.optimizeImports",
  CommentByLineComment: "code.commentLine",
  CommentByBlockComment: "code.commentBlock",
  ShowIntentionActions: "code.showIntentions",
  QuickJavaDoc: "code.quickDocumentation",
  QuickImplementations: "code.quickDefinition",
  ParameterInfo: "code.parameterInfo",
  CodeCompletion: "code.completion",
  Generate: "code.generate",
  SurroundWith: "code.surroundWith",
  EditorSelectWord: "code.extendSelection",
  EditorUnSelectWord: "code.shrinkSelection",
  CollapseRegion: "code.fold",
  ExpandRegion: "code.unfold",
  CollapseAllRegions: "code.foldAll",
  ExpandAllRegions: "code.unfoldAll",
  RenameElement: "refactor.rename",
  "Refactorings.QuickListPopupAction": "refactor.thisMenu",
  ChangeSignature: "refactor.changeSignature",
  ExtractMethod: "refactor.extractMethod",
  IntroduceVariable: "refactor.extractVariable",
  IntroduceConstant: "refactor.extractConstant",
  IntroduceField: "refactor.extractField",
  IntroduceParameter: "refactor.extractParameter",
  Inline: "refactor.inline",
  Move: "refactor.move",
  SafeDelete: "refactor.safeDelete",
  Run: "run.run",
  Debug: "run.debug",
  RunClass: "run.runContext",
  DebugClass: "run.debugContext",
  Stop: "run.stop",
  Rerun: "run.rerun",
  ChooseRunConfiguration: "run.chooseConfig",
  ToggleLineBreakpoint: "debug.toggleBreakpoint",
  SaveAll: "file.save",
  ShowSettings: "file.settings",
  NewScratchFile: "file.newScratchFile",
  CloseContent: "editor.closeTab",
  CloseEditor: "editor.closeTab",
  CloseAllEditors: "editor.closeAllTabs",
  ReopenClosedTab: "editor.reopenClosedTab",
  NextTab: "editor.nextTab",
  PreviousTab: "editor.prevTab",
  SplitVertically: "editor.splitRight",
  SplitHorizontally: "editor.splitDown",
  Unsplit: "editor.unsplit",
  ToggleDistractionFreeMode: "editor.toggleZen",
  ActivateProjectToolWindow: "toolwindow.project",
  HideAllWindows: "toolwindow.hideAll",
  "Vcs.QuickListPopupAction": "vcs.operations",
  CheckinProject: "vcs.commit",
  "Vcs.Push": "vcs.push",
  "Vcs.UpdateProject": "vcs.update",
  "Git.Branches": "vcs.branches",
  Annotate: "vcs.annotate",
  VcsShowNextChangeMarker: "vcs.nextChange",
  VcsShowPrevChangeMarker: "vcs.prevChange",
  "Compare.SameVersion": "vcs.showDiff",
};

/** The OpenIDEA action for an `:action` argument: an IdeaVim id, or one of ours as is. */
export function resolveActionId(id: string): string {
  return IDEA_ACTIONS[id] ?? id;
}
