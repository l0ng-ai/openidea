import { registerFontZoomSurface } from "@/workbench/contributions";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { _addEditor, _removeEditor, editorContributions, type EditorDocContext } from "@/editor/api";
import { fontZoom, resetAllEditorsFontZoom, setFontZoom } from "@/editor/core/cm/prefs";
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
    resetAllEditorsFontZoom();
    disposers.push(registerEditorActions(), registerMarkdownLiveSource());
    useContextKeys.setState({ projectOpen: true, textEditorActive: true, editorFocus: true, popupOpen: true });
  });
  afterEach(() => {
    cleanup();
    for (const view of views.splice(0)) view.destroy();
    for (const dispose of disposers.splice(0).reverse()) dispose();
    activeSlot = null;
    useLiveMarkdown.setState({}, true);
    useProject.setState({ settings: null });
    useContextKeys.setState({}, true);
  });

  it("zooms and resets only the active editor by default, clamped to -6..36", async () => {
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

    // Reset Font Size resets only the active editor, leaving the other tab untouched.
    await executeAction("editor.resetFontSize");
    expect(zoom(ts)).toBe(0);
    expect(zoom(md)).toBe(2);

    md.dispatch({ effects: setFontZoom.of(36) });
    activate(md);
    await executeAction("editor.increaseFontSize");
    expect(zoom(md)).toBe(36);
    md.dispatch({ effects: setFontZoom.of(-6) });
    await executeAction("editor.decreaseFontSize");
    expect(zoom(md)).toBe(-6);

    await executeAction("editor.resetFontSizeAll");
    expect(zoom(md)).toBe(0);
    expect(zoom(ts)).toBe(0);
  });

  it("zooms all open editors together when wheelZoomScope is 'all' (#2480)", async () => {
    useProject.setState({ settings: { editor: { general: { wheelZoomScope: "all" } } } } as never);
    const md = open(mdCtx);
    const ts = open(tsCtx);
    activate(md);
    await executeAction("editor.increaseFontSize");
    await executeAction("editor.increaseFontSize");
    expect(zoom(md)).toBe(2);
    expect(zoom(ts)).toBe(2);

    activate(ts);
    await executeAction("editor.decreaseFontSize");
    expect(zoom(ts)).toBe(1);
    expect(zoom(md)).toBe(1);

    await executeAction("editor.resetFontSize");
    expect(zoom(ts)).toBe(0);
    expect(zoom(md)).toBe(0);
  });

  it("scales only the focused Markdown preview tab (keyboard and ⌘/Ctrl+wheel) and resets with it", async () => {
    const otherMdCtx: EditorDocContext = {
      doc: 3,
      path: "/p/OTHER.md",
      language: "markdown",
      uiMode: null,
      readOnly: false,
    };
    const md = open(mdCtx);
    const otherMd = open(otherMdCtx);
    activate(md);
    act(() => useMarkdownModes.setState((s) => ({ byPath: { ...s.byPath, [mdCtx.path]: "split" } })));
    render(
      <MarkdownEditor path={mdCtx.path} tabId="t">
        <div />
      </MarkdownEditor>,
    );
    const preview = screen.getByRole("document", { name: "Markdown preview" });
    expect(preview.style.getPropertyValue("--markdown-font-zoom")).toBe("0px");
    expect(preview.style.getPropertyValue("--markdown-zoom-scale")).toBe("1");

    preview.focus();
    await act(() => executeAction("editor.increaseFontSize"));
    await act(() => executeAction("editor.increaseFontSize"));
    expect(preview.style.getPropertyValue("--markdown-font-zoom")).toBe("2px");
    expect(preview.style.getPropertyValue("--markdown-zoom-scale")).toBe("1.1538");
    expect(zoom(otherMd)).toBe(0);

    await act(() => executeAction("editor.decreaseFontSize"));
    await act(() => executeAction("editor.decreaseFontSize"));
    await act(() => executeAction("editor.decreaseFontSize"));
    expect(preview.style.getPropertyValue("--markdown-font-zoom")).toBe("-1px");
    expect(preview.style.getPropertyValue("--markdown-zoom-scale")).toBe("0.9231");

    // ⌘/Ctrl+wheel directly over the preview scales it when wheelZoom is enabled.
    act(() => useProject.setState({ settings: { editor: { general: { wheelZoom: true } } } } as never));
    act(() => {
      preview.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, metaKey: true, deltaY: -100 }));
    });
    expect(preview.style.getPropertyValue("--markdown-font-zoom")).toBe("0px");

    act(() => {
      preview.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -100 }));
    });
    expect(preview.style.getPropertyValue("--markdown-font-zoom")).toBe("1px");
    expect(zoom(otherMd)).toBe(0);

    await act(() => executeAction("editor.resetFontSize"));
    expect(zoom(md)).toBe(0);
    expect(preview.style.getPropertyValue("--markdown-font-zoom")).toBe("0px");
    expect(preview.style.getPropertyValue("--markdown-zoom-scale")).toBe("1");
  });

  it("sizes embedded excalidraw.svg, graph SVGs and raster images so they scale with font zoom", async () => {
    const excalidrawSvg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 940" width="1280" height="940"><!-- svg-source:excalidraw --></svg>';
    const excalidrawUrl = `data:image/svg+xml;base64,${btoa(excalidrawSvg)}`;
    const graphvizUrl = `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="300pt" height="150pt" viewBox="0 0 300 150"></svg>')}`;
    const wordmarkUrl = `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 280 56"></svg>')}`;
    const pngUrl = "data:image/png;base64,iVBORw0KGgo=";

    const ipc = await import("@/platform/ipc");
    const fsReadImage = vi.spyOn(ipc.commands, "fsReadImage").mockImplementation(async (p: string) => {
      if (p.endsWith("architecture.excalidraw.svg")) return { status: "ok", data: excalidrawUrl };
      if (p.endsWith("wordmark.svg")) return { status: "ok", data: wordmarkUrl };
      if (p.endsWith("shot.png")) return { status: "ok", data: pngUrl };
      return { status: "error", error: { kind: "notFound", message: p } } as never;
    });

    try {
      const doc = [
        "![Architecture](./architecture.excalidraw.svg)",
        "",
        `![Graph](${graphvizUrl})`,
        "",
        '<img src="./wordmark.svg" alt="Wordmark" height="56">',
        "",
        '<img src="./wordmark.svg" alt="Icon" width="80">',
        "",
        "![Shot](./shot.png)",
      ].join("\n");
      const live = editorContributions().find((c) => c.id === "viewers.markdownLive")!;
      const view = new EditorView({
        state: EditorState.create({ doc, extensions: [fontZoom, live.extensions(mdCtx)] }),
      });
      const handle = { view, ctx: mdCtx };
      _addEditor(handle);
      disposers.push(() => _removeEditor(handle));
      views.push(view);
      activate(view);

      act(() => useMarkdownModes.setState((s) => ({ byPath: { ...s.byPath, [mdCtx.path]: "preview" } })));
      render(
        <MarkdownEditor path={mdCtx.path} tabId="t">
          <div />
        </MarkdownEditor>,
      );
      const preview = screen.getByRole("document", { name: "Markdown preview" });
      await vi.waitFor(() => {
        const arch = preview.querySelector<HTMLImageElement>('img[alt="Architecture"]');
        expect(arch?.getAttribute("src")).toBe(excalidrawUrl);
      });

      const arch = preview.querySelector<HTMLImageElement>('img[alt="Architecture"]')!;
      expect(arch.hasAttribute("data-natural-width")).toBe(true);
      expect(arch.style.getPropertyValue("--image-width")).toBe("1280px");

      const graph = preview.querySelector<HTMLImageElement>('img[alt="Graph"]')!;
      expect(graph.hasAttribute("data-natural-width")).toBe(true);
      expect(graph.style.getPropertyValue("--image-width")).toBe("400px");

      const wordmark = preview.querySelector<HTMLImageElement>('img[alt="Wordmark"]')!;
      expect(wordmark.hasAttribute("data-natural-width")).toBe(true);
      expect(wordmark.style.getPropertyValue("--image-width")).toBe("280px");

      const icon = preview.querySelector<HTMLImageElement>('img[alt="Icon"]')!;
      expect(icon.hasAttribute("data-natural-width")).toBe(true);
      expect(icon.style.getPropertyValue("--image-width")).toBe("80px");

      const shot = preview.querySelector<HTMLImageElement>('img[alt="Shot"]')!;
      Object.defineProperty(shot, "naturalWidth", { value: 960, configurable: true });
      Object.defineProperty(shot, "naturalHeight", { value: 600, configurable: true });
      act(() => {
        shot.dispatchEvent(new Event("load"));
      });
      expect(shot.hasAttribute("data-natural-width")).toBe(true);
      expect(shot.style.getPropertyValue("--image-width")).toBe("960px");
    } finally {
      fsReadImage.mockRestore();
    }
  });

  it("scales a configured editor font size", () => {
    const settings = { fontSize: 13 } as Parameters<typeof fontExtension>[0];
    const view = new EditorView({ state: EditorState.create({ extensions: [fontExtension(settings), fontZoom] }) });
    views.push(view);
    view.dispatch({ effects: setFontZoom.of(2) });
    expect(view.dom.style.getPropertyValue("--openidea-editor-base-size")).toBe("13px");
    expect(view.dom.style.getPropertyValue("--openidea-editor-font-size")).toContain("+ 2px");
  });

  it("routes font size actions by focus even when another surface is hovered", async () => {
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
    const releaseTerminal = registerFontZoomSurface(termHost, (delta) => termZooms.push(delta));

    const iframe = document.createElement("iframe");
    iframe.setAttribute("data-plugin-webview", "dengliu.kubernetes");
    document.body.appendChild(iframe);
    const posted: unknown[] = [];
    Object.defineProperty(iframe, "contentWindow", {
      value: { postMessage: (msg: unknown) => posted.push(msg) },
      configurable: true,
    });

    const releaseFrame = registerFontZoomSurface(iframe, (delta) =>
      iframe.contentWindow?.postMessage({ tag: "openidea-view", fontZoomDelta: delta }, "*"),
    );

    const isolatedHost = document.createElement("div");
    isolatedHost.tabIndex = -1;
    document.body.appendChild(isolatedHost);
    const isolatedZooms: number[] = [];
    const releaseIsolated = registerFontZoomSurface(isolatedHost, (delta) => isolatedZooms.push(delta), {
      isolated: true,
    });

    try {
      termInput.focus();
      await executeAction("editor.increaseFontSize");
      await executeAction("editor.decreaseFontSize");
      expect(termZooms).toEqual([1, -1]);
      expect(zoom(md)).toBe(0);

      // The pointer must not redirect a keyboard action away from terminal focus.
      const qsa = vi.spyOn(document, "querySelectorAll").mockImplementation(((sel: string) => {
        if (sel === ":hover") return [iframe] as unknown as NodeListOf<Element>;
        return Document.prototype.querySelectorAll.call(document, sel);
      }) as typeof document.querySelectorAll);
      await executeAction("editor.increaseFontSize");
      expect(posted).toEqual([]);
      expect(termZooms).toEqual([1, -1, 1]);
      iframe.focus();
      await executeAction("editor.increaseFontSize");
      expect(posted).toEqual([{ tag: "openidea-view", fontZoomDelta: 1 }]);
      qsa.mockRestore();

      // Reset Font Size resets only the focused surface; Reset Font Size in All Editors resets non-isolated surfaces.
      await executeAction("editor.resetFontSize");
      expect(termZooms).toEqual([1, -1, 1]);
      expect(posted).toEqual([
        { tag: "openidea-view", fontZoomDelta: 1 },
        { tag: "openidea-view", fontZoomDelta: 0 },
      ]);

      await executeAction("editor.resetFontSizeAll");
      expect(termZooms).toEqual([1, -1, 1, 0]);
      expect(isolatedZooms).toEqual([]);
      expect(posted).toEqual([
        { tag: "openidea-view", fontZoomDelta: 1 },
        { tag: "openidea-view", fontZoomDelta: 0 },
        { tag: "openidea-view", fontZoomDelta: 0 },
      ]);

      // Under wheelZoomScope: "all", Reset Font Size resets all editors and non-isolated surfaces,
      // while an isolated surface still resets only itself when focused and is spared otherwise.
      useProject.setState({ settings: { editor: { general: { wheelZoomScope: "all" } } } } as never);
      md.dispatch({ effects: setFontZoom.of(3) });
      isolatedHost.focus();
      await executeAction("editor.resetFontSize");
      expect(isolatedZooms).toEqual([0]);
      expect(zoom(md)).toBe(3);

      termInput.focus();
      await executeAction("editor.resetFontSize");
      expect(zoom(md)).toBe(0);
      expect(termZooms).toEqual([1, -1, 1, 0, 0]);
      expect(isolatedZooms).toEqual([0]);
    } finally {
      releaseTerminal();
      releaseFrame();
      releaseIsolated();
      termHost.remove();
      iframe.remove();
      isolatedHost.remove();
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
