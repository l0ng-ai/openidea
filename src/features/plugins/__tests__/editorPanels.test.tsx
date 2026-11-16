import { afterEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { javascript } from "@codemirror/lang-javascript";
import { syntaxHighlighting } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { PluginInfo } from "@/bindings";
import type { TextEditorHandle } from "@/editor/api";
import { openideaHighlightStyle } from "@/editor/core/cm/highlight";
import { setContext } from "@/platform/context";
import { useEditorGroupPanels } from "@/workbench/contributions";
import { createMemoryPluginsBackend, setPluginsBackend } from "../backend";
import { usePlugins } from "../store";
import { FRAME_TAG, frameDocument } from "../views/frame";
import { PanelEditor, editorPanelUpdates, projectEditorPanel } from "../views/editorPanel";
import { WebView, type FrameEditor, type FrameEditorEvent } from "../views/WebView";

afterEach(() => {
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
      onTarget(fn: (v: unknown) => void): void;
      onViewport(fn: (v: unknown) => void): void;
      onHighlights(fn: (v: unknown) => void): void;
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

    const events: unknown[] = [];
    editor.onTarget((v) => events.push(["target", v]));
    editor.onViewport((v) => events.push(["viewport", v]));
    editor.onHighlights((v) => events.push(["highlights", v]));
    send({ editor: "target", value: null });
    send({ editor: "viewport", value: { firstLine: 1.5 } });
    send({ editor: "highlights", value: { fromLine: 0, toLine: 4 } });
    send({ editor: "constructor", value: 1 });
    expect(events).toEqual([
      ["target", null],
      ["viewport", { firstLine: 1.5 }],
      ["highlights", { fromLine: 0, toLine: 4 }],
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
      get: () => ({ path: "/p/a.ts", language: "typescript", version: 2, lineCount: 3 }),
      viewport: () => ({ firstLine: 0, lastLine: 2.5, lineCount: 3, scrollTop: 0, scrollHeight: 60, clientHeight: 50 }),
      scrollTo: (line) => void calls.push(["scrollTo", line]),
      scrollBy: (px) => void calls.push(["scrollBy", px]),
      highlights: (from, to) => {
        calls.push(["highlights", from, to]);
        return [[{ from: 0, to: 5, color: "rgb(1, 2, 3)" }]];
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
    expect((await reply(1)).value).toEqual({ path: "/p/a.ts", language: "typescript", version: 2, lineCount: 3 });
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
      value: { path: "/p/src/a.js", language: "javascript", version: 1, lineCount: 3 },
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
