/**
 * The Vim emulation itself (@replit/codemirror-vim), loaded only once Vim mode
 * is turned on: the per-editor extension, OpenIDEA's Ex commands (`:w`, `:q`,
 * `:action`) and applying the rc file.
 */
import { Prec, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, runScopeHandlers } from "@codemirror/view";
import { Vim, getCM, vim } from "@replit/codemirror-vim";
import { executeAction, getAction } from "@/platform/actions";
import { showStatusInfo } from "@/workbench/contributions";
import { VIM_EDITOR_ATTR } from "./conflicts";
import { useVimMode, type VimModeState } from "./mode";
import { resolveActionId, type RcCommand } from "./rc";

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
    Prec.highest([escapeClosesPopupsFirst, vim(), modeTracker]),
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
