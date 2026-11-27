/** Editor actions (ids from keymaps/intellij-macos.ts). */
import { writeClipboardText } from "@/platform/clipboard";
import { EditorSelection, type EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { indentSelection, moveLineDown, moveLineUp } from "@codemirror/commands";
import { foldEffect, syntaxTree, toggleFold } from "@codemirror/language";
import { acceptCompletion, completionStatus } from "@codemirror/autocomplete";
import { executeAction, registerActions, type Action } from "@/platform/actions";
import { getContext } from "@/platform/context";
import { focusedCellEditor } from "@/editor/api";
import { focusedSoftWrapSurface } from "@/workbench/softWrap";
import { resetSurfaceFontZoom, stepFocusedSurfaceFontZoom, stepSurfaceFontZoomIn } from "@/workbench/contributions";
import { editorController, useGotoLine, useTabs } from "./controller";
import {
  addCaretsToLineEnds,
  commentBlock,
  commentLine,
  completeStatement,
  cycleCase,
  deleteLine,
  duplicateEntireLines,
  duplicateLineOrSelection,
  inDifferentHumpsMode,
  joinLines,
  moveStatementDown,
  moveStatementUp,
  nextOccurrence,
  selectAllOccurrences,
  selectLineAtCaret,
  startNewLine,
  startNewLineBefore,
  swapSelectionBoundaries,
  toggleCase,
  transpose,
  unselectOccurrence,
} from "./cm/editing";
import {
  cutToLineEnd,
  deleteToLogicalLineEnd,
  deleteToLogicalLineStart,
  hungryBackspace,
  killToWordEnd,
  killToWordStart,
} from "./cm/lineDeletion";
import {
  emptyStack,
  extendSelection,
  shrinkSelection,
  type SelectionStack,
  type SimpleRange,
} from "./model/selectionStack";
import type { EditorSlot } from "./model/slot";
import type { SplitEdge, Tab } from "./model/tabs";
import {
  findAgain,
  findPanelTarget,
  findWordAtCaretInPane,
  openFindBar,
  openFindBarResults,
  useFindPreferences,
} from "./view/FindBar";
import {
  collapseAll,
  collapseRecursively,
  expandAll,
  expandRecursively,
  collapseBlock,
  expandToLevelEffects,
  foldAtCaret,
  foldRegions,
  foldSelection,
  unfoldAtCaret,
} from "./cm/folding";
import { fillParagraph } from "./cm/fillParagraph";
import { convertIndentsToSpaces, convertIndentsToTabs, reverseLines, sortLines, uniqueLines } from "./cm/lines";
import { hardWrapAt } from "./cm/setup";
import { customRegions } from "./cm/regions";
import { toggleRenderedViewAtCaret } from "./cm/renderedDocs";
import { enclosingHeaders } from "./cm/stickyScroll";
import { moveElementLeft, moveElementRight } from "./cm/moveElement";
import { caretAnchor, openPopup, updatePopup, useLspPopup } from "@/editor/lsp/popupStore";
import { copyPathPopup } from "./copyPathChooser";
import {
  cursorCodeBlockEnd,
  cursorCodeBlockStart,
  cursorMatchBrace,
  cursorPageBottom,
  cursorPageTop,
  cursorParagraphBackward,
  cursorParagraphForward,
  scrollDown,
  scrollDownAndMove,
  scrollLeft,
  scrollRight,
  scrollToBottom,
  scrollToCenter,
  scrollToTop,
  scrollUp,
  scrollUpAndMove,
  selectCodeBlockEnd,
  selectCodeBlockStart,
  selectPageBottom,
  selectPageTop,
  selectParagraphBackward,
  selectParagraphForward,
  splitLine,
} from "./cm/caretCommands";
import { isOverwrite, toggleOverwrite } from "./cm/overwrite";
import { isStickySelection, toggleStickySelection } from "./cm/stickySelection";
import { isColumnMode, toggleColumnMode } from "./cm/columnMode";
import {
  cloneCaretAbove,
  cloneCaretBelow,
  moveDownAndScroll,
  moveDownAndScrollWithSelection,
  moveUpAndScroll,
  moveUpAndScrollWithSelection,
} from "./cm/verticalMotion";
import { pasteAsPlainText, pasteFromHistory, unwrapAtCaret } from "./extras";
import { cyclicExpandWord } from "./wordCompletion";
import { copyReferenceToClipboard, declaredName, qualifiedReference, referenceOffset } from "./copyReference";
import { selectedLineContext, selectedLines } from "./selectedLines";
import { declarationChain } from "./view/outline";
import { recordClipboard } from "./clipboardHistory";
import { docCommentFolds, useDocMeta, useOutline } from "./model/document";
import {
  copyAs,
  resetAllEditorsFontZoom,
  resetConfiguredEditorsFontZoom,
  stepConfiguredEditorsFontZoom,
  stepEveryEditorFontZoom,
} from "./cm/prefs";
import { useProject } from "@/platform/project";
import { call, commands } from "@/platform/ipc";
import { editorPrefs } from "@/platform/editorSettings";
import { notifications } from "@/workbench/contributions";
import { togglePinSelectedContent } from "@/workbench/toolwindows/content";
import { useToolWindowLayout } from "@/workbench/toolwindows/store";
import { toggleReadOnly } from "./fileAttributes";
import { codeVisionShown, toggleCodeVision } from "./codeVision";
import { appearanceSwitches, toggleAppearance, type AppearanceSwitch } from "./gutterMenu";
import { openNavBarPopup } from "./view/NavBarPopup";
import {
  cachedStructureQueries,
  completeStatementStructural,
  hasLezerTree,
  moveStatementStructural,
  type StructureQueries,
} from "./cm/structural";
import type { DocModel } from "./model/document";
import { structure } from "@/editor/structure";
import { tx } from "@/platform/i18n";
import { lspRequest } from "@/editor/lsp/lsp";
import { readFileLines, withDocument } from "@/editor/lsp/files";
import { pathToCopy } from "@/platform/copyPath";
import { shortcutLabel } from "@/platform/keymap";

/**
 * Text-editing actions: the editor has focus, or a popup (Find Action) runs them on it. Not a
 * tool window's speed search: it opens a layer too, but the keys belong to its tree (⌘⌫).
 * `suspendEditorKeys` is set only while dispatching a key that belongs to something else
 * (a commit message, the Push dialog), so Find Action can still run these actions.
 */
export const TEXT_WHEN = "editorTextFocus || textEditorActive && popupOpen && !toolWindowFocus && !suspendEditorKeys";
const EDITOR_WHEN = "textEditorActive && (editorFocus || !toolWindowFocus)";
const TABS_WHEN = "editorTabsOpen && !toolWindowFocus";

function activeSlot(): EditorSlot | null {
  const slot = editorController().activeSlot;
  return slot && !slot.disposed ? slot : null;
}

/**
 * The text pane that has focus in a diff or merge editor (`editable`: only a side that can be
 * edited). Text actions that need nothing but the view run there, as in a file editor.
 */
function focusedDiffPane(editable: boolean): EditorView | null {
  const el = typeof document === "undefined" ? null : document.activeElement;
  const view = el instanceof HTMLElement ? EditorView.findFromDOM(el) : null;
  return view && !(editable && view.state.readOnly) ? view : null;
}

/** `run` on the focused diff pane while a diff has focus, otherwise on the active editor. */
function withTextView(run: (view: EditorView) => unknown, editable: boolean) {
  return () => {
    if (!getContext().diffEditorFocus) return withView(run)();
    const view = focusedDiffPane(editable);
    if (view) run(view);
  };
}

function withView(run: (view: EditorView, slot: EditorSlot | null) => unknown) {
  return () => {
    // While a notebook cell editor has focus it is the editor the action runs in
    // (the notebook publishes the editor context keys for it), never the last text tab.
    const cell = focusedCellEditor();
    if (cell) {
      run(cell, null);
      return;
    }
    const slot = activeSlot();
    if (!slot?.view) return;
    run(slot.view, slot);
    if (!slot.view.hasFocus && !getContext().popupOpen) slot.view.focus();
  };
}

function activePaneEditorFocus(): Element | null {
  if (typeof document === "undefined") return null;
  return document.querySelector(`[data-pane-id="${useTabs.getState().activePane}"] [data-editor-focus]`);
}

/** Routes keyboard font zoom to focus, then the active editor slot or pane surface. */
function stepSurfaceFontSize(delta: 1 | -1): void {
  const activeEl = typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null;
  if (activeEl) {
    if (stepFocusedSurfaceFontZoom(delta)) return;
    const cmEl = activeEl.closest?.(".cm-editor") as HTMLElement | null;
    if (cmEl) {
      const cmView = EditorView.findFromDOM(cmEl);
      if (cmView) {
        stepConfiguredEditorsFontZoom(cmView, delta);
        return;
      }
    }
  }

  const slot = activeSlot();
  if (!slot?.view) {
    stepSurfaceFontZoomIn(activePaneEditorFocus(), delta);
    return;
  }
  stepConfiguredEditorsFontZoom(slot.view, delta);
  if (!slot.view.hasFocus && !getContext().popupOpen) slot.view.focus();
}

function resetFontSize(): void {
  const allScope = editorPrefs().general.wheelZoomScope === "all";
  const surfaceOpts = allScope ? { isolatedOnly: true } : undefined;
  const activeEl = typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null;
  if (activeEl) {
    if (stepFocusedSurfaceFontZoom(0, surfaceOpts)) return;
    if (!allScope) {
      const cmEl = activeEl.closest?.(".cm-editor") as HTMLElement | null;
      if (cmEl) {
        const cmView = EditorView.findFromDOM(cmEl);
        if (cmView) {
          resetConfiguredEditorsFontZoom(cmView);
          return;
        }
      }
    }
  }

  const slot = activeSlot();
  if (!allScope && slot?.view) {
    resetConfiguredEditorsFontZoom(slot.view);
    return;
  }
  if (!slot?.view && stepSurfaceFontZoomIn(activePaneEditorFocus(), 0, surfaceOpts)) return;
  if (allScope) resetAllFontSize();
}

function resetAllFontSize(): void {
  resetAllEditorsFontZoom();
  if (typeof document !== "undefined") {
    resetSurfaceFontZoom();
  }
}

// --- extend / shrink selection ---------------------------------------------------

/** One stack per selection range (by index): ⌥↑ / ⌥↓ work on every caret. */
const stacks = new WeakMap<EditorSlot, SelectionStack[]>();

/** Syntax-tree candidates when the backend has nothing (or the language isn't parsed there). */
export function syntaxCandidates(state: EditorState, sel: SimpleRange): SimpleRange[] {
  const out: SimpleRange[] = [];
  const word = state.wordAt(sel.from);
  if (word) out.push({ from: word.from, to: word.to });
  const tree = syntaxTree(state);
  for (
    let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(sel.from, 1);
    node;
    node = node.parent
  ) {
    out.push({ from: node.from, to: node.to });
    const text =
      state.sliceDoc(node.from, Math.min(node.to, node.from + 1)) +
      state.sliceDoc(Math.max(node.from, node.to - 1), node.to);
    if (/^[([{"'`][)\]}"'`]$/.test(text) && node.to - node.from > 2) out.push({ from: node.from + 1, to: node.to - 1 });
  }
  const line = state.doc.lineAt(sel.from);
  const endLine = state.doc.lineAt(sel.to);
  const indent = /^\s*/.exec(line.text)![0].length;
  out.push(
    { from: line.from + indent, to: endLine.to },
    { from: line.from, to: endLine.to },
    { from: 0, to: state.doc.length },
  );
  return out;
}

function rangesFromBackend(
  state: EditorState,
  ranges: Array<{ start: { line: number; col: number }; end: { line: number; col: number } }>,
): SimpleRange[] {
  const off = (p: { line: number; col: number }) => {
    if (p.line + 1 > state.doc.lines) return state.doc.length;
    const l = state.doc.line(p.line + 1);
    return Math.min(l.from + p.col, l.to);
  };
  return ranges.map((r) => ({ from: off(r.start), to: off(r.end) }));
}

export interface BackendChain {
  /** `DocModel.changeCounter` when the chain was computed. */
  counter: number;
  /** Offset the backend was asked at. */
  pos: number;
  ranges: SimpleRange[];
}

/**
 * The backend chain of a previous extend answers again while the document is
 * unchanged and the selection still covers its position: every node around
 * the selection is around that position too. Repeated ⌥↑ then needs no IPC.
 */
export function reusableChain(
  chain: BackendChain | undefined,
  counter: number,
  current: SimpleRange,
): SimpleRange[] | null {
  return chain && chain.counter === counter && chain.pos >= current.from && chain.pos <= current.to
    ? chain.ranges
    : null;
}

const chains = new WeakMap<EditorSlot, BackendChain>();

/** Backend candidates around `current` (the cached chain for repeated extends of one range). */
async function backendCandidates(slot: EditorSlot, current: SimpleRange, cache: boolean): Promise<SimpleRange[]> {
  const model = slot.model;
  const cached = cache ? reusableChain(chains.get(slot), model.changeCounter, current) : null;
  if (cached) return cached;
  try {
    await model.sync.whenIdle();
    const counter = model.changeCounter;
    const ranges = await model.manager.backend.selectionRanges(model.doc, current.from);
    if (counter !== model.changeCounter || !slot.view) return [];
    const candidates = rangesFromBackend(slot.view.state, ranges);
    if (cache) chains.set(slot, { counter, pos: current.from, ranges: candidates });
    return candidates;
  } catch {
    return []; // fall back to the syntax tree
  }
}

async function extend(slot: EditorSlot) {
  const view = slot.view;
  if (!view) return;
  const before = view.state.selection;
  const currents = before.ranges.map((r) => ({ from: r.from, to: r.to }));
  const candidates = await Promise.all(currents.map((c, i) => backendCandidates(slot, c, i === before.mainIndex)));
  const v = slot.view;
  if (!v || !v.state.selection.eq(before)) return;
  const prev = stacks.get(slot) ?? [];
  const results = currents.map((c, i) =>
    extendSelection(prev[i] ?? emptyStack(), c, [...candidates[i]!, ...syntaxCandidates(v.state, c)]),
  );
  stacks.set(
    slot,
    results.map((r) => r.state),
  );
  if (!results.some((r) => r.next)) return;
  const ranges = results.map((r, i) => (r.next ? EditorSelection.range(r.next.from, r.next.to) : before.ranges[i]!));
  v.dispatch({
    selection: EditorSelection.create(ranges, before.mainIndex),
    scrollIntoView: true,
    userEvent: "select.extend",
  });
}

/** Extend / shrink run in order: a quick ⌥↑⌥↑ extends twice although extending waits for the backend. */
const selectionQueue = new WeakMap<EditorSlot, Promise<void>>();

function queueSelection(slot: EditorSlot, step: (slot: EditorSlot) => void | Promise<void>) {
  const next = (selectionQueue.get(slot) ?? Promise.resolve()).then(() => step(slot)).catch(() => {});
  selectionQueue.set(slot, next);
  return next;
}

function shrink(slot: EditorSlot) {
  const view = slot.view;
  if (!view) return;
  const sel = view.state.selection;
  const prev = stacks.get(slot) ?? [];
  const results = sel.ranges.map((r, i) => shrinkSelection(prev[i] ?? emptyStack(), { from: r.from, to: r.to }));
  stacks.set(
    slot,
    results.map((r) => r.state),
  );
  if (!results.some((r) => r.next)) return;
  const ranges = results.map((r, i) => (r.next ? EditorSelection.range(r.next.from, r.next.to) : sel.ranges[i]!));
  view.dispatch({
    selection: EditorSelection.create(ranges, sel.mainIndex),
    scrollIntoView: true,
    userEvent: "select.shrink",
  });
}

// --- structural editing without a Lezer tree ------------------------------------------

const structureQueries = new WeakMap<DocModel, StructureQueries>();

function queriesFor(model: DocModel): StructureQueries {
  let q = structureQueries.get(model);
  if (!q) {
    q = cachedStructureQueries({
      stamp: () => model.changeCounter,
      synced: () => model.sync.whenIdle(),
      fetchRanges: (pos) => structure.structuralRanges(model.doc, pos),
      fetchErrors: () => structure.syntaxErrors(model.doc),
    });
    structureQueries.set(model, q);
  }
  return q;
}

async function hasStructure(language: string): Promise<boolean> {
  try {
    return (await structure.support(language)).tree;
  } catch {
    return false;
  }
}

/** Structural edits wait for the backend: run them in order so a quick ⇧⌘↑⇧⌘↑ moves twice. */
const editQueue = new WeakMap<EditorSlot, Promise<void>>();

function queueEdit(slot: EditorSlot, step: () => Promise<unknown>) {
  const next = (editQueue.get(slot) ?? Promise.resolve()).then(step).then(
    () => {},
    (e: unknown) => console.warn("structural edit failed", e),
  );
  editQueue.set(slot, next);
  return next;
}

/** Move Statement: the Lezer tree where there is one, else the tree-sitter structure, else the line. */
function moveStatement(view: EditorView, slot: EditorSlot, up: boolean) {
  const sel = view.state.selection;
  if (hasLezerTree(view.state) || sel.ranges.length > 1 || !sel.main.empty) {
    return up ? moveStatementUp(view) : moveStatementDown(view);
  }
  void queueEdit(slot, async () => {
    const v = slot.view;
    if (!v) return;
    const language = slot.model.getMeta().language;
    if ((await hasStructure(language)) && (await moveStatementStructural(v, up, queriesFor(slot.model))) !== "fallback")
      return;
    if (slot.view === v) (up ? moveLineUp : moveLineDown)(v);
  });
}

/**
 * Complete Current Statement: tree-sitter knows what is missing where (and
 * which multi-line statement the caret is in) for stream-mode languages, and
 * places Java's `;` better than the line heuristics; the heuristics finish the line.
 * With the completion lookup open, its selected item is inserted first (IDEA).
 */
function completeCurrentStatement(view: EditorView, slot: EditorSlot) {
  if (completionStatus(view.state) === "active") acceptCompletion(view);
  const language = slot.model.getMeta().language;
  const sel = view.state.selection;
  if ((hasLezerTree(view.state) && language !== "java") || sel.ranges.length > 1)
    return completeStatement(language)(view);
  void queueEdit(slot, async () => {
    const v = slot.view;
    if (!v || v.state.readOnly) return;
    if (
      (await hasStructure(language)) &&
      (await completeStatementStructural(v, language, queriesFor(slot.model))) !== "fallback"
    )
      return;
    if (slot.view === v) completeStatement(language)(v);
  });
}

/**
 * View › Context Info (⌃⇧Q / Alt+Q): the declaration lines around the caret
 * (class, method, block headers), most useful when they are scrolled away.
 */
function showContextInfo(view: EditorView) {
  const state = view.state;
  const line = state.doc.lineAt(state.selection.main.head).number;
  const headers = enclosingHeaders(state, line);
  const text = headers.map((n) => state.doc.line(n).text.trimEnd()).join("\n");
  void executeAction("editor.showHint", { text: text || "No context information here" });
}

/** Navigate › Custom Folding (⌥⌘.): the file's custom regions; picking one moves the caret to it. */
function showCustomRegions(view: EditorView) {
  const regions = customRegions(view.state);
  if (!regions.length) return void executeAction("editor.showHint", { text: "No custom folding regions in this file" });
  const head = view.state.selection.main.head;
  openPopup({
    kind: "list",
    anchor: caretAnchor(view, head),
    title: "Custom Folding Regions",
    items: regions.map((r) => ({
      id: String(r.startLine),
      label: r.name || "(no description)",
      detail: `:${r.startLine}`,
      icon: "folder",
      run: () => {
        const line = view.state.doc.line(Math.min(r.startLine, view.state.doc.lines));
        const at = line.from + /^\s*/.exec(line.text)![0].length;
        view.dispatch({
          selection: { anchor: at },
          effects: EditorView.scrollIntoView(at, { y: "start", yMargin: 40 }),
          userEvent: "select.navigate",
        });
        view.focus();
      },
    })),
  });
}

/** Folding › Expand to Level / Expand All to Level (titles kept literal for the text catalog). */
const FOLD_LEVELS: Array<[number, string, string]> = [
  [1, "Expand to Level 1", "Expand All to Level 1"],
  [2, "Expand to Level 2", "Expand All to Level 2"],
  [3, "Expand to Level 3", "Expand All to Level 3"],
  [4, "Expand to Level 4", "Expand All to Level 4"],
  [5, "Expand to Level 5", "Expand All to Level 5"],
];

function foldLevel(view: EditorView, level: number, all: boolean) {
  const effects = expandToLevelEffects(view.state, level, all);
  if (!effects.length) return;
  // A caret inside a new fold would unfold it again: it moves to the fold's start.
  const head = view.state.selection.main.head;
  const hiding = effects
    .filter((e) => e.is(foldEffect))
    .map((e) => e.value as { from: number; to: number })
    .filter((r) => r.from < head && head < r.to)
    .sort((a, b) => a.from - b.from)[0];
  view.dispatch({ effects, selection: hiding ? { anchor: hiding.from } : undefined });
}

function foldDocComments(view: EditorView, slot: EditorSlot, collapse: boolean) {
  return foldRegions(view, docCommentFolds(view.state, slot.model.info), collapse);
}

// --- cyclic expand word / copy reference ------------------------------------------------

/** Text of the other open documents for Cyclic Expand Word (bounded). */
function otherEditorTexts(current: EditorSlot): string[] {
  const out: string[] = [];
  const seen = new Set([current.model.path]);
  let budget = 4 * 1024 * 1024;
  for (const slot of editorController().slots.values()) {
    if (slot.disposed || seen.has(slot.model.path)) continue;
    seen.add(slot.model.path);
    const doc = slot.currentState().doc;
    if (doc.length > budget) continue;
    budget -= doc.length;
    out.push(doc.toString());
  }
  return out;
}

function expandWord(view: EditorView, slot: EditorSlot, direction: "backward" | "forward") {
  const message = cyclicExpandWord(view, direction, () => otherEditorTexts(slot));
  if (message) void executeAction("editor.showHint", { text: message });
}

async function resolveReference(view: EditorView, slot: EditorSlot): Promise<string> {
  const state = view.state;
  const selection = state.selection.main;
  const line = state.doc.lineAt(selection.from);
  const meta = slot.model.getMeta();
  const root = useProject.getState().project?.root ?? null;
  const fallback = qualifiedReference({
    language: meta.language,
    path: slot.model.path,
    root,
    text: "",
    chain: [],
    line: line.number - 1,
  });
  let reference = fallback;
  const offset = referenceOffset(state.doc.toString(), selection.from, selection.to);
  if (offset !== null) {
    const position = state.doc.lineAt(offset);
    const localChain = declarationChain(
      useOutline.getState()[slot.model.path] ?? [],
      position.number - 1,
      offset - position.from,
    ).filter((item) => item.kind !== "package");
    if (localChain.length) {
      reference = qualifiedReference({
        language: meta.language,
        path: slot.model.path,
        root,
        text: state.doc.toString(),
        chain: localChain.map(declaredName),
        line: position.number - 1,
      });
    } else {
      try {
        const targets = await lspRequest(() =>
          commands.lspGoto(meta.doc, { line: position.number - 1, col: offset - position.from }, "definition"),
        );
        if (targets.length === 1) {
          const target = targets[0]!;
          const [outline, lines] = await Promise.all([
            withDocument(target.path, (doc) => call(commands.docOutline(doc))),
            readFileLines(target.path),
          ]);
          const pos = target.range.start;
          const chain = declarationChain(outline, pos.line, pos.col).filter((item) => item.kind !== "package");
          const symbol = chain.at(-1);
          if (symbol && ["function", "method", "constructor"].includes(symbol.kind) && lines) {
            reference = qualifiedReference({
              language: meta.language,
              path: target.path,
              root,
              text: lines.join("\n"),
              chain: chain.map(declaredName),
              line: pos.line,
            });
          }
        }
      } catch {
        // No unambiguous definition is available; copy the current location.
      }
    }
  }
  return reference;
}

function copyReference(reference: Promise<string>) {
  const failed = (error: unknown) => {
    notifications().notify({
      level: "error",
      title: tx("Cannot copy reference"),
      body: error instanceof Error ? error.message : String(error),
    });
  };
  const copied = async () => {
    const text = await reference;
    recordClipboard(text);
    void executeAction("editor.showHint", { text: tx`Copied reference: ${text}` });
  };
  try {
    void copyReferenceToClipboard(reference).then(copied).catch(failed);
  } catch (error) {
    failed(error);
  }
}

/** `path:12`, or `path:12-18` for a selection over several lines. */
function pathWithLines(state: EditorState, path: string, kind: "relative" | "absolute" = "relative"): string {
  const { first, last } = selectedLines(state);
  return `${pathToCopy(kind, path)}:${first}${last > first ? `-${last}` : ""}`;
}

function copyPathReferencePopup(view: EditorView, slot: EditorSlot | null) {
  // The popup's items resolve against the open document; a notebook cell has none.
  if (!slot) return;
  const path = slot.model.path;
  const flavours = [
    { id: "project.copyAbsolutePath", label: "Absolute Path", value: pathToCopy("absolute", path) },
    {
      id: "editor.copyAbsolutePathWithLineNumber",
      label: "Absolute Path with line number",
      value: pathWithLines(view.state, path, "absolute"),
    },
    { id: "project.copyFileName", label: "File Name", value: pathToCopy("name", path) },
    { id: "project.copyRelativePath", label: "Path From Content Root", value: pathToCopy("relative", path) },
    { id: "project.copySourceRootPath", label: "Path From Source Root", value: pathToCopy("source", path) },
    {
      id: "editor.copyPathWithLineNumber",
      label: "Path with line number",
      value: pathWithLines(view.state, path),
    },
  ];
  const popup = copyPathPopup(
    caretAnchor(view, view.state.selection.main.head),
    flavours.map((f) => ({
      id: f.id,
      label: f.label,
      preview: f.value,
      run: () => {
        const lineNumbered =
          f.id === "editor.copyPathWithLineNumber" || f.id === "editor.copyAbsolutePathWithLineNumber";
        void executeAction(f.id, lineNumbered ? f.value : path);
      },
    })),
    { paths: [path], ...selectedLineContext(view.state) },
    [
      {
        id: "editor.copyReference",
        label: tx("Reference"),
        preview: tx("Resolving reference…"),
        disabled: tx("Resolving reference…"),
        shortcut: shortcutLabel("editor.copyReference"),
        run: () => {},
      },
    ],
  );
  openPopup(popup);
  void resolveReference(view, slot)
    .then((reference) => {
      if (useLspPopup.getState().popup !== popup) return;
      updatePopup("list", {
        items: popup.items.map((item) =>
          item.id === "editor.copyReference"
            ? {
                ...item,
                preview: reference,
                disabled: null,
                run: () => {
                  void executeAction(item.id, reference);
                },
              }
            : item,
        ),
      });
    })
    .catch(() => {
      if (useLspPopup.getState().popup === popup)
        updatePopup("list", {
          items: popup.items.map((item) =>
            item.id === "editor.copyReference"
              ? { ...item, preview: undefined, disabled: tx("Cannot copy reference") }
              : item,
          ),
        });
    });
}

function copyEditorPath(text: string) {
  void writeClipboardText(text)
    .then(() => {
      recordClipboard(text);
      void executeAction("editor.showHint", { text: tx`Copied ${text}` });
    })
    .catch((error: unknown) => {
      notifications().notify({
        level: "error",
        title: tx("Cannot access the clipboard"),
        body: error instanceof Error ? error.message : String(error),
      });
    });
}

/** ⌃G; when nothing more is found, a hint first and the search from the top on the next press (IDEA). */
function addNextOccurrence(view: EditorView) {
  if (nextOccurrence(view) === "notFound")
    void executeAction("editor.showHint", { text: "Not found, press again to search from the top" });
}

/** Settings › Editor › Color Scheme switches that are also toggle actions. */
type SchemeSwitch = "semanticHighlighting" | "rainbowBrackets";

export async function toggleSchemeSwitch(key: SchemeSwitch, on = !editorPrefs()[key]): Promise<void> {
  try {
    useProject.setState({ settings: await call(commands.settingsSet("global", `editor.${key}`, JSON.stringify(on))) });
  } catch (e) {
    notifications().notify({
      level: "error",
      title: "Cannot change the setting",
      body: e instanceof Error ? e.message : String(e),
    });
  }
}

const appearanceSwitch = (id: string, s: AppearanceSwitch, keywords: string[]): Action => ({
  id,
  title: s.title,
  category: "View",
  keywords,
  toggled: s.on,
  run: () => toggleAppearance(s),
});

const schemeSwitch = (id: string, title: string, key: SchemeSwitch, keywords: string[]): Action => ({
  id,
  title,
  category: "Editor",
  keywords,
  toggled: () => editorPrefs()[key],
  run: () => toggleSchemeSwitch(key),
});

// ---------------------------------------------------------------------------------

export function registerEditorActions(): () => void {
  const ctrl = editorController();
  const text = (
    id: string,
    title: string,
    run: (view: EditorView, slot: EditorSlot | null) => unknown,
    extra: Partial<Action> = {},
  ): Action => ({
    id,
    title,
    category: "Code",
    when: TEXT_WHEN,
    run: withView(run),
    ...extra,
  });
  /** A text action that also runs in a diff: on its editable side (`edit`) or on either side (`caret`). */
  const diffText =
    (editable: boolean) =>
    (id: string, title: string, run: (view: EditorView) => unknown, extra: Partial<Action> = {}): Action => ({
      ...text(id, title, run, extra),
      when: `${TEXT_WHEN} || diffEditorFocus`,
      run: withTextView(run, editable),
    });
  const edit = diffText(true);
  const caret = diffText(false);
  const activePaneTab = () => {
    const s = useTabs.getState();
    const pane = s.panes[s.activePane];
    return pane?.active ? { paneId: pane.id, tabId: pane.active } : null;
  };
  /**
   * A tab menu close item as a Window action on the active tab of the active group; `canClose`
   * mirrors when the menu disables or hides the item.
   */
  const closeTabs = (
    id: string,
    title: string,
    close: (paneId: string, tabId: string) => Promise<boolean>,
    canClose: (tabs: Tab[], index: number) => boolean = () => true,
  ): Action => ({
    id,
    title,
    category: "Window",
    when: TABS_WHEN,
    enabled: () => {
      const s = useTabs.getState();
      const pane = s.panes[s.activePane];
      const tabs = pane?.tabs ?? [];
      const index = tabs.findIndex((t) => t.id === pane?.active);
      return index >= 0 && canClose(tabs, index);
    },
    run: async () => {
      const t = activePaneTab();
      if (t) await close(t.paneId, t.tabId);
    },
  });
  /** The tab menu's Split and Move item for the active tab; a lone tab cannot leave its group. */
  const splitAndMove = (id: string, title: string, edge: SplitEdge): Action => ({
    id,
    title,
    category: "Window",
    when: TABS_WHEN,
    enabled: () => {
      const t = activePaneTab();
      return !!t && (useTabs.getState().panes[t.paneId]?.tabs.length ?? 0) > 1;
    },
    run: () => {
      const t = activePaneTab();
      if (t) ctrl.moveTabToSplit(t.paneId, t.tabId, t.paneId, edge);
    },
  });
  const occurrence = (id: string, title: string, run: (view: EditorView) => unknown): Action => ({
    id,
    title,
    category: "Edit",
    when: `${TEXT_WHEN} || diffEditorFocus || findBarFocus || findBarOpen && popupOpen && !toolWindowFocus`,
    run: ({ arg, ctx }) => {
      const view = typeof arg === "string" || ctx.findBarFocus ? findPanelTarget(arg)?.view() : null;
      if (view) {
        run(view);
        view.focus();
      } else withTextView(run, false)();
    },
  });
  return registerActions([
    schemeSwitch("editor.toggleSemanticHighlighting", "Semantic Highlighting", "semanticHighlighting", [
      "rainbow variables",
      "rainbow identifiers",
      "color scheme",
    ]),
    schemeSwitch("editor.toggleRainbowBrackets", "Rainbow Brackets", "rainbowBrackets", [
      "bracket pair colorization",
      "rainbow parentheses",
      "color scheme",
    ]),
    appearanceSwitch("editor.toggleLineNumbers", appearanceSwitches.lineNumbers, ["gutter", "hide line numbers"]),
    appearanceSwitch("editor.toggleIndentGuides", appearanceSwitches.indentGuides, ["indent lines", "indentation"]),
    appearanceSwitch("editor.toggleStickyLines", appearanceSwitches.stickyLines, ["sticky scroll"]),
    appearanceSwitch("editor.toggleWhitespaces", appearanceSwitches.whitespaces, [
      "render whitespace",
      "spaces",
      "tabs",
    ]),
    {
      id: "editor.toggleCodeVision",
      title: "Code Vision",
      category: "Editor",
      keywords: ["code lens", "usages", "code author", "git author", "inlay hints", "show", "hide"],
      toggled: codeVisionShown,
      run: () => toggleCodeVision(),
    },
    edit("code.commentLine", "Comment with Line Comment", (v) => commentLine(v)),
    edit("code.commentBlock", "Comment with Block Comment", (v) => commentBlock(v)),
    edit("code.duplicateLine", "Duplicate Line or Selection", (v) => duplicateLineOrSelection(v)),
    edit("code.duplicateEntireLines", "Duplicate Entire Lines", (v) => duplicateEntireLines(v)),
    edit("code.deleteLine", "Delete Line", (v) => deleteLine(v)),
    // Their keys (⌃K, ⇧⌘⌦) also edit a popup's text field, so they run only in a focused editor.
    edit("code.deleteToLineStart", "Delete to Line Start", (v) => deleteToLogicalLineStart(v), {
      category: "Editor Actions",
      keyWhen: "editorTextFocus || diffEditorFocus",
    }),
    edit("code.deleteToLineEnd", "Delete to Line End", (v) => deleteToLogicalLineEnd(v), {
      category: "Editor Actions",
      keyWhen: "editorTextFocus || diffEditorFocus",
    }),
    edit("code.cutLineEnd", "Cut up to Line End", (v) => cutToLineEnd(v), {
      category: "Editor Actions",
      keyWhen: "editorTextFocus || diffEditorFocus",
    }),
    edit("code.killToWordStart", "Kill to Word Start", (v) => killToWordStart(editorPrefs().smartKeys.camelHumps)(v), {
      category: "Editor Actions",
      keyWhen: "editorTextFocus || diffEditorFocus",
    }),
    edit("code.killToWordEnd", "Kill to Word End", (v) => killToWordEnd(editorPrefs().smartKeys.camelHumps)(v), {
      category: "Editor Actions",
      keyWhen: "editorTextFocus || diffEditorFocus",
    }),
    edit("code.hungryBackspace", "Hungry Backspace", (v) => hungryBackspace(v), {
      category: "Editor Actions",
      keyWhen: "editorTextFocus || diffEditorFocus",
    }),
    edit(
      "code.deleteToWordStartInDifferentHumpsMode",
      'Delete to Word Start in Different "CamelHumps" Mode',
      (v) => inDifferentHumpsMode("deleteToStart", editorPrefs().smartKeys.camelHumps)(v),
      { category: "Editor Actions", keyWhen: "editorTextFocus || diffEditorFocus" },
    ),
    edit(
      "code.deleteToWordEndInDifferentHumpsMode",
      'Delete to Word End in Different "CamelHumps" Mode',
      (v) => inDifferentHumpsMode("deleteToEnd", editorPrefs().smartKeys.camelHumps)(v),
      { category: "Editor Actions", keyWhen: "editorTextFocus || diffEditorFocus" },
    ),
    edit("code.moveLineUp", "Move Line Up", (v) => moveLineUp(v)),
    edit("code.moveLineDown", "Move Line Down", (v) => moveLineDown(v)),
    edit("code.moveElementLeft", "Move Element Left", (v) => moveElementLeft(v), {
      keywords: ["swap argument", "move parameter"],
    }),
    edit("code.moveElementRight", "Move Element Right", (v) => moveElementRight(v), {
      keywords: ["swap argument", "move parameter"],
    }),
    text("code.moveStatementUp", "Move Statement Up", (v, slot) => slot && moveStatement(v, slot, true)),
    text("code.moveStatementDown", "Move Statement Down", (v, slot) => slot && moveStatement(v, slot, false)),
    text(
      "code.extendSelection",
      "Extend Selection",
      (_v, slot) => {
        if (slot) void queueSelection(slot, extend);
      },
      {
        category: "Edit",
      },
    ),
    text(
      "code.shrinkSelection",
      "Shrink Selection",
      (_v, slot) => {
        if (slot) void queueSelection(slot, shrink);
      },
      {
        category: "Edit",
      },
    ),
    text("code.fold", "Collapse", (v) => foldAtCaret(v), { category: "Folding", keywords: ["fold"] }),
    text("code.unfold", "Expand", (v) => unfoldAtCaret(v), { category: "Folding", keywords: ["unfold"] }),
    text("code.foldToggle", "Toggle Fold", (v) => toggleFold(v), { category: "Folding" }),
    text("code.cyclicExpandWord", "Cyclic Expand Word", (v, slot) => slot && expandWord(v, slot, "backward"), {
      keywords: ["hippie", "complete word", "dabbrev"],
    }),
    text(
      "code.cyclicExpandWordBackward",
      "Cyclic Expand Word (Backward)",
      (v, slot) => slot && expandWord(v, slot, "forward"),
      {
        keywords: ["hippie", "complete word", "dabbrev"],
      },
    ),
    {
      id: "editor.copyReference",
      title: "Copy Reference",
      when: TEXT_WHEN,
      run: ({ arg }) => {
        if (typeof arg === "string") copyReference(Promise.resolve(arg));
        else withView((v, slot) => slot && copyReference(resolveReference(v, slot)))();
      },
      category: "Edit",
      keywords: ["fully qualified name", "fqn", "copy path"],
    },
    edit("code.pasteAsPlainText", "Paste as Plain Text", (v) => pasteAsPlainText(v), {
      category: "Edit",
      icon: "paste",
    }),
    // Copy once in the format Settings › Editor › General › Rich-Text Copy doesn't give.
    text("code.copyAsPlainText", "Copy as Plain Text", (v) => copyAs(v, "plain"), {
      category: "Edit",
      icon: "copy",
      keywords: ["without formatting", "rich text"],
    }),
    text("code.copyAsRichText", "Copy as Rich Text", (v) => copyAs(v, "rich"), {
      category: "Edit",
      icon: "copy",
      keywords: ["html", "syntax colors", "formatting"],
    }),
    {
      id: "editor.toggleSoftWrap",
      title: "Soft-Wrap",
      category: "View",
      icon: "soft-wrap",
      keywords: ["word wrap", "line wrap"],
      when: "textEditorActive || softWrapSurfaceFocus",
      // Cell editors wrap always; without the cell the setting is the active text tab's.
      toggled: () =>
        focusedSoftWrapSurface()?.enabled() ??
        (focusedCellEditor() ? true : (activeSlot()?.model.softWrapOn() ?? false)),
      run: () => {
        // Don't flip the last text tab's setting while a notebook cell has focus.
        if (focusedCellEditor()) return;
        const surface = focusedSoftWrapSurface();
        if (surface) surface.toggle();
        else activeSlot()?.model.toggleSoftWrap();
      },
    },
    {
      id: "editor.toggleRenderedDocs",
      title: "Render Documentation Comments",
      category: "View",
      keywords: ["render documentation comments", "javadoc", "rendered doc", "comments"],
      when: "textEditorActive",
      toggled: () => (focusedCellEditor() ? false : (activeSlot()?.model.renderedDocsOn() ?? false)),
      run: () => {
        // Notebook cells have no doc-comment rendering: leave it, don't toggle the last text tab's.
        if (focusedCellEditor()) return;
        activeSlot()?.model.toggleRenderedDocs();
      },
    },
    text("editor.toggleRenderedView", "Toggle Rendered View", (v) => toggleRenderedViewAtCaret(v), {
      category: "View",
      keywords: ["reader mode", "render documentation comment", "javadoc", "edit comment"],
    }),
    text("code.foldAll", "Collapse All", (v) => collapseAll(v), { category: "Folding", icon: "collapse-all" }),
    text("code.unfoldAll", "Expand All", (v) => expandAll(v), { category: "Folding", icon: "expand-all" }),
    text("code.expandDocComments", "Expand Doc Comments", (v, slot) => slot && foldDocComments(v, slot, false), {
      category: "Folding",
      keywords: ["unfold", "documentation comments", "javadoc"],
    }),
    text("code.collapseDocComments", "Collapse Doc Comments", (v, slot) => slot && foldDocComments(v, slot, true), {
      category: "Folding",
      keywords: ["fold", "documentation comments", "javadoc"],
    }),
    text("code.collapseRecursively", "Collapse Recursively", (v) => collapseRecursively(v), {
      category: "Folding",
      keywords: ["fold"],
    }),
    text("code.expandRecursively", "Expand Recursively", (v) => expandRecursively(v), {
      category: "Folding",
      keywords: ["unfold"],
    }),
    occurrence("code.addCaretNextOccurrence", "Add Selection for Next Occurrence", addNextOccurrence),
    occurrence("code.selectAllOccurrences", "Select All Occurrences", selectAllOccurrences),
    text(
      "code.completeStatement",
      "Complete Current Statement",
      (v, slot) => slot && completeCurrentStatement(v, slot),
    ),
    edit("code.startNewLine", "Start New Line", (v) => startNewLine(v)),
    edit("code.startNewLineBefore", "Start New Line Before Current", (v) => startNewLineBefore(v)),
    edit("code.splitLine", "Split Line", (v) => splitLine(v)),
    caret("editor.scrollToCenter", "Scroll to Center", (v) => scrollToCenter(v), { category: "Editor Actions" }),
    caret("editor.scrollUp", "Scroll Up", (v) => scrollUp(v), { category: "Editor Actions" }),
    caret("editor.scrollDown", "Scroll Down", (v) => scrollDown(v), { category: "Editor Actions" }),
    caret("editor.scrollLeft", "Scroll Left", (v) => scrollLeft(v), { category: "Editor Actions" }),
    caret("editor.scrollRight", "Scroll Right", (v) => scrollRight(v), { category: "Editor Actions" }),
    caret("editor.scrollUpAndMove", "Scroll Up and Move if Necessary", (v) => scrollUpAndMove(v), {
      category: "Editor Actions",
    }),
    caret("editor.scrollDownAndMove", "Scroll Down and Move if Necessary", (v) => scrollDownAndMove(v), {
      category: "Editor Actions",
    }),
    caret("editor.moveUpAndScroll", "Move Up and Scroll", (v) => moveUpAndScroll(v), { category: "Editor Actions" }),
    caret("editor.moveDownAndScroll", "Move Down and Scroll", (v) => moveDownAndScroll(v), {
      category: "Editor Actions",
    }),
    caret(
      "editor.moveUpAndScrollWithSelection",
      "Move Up and Scroll with Selection",
      (v) => moveUpAndScrollWithSelection(v),
      { category: "Editor Actions" },
    ),
    caret(
      "editor.moveDownAndScrollWithSelection",
      "Move Down and Scroll with Selection",
      (v) => moveDownAndScrollWithSelection(v),
      { category: "Editor Actions" },
    ),
    caret("editor.scrollToTop", "Scroll to Top", (v) => scrollToTop(v), { category: "Editor Actions" }),
    caret("editor.scrollToBottom", "Scroll to Bottom", (v) => scrollToBottom(v), { category: "Editor Actions" }),
    caret("editor.moveToPageTop", "Move Caret to Page Top", (v) => cursorPageTop(v), { category: "Editor Actions" }),
    caret("editor.moveToPageBottom", "Move Caret to Page Bottom", (v) => cursorPageBottom(v), {
      category: "Editor Actions",
    }),
    caret("editor.moveToPageTopWithSelection", "Move Caret to Page Top with Selection", (v) => selectPageTop(v), {
      category: "Editor Actions",
    }),
    caret(
      "editor.moveToPageBottomWithSelection",
      "Move Caret to Page Bottom with Selection",
      (v) => selectPageBottom(v),
      { category: "Editor Actions" },
    ),
    caret("editor.codeBlockStart", "Move Caret to Code Block Start", (v) => cursorCodeBlockStart(v), {
      category: "Editor Actions",
    }),
    caret("editor.codeBlockEnd", "Move Caret to Code Block End", (v) => cursorCodeBlockEnd(v), {
      category: "Editor Actions",
    }),
    caret(
      "editor.codeBlockStartWithSelection",
      "Move Caret to Code Block Start with Selection",
      (v) => selectCodeBlockStart(v),
      { category: "Editor Actions" },
    ),
    caret(
      "editor.codeBlockEndWithSelection",
      "Move Caret to Code Block End with Selection",
      (v) => selectCodeBlockEnd(v),
      {
        category: "Editor Actions",
      },
    ),
    caret("editor.paragraphForward", "Move Caret Forward a Paragraph", (v) => cursorParagraphForward(v), {
      category: "Editor Actions",
    }),
    caret("editor.paragraphBackward", "Move Caret Backward a Paragraph", (v) => cursorParagraphBackward(v), {
      category: "Editor Actions",
    }),
    caret(
      "editor.paragraphForwardWithSelection",
      "Move Caret Forward a Paragraph with Selection",
      (v) => selectParagraphForward(v),
      { category: "Editor Actions" },
    ),
    caret(
      "editor.paragraphBackwardWithSelection",
      "Move Caret Backward a Paragraph with Selection",
      (v) => selectParagraphBackward(v),
      { category: "Editor Actions" },
    ),
    caret(
      "editor.nextWordInDifferentHumpsMode",
      'Move Caret to Next Word in Different "CamelHumps" Mode',
      (v) =>
        inDifferentHumpsMode(
          isStickySelection(v.state) ? "selectRight" : "right",
          editorPrefs().smartKeys.camelHumps,
        )(v),
      { category: "Editor Actions" },
    ),
    caret(
      "editor.previousWordInDifferentHumpsMode",
      'Move Caret to Previous Word in Different "CamelHumps" Mode',
      (v) =>
        inDifferentHumpsMode(isStickySelection(v.state) ? "selectLeft" : "left", editorPrefs().smartKeys.camelHumps)(v),
      { category: "Editor Actions" },
    ),
    caret(
      "editor.nextWordInDifferentHumpsModeWithSelection",
      'Move Caret to Next Word in Different "CamelHumps" Mode with Selection',
      (v) => inDifferentHumpsMode("selectRight", editorPrefs().smartKeys.camelHumps)(v),
      { category: "Editor Actions" },
    ),
    caret(
      "editor.previousWordInDifferentHumpsModeWithSelection",
      'Move Caret to Previous Word in Different "CamelHumps" Mode with Selection',
      (v) => inDifferentHumpsMode("selectLeft", editorPrefs().smartKeys.camelHumps)(v),
      { category: "Editor Actions" },
    ),
    text("editor.contextInfo", "Context Info", (v) => showContextInfo(v), {
      category: "View",
      keywords: ["enclosing method", "enclosing class", "where am I"],
    }),
    text("navigate.customRegion", "Custom Folding…", (v) => showCustomRegions(v), {
      category: "Navigate",
      keywords: ["region", "editor-fold", "go to region"],
    }),
    ...FOLD_LEVELS.flatMap(([level, one, all]) => [
      text(`code.expandToLevel${level}`, one, (v) => foldLevel(v, level, false), {
        category: "Folding",
        keywords: ["unfold", "fold level"],
      }),
      text(`code.expandAllToLevel${level}`, all, (v) => foldLevel(v, level, true), {
        category: "Folding",
        keywords: ["unfold", "fold level"],
      }),
    ]),
    text("code.collapseBlock", "Fold Code Block", (v) => collapseBlock(v), { category: "Folding", keywords: ["fold"] }),
    edit("code.autoIndentLines", "Auto-Indent Lines", (v) => !v.state.readOnly && indentSelection(v), {
      keywords: ["reindent", "fix indentation"],
    }),
    {
      id: "editor.addOrRemoveCaret",
      title: "Add or Remove Caret",
      category: "Editor Actions",
      when: "textEditorActive",
      hidden: true,
      // The mouse selection style handles the pointer position and dragging.
      run: () => {},
    },
    {
      id: "editor.createRectangularSelectionOnMouseDrag",
      title: "Create Rectangular Selection on Mouse Drag",
      category: "Editor Actions",
      when: "textEditorActive",
      hidden: true,
      keymap: true,
      // The mouse selection style owns the drag; invoking the action alone is harmless.
      run: () => {},
    },
    caret("editor.cloneCaretAbove", "Clone Caret Above", (v) => cloneCaretAbove(v), { category: "Editor Actions" }),
    caret("editor.cloneCaretBelow", "Clone Caret Below", (v) => cloneCaretBelow(v), { category: "Editor Actions" }),
    text("editor.matchBrace", "Move Caret to Matching Brace", (v) => cursorMatchBrace(v), {
      category: "Editor Actions",
      // ⌃M is Show Commit Message History in the commit window.
      keyWhen: "editorTextFocus",
    }),
    text("editor.toggleInsertState", "Toggle Insert/Overwrite", (v) => toggleOverwrite(v), {
      category: "Editor Actions",
      keywords: ["overwrite mode", "overtype"],
      toggled: () => {
        const view = focusedCellEditor() ?? activeSlot()?.view;
        return view ? isOverwrite(view.state) : false;
      },
    }),
    text("editor.toggleStickySelection", "Toggle Sticky Selection", (v) => toggleStickySelection(v), {
      category: "Editor Actions",
      keywords: ["set mark", "selection mode"],
      toggled: () => {
        const view = focusedCellEditor() ?? activeSlot()?.view;
        return view ? isStickySelection(view.state) : false;
      },
    }),
    edit("code.joinLines", "Join Lines", (v) => joinLines(v)),
    edit("code.toggleCase", "Toggle Case", (v) => toggleCase(v), { keywords: ["upper", "lower"] }),
    edit("code.transpose", "Transpose", (v) => transpose(v), { category: "Editor Actions" }),
    edit("code.cycleCase", "Cycle Identifier Case", (v) => cycleCase(v), {
      keywords: ["camel", "snake", "kebab", "pascal", "screaming"],
    }),
    caret("code.addCaretsToLineEnds", "Add Carets to Ends of Selected Lines", (v) => addCaretsToLineEnds(v), {
      category: "Edit",
    }),
    caret("editor.swapSelectionBoundaries", "Swap Selection Boundaries", (v) => swapSelectionBoundaries(v), {
      category: "Editor Actions",
      keywords: ["anchor", "exchange point and mark"],
    }),
    caret("editor.selectLine", "Select Line at Caret", (v) => selectLineAtCaret(v), { category: "Editor Actions" }),
    occurrence("code.unselectOccurrence", "Unselect Occurrence", unselectOccurrence),
    text("code.pasteFromHistory", "Paste from History…", (v) => pasteFromHistory(v), {
      category: "Edit",
      keywords: ["clipboard", "paste multiple"],
    }),
    edit("code.sortLines", "Sort Lines", (v) => sortLines(v), { category: "Edit" }),
    edit("code.reverseLines", "Reverse Lines", (v) => reverseLines(v), { category: "Edit" }),
    edit("code.uniqueLines", "Delete Duplicate Lines", (v) => uniqueLines(v), {
      category: "Edit",
      keywords: ["unique", "dedupe", "remove duplicates"],
    }),
    text(
      "code.fillParagraph",
      "Fill Paragraph",
      (v, slot) => slot && fillParagraph(v, hardWrapAt(slot.model.settings(), slot.model.info)),
      {
        category: "Edit",
        keywords: ["wrap", "reflow", "rewrap comment"],
      },
    ),
    edit("code.convertIndentsToSpaces", "Convert Indents to Spaces", (v) => convertIndentsToSpaces(v), {
      category: "Edit",
      keywords: ["tabs", "indentation"],
    }),
    edit("code.convertIndentsToTabs", "Convert Indents to Tabs", (v) => convertIndentsToTabs(v), {
      category: "Edit",
      keywords: ["spaces", "indentation"],
    }),
    text(
      "code.unwrap",
      "Unwrap/Remove…",
      (_v, slot) => {
        if (slot) void unwrapAtCaret(slot);
      },
      {
        keywords: ["unwrap", "remove if"],
      },
    ),
    text("code.foldSelection", "Fold Selection / Remove Region", (v) => foldSelection(v), { category: "Folding" }),
    {
      id: "editor.toggleColumnSelection",
      title: "Column Selection Mode",
      category: "Edit",
      keywords: ["block selection", "rectangular selection"],
      when: "textEditorActive",
      toggled: () => {
        const view = focusedCellEditor() ?? activeSlot()?.view;
        return view ? isColumnMode(view.state) : false;
      },
      run: withView((v) => toggleColumnMode(v)),
    },
    {
      id: "file.reloadFromDisk",
      title: "Reload from Disk",
      category: "File",
      icon: "refresh",
      when: "projectOpen",
      keywords: ["synchronize", "refresh", "revert"],
      run: ({ arg }) => {
        const paths =
          typeof arg === "string"
            ? [arg]
            : Array.isArray(arg)
              ? arg.filter((p): p is string => typeof p === "string")
              : [];
        const active = ctrl.activePath();
        return ctrl.reloadFromDisk(paths.length ? paths : active ? [active] : []);
      },
    },
    {
      // IDEA's Synchronize: open documents without unsaved changes, the project tree and VCS status.
      id: "file.reloadAllFromDisk",
      title: "Reload All from Disk",
      category: "File",
      icon: "refresh",
      when: "projectOpen",
      keywords: ["synchronize", "refresh"],
      run: async () => {
        const meta = useDocMeta.getState();
        await ctrl.reloadFromDisk(ctrl.openPaths().filter((p) => !meta[p]?.dirty));
        void executeAction("project.refresh");
        void executeAction("vcs.refresh");
      },
    },
    {
      id: "editor.resetFontSize",
      title: "Reset Font Size",
      category: "View",
      keywords: ["zoom", "font size", "mouse wheel"],
      when: "projectOpen || lightEdit",
      run: resetFontSize,
    },
    {
      id: "editor.resetFontSizeAll",
      title: "Reset Font Size in All Editors",
      category: "View",
      keywords: ["zoom", "font size", "mouse wheel"],
      when: "projectOpen",
      run: resetAllFontSize,
    },
    {
      id: "editor.increaseFontSizeAll",
      title: "Increase Font Size in All Editors",
      category: "View",
      keywords: ["zoom", "font size"],
      when: "projectOpen",
      run: () => stepEveryEditorFontZoom(focusedCellEditor() ?? activeSlot()?.view ?? null, 1),
    },
    {
      id: "editor.decreaseFontSizeAll",
      title: "Decrease Font Size in All Editors",
      category: "View",
      keywords: ["zoom", "font size"],
      when: "projectOpen",
      run: () => stepEveryEditorFontZoom(focusedCellEditor() ?? activeSlot()?.view ?? null, -1),
    },
    {
      id: "editor.increaseFontSize",
      title: "Increase Font Size",
      category: "View",
      keywords: ["zoom", "font size"],
      when: "projectOpen",
      run: () => stepSurfaceFontSize(1),
    },
    {
      id: "editor.decreaseFontSize",
      title: "Decrease Font Size",
      category: "View",
      keywords: ["zoom", "font size"],
      when: "projectOpen",
      run: () => stepSurfaceFontSize(-1),
    },
    {
      id: "file.toggleReadOnly",
      title: "Toggle Read-only Attribute",
      category: "File",
      keywords: ["make file writable", "make file read-only", "lock"],
      when: "textEditorActive",
      run: () => {
        const slot = activeSlot();
        // A notebook has no document model to toggle: leave it rather than the last text tab's file.
        if (slot && !focusedCellEditor()) toggleReadOnly(slot.model);
      },
    },
    {
      id: "find.openInWindow",
      title: "Open Results in Find Window",
      category: "Find",
      when: "findBarHasResults",
      keyWhen: "findBarFocus",
      run: ({ arg }) => openFindBarResults(arg),
    },
    {
      id: "find.scrollToResults",
      title: "Scroll to Results During Typing",
      category: "Find",
      when: "findBarOpen",
      toggled: () => useFindPreferences.getState().scrollToResults,
      run: () => useFindPreferences.setState((s) => ({ scrollToResults: !s.scrollToResults })),
    },
    {
      id: "find.inFile",
      title: "Find",
      category: "Find",
      icon: "search",
      when: EDITOR_WHEN,
      run: () => openFindBar(useTabs.getState().activePane, false),
    },
    {
      id: "find.replaceInFile",
      title: "Replace",
      category: "Find",
      icon: "replace",
      when: EDITOR_WHEN,
      run: () => openFindBar(useTabs.getState().activePane, true),
    },
    {
      id: "find.next",
      title: "Find Next Occurrence",
      category: "Find",
      icon: "arrow-down",
      when: EDITOR_WHEN,
      run: () => findAgain(useTabs.getState().activePane, true),
    },
    {
      id: "find.previous",
      title: "Find Previous Occurrence",
      category: "Find",
      icon: "arrow-up",
      when: EDITOR_WHEN,
      run: () => findAgain(useTabs.getState().activePane, false),
    },
    {
      id: "find.wordAtCaret",
      title: "Find Word at Caret",
      category: "Find",
      when: EDITOR_WHEN,
      run: () => findWordAtCaretInPane(useTabs.getState().activePane, true),
    },
    {
      id: "find.previousWordAtCaret",
      title: "Find Previous Word at Caret",
      category: "Find",
      when: EDITOR_WHEN,
      run: () => findWordAtCaretInPane(useTabs.getState().activePane, false),
    },
    {
      id: "navigate.gotoLine",
      title: "Go to Line:Column…",
      category: "Navigate",
      when: EDITOR_WHEN,
      run: () => useGotoLine.setState({ open: true }),
    },
    {
      id: "navigate.back",
      title: "Back",
      category: "Navigate",
      icon: "arrow-left",
      run: () => ctrl.back(),
    },
    {
      id: "navigate.forward",
      title: "Forward",
      category: "Navigate",
      icon: "arrow-right",
      run: () => ctrl.forward(),
    },
    {
      id: "navigate.navigationBar",
      title: "Jump to Navigation Bar",
      category: "Navigate",
      keywords: ["breadcrumbs"],
      when: "projectOpen",
      // ⌘↑ / ⌘↓ inside a popup (Search Everywhere's previous / next group) stay with it.
      keyWhen: "!popupOpen",
      run: () => openNavBarPopup(),
    },
    {
      id: "navigate.lastEditLocation",
      title: "Last Edit Location",
      category: "Navigate",
      when: "projectOpen",
      run: () => void ctrl.lastEditLocation(),
    },
    {
      id: "navigate.nextEditLocation",
      title: "Next Edit Location",
      category: "Navigate",
      when: "projectOpen",
      run: () => void ctrl.nextEditLocation(),
    },
    {
      id: "editor.closeTab",
      title: "Close Tab",
      category: "Window",
      icon: "close",
      when: "(editorTabsOpen || editorSplit) && !toolWindowFocus",
      run: async () => {
        await ctrl.closeActiveTab();
      },
    },
    {
      id: "editor.closeOtherTabs",
      title: "Close Other Tabs",
      category: "Window",
      when: TABS_WHEN,
      run: async () => {
        const t = activePaneTab();
        if (t) await ctrl.closeOthers(t.paneId, t.tabId);
      },
    },
    {
      id: "editor.closeAllTabs",
      title: "Close All Tabs",
      category: "Window",
      when: "editorTabsOpen",
      run: async () => {
        await ctrl.closeEverything();
      },
    },
    closeTabs("editor.closeUnmodifiedTabs", "Close Unmodified Tabs", (pane) => ctrl.closeUnmodified(pane)),
    // Without a pinned tab this would be Close All; IDEA disables it, the tab menu hides it.
    closeTabs(
      "editor.closeAllButPinned",
      "Close All but Pinned",
      (pane) => ctrl.closeAll(pane, true),
      (tabs) => tabs.some((t) => t.pinned),
    ),
    closeTabs(
      "editor.closeTabsToLeft",
      "Close Tabs to the Left",
      (pane, tab) => ctrl.closeToLeft(pane, tab),
      (_tabs, index) => index > 0,
    ),
    closeTabs(
      "editor.closeTabsToRight",
      "Close Tabs to the Right",
      (pane, tab) => ctrl.closeToRight(pane, tab),
      (tabs, index) => index < tabs.length - 1,
    ),
    closeTabs(
      "editor.closeReadOnlyTabs",
      "Close All Read-Only Tabs",
      (pane) => ctrl.closeReadOnly(pane),
      (tabs) => tabs.some((t) => !t.pinned && !!t.input.path && useDocMeta.getState()[t.input.path]?.readOnly),
    ),
    {
      id: "editor.pinTab",
      title: "Pin / Unpin Tab",
      category: "Window",
      icon: "pin",
      // IDEA: in a focused tool window, its selected content tab (Find, Usages).
      when: "editorTabsOpen || toolWindowFocus",
      run: () => {
        const tw = useToolWindowLayout.getState().focused;
        if (tw) return void togglePinSelectedContent(tw);
        const t = activePaneTab();
        if (t) ctrl.togglePin(t.paneId, t.tabId);
      },
    },
    {
      id: "editor.reopenClosedTab",
      title: "Reopen Closed Tab",
      category: "Window",
      run: () => ctrl.reopenClosed(),
    },
    { id: "editor.nextTab", title: "Select Next Tab", category: "Window", when: TABS_WHEN, run: () => ctrl.cycle(1) },
    {
      id: "editor.prevTab",
      title: "Select Previous Tab",
      category: "Window",
      when: TABS_WHEN,
      run: () => ctrl.cycle(-1),
    },
    {
      id: "editor.splitRight",
      title: "Split Right",
      category: "Window",
      icon: "split",
      when: "editorTabsOpen",
      run: () => ctrl.split(useTabs.getState().activePane, "row"),
    },
    {
      id: "editor.splitDown",
      title: "Split Down",
      category: "Window",
      icon: "split-horizontal",
      when: "editorTabsOpen",
      run: () => ctrl.split(useTabs.getState().activePane, "column"),
    },
    splitAndMove("editor.splitAndMoveRight", "Split and Move Right", "right"),
    splitAndMove("editor.splitAndMoveDown", "Split and Move Down", "bottom"),
    {
      id: "editor.nextSplitter",
      title: "Go to Next Splitter",
      category: "Window",
      keywords: ["split", "editor group", "pane"],
      when: "editorSplit",
      run: () => ctrl.focusSplitter(1),
    },
    {
      id: "editor.prevSplitter",
      title: "Go to Previous Splitter",
      category: "Window",
      keywords: ["split", "editor group", "pane"],
      when: "editorSplit",
      run: () => ctrl.focusSplitter(-1),
    },
    {
      id: "editor.moveToOppositeGroup",
      title: "Move to Opposite Group",
      category: "Window",
      when: "editorSplit",
      run: () => {
        const t = activePaneTab();
        if (t) ctrl.moveToOpposite(t.paneId, t.tabId);
      },
    },
    {
      id: "editor.unsplit",
      title: "Unsplit",
      category: "Window",
      when: "editorSplit",
      run: async () => {
        await ctrl.unsplit(useTabs.getState().activePane);
      },
    },
    {
      id: "editor.unsplitAll",
      title: "Unsplit All",
      category: "Window",
      when: "editorSplit",
      run: () => void ctrl.unsplitAll(useTabs.getState().activePane),
    },
    {
      id: "editor.changeSplitOrientation",
      title: "Change Splitter Orientation",
      category: "Window",
      when: "editorSplit",
      run: () => ctrl.changeSplitOrientation(useTabs.getState().activePane),
    },
    {
      id: "editor.openInOppositeGroup",
      title: "Open in Opposite Group",
      category: "Window",
      when: TABS_WHEN,
      run: () => {
        const t = activePaneTab();
        if (t) ctrl.openInOpposite(t.paneId, t.tabId);
      },
    },
    {
      id: "editor.copyPath",
      title: "Absolute Path",
      category: "Edit",
      icon: "copy",
      when: "textEditorActive",
      // ⇧⌘C / Ctrl+Shift+C stays with the terminal (copy) and other tool windows.
      keyWhen: "editorFocus || !toolWindowFocus",
      run: () => {
        const p = ctrl.activePath();
        if (p) copyEditorPath(pathToCopy("absolute", p) ?? p);
      },
    },
    {
      id: "editor.copyPathReference",
      title: "Copy Path/Reference…",
      category: "Edit",
      icon: "copy",
      when: "textEditorActive",
      keyWhen: "editorFocus || !toolWindowFocus",
      run: withView(copyPathReferencePopup),
    },
    {
      id: "editor.copyPathWithLineNumber",
      title: "Copy Path with Line Number",
      category: "Edit",
      when: TEXT_WHEN,
      run: ({ arg }) => {
        if (typeof arg === "string") copyEditorPath(arg);
        else withView((view, slot) => slot && copyEditorPath(pathWithLines(view.state, slot.model.path)))();
      },
    },
    {
      id: "editor.copyAbsolutePathWithLineNumber",
      title: "Copy Absolute Path with Line Number",
      category: "Edit",
      when: TEXT_WHEN,
      run: ({ arg }) => {
        if (typeof arg === "string") copyEditorPath(arg);
        else withView((view, slot) => slot && copyEditorPath(pathWithLines(view.state, slot.model.path, "absolute")))();
      },
    },
    {
      id: "file.save",
      title: "Save All",
      category: "File",
      keywords: ["save"],
      run: () => ctrl.saveAll(),
    },
  ]);
}
