import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { commands } from "@/platform/ipc";
import { usePlatform } from "@/platform/platformInfo";
import { resetNavigationModifier } from "@/platform/navigationModifier";
import { installKeyboardDispatcher, useKeymap } from "@/platform/keymap";
import { registerAction } from "@/platform/actions";

const lspGoto = vi.hoisted(() => vi.fn<typeof commands.lspGoto>());
vi.mock("@/platform/ipc", async (orig) => {
  const real = await orig<typeof import("@/platform/ipc")>();
  return { ...real, isTauri: () => true, commands: { ...real.commands, lspGoto } };
});

const { gotoTargets, navigationExtension } = await import("./navigation");
const { lspDoc } = await import("./lsp");
const { provideEditorService } = await import("@/workbench/contributions");
const openFile = vi.fn(async () => {});
provideEditorService({ openFile } as never);

let view: EditorView;
let uninstall: () => void;
let removeAction: () => void;
beforeEach(() => {
  usePlatform.setState({ os: "macos" });
  resetNavigationModifier();
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
