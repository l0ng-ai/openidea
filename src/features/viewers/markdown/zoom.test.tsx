import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { _addEditor, _removeEditor, editorContributions, type EditorDocContext } from "@/editor/api";
import { fontZoom, setFontZoom } from "@/editor/core/cm/prefs";
import { fontExtension } from "@/editor/core/cm/setup";
import type { EditorSlot } from "@/editor/core/model/slot";
import { executeAction } from "@/platform/actions";
import { useContextKeys } from "@/platform/context";
import { intellijMacos } from "@/platform/keymaps/intellij-macos";
import { intellijWindows } from "@/platform/keymaps/intellij-windows";
import { vscodeMacos } from "@/platform/keymaps/vscode-macos";

let activeSlot: Partial<EditorSlot> | null = null;
vi.mock("@/editor/core/controller", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  editorController: () => ({
    get activeSlot() {
      return activeSlot;
    },
  }),
}));

const { registerEditorActions } = await import("@/editor/core/actions");
const { registerMarkdownLiveSource, useLiveMarkdown } = await import("./live");
const { MarkdownEditor } = await import("./MarkdownEditor");
const { useMarkdownModes } = await import("./modes");

const mdCtx: EditorDocContext = { doc: 1, path: "/p/README.md", language: "markdown", uiMode: null, readOnly: false };
const tsCtx: EditorDocContext = { doc: 2, path: "/p/a.ts", language: "typescript", uiMode: null, readOnly: false };

describe("editor font size actions", () => {
  const disposers: Array<() => void> = [];
  const views: EditorView[] = [];

  const open = (ctx: EditorDocContext) => {
    const live = editorContributions().find((c) => c.id === "viewers.markdownLive")!;
    const extensions = [fontZoom, live.extensions(ctx)];
    const view = new EditorView({ state: EditorState.create({ doc: "# Title", extensions }) });
    const handle = { view, ctx };
    _addEditor(handle);
    disposers.push(() => _removeEditor(handle));
    views.push(view);
    return view;
  };
  const activate = (view: EditorView) => (activeSlot = { view, disposed: false });
  const zoom = (view: EditorView) => view.state.field(fontZoom);

  beforeEach(() => {
    disposers.push(registerEditorActions(), registerMarkdownLiveSource());
    useContextKeys.setState({ projectOpen: true, textEditorActive: true, editorFocus: true, popupOpen: true });
  });
  afterEach(() => {
    cleanup();
    for (const view of views.splice(0)) view.destroy();
    for (const dispose of disposers.splice(0).reverse()) dispose();
    activeSlot = null;
    useLiveMarkdown.setState({}, true);
    useContextKeys.setState({}, true);
  });

  it("zooms only the active editor, clamped to -6..36", async () => {
    const md = open(mdCtx);
    const ts = open(tsCtx);
    activate(md);
    await executeAction("editor.increaseFontSize");
    await executeAction("editor.increaseFontSize");
    expect(zoom(md)).toBe(2);
    expect(zoom(ts)).toBe(0);

    activate(ts);
    await executeAction("editor.decreaseFontSize");
    expect(zoom(ts)).toBe(-1);
    expect(zoom(md)).toBe(2);

    ts.dispatch({ effects: setFontZoom.of(36) });
    await executeAction("editor.increaseFontSize");
    expect(zoom(ts)).toBe(36);
    ts.dispatch({ effects: setFontZoom.of(-6) });
    await executeAction("editor.decreaseFontSize");
    expect(zoom(ts)).toBe(-6);
  });

  it("scales the Markdown preview with its editor and resets with it", async () => {
    const md = open(mdCtx);
    activate(md);
    act(() => useMarkdownModes.setState((s) => ({ byPath: { ...s.byPath, [mdCtx.path]: "split" } })));
    render(
      <MarkdownEditor path={mdCtx.path} tabId="t">
        <div />
      </MarkdownEditor>,
    );
    const preview = screen.getByRole("document", { name: "Markdown preview" });
    expect(preview.style.getPropertyValue("--markdown-font-zoom")).toBe("0px");

    await act(() => executeAction("editor.increaseFontSize"));
    await act(() => executeAction("editor.increaseFontSize"));
    expect(preview.style.getPropertyValue("--markdown-font-zoom")).toBe("2px");

    await act(() => executeAction("editor.resetFontSize"));
    expect(zoom(md)).toBe(0);
    expect(preview.style.getPropertyValue("--markdown-font-zoom")).toBe("0px");
  });

  it("scales a configured editor font size", () => {
    const settings = { fontSize: 13 } as Parameters<typeof fontExtension>[0];
    const view = new EditorView({ state: EditorState.create({ extensions: [fontExtension(settings), fontZoom] }) });
    views.push(view);
    view.dispatch({ effects: setFontZoom.of(2) });
    expect(view.dom.style.getPropertyValue("--openidea-editor-base-size")).toBe("13px");
    expect(view.dom.style.getPropertyValue("--openidea-editor-font-size")).toContain("+ 2px");
  });

  it("leaves ⌘= / ⌘- to fold and unfold", () => {
    for (const km of [intellijMacos, intellijWindows]) {
      expect(km["editor.increaseFontSize"]).toEqual(["Alt+Shift+."]);
      expect(km["editor.decreaseFontSize"]).toEqual(["Alt+Shift+,"]);
    }
    expect(intellijMacos["code.fold"]).toEqual(["Meta+-"]);
    expect(intellijMacos["code.unfold"]).toEqual(["Meta+="]);
    expect(intellijWindows["code.fold"]).toEqual(["Ctrl+-"]);
    expect(intellijWindows["code.unfold"]).toEqual(["Ctrl+="]);
    for (const km of [intellijMacos, intellijWindows, vscodeMacos]) {
      const keys = [...(km["editor.increaseFontSize"] ?? []), ...(km["editor.decreaseFontSize"] ?? [])];
      expect(keys.filter((k) => /^(Meta|Ctrl)\+(Shift\+)?[=-]$/.test(k))).toEqual([]);
      expect(Object.keys(km).filter((id) => id.startsWith("markdown.zoom"))).toEqual([]);
    }
  });
});
