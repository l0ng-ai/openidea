import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { getCM, Vim } from "@replit/codemirror-vim";
import { embeddedEditorExtensions, useEditorRegistry } from "@/editor/api";
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

describe("Normal-mode IME composition guard", () => {
  const DOC = "one two\nthree";

  const compose = (type: string, view: EditorView) =>
    view.contentDOM.dispatchEvent(new CompositionEvent(type, { bubbles: true }));

  /** Runs every input handler the way CM6 does; returns the first one that claimed the input. */
  const runInput = (view: EditorView, text: string): boolean => {
    const { from, to } = view.state.selection.main;
    const insert = () => view.state.update(view.state.replaceSelection(text), { userEvent: "input.type" });
    return view.state.facet(EditorView.inputHandler).some((h) => h(view, from, to, text, insert));
  };

  afterEach(() => vi.restoreAllMocks());

  it("swallows composition output in Normal mode, pinyin letters and the commit alike", () => {
    const view = makeView();
    const cm = getCM(view)!;
    compose("compositionstart", view);
    expect(runInput(view, "j")).toBe(true); // A pinyin letter must not run the motion.
    expect(runInput(view, "nihao")).toBe(true); // Candidates must not reach the document.
    expect(runInput(view, "你好")).toBe(true); // Nor the commit.
    expect(view.state.doc.toString()).toBe(DOC);
    expect(view.state.selection.main.head).toBe(0);
    expect(cm.state.vim?.insertMode).toBe(false);
    view.destroy();
  });

  it("keeps Insert-mode composition output flowing to the document", () => {
    const view = makeView();
    const cm = getCM(view)!;
    Vim.handleKey(cm as never, "i", "user");
    compose("compositionstart", view);
    const insert = () => view.state.update(view.state.replaceSelection("你好"), { userEvent: "input.type" });
    expect(runInput(view, "你好")).toBe(false); // Handlers leave it to CM6's default insert.
    view.dispatch(insert());
    expect(view.state.doc.toString()).toBe(`你好${DOC}`);
    view.destroy();
  });

  it("keeps guarding a commit that lands just after compositionend, then stands down", () => {
    const view = makeView();
    const clock = vi.spyOn(Date, "now");
    compose("compositionstart", view);
    compose("compositionend", view);
    expect(runInput(view, "你好")).toBe(true);
    clock.mockReturnValue(Date.now() + 500);
    expect(runInput(view, "你好")).toBe(false); // Ordinary input again: nothing to swallow.
    expect(view.state.doc.toString()).toBe(DOC);
    view.destroy();
  });

  it("leaves the package's own \\0\\0 end-composition marker to it", () => {
    const view = makeView();
    compose("compositionstart", view);
    expect(runInput(view, "\0\0")).toBe(true); // Claimed by the package, not swallowed silently.
    expect(view.state.doc.toString()).toBe(DOC);
    view.destroy();
  });
});
