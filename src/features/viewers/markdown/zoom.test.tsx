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
import { markdownPreviewFontSize } from "@/platform/languageSettings";
import { useProject } from "@/platform/project";

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

  it("routes font size actions to hovered or focused terminal tabs and plugin webviews", async () => {
    const md = open(mdCtx);
    activate(md);
    // Works even when editorFocus is false (e.g. a tool window has focus).
    useContextKeys.setState({ projectOpen: true, textEditorActive: false, editorFocus: false, popupOpen: false });

    const termHost = document.createElement("div");
    termHost.setAttribute("data-terminal-session", "s1");
    const termInput = document.createElement("textarea");
    termHost.appendChild(termInput);
    document.body.appendChild(termHost);
    const termZooms: number[] = [];
    termHost.addEventListener("openidea:terminal-font-zoom", (e) => {
      termZooms.push((e as CustomEvent<number>).detail);
    });

    const iframe = document.createElement("iframe");
    iframe.setAttribute("data-plugin-webview", "dengliu.kubernetes");
    document.body.appendChild(iframe);
    const posted: unknown[] = [];
    Object.defineProperty(iframe, "contentWindow", {
      value: { postMessage: (msg: unknown) => posted.push(msg) },
      configurable: true,
    });

    try {
      termInput.focus();
      await executeAction("editor.increaseFontSize");
      await executeAction("editor.decreaseFontSize");
      expect(termZooms).toEqual([1, -1]);
      expect(zoom(md)).toBe(0);

      // Hovering over the plugin webview wins over terminal focus.
      const qsa = vi.spyOn(document, "querySelectorAll").mockImplementation(((sel: string) => {
        if (sel === ":hover") return [iframe] as unknown as NodeListOf<Element>;
        return Document.prototype.querySelectorAll.call(document, sel);
      }) as typeof document.querySelectorAll);
      await executeAction("editor.increaseFontSize");
      expect(posted).toEqual([{ tag: "openidea-view", fontZoomDelta: 1 }]);
      qsa.mockRestore();

      await executeAction("editor.resetFontSize");
      expect(termZooms).toEqual([1, -1, 0]);
      expect(posted).toEqual([
        { tag: "openidea-view", fontZoomDelta: 1 },
        { tag: "openidea-view", fontZoomDelta: 0 },
      ]);
    } finally {
      termHost.remove();
      iframe.remove();
    }
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

describe("Markdown preview font size", () => {
  const preview = () => {
    act(() => useMarkdownModes.setState((s) => ({ byPath: { ...s.byPath, [mdCtx.path]: "preview" } })));
    render(
      <MarkdownEditor path={mdCtx.path} tabId="t">
        <div />
      </MarkdownEditor>,
    );
    return screen.getByRole("document", { name: "Markdown preview" });
  };
  afterEach(() => {
    cleanup();
    useProject.setState({ settings: null });
  });

  it("follows the editor font size until Markdown › Preview font size is set, never the UI font", () => {
    expect(preview().style.getPropertyValue("--markdown-preview-font-size")).toBe("13px");
    cleanup();
    act(() => useProject.setState({ settings: { appearance: { uiFontSize: 11 }, editor: { fontSize: 15 } } } as never));
    expect(preview().style.getPropertyValue("--markdown-preview-font-size")).toBe("15px");
    cleanup();
    act(() =>
      useProject.setState({
        settings: {
          appearance: { uiFontSize: 11 },
          editor: { fontSize: 15 },
          languages: { markdown: { previewFontSize: 20 } },
        },
      } as never),
    );
    expect(preview().style.getPropertyValue("--markdown-preview-font-size")).toBe("20px");
  });

  it("keeps a set size within IDEA's 8..72", () => {
    const size = (v: unknown) =>
      markdownPreviewFontSize({ editor: { fontSize: 14 }, languages: { markdown: { previewFontSize: v } } });
    expect(size(3)).toBe(8);
    expect(size(200)).toBe(72);
    expect(size(15.6)).toBe(16);
    expect(size(null)).toBe(14);
    expect(size("big")).toBe(14);
  });
});
