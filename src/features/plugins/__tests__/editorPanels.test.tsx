import { afterEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { javascript } from "@codemirror/lang-javascript";
import { codeFolding, foldEffect, syntaxHighlighting, unfoldEffect } from "@codemirror/language";
import { Compartment, EditorSelection, EditorState, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { Diagnostic, LineHunk, PluginInfo } from "@/bindings";
import type { TextEditorHandle } from "@/editor/api";
import { diagnosticsExtension, setFileDiagnostics } from "@/editor/lsp/diagnostics";
import { lspDoc } from "@/editor/lsp/lsp";
import { hunkField, setHunksEffect } from "@/features/vcs/gutter";
import { openideaHighlightStyle } from "@/editor/core/cm/highlight";
import { setContext } from "@/platform/context";
import { useEditorGroupPanels } from "@/workbench/contributions";
import type { SemanticTokens } from "@/platform/ipc";
import { createMemoryPluginsBackend, setPluginsBackend } from "../backend";
import { usePlugins } from "../store";
import { FRAME_TAG, frameDocument } from "../views/frame";
import { PanelEditor, editorPanelUpdates, projectEditorPanel } from "../views/editorPanel";
import { WebView, type FrameEditor, type FrameEditorEvent } from "../views/WebView";

// The language server's semantic tokens, for the editor's semantic highlighting.
const lsp = vi.hoisted(() => ({ tokens: { data: [], tokenTypes: [], tokenModifiers: [] } as SemanticTokens }));
const lspSemanticTokens = vi.hoisted(() => async () => ({ status: "ok" as const, data: lsp.tokens }));
vi.mock("@/platform/ipc", async (orig) => {
  const actual = await orig<typeof import("@/platform/ipc")>();
  return { ...actual, isTauri: () => true, commands: { ...actual.commands, lspSemanticTokens } };
});
const { semanticExtension } = await import("@/editor/lsp/semantic");

afterEach(() => {
  vi.useRealTimers();
  setPluginsBackend(null);
  usePlugins.setState({ plugins: [] });
});

async function frameIn(container: HTMLElement) {
  return waitFor(() => {
    const f = container.querySelector("iframe");
    expect(f).not.toBeNull();
    return f!;
  });
}

const nextFrame = () => new Promise((r) => requestAnimationFrame(r));

/** Runs the bridge in a fake frame window at `search`; what it posts up, and a way to post down. */
function bridgeAt(search: string) {
  const script = /<script>([\s\S]*)<\/script>/.exec(frameDocument("", { dark: true, vars: {} }))![1]!;
  const sent: Array<{ call?: number; op?: string; args?: Record<string, unknown> }> = [];
  const parent = { postMessage: (m: (typeof sent)[number]) => void sent.push(m) };
  const handlers = new Map<string, (e: { source: object; data: object }) => void>();
  const frameWindow: Record<string, unknown> = {
    parent,
    addEventListener: (type: string, fn: (e: { source: object; data: object }) => void) => handlers.set(type, fn),
  };
  new Function("window", "document", "location", script)(
    frameWindow,
    { documentElement: document.createElement("html") },
    { search },
  );
  const send = (data: object) => handlers.get("message")!({ source: parent, data: { tag: FRAME_TAG, ...data } });
  return { api: frameWindow.openidea as Record<string, unknown>, sent, send };
}

describe("frame bridge: openidea.editor", () => {
  it("exists only in editor panel pages", () => {
    expect(bridgeAt("").api.editor).toBeUndefined();
    expect(bridgeAt("?x=1").api.editor).toBeUndefined();
    expect(bridgeAt("?openidea=editor-panel").api.editor).toBeDefined();
  });

  it("asks the workbench and hears the editor's events", async () => {
    const { api, sent, send } = bridgeAt("?openidea=editor-panel");
    const editor = api.editor as {
      get(): Promise<unknown>;
      viewport(): Promise<unknown>;
      scrollTo(line: number): Promise<unknown>;
      scrollBy(pixels: number): Promise<unknown>;
      highlights(from: number, to: number): Promise<unknown>;
      problems(): Promise<unknown>;
      folded(): Promise<unknown>;
      wrapped(from: number, to: number): Promise<unknown>;
      selections(): Promise<unknown>;
      changes(): Promise<unknown>;
      onTarget(fn: (v: unknown) => void): void;
      onViewport(fn: (v: unknown) => void): void;
      onHighlights(fn: (v: unknown) => void): void;
      onProblems(fn: (v: unknown) => void): void;
      onLayout(fn: (v: unknown) => void): void;
      onSelections(fn: (v: unknown) => void): void;
      onChanges(fn: (v: unknown) => void): void;
      document: unknown;
    };
    expect(editor.document).toBe(api.document);

    const got = editor.get();
    expect(sent.at(-1)).toMatchObject({ op: "editor.get" });
    send({ reply: sent.at(-1)!.call, value: { path: "/p/a.ts", language: "typescript", version: 1, lineCount: 9 } });
    await expect(got).resolves.toMatchObject({ path: "/p/a.ts", lineCount: 9 });

    void editor.scrollTo(2.5);
    expect(sent.at(-1)).toMatchObject({ op: "editor.scrollTo", args: { line: 2.5 } });
    void editor.scrollBy(-40);
    expect(sent.at(-1)).toMatchObject({ op: "editor.scrollBy", args: { pixels: -40 } });
    void editor.viewport();
    expect(sent.at(-1)).toMatchObject({ op: "editor.viewport" });
    const lines = editor.highlights(0, 3000);
    expect(sent.at(-1)).toMatchObject({ op: "editor.highlights", args: { fromLine: 0, toLine: 3000 } });
    send({ reply: sent.at(-1)!.call, error: "at most 2000 lines at a time" });
    await expect(lines).rejects.toThrow("2000");
    const problems = editor.problems();
    expect(sent.at(-1)).toMatchObject({ op: "editor.problems" });
    send({ reply: sent.at(-1)!.call, value: [{ line: 2, lastLine: 2, severity: "error" }] });
    await expect(problems).resolves.toEqual([{ line: 2, lastLine: 2, severity: "error" }]);
    void editor.folded();
    expect(sent.at(-1)).toMatchObject({ op: "editor.folded" });
    void editor.wrapped(4, 9);
    expect(sent.at(-1)).toMatchObject({ op: "editor.wrapped", args: { fromLine: 4, toLine: 9 } });
    void editor.selections();
    expect(sent.at(-1)).toMatchObject({ op: "editor.selections" });
    void editor.changes();
    expect(sent.at(-1)).toMatchObject({ op: "editor.changes" });

    const events: unknown[] = [];
    editor.onTarget((v) => events.push(["target", v]));
    editor.onViewport((v) => events.push(["viewport", v]));
    editor.onHighlights((v) => events.push(["highlights", v]));
    editor.onProblems((v) => events.push(["problems", v]));
    editor.onLayout((v) => events.push(["layout", v]));
    editor.onSelections((v) => events.push(["selections", v]));
    editor.onChanges((v) => events.push(["changes", v]));
    send({ editor: "target", value: null });
    send({ editor: "viewport", value: { firstLine: 1.5 } });
    send({ editor: "highlights", value: { fromLine: 0, toLine: 4 } });
    send({ editor: "problems", value: [] });
    send({ editor: "layout", value: { folded: [], softWrap: true } });
    send({ editor: "selections", value: [] });
    send({ editor: "changes", value: [] });
    send({ editor: "constructor", value: 1 });
    expect(events).toEqual([
      ["target", null],
      ["viewport", { firstLine: 1.5 }],
      ["highlights", { fromLine: 0, toLine: 4 }],
      ["problems", []],
      ["layout", { folded: [], softWrap: true }],
      ["selections", []],
      ["changes", []],
    ]);
  });

  it("ignores editor events in other pages", () => {
    const { api, send } = bridgeAt("");
    const changes: unknown[] = [];
    (api.document as { onChange(fn: (v: unknown) => void): void }).onChange((v) => changes.push(v));
    send({ editor: "target", value: null });
    expect(changes).toEqual([]);
  });
});

describe("WebView as an editor panel", () => {
  function memoryEditor() {
    const listeners = new Set<(e: FrameEditorEvent) => void>();
    const calls: unknown[] = [];
    const editor: FrameEditor & { fire(e: FrameEditorEvent): void } = {
      get: () => ({ path: "/p/a.ts", language: "typescript", version: 2, lineCount: 3, tabSize: 4 }),
      viewport: () => ({ firstLine: 0, lastLine: 2.5, lineCount: 3, scrollTop: 0, scrollHeight: 60, clientHeight: 50 }),
      scrollTo: (line) => void calls.push(["scrollTo", line]),
      scrollBy: (px) => void calls.push(["scrollBy", px]),
      highlights: (from, to) => {
        calls.push(["highlights", from, to]);
        return [[{ from: 0, to: 5, color: "rgb(1, 2, 3)" }]];
      },
      problems: () => [{ line: 1, lastLine: 2, severity: "warning" }],
      folded: () => [{ fromLine: 0, toLine: 2 }],
      selections: () => [{ anchor: { line: 1, column: 0 }, head: { line: 1, column: 4 } }],
      changes: () => [{ line: 0, lastLine: 1, kind: "added" }],
      wrapped: (from, to) => {
        calls.push(["wrapped", from, to]);
        return [1, 3];
      },
      subscribe: (l) => {
        listeners.add(l);
        return () => void listeners.delete(l);
      },
      fire: (e) => listeners.forEach((l) => l(e)),
    };
    return { editor, calls };
  }

  it("loads the page as an editor panel and answers openidea.editor", async () => {
    setPluginsBackend({ ...createMemoryPluginsBackend([]), webPageUrl: async () => "about:blank" });
    usePlugins.setState({ plugins: [{ id: "acme.map", hasCode: false, capabilities: [] } as unknown as PluginInfo] });
    const { editor, calls } = memoryEditor();
    const document = new PanelEditor().document;
    const { container } = render(
      <WebView pluginId="acme.map" view="minimap" label="minimap" editor={editor} document={document} />,
    );
    const frame = await frameIn(container);
    expect(frame.getAttribute("src")).toBe("about:blank?openidea=editor-panel");
    const posted: Array<Record<string, unknown>> = [];
    vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation((m: unknown) => void posted.push(m as never));
    const send = (data: object) =>
      window.dispatchEvent(
        new MessageEvent("message", { data: { tag: FRAME_TAG, ...data }, source: frame.contentWindow }),
      );
    const reply = (id: number) =>
      waitFor(() => {
        const r = posted.find((m) => m.reply === id);
        expect(r).toBeDefined();
        return r!;
      });

    send({ call: 1, op: "editor.get" });
    expect((await reply(1)).value).toEqual({
      path: "/p/a.ts",
      language: "typescript",
      version: 2,
      lineCount: 3,
      tabSize: 4,
    });
    send({ call: 2, op: "editor.highlights", args: { fromLine: 0, toLine: 1 } });
    expect((await reply(2)).value).toEqual([[{ from: 0, to: 5, color: "rgb(1, 2, 3)" }]]);
    send({ call: 3, op: "editor.highlights", args: { fromLine: 0, toLine: 2001 } });
    expect(String((await reply(3)).error)).toContain("2000");
    send({ call: 4, op: "editor.highlights", args: { fromLine: 2, toLine: 1 } });
    expect((await reply(4)).error).toBeDefined();
    send({ call: 5, op: "editor.scrollTo", args: { line: 1.25 } });
    await reply(5);
    send({ call: 6, op: "editor.scrollTo", args: { line: null } });
    expect(String((await reply(6)).error)).toContain("number");
    send({ call: 7, op: "editor.scrollBy", args: { pixels: 30 } });
    await reply(7);
    expect(calls).toEqual([
      ["highlights", 0, 1],
      ["scrollTo", 1.25],
      ["scrollBy", 30],
    ]);
    // Read-only: the page cannot edit the group's file.
    send({ call: 8, op: "document.edit", args: { version: 0, edits: [] } });
    expect((await reply(8)).error).toBeDefined();
    send({ call: 9, op: "editor.problems" });
    expect((await reply(9)).value).toEqual([{ line: 1, lastLine: 2, severity: "warning" }]);
    send({ call: 10, op: "editor.folded" });
    expect((await reply(10)).value).toEqual([{ fromLine: 0, toLine: 2 }]);
    send({ call: 11, op: "editor.wrapped", args: { fromLine: 1, toLine: 3 } });
    expect((await reply(11)).value).toEqual([1, 3]);
    send({ call: 12, op: "editor.wrapped", args: { fromLine: 0, toLine: 2001 } });
    expect(String((await reply(12)).error)).toContain("2000");
    send({ call: 13, op: "editor.wrapped", args: { fromLine: 0.5, toLine: 2 } });
    expect((await reply(13)).error).toBeDefined();
    expect(calls.at(-1)).toEqual(["wrapped", 1, 3]);
    send({ call: 14, op: "editor.selections" });
    expect((await reply(14)).value).toEqual([{ anchor: { line: 1, column: 0 }, head: { line: 1, column: 4 } }]);
    send({ call: 15, op: "editor.changes" });
    expect((await reply(15)).value).toEqual([{ line: 0, lastLine: 1, kind: "added" }]);

    editor.fire({ editor: "highlights", value: { fromLine: 0, toLine: 3 } });
    expect(posted.at(-1)).toEqual({ tag: FRAME_TAG, editor: "highlights", value: { fromLine: 0, toLine: 3 } });
  });

  it("refuses openidea.editor requests from other web views", async () => {
    setPluginsBackend({ ...createMemoryPluginsBackend([]), webPageUrl: async () => "about:blank" });
    usePlugins.setState({ plugins: [{ id: "acme.map", hasCode: false, capabilities: [] } as unknown as PluginInfo] });
    const { container } = render(<WebView pluginId="acme.map" view="tool" label="tool" />);
    const frame = await frameIn(container);
    expect(frame.getAttribute("src")).toBe("about:blank");
    const posted: Array<Record<string, unknown>> = [];
    vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation((m: unknown) => void posted.push(m as never));
    window.dispatchEvent(
      new MessageEvent("message", { data: { tag: FRAME_TAG, call: 1, op: "editor.get" }, source: frame.contentWindow }),
    );
    await waitFor(() => expect(String(posted.find((m) => m.reply === 1)?.error)).toContain("not an editor panel"));
  });
});

describe("PanelEditor", () => {
  function editorView(doc: string) {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc,
        extensions: [javascript(), syntaxHighlighting(openideaHighlightStyle), editorPanelUpdates],
      }),
    });
    const handle: TextEditorHandle = {
      view,
      tabId: "t1",
      ctx: { doc: 1, path: "/p/src/a.js", language: "javascript", uiMode: "JavaScript", readOnly: false },
    };
    return { view, handle };
  }

  it("reports the target, read-only text and per-line highlights in UTF-16 columns", async () => {
    const { view, handle } = editorView('const a = "é😀";\n/* one\ntwo */ let b');
    const panel = new PanelEditor();
    const events: FrameEditorEvent[] = [];
    panel.subscribe((e) => events.push(e));
    expect(panel.get()).toBeNull();
    panel.bind(handle);
    expect(events[0]).toEqual({
      editor: "target",
      value: { path: "/p/src/a.js", language: "javascript", version: 1, lineCount: 3, tabSize: 4 },
    });
    expect(panel.document.read()).toMatchObject({ readOnly: true, name: "a.js", text: view.state.doc.toString() });
    expect(() => panel.document.edit(0, [])).toThrow("read-only");

    const lines = panel.highlights(0, 99);
    expect(lines).toHaveLength(3);
    const ranges = lines.map((spans) => spans.map((s) => [s.from, s.to]));
    // `const` … the string, whose 😀 is two UTF-16 units: `"é😀"` is columns 10–15.
    expect(ranges[0]).toContainEqual([0, 5]);
    expect(ranges[0]).toContainEqual([10, 15]);
    // A block comment over two lines: one span on each.
    expect(ranges[1]).toEqual([[0, 6]]);
    expect(ranges[2]).toContainEqual([0, 6]);
    expect(ranges[2]).toContainEqual([7, 10]);
    expect(panel.highlights(1, 2)).toEqual([lines[1]]);
    for (const s of lines.flat()) expect(typeof s.color).toBe("string");

    // An edit: the document, then highlights from the changed line, in one frame.
    const changes: unknown[] = [];
    panel.document.subscribe((s) => changes.push(s));
    events.length = 0;
    view.dispatch({ changes: { from: view.state.doc.line(2).from, insert: "x;\n" } });
    view.dispatch({ changes: { from: 0, insert: "// top\n" } });
    await nextFrame();
    expect(changes).toEqual([{ version: 3, text: view.state.doc.toString() }]);
    expect(events).toContainEqual({ editor: "highlights", value: { fromLine: 0, toLine: 5 } });
    expect(events.filter((e) => e.editor === "viewport")).toHaveLength(1);

    // A theme switch: every line again.
    events.length = 0;
    panel.themeChanged();
    await nextFrame();
    expect(events).toEqual([{ editor: "highlights", value: { fromLine: 0, toLine: 5 } }]);

    // Unbound: no file, nothing follows the old editor.
    panel.bind(null);
    expect(events.at(-1)).toEqual({ editor: "target", value: null });
    events.length = 0;
    view.dispatch({ changes: { from: 0, insert: "x" } });
    await nextFrame();
    expect(events).toEqual([]);
    expect(() => panel.document.read()).toThrow();
    view.destroy();
  });
});

describe("PanelEditor semantic highlights", () => {
  it("layers the semantic colours over the syntax colours and follows the tokens", async () => {
    vi.useFakeTimers();
    const PATH = "/p/src/semantic.js";
    lsp.tokens = { data: [1, 0, 5, 0, 0], tokenTypes: ["property"], tokenModifiers: [] };
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: "let total = 1;\ntotal;\nend",
        extensions: [
          lspDoc.of({ doc: 1, path: PATH, language: "javascript", uiMode: null, readOnly: false }),
          javascript(),
          syntaxHighlighting(openideaHighlightStyle),
          semanticExtension(),
          EditorView.theme({ ".cm-sem-property": { color: "rgb(1, 2, 3)" } }),
          editorPanelUpdates,
        ],
      }),
    });
    const handle: TextEditorHandle = {
      view,
      tabId: "t1",
      ctx: { doc: 1, path: PATH, language: "javascript", uiMode: "JavaScript", readOnly: false },
    };
    const panel = new PanelEditor();
    const events: FrameEditorEvent[] = [];
    panel.subscribe((e) => events.push(e));
    panel.bind(handle);
    const syntaxOnly = panel.highlights(0, 3);
    const semantic = "rgb(1, 2, 3)";
    expect(syntaxOnly.flat().map((s) => s.color)).not.toContain(semantic);

    // The tokens arrive: line 1's `total` takes the semantic colour; the other lines keep theirs.
    events.length = 0;
    await vi.advanceTimersByTimeAsync(1000);
    expect(view.contentDOM.querySelector(".cm-sem-property")).not.toBeNull();
    expect(events).toContainEqual({ editor: "highlights", value: { fromLine: 1, toLine: 2 } });
    const lines = panel.highlights(0, 3);
    expect(lines[1]).toContainEqual({ from: 0, to: 5, color: semantic });
    expect(lines[1]!.filter((s) => s.from < 5)).toHaveLength(1);
    expect(lines[0]).toEqual(syntaxOnly[0]);
    expect(lines[2]).toEqual(syntaxOnly[2]);

    // Refreshed after an edit at the end: the token moved to line 0, whose colours are reported.
    lsp.tokens = { data: [0, 4, 5, 0, 0], tokenTypes: ["property"], tokenModifiers: [] };
    view.dispatch({ changes: { from: view.state.doc.length, insert: "!" } });
    await vi.advanceTimersByTimeAsync(20);
    events.length = 0;
    await vi.advanceTimersByTimeAsync(1000);
    expect(events).toContainEqual({ editor: "highlights", value: { fromLine: 0, toLine: 2 } });
    expect(panel.highlights(0, 1)[0]).toContainEqual({ from: 4, to: 9, color: semantic });
    expect(panel.highlights(1, 2)).toEqual([syntaxOnly[1]]);

    panel.dispose();
    view.destroy();
  });
});

describe("PanelEditor layout", () => {
  it("reports the folded lines and the rows of wrapped lines, and follows them", async () => {
    const long = "x".repeat(200);
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: `function f() {\n  a;\n  b;\n}\n${long}\nend`,
        extensions: [codeFolding(), editorPanelUpdates],
      }),
    });
    const handle: TextEditorHandle = {
      view,
      tabId: "t1",
      ctx: { doc: 1, path: "/p/src/a.js", language: "javascript", uiMode: "JavaScript", readOnly: false },
    };
    const panel = new PanelEditor();
    const events: FrameEditorEvent[] = [];
    panel.subscribe((e) => events.push(e));
    panel.bind(handle);
    await nextFrame();
    // Neither: no folds, no rows (switching to a file says so).
    expect(panel.folded()).toEqual([]);
    expect(panel.wrapped(0, 6)).toBeNull();
    expect(events.filter((e) => e.editor === "layout")).toEqual([
      { editor: "layout", value: { folded: [], softWrap: false } },
    ]);

    // Folding lines 1–2 (the `{` line stays, `}` joins it), and a fold inside it.
    events.length = 0;
    const open = view.state.doc.line(1).to;
    const close = view.state.doc.line(4).from;
    view.dispatch({
      effects: [foldEffect.of({ from: open, to: close }), foldEffect.of({ from: open + 3, to: open + 6 })],
    });
    await nextFrame();
    const folds = [{ fromLine: 0, toLine: 3 }];
    expect(panel.folded()).toEqual(folds);
    expect(events.filter((e) => e.editor === "layout")).toEqual([
      { editor: "layout", value: { folded: folds, softWrap: false } },
    ]);

    // Soft wrap on: the long line takes several rows, the folded ones none. jsdom lays nothing
    // out, so the measured state stands in: wrapping on, the long line's block three rows high.
    events.length = 0;
    let wrapping = false;
    Object.defineProperty(view, "lineWrapping", { get: () => wrapping });
    const lineBlockAt = view.lineBlockAt.bind(view);
    vi.spyOn(view, "lineBlockAt").mockImplementation((pos) => {
      const b = lineBlockAt(pos);
      return b.from === view.state.doc.line(5).from
        ? Object.assign(Object.create(b), { height: 3 * view.defaultLineHeight })
        : b;
    });
    wrapping = true;
    view.dispatch({ effects: StateEffect.appendConfig.of(EditorView.lineWrapping) });
    await nextFrame();
    const rows = panel.wrapped(0, 6)!;
    expect(rows).toEqual([1, 0, 0, 0, 3, 1]);
    expect(panel.wrapped(4, 99)).toEqual(rows.slice(4));
    expect(events.filter((e) => e.editor === "layout")).toEqual([
      { editor: "layout", value: { folded: folds, softWrap: true } },
    ]);

    // The outer fold opened: the lines come back, but for the inner fold's.
    events.length = 0;
    view.dispatch({ effects: unfoldEffect.of({ from: open, to: close }) });
    await nextFrame();
    const inner = [{ fromLine: 1, toLine: 2 }];
    expect(panel.folded()).toEqual(inner);
    expect(panel.wrapped(0, 4)).toEqual([1, 1, 0, 1]);
    expect(events.filter((e) => e.editor === "layout")).toEqual([
      { editor: "layout", value: { folded: inner, softWrap: true } },
    ]);

    // Soft wrap off: no rows.
    events.length = 0;
    wrapping = false;
    view.dispatch({ effects: StateEffect.reconfigure.of([codeFolding(), editorPanelUpdates]) });
    await nextFrame();
    expect(panel.wrapped(0, 4)).toBeNull();
    expect(events.filter((e) => e.editor === "layout")).toEqual([
      { editor: "layout", value: { folded: inner, softWrap: false } },
    ]);

    // Selecting alone says nothing.
    events.length = 0;
    view.dispatch({ selection: { anchor: 2 } });
    await nextFrame();
    expect(events.filter((e) => e.editor === "layout")).toEqual([]);

    panel.dispose();
    view.destroy();
  });
});

describe("PanelEditor problems", () => {
  const PATH = "/p/src/problems.js";
  const at = (line: number, col: number, endLine = line, endCol = col + 1) => ({
    start: { line, col },
    end: { line: endLine, col: endCol },
  });
  const diag = (range: ReturnType<typeof at>, severity: Diagnostic["severity"], extra: Partial<Diagnostic> = {}) =>
    ({ range, severity, message: severity, source: null, code: null, ...extra }) as Diagnostic;

  it("reports the marker bar's problems by line and follows them", async () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: "let a = 1;\nlet b = 2;\nfoo(\n  bar);\nend",
        extensions: [
          lspDoc.of({ doc: 1, path: PATH, language: "javascript", uiMode: null, readOnly: false }),
          diagnosticsExtension(),
          editorPanelUpdates,
        ],
      }),
    });
    const handle: TextEditorHandle = {
      view,
      tabId: "t1",
      ctx: { doc: 1, path: PATH, language: "javascript", uiMode: "JavaScript", readOnly: false },
    };
    const panel = new PanelEditor();
    const events: FrameEditorEvent[] = [];
    panel.subscribe((e) => events.push(e));
    panel.bind(handle);
    await nextFrame();
    // Switching to a file: its problems (none yet).
    expect(events).toContainEqual({ editor: "problems", value: [] });

    events.length = 0;
    setFileDiagnostics(PATH, "test", [
      diag(at(2, 0, 3, 6), "error"),
      diag(at(0, 4), "warning"),
      diag(at(1, 4), "info"),
      // Not on the marker bar: hints, unused code.
      diag(at(4, 0), "hint"),
      diag(at(0, 0), "warning", { unnecessary: true }),
    ]);
    await Promise.resolve();
    await nextFrame();
    const shown = [
      { line: 0, lastLine: 0, severity: "warning" },
      { line: 1, lastLine: 1, severity: "weakWarning" },
      { line: 2, lastLine: 3, severity: "error" },
    ];
    expect(panel.problems()).toEqual(shown);
    expect(events.filter((e) => e.editor === "problems")).toEqual([{ editor: "problems", value: shown }]);

    // An edit above moves them.
    events.length = 0;
    view.dispatch({ changes: { from: 0, insert: "\n" } });
    await nextFrame();
    expect(events).toContainEqual({
      editor: "problems",
      value: shown.map((p) => ({ ...p, line: p.line + 1, lastLine: p.lastLine + 1 })),
    });

    // Fixed: gone.
    events.length = 0;
    setFileDiagnostics(PATH, "test", []);
    await Promise.resolve();
    await nextFrame();
    expect(events).toEqual([{ editor: "problems", value: [] }]);

    // Scrolling or selecting alone says nothing.
    events.length = 0;
    view.dispatch({ selection: { anchor: 2 } });
    await nextFrame();
    expect(events.filter((e) => e.editor === "problems")).toEqual([]);

    panel.dispose();
    view.destroy();
  });
});

describe("PanelEditor selections", () => {
  const view = (doc: string) => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    return new EditorView({
      parent,
      state: EditorState.create({
        doc,
        extensions: [EditorState.allowMultipleSelections.of(true), editorPanelUpdates],
      }),
    });
  };
  const handleOf = (v: EditorView, path: string): TextEditorHandle => ({
    view: v,
    tabId: path,
    ctx: { doc: 1, path, language: "javascript", uiMode: "JavaScript", readOnly: false },
  });
  const at = (line: number, column: number) => ({ line, column });

  it("reports the caret and every selection, the main one first, and follows them", async () => {
    // Line 0 is "é😀ab": the emoji takes two UTF-16 columns.
    const a = view("é😀ab\nsecond\nthird");
    const panel = new PanelEditor();
    const events: FrameEditorEvent[] = [];
    panel.subscribe((e) => events.push(e));
    panel.bind(handleOf(a, "/p/a.js"));
    await nextFrame();
    // Showing a file: its caret (at the start).
    expect(events).toContainEqual({ editor: "selections", value: [{ anchor: at(0, 0), head: at(0, 0) }] });

    // Two selections and a caret; the main one (the last) comes first, the others in file order.
    events.length = 0;
    const three = EditorSelection.create(
      [EditorSelection.range(1, 3), EditorSelection.range(12, 7), EditorSelection.cursor(15)],
      2,
    );
    a.dispatch({ selection: three });
    const shown = [
      { anchor: at(2, 2), head: at(2, 2) },
      { anchor: at(0, 1), head: at(0, 3) },
      { anchor: at(1, 6), head: at(1, 1) },
    ];
    expect(panel.selections()).toEqual(shown);
    // Several moves in one frame: one event.
    a.dispatch({ selection: EditorSelection.cursor(0) });
    a.dispatch({ selection: three });
    await nextFrame();
    expect(events.filter((e) => e.editor === "selections")).toEqual([{ editor: "selections", value: shown }]);

    // An edit above moves the caret to another line.
    events.length = 0;
    a.dispatch({ changes: { from: 0, insert: "\n" }, selection: EditorSelection.cursor(1) });
    await nextFrame();
    expect(events).toContainEqual({ editor: "selections", value: [{ anchor: at(1, 0), head: at(1, 0) }] });

    // Scrolling alone says nothing.
    events.length = 0;
    a.scrollDOM.dispatchEvent(new Event("scroll"));
    await nextFrame();
    expect(events.filter((e) => e.editor === "selections")).toEqual([]);

    // Another file: its selections.
    const b = view("x\ny");
    b.dispatch({ selection: EditorSelection.range(0, 3) });
    events.length = 0;
    panel.bind(handleOf(b, "/p/b.js"));
    await nextFrame();
    expect(events).toContainEqual({ editor: "selections", value: [{ anchor: at(0, 0), head: at(1, 1) }] });

    panel.bind(null);
    expect(panel.selections()).toEqual([]);
    panel.dispose();
    a.destroy();
    b.destroy();
  });
});

describe("PanelEditor changes", () => {
  const hunk = (kind: LineHunk["kind"], start: number, lines: number): LineHunk => ({
    kind,
    start,
    lines,
    oldStart: start,
    oldLines: kind === "added" ? 0 : 1,
    oldText: kind === "added" ? "" : "old\n",
  });

  it("reports the change lane's hunks by line and follows them", async () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({ doc: "a\nb\nc\nd\ne\nf", extensions: [hunkField, editorPanelUpdates] }),
    });
    const handle: TextEditorHandle = {
      view,
      tabId: "t1",
      ctx: { doc: 1, path: "/p/src/a.js", language: "javascript", uiMode: "JavaScript", readOnly: false },
    };
    const panel = new PanelEditor();
    const events: FrameEditorEvent[] = [];
    panel.subscribe((e) => events.push(e));
    panel.bind(handle);
    await nextFrame();
    // Showing a file: its changes (none yet, as outside version control).
    expect(events).toContainEqual({ editor: "changes", value: [] });

    events.length = 0;
    view.dispatch({ effects: setHunksEffect.of([hunk("added", 0, 1), hunk("modified", 2, 2), hunk("deleted", 5, 0)]) });
    const shown = [
      { line: 0, lastLine: 0, kind: "added" },
      { line: 2, lastLine: 3, kind: "modified" },
      // Deleted above line 5: marked on line 5.
      { line: 5, lastLine: 5, kind: "deleted" },
    ];
    expect(panel.changes()).toEqual(shown);
    await nextFrame();
    expect(events.filter((e) => e.editor === "changes")).toEqual([{ editor: "changes", value: shown }]);

    // An edit above moves them; deleting the added line leaves a deletion, as the lane shows it.
    events.length = 0;
    view.dispatch({ changes: { from: 0, to: 2 } });
    await nextFrame();
    expect(events.filter((e) => e.editor === "changes")).toEqual([
      {
        editor: "changes",
        value: [
          { line: 0, lastLine: 0, kind: "deleted" },
          { line: 1, lastLine: 2, kind: "modified" },
          { line: 4, lastLine: 4, kind: "deleted" },
        ],
      },
    ]);

    // Moving the caret alone says nothing.
    events.length = 0;
    view.dispatch({ selection: { anchor: 1 } });
    await nextFrame();
    expect(events.filter((e) => e.editor === "changes")).toEqual([]);

    // No changes any more.
    events.length = 0;
    view.dispatch({ effects: setHunksEffect.of([]) });
    await nextFrame();
    expect(events).toEqual([{ editor: "changes", value: [] }]);

    panel.dispose();
    view.destroy();
  });
});

describe("PanelEditor tab size", () => {
  it("reports the editor's tab size and the new one when it changes", async () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const indent = new Compartment();
    const view = new EditorView({
      parent,
      state: EditorState.create({ doc: "\tx", extensions: [indent.of(EditorState.tabSize.of(2)), editorPanelUpdates] }),
    });
    const handle: TextEditorHandle = {
      view,
      tabId: "t1",
      ctx: { doc: 1, path: "/p/src/a.go", language: "go", uiMode: "Go", readOnly: false },
    };
    const panel = new PanelEditor();
    const events: FrameEditorEvent[] = [];
    panel.subscribe((e) => events.push(e));
    panel.bind(handle);
    expect(panel.get()).toMatchObject({ path: "/p/src/a.go", tabSize: 2 });
    await nextFrame();

    // A settings or `.editorconfig` change: `onTarget` again, once a frame.
    events.length = 0;
    view.dispatch({ effects: indent.reconfigure(EditorState.tabSize.of(8)) });
    view.dispatch({ effects: indent.reconfigure(EditorState.tabSize.of(3)) });
    await nextFrame();
    expect(events.filter((e) => e.editor === "target")).toEqual([
      { editor: "target", value: { path: "/p/src/a.go", language: "go", version: 1, lineCount: 1, tabSize: 3 } },
    ]);

    // The same size again, or an edit: no new target.
    events.length = 0;
    view.dispatch({ effects: indent.reconfigure(EditorState.tabSize.of(3)) });
    view.dispatch({ changes: { from: 0, insert: "y" } });
    await nextFrame();
    expect(events.filter((e) => e.editor === "target")).toEqual([]);

    panel.dispose();
    view.destroy();
  });
});

describe("editorPanels projection", () => {
  it("shows the panel only while `editor.read` is granted and `when` holds", () => {
    const plugin = (granted: boolean) =>
      ({ id: "acme.map", capabilities: [{ id: "editor.read", granted }] }) as unknown as PluginInfo;
    usePlugins.setState({ plugins: [plugin(true)] });
    const shown = () => useEditorGroupPanels.getState().panels.get("plugin.acme.map.minimap")?.width;
    const dispose = projectEditorPanel("acme.map", {
      id: "minimap",
      web: "web/index.html",
      width: 110,
      when: "plugin.acme.map.enabled",
    });
    expect(shown()).toBeUndefined();
    setContext("plugin.acme.map.enabled", true);
    expect(shown()).toBe(110);
    usePlugins.setState({ plugins: [plugin(false)] });
    expect(shown()).toBeUndefined();
    usePlugins.setState({ plugins: [plugin(true)] });
    expect(shown()).toBe(110);
    dispose();
    expect(shown()).toBeUndefined();
    setContext("plugin.acme.map.enabled", false);
  });
});
