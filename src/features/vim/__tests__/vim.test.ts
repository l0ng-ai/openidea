import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { getCM, Vim } from "@replit/codemirror-vim";
import { embeddedEditorExtensions, transientChange, useEditorRegistry } from "@/editor/api";
import { executeAction, registerAction } from "@/platform/actions";
import { getContext } from "@/platform/context";
import { _handleEx, applyRcCommands, vimExtension } from "../engine";
import { activate } from "../index";
import { useVimMode } from "../mode";
import { parseVimrc } from "../rc";
import { updateVimSettings, useVimSettings, VIM_SETTINGS_KEY } from "../settings";

const tick = () => new Promise((r) => setTimeout(r, 0));
const until = async (cond: () => boolean) => {
  for (let i = 0; i < 50 && !cond(); i++) await tick();
  expect(cond()).toBe(true);
};

function makeView(extra = vimExtension()) {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  return new EditorView({ parent, state: EditorState.create({ doc: "one two\nthree", extensions: extra }) });
}

describe("Vim mode toggle", () => {
  let dispose = () => {};
  beforeEach(() => {
    localStorage.clear();
    useVimSettings.setState({ enabled: false, handlers: {} }, true);
    dispose = activate();
  });
  afterEach(() => dispose());

  const hasContribution = () => useEditorRegistry.getState().contributions.has("vim");

  it("vim.toggle turns Vim on and off for every editor, live, and persists it", async () => {
    const diffSide = makeView(embeddedEditorExtensions("/p/a.ts"));
    expect(hasContribution()).toBe(false);

    await executeAction("vim.toggle");
    expect(useVimSettings.getState().enabled).toBe(true);
    expect(JSON.parse(localStorage.getItem(VIM_SETTINGS_KEY)!).enabled).toBe(true);
    await until(hasContribution);
    expect(getContext().vimMode).toBe(true);
    expect(diffSide.dom.hasAttribute("data-openidea-vim")).toBe(true);
    expect(getCM(diffSide)).not.toBeNull();

    await executeAction("vim.toggle");
    expect(useVimSettings.getState().enabled).toBe(false);
    expect(hasContribution()).toBe(false);
    expect(diffSide.dom.hasAttribute("data-openidea-vim")).toBe(false);
    expect(getCM(diffSide)).toBeNull();
    diffSide.destroy();
  });

  it("follows the setting changed from another window", async () => {
    updateVimSettings({ enabled: true });
    await until(hasContribution);
    localStorage.setItem(VIM_SETTINGS_KEY, JSON.stringify({ enabled: false, handlers: {} }));
    window.dispatchEvent(new StorageEvent("storage", { key: VIM_SETTINGS_KEY }));
    expect(useVimSettings.getState().enabled).toBe(false);
    expect(hasContribution()).toBe(false);
  });
});

describe("Vim engine", () => {
  const ran: string[] = [];
  let disposers: Array<() => void> = [];
  beforeEach(() => {
    ran.length = 0;
    disposers = ["navigate.declaration", "code.reformat", "file.save", "editor.closeTab"].map((id) =>
      registerAction({ id, title: id, run: () => void ran.push(id) }),
    );
  });
  afterEach(() => {
    disposers.forEach((d) => d());
    Vim.mapclear();
  });

  it(":action runs OpenIDEA actions by IdeaVim or OpenIDEA id", async () => {
    const view = makeView();
    _handleEx(view, "action GotoDeclaration");
    _handleEx(view, "action code.reformat");
    _handleEx(view, "action NoSuchAction");
    await tick();
    expect(ran).toEqual(["navigate.declaration", "code.reformat"]);
    view.destroy();
  });

  it(":w saves, :q closes the tab, :wq does both", async () => {
    const view = makeView();
    _handleEx(view, "w");
    await tick();
    expect(ran).toEqual(["file.save"]);
    _handleEx(view, "q");
    await tick();
    expect(ran).toEqual(["file.save", "editor.closeTab"]);
    ran.length = 0;
    _handleEx(view, "wq");
    await until(() => ran.length === 2);
    expect(ran).toEqual(["file.save", "editor.closeTab"]);
    view.destroy();
  });

  it("applies rc mappings, including <Action>() ones", async () => {
    const view = makeView();
    const cm = getCM(view)!;
    applyRcCommands(parseVimrc("nmap gd <Action>(GotoDeclaration)\nnnoremap H ^").commands);
    Vim.handleKey(cm as never, "g", "user");
    Vim.handleKey(cm as never, "d", "user");
    await tick();
    expect(ran).toEqual(["navigate.declaration"]);
    view.destroy();
  });

  it("keeps an IME composition out of the document in Normal mode", async () => {
    const transient: boolean[] = [];
    const view = makeView([
      vimExtension(),
      EditorView.updateListener.of((u) => {
        for (const tr of u.transactions) if (tr.docChanged) transient.push(!!tr.annotation(transientChange));
      }),
    ]);
    const content = view.contentDOM;
    const composition = (type: string, data: string) =>
      content.dispatchEvent(new CompositionEvent(type, { data, bubbles: true }));

    // A composition over a selection replaces it, then restores it.
    view.dispatch({ selection: { anchor: 0, head: 3 } });
    composition("compositionstart", "");
    // Preedit, then the committed character (as CodeMirror reports them).
    view.dispatch({ changes: { from: 0, to: 3, insert: "ni" }, userEvent: "input.type.compose.start" });
    view.dispatch({ changes: { from: 0, to: 2, insert: "你" }, userEvent: "input.type.compose" });
    expect(view.state.doc.toString()).toBe("你 two\nthree");
    composition("compositionend", "你");
    await tick();

    expect(view.state.doc.toString()).toBe("one two\nthree");
    expect(view.state.selection.main.from).toBe(0);
    expect(view.state.selection.main.to).toBe(3);
    // Preedit, commit and the cleanup itself never reach the document model.
    expect(transient).toEqual([true, true, true]);
    view.destroy();
  });

  it("keeps Normal-mode Vim edits in the document", async () => {
    const transient: boolean[] = [];
    const view = makeView([
      vimExtension(),
      EditorView.updateListener.of((u) => {
        for (const tr of u.transactions) if (tr.docChanged) transient.push(!!tr.annotation(transientChange));
      }),
    ]);
    const cm = getCM(view)!;
    // codemirror-vim labels these `input.type.compose` to group them for undo.
    Vim.handleKey(cm, "x", "user");
    for (const key of ["w", "c", "i", "w"]) Vim.handleKey(cm, key, "user");
    await tick();
    view.dispatch(view.state.replaceSelection("2"));
    Vim.handleKey(cm, "<Esc>", "user");
    await tick();

    expect(view.state.doc.toString()).toBe("ne 2\nthree");
    expect(transient).not.toContain(true);
    view.destroy();
  });

  it("removes a whole composition whose commit shares text with the preedit", async () => {
    const view = makeView([vimExtension()]);
    const composition = (type: string, data: string) =>
      view.contentDOM.dispatchEvent(new CompositionEvent(type, { data, bubbles: true }));

    view.dispatch({ selection: { anchor: 4 } });
    composition("compositionstart", "");
    view.dispatch({ changes: { from: 4, insert: "かんじを" }, userEvent: "input.type.compose.start" });
    // CodeMirror reports the conversion as a minimal diff: the shared `を` is not part of it.
    view.dispatch({ changes: { from: 4, to: 7, insert: "漢字" }, userEvent: "input.type.compose" });
    expect(view.state.doc.toString()).toBe("one 漢字をtwo\nthree");
    composition("compositionend", "漢字を");
    await tick();

    expect(view.state.doc.toString()).toBe("one two\nthree");
    expect(view.state.selection.main.head).toBe(4);
    view.destroy();
  });

  it("replays a dead-key composition as a Vim command and keeps insert-mode IME input", async () => {
    const view = makeView();
    const content = view.contentDOM;
    const cm = getCM(view)!;
    const composition = (type: string, data: string) =>
      content.dispatchEvent(new CompositionEvent(type, { data, bubbles: true }));

    // `^` (first non-blank) at column 5.
    view.dispatch({ selection: { anchor: 5 } });
    composition("compositionstart", "");
    view.dispatch({ changes: { from: 5, insert: "^" }, userEvent: "input.type.compose.start" });
    composition("compositionend", "^");
    await tick();
    expect(view.state.doc.toString()).toBe("one two\nthree");
    expect(view.state.selection.main.head).toBe(0);

    // IME input in Insert mode is ordinary text.
    Vim.handleKey(cm as never, "i", "user");
    await tick();
    composition("compositionstart", "");
    view.dispatch({ changes: { from: 0, insert: "你" }, userEvent: "input.type.compose.start" });
    composition("compositionend", "你");
    await tick();
    expect(view.state.doc.toString()).toBe("你one two\nthree");
    view.destroy();
  });

  it("publishes the mode and lets the editor's Escape bindings (popups) go first", () => {
    let popupOpen = true;
    const closePopup = Prec.highest(
      keymap.of([{ key: "Escape", run: () => (popupOpen ? !(popupOpen = false) : false) }]),
    );
    const view = makeView([vimExtension(), closePopup]);
    view.focus();
    const cm = getCM(view)!;
    Vim.handleKey(cm as never, "i", "user");
    expect(cm.state.vim?.insertMode).toBe(true);
    const escape = () =>
      view.contentDOM.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }),
      );
    escape();
    expect(popupOpen).toBe(false);
    expect(cm.state.vim?.insertMode).toBe(true);
    escape();
    expect(cm.state.vim?.insertMode).toBe(false);
    Vim.handleKey(cm as never, "v", "user");
    expect(useVimMode.getState().mode).toBe("visual");
    view.destroy();
  });
});
