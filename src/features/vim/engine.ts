/**
 * The Vim emulation itself (@replit/codemirror-vim), loaded only once Vim mode
 * is turned on: the per-editor extension, OpenIDEA's Ex commands (`:w`, `:q`,
 * `:action`) and applying the rc file.
 */
import { EditorState, Prec, StateEffect, StateField, Transaction, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, runScopeHandlers } from "@codemirror/view";
import { Vim, getCM, vim } from "@replit/codemirror-vim";
import { transientChange } from "@/editor/api";
import { executeAction, getAction } from "@/platform/actions";
import { showStatusInfo } from "@/workbench/contributions";
import { VIM_EDITOR_ATTR } from "./conflicts";
import { useVimMode, type VimModeState } from "./mode";
import { resolveActionId, type RcCommand } from "./rc";

/** Insert/Replace state as seen by transactions (mode changes are queued). */
const setVimInsert = StateEffect.define<boolean>();

const vimInsert = StateField.define<boolean>({
  // Vim starts in Normal mode.
  create: () => false,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setVimInsert)) value = e.value;
    return value;
  },
});

interface ImeComposition {
  /** Start of the selection the composition replaced. */
  from: number;
  /** Selection contents replaced by the composition. */
  before: string;
  /** Selection before the composition, to restore it afterwards. */
  selection: { anchor: number; head: number };
  /** Last change CodeMirror read from the composing DOM. */
  last: { from: number; text: string } | null;
  /** The text the IME committed. */
  ended: string | null;
  timer: ReturnType<typeof setTimeout> | undefined;
}

const imeCompositions = new WeakMap<EditorView, ImeComposition>();

/**
 * codemirror-vim only discards single-character IME commits in Normal mode, so
 * Chinese pinyin (often several characters) is written to the document. Let the
 * IME and CodeMirror own the composition normally, then drop its net change:
 * the preedit is temporary, an ASCII commit (dead keys) is replayed as a Vim
 * key, and text commits (CJK, words) are discarded. The changes are marked
 * transient, keeping them out of undo and the document model.
 */
function finishImeComposition(view: EditorView) {
  const composition = imeCompositions.get(view);
  if (!composition) return;
  imeCompositions.delete(view);
  clearTimeout(composition.timer);
  const cm = getCM(view);
  if (!cm) return;
  const insert = !!cm.state.vim?.insertMode;
  const { last, before, selection, ended } = composition;
  let cleaned = false;
  if (last && last.text.length > 0) {
    const to = last.from + last.text.length;
    if (view.state.sliceDoc(last.from, to) === last.text) {
      view.dispatch({
        changes: { from: last.from, to, insert: before },
        selection,
        annotations: [Transaction.addToHistory.of(false), transientChange.of(true)],
      });
      cleaned = true;
    }
  } else if (before && view.state.sliceDoc(composition.from, composition.from + before.length) !== before) {
    // The IME cancelled after the preedit had already been removed.
    view.dispatch({
      changes: { from: composition.from, insert: before },
      selection,
      annotations: [Transaction.addToHistory.of(false), transientChange.of(true)],
    });
    cleaned = true;
  }
  const main = view.state.selection.main;
  if (!cleaned && (main.anchor !== selection.anchor || main.head !== selection.head)) {
    view.dispatch({ selection, annotations: transientChange.of(true) });
  }
  // Dead keys and ASCII compositions are Vim commands (`^`, `` ` ``, letters);
  // CJK commits are text and must not move the cursor or consume a pending operator.
  if (!insert && ended?.length === 1 && ended.charCodeAt(0) < 0x80) Vim.handleKey(cm, ended, "user");
}

const imeHandlers = EditorView.domEventHandlers({
  compositionstart(e, view) {
    if (typeof e.data !== "string") return false;
    const cm = getCM(view);
    if (!cm?.state.vim || cm.state.vim.insertMode) return false;
    const previous = imeCompositions.get(view);
    if (previous) clearTimeout(previous.timer);
    const range = view.state.selection.main;
    imeCompositions.set(view, {
      from: range.from,
      before: view.state.sliceDoc(range.from, range.to),
      selection: { anchor: range.anchor, head: range.head },
      last: null,
      ended: null,
      timer: undefined,
    });
    return false;
  },
  compositionupdate(_e, view) {
    if (!imeCompositions.has(view)) return false;
    const cm = getCM(view);
    if (cm?.state.vim && !cm.state.vim.insertMode && cm.state.vimPlugin) {
      // Keep codemirror-vim's single-character path from calling its
      // forceEndComposition() while we let the browser compose normally.
      cm.state.vimPlugin.useNextTextInput = false;
    }
    return false;
  },
  compositionend(e, view) {
    const composition = imeCompositions.get(view);
    // Ignore the untrusted, data-less event codemirror-vim synthesises when it
    // force-ends a composition; real ends (even cancelled ones) are trusted.
    if (!composition || (typeof e.data !== "string" && !e.isTrusted)) return false;
    composition.ended = typeof e.data === "string" ? e.data : "";
    clearTimeout(composition.timer);
    composition.timer = setTimeout(() => finishImeComposition(view), 0);
    return false;
  },
});

/** Let CodeMirror apply the composing text; it is removed when the IME ends. */
const imeInput = EditorView.inputHandler.of((view, from, _to, text) => {
  const composition = imeCompositions.get(view);
  if (!composition) return false;
  const cm = getCM(view);
  if (cm?.state.vim && !cm.state.vim.insertMode && cm.state.vimPlugin) {
    cm.state.vimPlugin.useNextTextInput = false;
  }
  composition.last = { from, text };
  return false;
});

/** Remember the net change of the composition, including commits CodeMirror
 * reports after `compositionend`. */
const imeTracker = ViewPlugin.define((view) => ({
  update(update) {
    const composition = imeCompositions.get(view);
    if (!composition) return;
    for (const tr of update.transactions) {
      if (!tr.docChanged || !tr.isUserEvent("input.type.compose")) continue;
      tr.changes.iterChanges((_fromA, _toA, fromB, _toB, inserted) => {
        composition.last = { from: fromB, text: inserted.toString() };
      });
    }
  },
}));

/** Composition changes are temporary: no undo entry, no document/backend sync. */
const imeTransactions = EditorState.transactionExtender.of((tr) =>
  !tr.startState.field(vimInsert) && tr.isUserEvent("input.type.compose")
    ? { annotations: [Transaction.addToHistory.of(false), transientChange.of(true)] }
    : null,
);

const imeCleanup = ViewPlugin.define((view) => ({
  destroy() {
    const composition = imeCompositions.get(view);
    if (composition) {
      clearTimeout(composition.timer);
      imeCompositions.delete(view);
    }
  },
}));

/**
 * IdeaVim's Escape: an open popup, lookup, find bar or template closes first
 * (the editor's Escape key bindings); Vim only gets Escape that nothing else
 * wanted. In Visual mode Escape always leaves Visual mode.
 */
const escapeClosesPopupsFirst = EditorView.domEventHandlers({
  keydown(e, view) {
    if (e.key !== "Escape" || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return false;
    if (getCM(view)?.state.vim?.visualMode) return false;
    return runScopeHandlers(view, e, "editor");
  },
});

const modeTracker = ViewPlugin.define((view) => {
  const cm = getCM(view);
  let state: VimModeState = { mode: cm?.state.vim?.insertMode ? "insert" : "normal", sub: null };
  const publish = () => useVimMode.setState(state);
  // Not `view.hasFocus`: that also needs the window focused, and this editor stays the last focused one.
  const focused = () => view.root.activeElement === view.contentDOM;
  const onModeChange = (e: { mode: string; subMode?: string }) => {
    state = { mode: e.mode, sub: e.subMode === "linewise" || e.subMode === "blockwise" ? e.subMode : null };
    queueMicrotask(() => view.dispatch({ effects: setVimInsert.of(e.mode === "insert" || e.mode === "replace") }));
    if (focused()) publish();
  };
  cm?.on("vim-mode-change", onModeChange);
  view.contentDOM.addEventListener("focus", publish);
  if (focused()) publish();
  return {
    destroy() {
      cm?.off("vim-mode-change", onModeChange);
      view.contentDOM.removeEventListener("focus", publish);
    },
  };
});

const caret = "var(--caret, var(--fg-strong))";

/** Block caret and command line in theme tokens (the package's defaults are fixed colours). */
const vimTheme = EditorView.theme({
  "& .cm-vimCursorLayer .cm-fat-cursor": {
    background: `color-mix(in srgb, ${caret} 60%, transparent)`,
  },
  "&:not(.cm-focused) .cm-vimCursorLayer .cm-fat-cursor": {
    background: "none",
    outline: `1px solid ${caret}`,
  },
  ".cm-vim-panel": {
    padding: "2px 10px",
    minHeight: "1.6em",
    alignItems: "center",
    fontFamily: "var(--font-mono)",
    fontSize: "var(--fs-code)",
    background: "var(--bg-elev)",
    color: "var(--fg)",
    borderTop: "1px solid var(--border)",
  },
  ".cm-vim-panel input": { color: "var(--fg)", fontFamily: "inherit", fontSize: "inherit" },
});

/** Vim for one editor. Highest precedence: Vim sees keys before the editor's keymaps. */
export function vimExtension(): Extension {
  defineExCommands();
  return [
    Prec.highest([
      vimInsert,
      imeHandlers,
      imeInput,
      imeTracker,
      imeTransactions,
      escapeClosesPopupsFirst,
      vim(),
      modeTracker,
    ]),
    imeCleanup,
    vimTheme,
    EditorView.editorAttributes.of({ [VIM_EDITOR_ATTR]: "true" }),
  ];
}

function later(run: () => void) {
  // Ex commands run inside Vim's key handling; closing the editor there would destroy it mid-call.
  setTimeout(run, 0);
}

/** `:action <id>`: an IdeaVim action id or an OpenIDEA one. Returns the action run, or null. */
export function runIdeAction(id: string | undefined): string | null {
  if (!id) {
    showStatusInfo("Usage: :action <action id>");
    return null;
  }
  const resolved = resolveActionId(id);
  if (!getAction(resolved)) {
    showStatusInfo(`Vim: no action "${id}"`);
    return null;
  }
  later(() => void executeAction(resolved));
  return resolved;
}

let exDefined = false;

/** OpenIDEA's Ex commands: `:w`, `:wa`, `:q`, `:qa`, `:wq`, `:x`, `:action`. */
export function defineExCommands() {
  if (exDefined) return;
  exDefined = true;
  const run = (id: string) => () => later(() => void executeAction(id));
  const saveThenClose = () =>
    later(() => {
      void executeAction("file.save").then(() => executeAction("editor.closeTab"));
    });
  Vim.defineEx("write", "w", run("file.save"));
  Vim.defineEx("wall", "wa", run("file.save"));
  Vim.defineEx("quit", "q", run("editor.closeTab"));
  Vim.defineEx("qall", "qa", run("editor.closeAllTabs"));
  Vim.defineEx("wq", "wq", saveThenClose);
  Vim.defineEx("xit", "x", saveThenClose);
  Vim.defineEx("action", "action", (_cm, params) => void runIdeAction(params.args?.[0]));
}

/** Applies rc commands (replacing earlier rc mappings). Returns problems to report. */
export function applyRcCommands(commands: readonly RcCommand[]): string[] {
  defineExCommands();
  Vim.mapclear();
  const problems: string[] = [];
  for (const c of commands) {
    try {
      if (c.kind === "set") {
        const err = Vim.setOption(c.name, c.value);
        if (err) problems.push(`set ${c.name}: ${err.message}`);
      } else if (c.kind === "map") {
        if (c.noremap) Vim.noremap(c.lhs, c.rhs, c.mode as string);
        else Vim.map(c.lhs, c.rhs, c.mode as string);
      } else {
        Vim._mapCommand({ keys: c.lhs, type: "keyToEx", exArgs: { input: c.ex }, context: c.mode } as never);
      }
    } catch (e) {
      problems.push(`${c.kind === "set" ? c.name : c.lhs}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return problems;
}

/** Test hook: runs an Ex command line in `view`. */
export function _handleEx(view: EditorView, input: string) {
  const cm = getCM(view);
  if (cm) Vim.handleEx(cm as never, input);
}
