import { registerNavigationProvider } from "../navigationProviders";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { commands } from "@/platform/ipc";
import { usePlatform } from "@/platform/platformInfo";
import { resetNavigationModifier } from "@/platform/navigationModifier";
import { installKeyboardDispatcher, useKeymap } from "@/platform/keymap";
import { registerAction } from "@/platform/actions";
import { multiCaretMouse } from "@/editor/core/cm/multiCaret";
import { columnModeExtension, isColumnMode } from "@/editor/core/cm/columnMode";

const lspGoto = vi.hoisted(() => vi.fn<typeof commands.lspGoto>());
vi.mock("@/platform/ipc", async (orig) => {
  const real = await orig<typeof import("@/platform/ipc")>();
  // Go to Implementation streams (`lspGotoImplementation`); here it answers all at once.
  const lspGotoImplementation: typeof commands.lspGotoImplementation = (_request, doc, pos) =>
    lspGoto(doc, pos, "implementation");
  return {
    ...real,
    isTauri: () => true,
    commands: {
      ...real.commands,
      lspGoto,
      lspGotoImplementation,
      lspHighlights: vi.fn(async () => ({ status: "ok", data: [] })),
    },
  };
});
vi.mock("@tauri-apps/api/core", async (orig) => ({
  ...(await orig<object>()),
  Channel: class {
    onmessage = () => {};
  },
}));

const { gotoTargets, navigationExtension } = await import("./navigation");
const { lspDoc } = await import("./lsp");
const { invalidateConfigurationNavigation } = await import("./configurationNavigation");
const { provideEditorService } = await import("@/workbench/contributions");
const openFile = vi.fn(async () => {});
provideEditorService({ openFile } as never);

let view: EditorView;
let uninstall: () => void;
let removeAction: () => void;
beforeEach(() => {
  usePlatform.setState({ os: "macos" });
  resetNavigationModifier();
  invalidateConfigurationNavigation();
  vi.clearAllMocks();
  useKeymap.setState({
    preset: "intellij-macos",
    overrides: {},
  });
  removeAction = registerAction({
    id: "navigate.implementation",
    title: "Go to Implementation(s)",
    run: () => gotoTargets(view, "implementation"),
  });
  uninstall = installKeyboardDispatcher(window);
  lspGoto.mockResolvedValue({
    status: "ok",
    data: [{ path: "/p/ServiceImpl.java", range: { start: { line: 4, col: 2 }, end: { line: 4, col: 5 } }, uri: null }],
  });
  view = new EditorView({
    state: EditorState.create({
      doc: "service.run()",
      extensions: [
        lspDoc.of({ doc: 1, path: "/p/Main.java", language: "java", uiMode: "Java", readOnly: false }),
        navigationExtension(),
      ],
    }),
    parent: document.body,
  });
  vi.spyOn(view, "posAtCoords").mockReturnValue(9);
});
afterEach(() => {
  uninstall();
  removeAction();
  useKeymap.setState({ overrides: {} });
  view.destroy();
  document.body.replaceChildren();
  resetNavigationModifier();
  usePlatform.setState({ os: "macos" });
  vi.restoreAllMocks();
});

function click(init: MouseEventInit) {
  const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, ...init });
  view.contentDOM.dispatchEvent(event);
  return event;
}

describe("mouse navigation", () => {
  it("uses plugin navigation for clicks without asking the language server", async () => {
    const off = registerNavigationProvider(async () => ({
      from: 0,
      to: 13,
      targets: [{ path: "/p/Mapper.xml", range: { start: { line: 2, col: 4 }, end: { line: 2, col: 8 } } }],
    }));
    try {
      click({ metaKey: true });
      await vi.waitFor(() =>
        expect(openFile).toHaveBeenCalledWith("/p/Mapper.xml", { selection: { line: 2, col: 4 }, focus: true }),
      );
      expect(lspGoto).not.toHaveBeenCalled();
    } finally {
      off();
    }
  });

  it("opens the implementation of the symbol clicked with Option+Command", async () => {
    const event = click({ metaKey: true, altKey: true });
    await vi.waitFor(() =>
      expect(openFile).toHaveBeenCalledWith("/p/ServiceImpl.java", {
        selection: { line: 4, col: 2 },
        focus: true,
      }),
    );
    expect(lspGoto).toHaveBeenCalledExactlyOnceWith(1, { line: 0, col: 9 }, "implementation");
    expect(view.state.selection.main.head).toBe(9);
    expect(event.defaultPrevented).toBe(true);
  });

  it.each([
    { os: "macos", mods: { metaKey: true } },
    { os: "windows", mods: { ctrlKey: true } },
    { os: "linux", mods: { ctrlKey: true } },
  ] as const)("preserves declaration navigation on $os", async ({ os, mods }) => {
    usePlatform.setState({ os });
    click(mods);
    await vi.waitFor(() => expect(openFile).toHaveBeenCalledOnce());
    expect(lspGoto).toHaveBeenCalledExactlyOnceWith(1, { line: 0, col: 9 }, "definition");
  });

  it("opens the definition only after a plain middle-button click is released", async () => {
    const event = click({ button: 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(lspGoto).not.toHaveBeenCalled();
    view.contentDOM.dispatchEvent(new MouseEvent("mouseup", { button: 1, bubbles: true }));
    await vi.waitFor(() => expect(openFile).toHaveBeenCalledOnce());
    expect(lspGoto).toHaveBeenCalledExactlyOnceWith(1, { line: 0, col: 9 }, "definition");
    expect(view.state.selection.main.head).toBe(9);
    expect(event.defaultPrevented).toBe(false);
  });

  it.each([false, true])("does not navigate after a middle drag (returns to start: %s)", async (back) => {
    click({ button: 1, clientX: 10, clientY: 10 });
    document.dispatchEvent(new MouseEvent("mousemove", { buttons: 4, clientX: 30, clientY: 40 }));
    view.contentDOM.dispatchEvent(
      new MouseEvent("mouseup", { button: 1, bubbles: true, clientX: back ? 10 : 30, clientY: back ? 10 : 40 }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(lspGoto).not.toHaveBeenCalled();
  });

  it("detects a drag from the release even if no move event arrived", async () => {
    click({ button: 1, clientX: 10 });
    view.contentDOM.dispatchEvent(new MouseEvent("mouseup", { button: 1, bubbles: true, clientX: 40 }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(lspGoto).not.toHaveBeenCalled();
  });

  it("tolerates a small click movement without navigating twice", async () => {
    click({ button: 1, clientX: 10 });
    document.dispatchEvent(new MouseEvent("mousemove", { buttons: 4, clientX: 11 }));
    view.contentDOM.dispatchEvent(new MouseEvent("mouseup", { button: 1, bubbles: true, clientX: 11 }));
    await vi.waitFor(() => expect(openFile).toHaveBeenCalledOnce());
    expect(lspGoto).toHaveBeenCalledOnce();
  });

  it.each([
    "blur",
    "edit",
    "context",
    "destroy",
    "outside",
    "lost-button",
    "keydown",
    "new-gesture",
    "other-component",
    "side-button",
  ])("cancels pending middle navigation on %s", async (cancel) => {
    click({ button: 1 });
    if (cancel === "blur") window.dispatchEvent(new Event("blur"));
    if (cancel === "edit") view.dispatch({ changes: { from: 0, insert: " " } });
    if (cancel === "context")
      view.dispatch({
        effects: StateEffect.reconfigure.of([
          lspDoc.of({ doc: 2, path: "/p/Other.java", language: "java", uiMode: "Java", readOnly: false }),
          navigationExtension(),
        ]),
      });
    if (cancel === "destroy") view.destroy();
    if (cancel === "lost-button") document.dispatchEvent(new MouseEvent("mousemove", { buttons: 0 }));
    if (cancel === "keydown") document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    if (cancel === "new-gesture") click({});
    if (cancel === "other-component")
      document.body.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true }));
    if (cancel === "side-button")
      view.contentDOM.dispatchEvent(new MouseEvent("mousedown", { button: 3, bubbles: true }));
    const target = cancel === "outside" ? document.body : view.contentDOM;
    target.dispatchEvent(new MouseEvent("mouseup", { button: 1, bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(lspGoto).not.toHaveBeenCalled();
  });

  it("cancels a released click if another gesture starts before its deferred navigation", async () => {
    click({ button: 1 });
    view.contentDOM.dispatchEvent(new MouseEvent("mouseup", { button: 1, bubbles: true }));
    click({});
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(lspGoto).not.toHaveBeenCalled();
  });

  it.each(["middle", "short-middle", "alt", "rebound", "shared-middle", "shared-modified-middle"])(
    "keeps real rectangular ranges with navigation installed: %s",
    async (gesture) => {
      const id = "editor.createRectangularSelectionOnMouseDrag";
      const remove = registerAction({ id, title: "Create Rectangular Selection on Mouse Drag", run: () => {} });
      const removeDeclaration = registerAction({
        id: "navigate.declaration",
        title: "Go to Declaration",
        run: () => gotoTargets(view, "definition"),
      });
      try {
        if (gesture === "rebound") useKeymap.setState({ overrides: { [id]: ["Ctrl+Alt+Button1"] } });
        if (gesture.startsWith("shared-")) {
          const binding = gesture === "shared-middle" ? "Button2" : "Alt+Button2";
          useKeymap.setState({ overrides: { [id]: [binding], "navigate.declaration": [binding] } });
        }
        view.setState(
          EditorState.create({
            doc: "first\nsecond\nthird",
            extensions: [
              EditorState.allowMultipleSelections.of(true),
              lspDoc.of({ doc: 1, path: "/p/Main.java", language: "java", uiMode: "Java", readOnly: false }),
              multiCaretMouse,
              columnModeExtension,
              navigationExtension(),
            ],
          }),
        );
        vi.mocked(view.posAtCoords).mockImplementation((coords) => coords.x);
        vi.spyOn(view, "coordsAtPos").mockReturnValue(null);
        const mods = gesture.endsWith("middle")
          ? { button: 1, buttons: 4, altKey: gesture === "shared-modified-middle" }
          : { button: 0, buttons: 1, ctrlKey: gesture === "rebound", altKey: true };
        const end = gesture === "short-middle" ? 2 : 9;
        click({ ...mods, clientX: 1, detail: 1 });
        document.dispatchEvent(new MouseEvent("mousemove", { ...mods, clientX: end, bubbles: true }));
        document.dispatchEvent(new MouseEvent("mouseup", { ...mods, buttons: 0, clientX: end, bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(view.state.selection.ranges.map((r) => [r.from, r.to])).toEqual(
          gesture === "short-middle"
            ? [[1, 2]]
            : [
                [1, 3],
                [7, 9],
              ],
        );
        expect(isColumnMode(view.state)).toBe(false);
        expect(lspGoto).not.toHaveBeenCalled();
      } finally {
        remove();
        removeDeclaration();
      }
    },
  );

  it.each([false, true])("delays an explicitly bound middle declaration click (Alt: %s)", async (altKey) => {
    const binding = altKey ? "Alt+Button2" : "Button2";
    const remove = registerAction({
      id: "navigate.declaration",
      title: "Go to Declaration",
      run: () => gotoTargets(view, "definition"),
    });
    useKeymap.setState({ overrides: { "navigate.declaration": [binding] } });
    try {
      click({ button: 1, altKey });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(lspGoto).not.toHaveBeenCalled();
      view.contentDOM.dispatchEvent(new MouseEvent("mouseup", { button: 1, altKey, bubbles: true }));
      await vi.waitFor(() => expect(openFile).toHaveBeenCalledOnce());
      expect(lspGoto).toHaveBeenCalledOnce();
    } finally {
      remove();
    }
  });

  it.each([
    { button: 1, metaKey: true, altKey: true },
    { button: 2, metaKey: true, altKey: true },
    { metaKey: true, altKey: true, shiftKey: true },
    { metaKey: true, altKey: true, ctrlKey: true },
  ])("ignores other button/modifier combinations: %o", async (mods) => {
    click(mods);
    await Promise.resolve();
    expect(lspGoto).not.toHaveBeenCalled();
  });

  it("reports missing implementations without navigating to the declaration", async () => {
    lspGoto.mockResolvedValue({ status: "ok", data: [] });
    click({ metaKey: true, altKey: true });
    await vi.waitFor(() =>
      expect(document.querySelector(".cm-lsp-hint")?.textContent).toBe("No implementations found"),
    );
    expect(lspGoto).toHaveBeenCalledExactlyOnceWith(1, { line: 0, col: 9 }, "implementation");
    expect(openFile).not.toHaveBeenCalled();
  });

  it.each(["windows", "linux"] as const)("opens the implementation with Ctrl+Alt+click on %s", async (os) => {
    usePlatform.setState({ os });
    useKeymap.setState({ preset: "intellij-windows", overrides: {} });
    click({ ctrlKey: true, altKey: true });
    await vi.waitFor(() => expect(openFile).toHaveBeenCalledOnce());
    expect(lspGoto).toHaveBeenCalledExactlyOnceWith(1, { line: 0, col: 9 }, "implementation");
  });

  it("does not navigate with Option+Command when the binding is removed", async () => {
    useKeymap.setState({ overrides: { "navigate.implementation": ["Meta+Alt+B"] } });
    click({ metaKey: true, altKey: true });
    await Promise.resolve();
    expect(lspGoto).not.toHaveBeenCalled();
  });

  it("follows a different mouse binding assigned to the implementation action", async () => {
    useKeymap.setState({ overrides: { "navigate.implementation": ["Ctrl+Alt+Button1"] } });
    click({ metaKey: true, altKey: true });
    expect(lspGoto).not.toHaveBeenCalled();
    click({ ctrlKey: true, altKey: true });
    await vi.waitFor(() => expect(openFile).toHaveBeenCalledOnce());
    expect(lspGoto).toHaveBeenCalledExactlyOnceWith(1, { line: 0, col: 9 }, "implementation");
  });

  it("does not run the binding if the click has no document position", async () => {
    vi.mocked(view.posAtCoords).mockReturnValue(null);
    click({ metaKey: true, altKey: true });
    await Promise.resolve();
    expect(lspGoto).not.toHaveBeenCalled();
  });

  it("allows the same gesture to be reassigned to another action", async () => {
    const run = vi.fn();
    const remove = registerAction({ id: "test.mouse", title: "Custom action", run });
    try {
      useKeymap.setState({
        overrides: { "navigate.implementation": ["Meta+Alt+B"], "test.mouse": ["Alt+Meta+Button1"] },
      });
      click({ metaKey: true, altKey: true });
      await Promise.resolve();
      expect(run).toHaveBeenCalledOnce();
      expect(lspGoto).not.toHaveBeenCalled();
    } finally {
      remove();
    }
  });
});

describe("force click (macOS trackpad)", () => {
  function force(type: string, init: MouseEventInit = {}) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
    view.contentDOM.dispatchEvent(event);
    return event;
  }

  it("keeps the system Look Up popover away", () => {
    expect(force("webkitmouseforcewillbegin").defaultPrevented).toBe(true);
  });

  it("goes to the declaration under the pointer, like ⌘-click", async () => {
    const event = force("webkitmouseforcedown");
    await vi.waitFor(() => expect(openFile).toHaveBeenCalledOnce());
    expect(lspGoto).toHaveBeenCalledExactlyOnceWith(1, { line: 0, col: 9 }, "definition");
    expect(view.state.selection.main.head).toBe(9);
    expect(event.defaultPrevented).toBe(true);
  });

  it.each([{ metaKey: true }, { altKey: true }, { ctrlKey: true }, { shiftKey: true }])(
    "leaves a modified force click to the click gesture: %o",
    async (mods) => {
      force("webkitmouseforcedown", mods);
      await Promise.resolve();
      expect(lspGoto).not.toHaveBeenCalled();
    },
  );
});
