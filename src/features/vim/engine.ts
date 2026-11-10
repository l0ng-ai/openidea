/**
 * The Vim emulation itself (@replit/codemirror-vim), loaded only once Vim mode
 * is turned on: the per-editor extension, OpenIDEA's Ex commands (`:w`, `:q`,
 * `:action`) and applying the rc file.
 */
import { EditorState, Prec, StateEffect, StateField, Transaction, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, runScopeHandlers } from "@codemirror/view";
import { Vim, getCM, vim } from "@replit/codemirror-vim";
import { transientChange, reportInputMode, type EditorDocContext } from "@/editor/api";
import { setContext } from "@/platform/context";
import { executeAction, getAction } from "@/platform/actions";
import { showStatusInfo } from "@/workbench/contributions";
import { VIM_EDITOR_ATTR } from "./conflicts";
import { useVimMode, type VimModeState } from "./mode";
import { resolveActionId, type RcCommand } from "./rc";
import { mapFunctionTextObjects } from "./textObjects";

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
  /** The span the composition occupies now: the replaced selection, mapped through its changes. */
  from: number;
  to: number;
  /** Selection contents replaced by the composition. */
  before: string;
  /** Selection before the composition, to restore it afterwards. */
  selection: { anchor: number; head: number };
  /** The text the IME committed. */
  ended: string | null;
  timer: ReturnType<typeof setTimeout> | undefined;
}

const imeCompositions = new WeakMap<EditorView, ImeComposition>();
/** The last Normal-mode composition's end, until a keydown reaches the editor (see `imeNextKey`). */
const imeEnded = new WeakMap<EditorView, { at: number; commit: string }>();
/** CodeMirror's own window is 100ms; the text input follows its dropped keydown a little later. */
const IME_NEXT_KEY_WINDOW_MS = 200;
/** Text input as the `KeyboardEvent.key` Vim maps (`<Space>`, `<CR>`, `<Tab>`). */
const TEXT_KEYS: Record<string, string> = { "\n": "Enter", "\t": "Tab" };
/** Views with a Normal-mode IME composition in progress (`imeCompositions` can't be iterated). */
const composingViews = new Set<EditorView>();

function endComposition(view: EditorView) {
  imeCompositions.delete(view);
  composingViews.delete(view);
}

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
  endComposition(view);
  clearTimeout(composition.timer);
  const cm = getCM(view);
  if (!cm) return;
  const insert = !!cm.state.vim?.insertMode;
  const { from, to, before, selection, ended } = composition;
  // The whole span, not the last change CodeMirror read: its changes are minimal diffs, so a
  // commit sharing a prefix or suffix with the preedit (`かんじを` → `漢字を`) touches only part of it.
  if (view.state.sliceDoc(from, to) !== before) {
    view.dispatch({
      changes: { from, to, insert: before },
      selection,
      annotations: [Transaction.addToHistory.of(false), transientChange.of(true)],
    });
  } else {
    const main = view.state.selection.main;
    if (main.anchor !== selection.anchor || main.head !== selection.head) {
      view.dispatch({ selection, annotations: transientChange.of(true) });
    }
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
    composingViews.add(view);
    imeCompositions.set(view, {
      from: range.from,
      to: range.to,
      before: view.state.sliceDoc(range.from, range.to),
      selection: { anchor: range.anchor, head: range.head },
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
    imeEnded.set(view, { at: Date.now(), commit: composition.ended });
    clearTimeout(composition.timer);
    composition.timer = setTimeout(() => finishImeComposition(view), 0);
    return false;
  },
});

/** A keydown CodeMirror didn't drop reaches Vim the usual way (observers run even after Vim's). */
const imeKeydown = EditorView.domEventObservers({
  keydown(_e, view) {
    imeEnded.delete(view);
  },
});

/**
 * The key typed right after a Normal-mode composition. On WebKit (macOS, and WebKitGTK on
 * Linux), CodeMirror drops the first keydown within 100ms of `compositionend`, meant for the
 * IME's own Enter. Vim never sees that key, and a printable one arrives as text input that
 * would be written to the document. Korean ends a composition implicitly, by the next key or
 * an input source switch, so `ㄱ` then a quick `j` hits this; Japanese and Chinese can too.
 * Run the key through Vim instead. Keys that type no text (Esc, arrows) are still dropped.
 */
function imeNextKey(view: EditorView, text: string): boolean {
  const ended = imeEnded.get(view);
  if (!ended || view.composing) return false;
  if (Date.now() - ended.at > IME_NEXT_KEY_WINDOW_MS) {
    imeEnded.delete(view);
    return false;
  }
  const composition = imeCompositions.get(view);
  if (composition?.ended === null) return false;
  // The IME's own commit (or the part CodeMirror reports of it) belongs to the composition.
  if (ended.commit.endsWith(text)) return false;
  if (text.length !== 1 || text.charCodeAt(0) >= 0x80) return false;
  const cm = getCM(view);
  const vimState = cm?.state.vim;
  if (!cm || !vimState || vimState.insertMode || cm.curOp?.isVimOp) return false;
  imeEnded.delete(view);
  if (composition) finishImeComposition(view);
  // Through `vimKeyFromEvent` like a keydown, for `<Space>`/`<CR>` and 'langmap'.
  const key = Vim.vimKeyFromEvent({ key: TEXT_KEYS[text] ?? text } as KeyboardEvent, vimState);
  if (key) Vim.handleKey(cm, key, "user");
  return true;
}

/** Let CodeMirror apply the composing text; it is removed when the IME ends. */
const imeInput = EditorView.inputHandler.of((view, _from, _to, text) => {
  if (imeNextKey(view, text)) return true;
  const composition = imeCompositions.get(view);
  if (!composition) return false;
  const cm = getCM(view);
  if (cm?.state.vim && !cm.state.vim.insertMode && cm.state.vimPlugin) {
    cm.state.vimPlugin.useNextTextInput = false;
  }
  return false;
});

/** Keeps the composition's span current, including commits CodeMirror reports after
 * `compositionend`: composing text at its edges belongs to it, other edits there don't. */
const imeTracker = ViewPlugin.define((view) => ({
  update(update) {
    const composition = imeCompositions.get(view);
    if (!composition) return;
    for (const tr of update.transactions) {
      if (!tr.docChanged) continue;
      const compose = tr.isUserEvent("input.type.compose");
      composition.from = tr.changes.mapPos(composition.from, compose ? -1 : 1);
      composition.to = Math.max(composition.from, tr.changes.mapPos(composition.to, compose ? 1 : -1));
    }
  },
}));

/**
 * Composition changes are temporary: no undo entry, no document/backend sync. Only those of a
 * composition the IME started: codemirror-vim labels its own edits (`x`, `dd`, `ciw`…)
 * `input.type.compose` too, to group them for undo, and those are real edits.
 */
const imeTransactions = EditorState.transactionExtender.of((tr) =>
  !tr.startState.field(vimInsert) && tr.isUserEvent("input.type.compose") && composingState(tr.startState)
    ? { annotations: [Transaction.addToHistory.of(false), transientChange.of(true)] }
    : null,
);

/** Whether `state` is the current state of a view with an IME composition in progress. */
function composingState(state: EditorState): boolean {
  for (const view of composingViews) if (view.state === state) return true;
  return false;
}

const imeCleanup = ViewPlugin.define((view) => ({
  destroy() {
    const composition = imeCompositions.get(view);
    if (composition) {
      clearTimeout(composition.timer);
      endComposition(view);
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

const modeTracker = (ctx?: EditorDocContext) =>
  ViewPlugin.define((view) => {
    const cm = getCM(view);
    let state: VimModeState = { mode: cm?.state.vim?.insertMode ? "insert" : "normal", sub: null };
    const publish = () => {
      useVimMode.setState(state);
      setContext("vim.mode", state.mode);
      if (ctx) reportInputMode(ctx.path, state.mode, state.sub);
    };
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
export function vimExtension(ctx?: EditorDocContext): Extension {
  defineExCommands();
  return [
    Prec.highest([
      vimInsert,
      imeHandlers,
      imeKeydown,
      imeInput,
      imeTracker,
      imeTransactions,
      escapeClosesPopupsFirst,
      vim(),
      modeTracker(ctx),
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
  mapFunctionTextObjects();
}

/**
 * The first key of a mapping's lhs — `<Space>` / `,` / `x` and so on. Vim's own
 * single-key built-ins occupy most of these: codemirror-vim prefers a full
 * match over a partial one, so `<Space>` → `l` or `,` → repeat-find would fire
 * before a `<leader>…` sequence can complete (#2337). The fix is to unmap the
 * built-in while a user mapping starts with that key.
 *
 * codemirror-vim tells defaults from user mappings by count (`mapclear` and
 * `noremap` treat the last N entries as defaults), so the default keymap must
 * keep its size: the first time a key is shadowed, its built-in is swapped for a
 * stand-in entry right after `mapclear`, before any user mapping, where it
 * becomes part of the default region. Later applies only switch the stand-in's
 * `keys` between the built-in key and one nothing can type.
 */
const LEADER_BUILTIN_DEFAULTS: Record<string, Record<string, unknown>> = {
  "<Space>": { keys: "<Space>", type: "keyToKey", toKeys: "l" },
  "<S-Space>": { keys: "<S-Space>", type: "keyToKey", toKeys: "w" },
  "<C-Space>": { keys: "<C-Space>", type: "keyToKey", toKeys: "W" },
  "<BS>": { keys: "<BS>", type: "keyToKey", toKeys: "h" },
  "<S-BS>": { keys: "<S-BS>", type: "keyToKey", toKeys: "b" },
  "<C-BS>": { keys: "<C-BS>", type: "keyToKey", toKeys: "B" },
  "<Del>": { keys: "<Del>", type: "keyToKey", toKeys: "x" },
  ",": { keys: ",", type: "motion", motion: "repeatLastCharacterSearch", motionArgs: { forward: false } },
  ";": { keys: ";", type: "motion", motion: "repeatLastCharacterSearch", motionArgs: { forward: true } },
};

/** Stand-ins for the built-ins a leader has shadowed, by key. */
const leaderStandIns = new Map<string, { keys: string }>();
/** Keys of a shadowed stand-in: no key sequence starts with NUL. */
const SHADOWED = "\u0000";

function shadowLeaderBuiltins(commands: readonly RcCommand[]) {
  const shadow = new Set<string>();
  for (const c of commands) {
    // Only the single-key motions a leader reuses: shadowing an operator or prefix
    // (`d`, `c`, `y`, `<C-d>`…) would break every command built on it.
    if ((c.kind === "map" || c.kind === "mapEx") && firstKey(c.lhs) in LEADER_BUILTIN_DEFAULTS) {
      shadow.add(firstKey(c.lhs));
    }
  }
  for (const [key, standIn] of leaderStandIns) standIn.keys = shadow.has(key) ? SHADOWED : key;
  for (const key of shadow) {
    // The builtins this shadows are context-less; `undefined` matches them.
    if (leaderStandIns.has(key) || !Vim.unmap(key, undefined as unknown as string)) continue;
    const standIn = { ...LEADER_BUILTIN_DEFAULTS[key], keys: SHADOWED };
    Vim._mapCommand(standIn as never);
    leaderStandIns.set(key, standIn);
  }
}

function firstKey(lhs: string): string {
  return /^<[^<>]+>|^./.exec(lhs)?.[0] ?? lhs;
}

/** Applies rc commands (replacing earlier rc mappings). Returns problems to report. */
export function applyRcCommands(commands: readonly RcCommand[]): string[] {
  defineExCommands();
  Vim.mapclear();
  shadowLeaderBuiltins(commands);
  // `mapclear` drops them with the user mappings; before those, which may remap them.
  mapFunctionTextObjects();
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
