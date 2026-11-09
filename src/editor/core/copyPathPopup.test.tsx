import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { executeAction, getAction, isActionKeyEnabled, registerAction } from "@/platform/actions";
import { useContextKeys } from "@/platform/context";
import { installKeyboardDispatcher, shortcutLabel, useKeymap } from "@/platform/keymap";
import { useProject } from "@/platform/project";
import { useProjectRoots } from "@/platform/projectRoots";
import { closePopup, openPopup, useLspPopup } from "@/editor/lsp/popupStore";
import { LspPopups } from "@/editor/lsp/Popups";
import { registerProjectActions } from "@/features/project-tree/actions";
import { useProjectTree } from "@/features/project-tree/store";
import { useContextMenuStore } from "@/ui";
import { provideNotificationService } from "@/workbench/contributions";
import * as controller from "./controller";
import { createMemoryBackend } from "./backend";
import { registerEditorActions } from "./actions";
import { useOutline } from "./model/document";
import { initialTabsState } from "./model/tabs";

const path = "/p/src/A.java";
const documentText = "package com.acme;\nclass A {}\n";
const writeText = vi.fn(async (_text: string) => undefined);
const hint = vi.fn();
const notify = vi.fn();
const disposers: Array<() => void> = [];
let ctrl: controller.EditorController;
let host: HTMLDivElement;

const popup = () => {
  const value = useLspPopup.getState().popup;
  if (value?.kind !== "list") throw new Error("Expected copy chooser");
  return value;
};

beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubGlobal("navigator", { clipboard: { writeText }, userAgent: navigator.userAgent });
  vi.stubGlobal("ClipboardItem", undefined);
  provideNotificationService({ notify });
  useProject.setState({ project: { name: "p", root: "/p", settings: {} } as never, settings: {} as never });
  useProjectRoots.setState({ root: "/p", detected: [{ path: "src", kind: "source", detectedFrom: null }] });
  useProjectTree.setState({ root: "/p" });
  useKeymap.setState({ preset: "intellij-macos", overrides: {} });
  ctrl = new controller.EditorController(createMemoryBackend({ [path]: documentText }));
  vi.spyOn(controller, "editorController").mockReturnValue(ctrl);
  await ctrl.openFile(path, { focus: false });
  host = document.createElement("div");
  document.body.appendChild(host);
  const view = ctrl.activeSlot!.mount(host);
  ctrl.onMounted(ctrl.activeSlot!);
  view.dispatch({ selection: { anchor: documentText.indexOf("A {}") } });
  view.focus();
  useOutline.setState({
    [path]: [
      {
        name: "A",
        kind: "class",
        detail: null,
        children: [],
        range: { start: { line: 1, col: 0 }, end: { line: 1, col: 10 } },
        selection_range: { start: { line: 1, col: 6 }, end: { line: 1, col: 7 } },
      },
    ],
  });
  useContextKeys.setState(
    { textEditorActive: true, editorFocus: true, editorTextFocus: true, projectOpen: true },
    true,
  );
  disposers.push(
    registerEditorActions(),
    registerProjectActions(),
    registerAction({ id: "editor.showHint", title: "Hint", run: ({ arg }) => hint(arg) }),
  );
});

afterEach(() => {
  act(() => closePopup());
  disposers
    .splice(0)
    .reverse()
    .forEach((dispose) => dispose());
  ctrl.stop();
  host.remove();
  controller.useTabs.setState(initialTabsState(), true);
  useProject.setState({ project: null, settings: null });
  useProjectRoots.setState({ root: null, detected: [] });
  useProjectTree.setState({ root: null });
  useContextMenuStore.setState({ menu: null });
  useContextKeys.setState({}, true);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("editor Copy Path/Reference chooser", () => {
  it("keeps the old action available as Absolute Path with a copied hint", async () => {
    expect(getAction("editor.copyPath")!.title).toBe("Absolute Path");
    await executeAction("editor.copyPath");
    expect(writeText).toHaveBeenCalledExactlyOnceWith(path);
    expect(useLspPopup.getState().popup).toBeNull();
    expect(hint).toHaveBeenCalledWith({ text: `Copied ${path}` });
  });

  it("opens at the caret without copying, with every preview and assigned shortcut", async () => {
    vi.spyOn(ctrl.activeSlot!.view!, "coordsAtPos").mockReturnValue({ left: 120, right: 121, top: 80, bottom: 100 });
    useKeymap.setState({ overrides: { "project.copyFileName": ["Meta+Alt+N"] } });
    await executeAction("editor.copyPathReference");
    await vi.waitFor(() => expect(popup().items.at(-1)?.disabled).toBeNull());
    expect(writeText).not.toHaveBeenCalled();
    expect(popup().anchor).toEqual({ x: 120, y: 100 });
    expect(popup().items.map(({ label, preview }) => [label, preview])).toEqual([
      ["Absolute Path", path],
      ["File Name", "A.java"],
      ["Path From Content Root", "src/A.java"],
      ["Path From Source Root", "A.java"],
      ["Path with line number", "src/A.java:2"],
      ["Reference", "com.acme.A"],
    ]);
    for (const item of popup().items) expect(item.shortcut).toBe(shortcutLabel(item.id));
    expect(popup().items[1]!.shortcut).toBeTruthy();
  });

  it.each([
    "project.copyAbsolutePath",
    "project.copyFileName",
    "project.copyRelativePath",
    "project.copySourceRootPath",
    "editor.copyPathWithLineNumber",
    "editor.copyReference",
  ])("copies the preview through %s and confirms it", async (id) => {
    await executeAction("editor.copyPathReference");
    await vi.waitFor(() => expect(popup().items.at(-1)?.disabled).toBeNull());
    const item = popup().items.find((item) => item.id === id)!;
    await item.run();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledExactlyOnceWith(item.preview));
    await vi.waitFor(() =>
      expect(hint).toHaveBeenCalledWith({
        text: id === "editor.copyReference" ? `Copied reference: ${item.preview}` : `Copied ${item.preview}`,
      }),
    );
  });

  it("omits source paths outside known roots and supports loose files", async () => {
    useProjectRoots.setState({ detected: [{ path: "other", kind: "source", detectedFrom: null }] });
    await executeAction("editor.copyPathReference");
    expect(popup().items.some((item) => item.id === "project.copySourceRootPath")).toBe(false);
    useProject.setState({ project: null, settings: null });
    useProjectTree.setState({ root: null });
    useContextKeys.setState({ projectOpen: false });
    await executeAction("editor.copyPathReference");
    expect(popup().items.find((item) => item.id === "editor.copyPathWithLineNumber")?.preview).toBe(`${path}:2`);
    await popup()
      .items.find((item) => item.id === "project.copyRelativePath")!
      .run();
    expect(writeText).toHaveBeenCalledExactlyOnceWith(path);
  });

  it("uses path:line off a symbol and ignores stale reference resolution", async () => {
    ctrl.activeSlot!.view!.dispatch({ selection: { anchor: documentText.length - 1 } });
    await executeAction("editor.copyPathReference");
    await vi.waitFor(() => expect(popup().items.at(-1)?.preview).toBe("src/A.java:2"));
    void executeAction("editor.copyPathReference");
    closePopup();
    openPopup({ kind: "list", title: "Other", anchor: { x: 1, y: 1 }, items: [] });
    await Promise.resolve();
    expect(popup().title).toBe("Other");
    expect(popup().items).toEqual([]);
  });

  it("copies the reference preview even if the caret moves afterwards", async () => {
    await executeAction("editor.copyPathReference");
    await vi.waitFor(() => expect(popup().items.at(-1)?.disabled).toBeNull());
    const reference = popup().items.at(-1)!;
    ctrl.activeSlot!.view!.dispatch({ selection: { anchor: 0 } });
    await reference.run();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledExactlyOnceWith("com.acme.A"));
  });

  it("supports keyboard selection and Escape through the existing list popup", async () => {
    await executeAction("editor.copyPathReference");
    render(<LspPopups />);
    expect(screen.getAllByRole("option")).toHaveLength(6);
    expect(screen.getByTitle(path)).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Enter" });
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledExactlyOnceWith("A.java"));
    expect(useLspPopup.getState().popup).toBeNull();
    await act(() => executeAction("editor.copyPathReference"));
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
    expect(useLspPopup.getState().popup).toBeNull();
  });

  it("adds the chooser to Copy / Paste Special", () => {
    vi.spyOn(ctrl.activeSlot!.view!, "posAtCoords").mockReturnValue(null);
    ctrl.onContextMenu(ctrl.activeSlot!, new MouseEvent("contextmenu"));
    const special = useContextMenuStore
      .getState()
      .menu!.items.find((item) => "label" in item && item.label === "Copy / Paste Special");
    expect(special && "submenu" in special && special.submenu).toContainEqual({
      kind: "action",
      action: "editor.copyPathReference",
    });
  });

  it.each(["intellij-macos", "intellij-windows"])("routes %s shortcuts by focus", (preset) => {
    useKeymap.setState({ preset });
    disposers.push(installKeyboardDispatcher(window));
    const key = () =>
      new KeyboardEvent("keydown", {
        key: "C",
        code: "KeyC",
        shiftKey: true,
        metaKey: preset.endsWith("macos"),
        ctrlKey: preset.endsWith("windows"),
        bubbles: true,
        cancelable: true,
      });
    window.dispatchEvent(key());
    expect(useLspPopup.getState().popup?.kind).toBe("list");
    expect(writeText).not.toHaveBeenCalled();
    closePopup();
    useContextKeys.setState({
      editorFocus: false,
      editorTextFocus: false,
      toolWindowFocus: true,
      projectViewFocus: true,
    });
    expect(isActionKeyEnabled(getAction("editor.copyPathReference")!)).toBe(false);
    expect(isActionKeyEnabled(getAction("project.copyAbsolutePath")!)).toBe(true);
    useContextKeys.setState({ projectViewFocus: false, terminalFocus: true });
    const terminalKey = key();
    window.dispatchEvent(terminalKey);
    expect(terminalKey.defaultPrevented).toBe(false);
    expect(useLspPopup.getState().popup).toBeNull();
    expect(writeText).not.toHaveBeenCalled();
  });

  it("reports clipboard failures without a copied hint", async () => {
    writeText.mockRejectedValueOnce(new Error("Clipboard denied"));
    await executeAction("editor.copyPathReference");
    await popup().items[0]!.run();
    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith(expect.objectContaining({ level: "error" })));
    expect(hint).not.toHaveBeenCalled();
  });
});
