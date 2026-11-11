import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Compartment, EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { closeHoverTooltips, EditorView, hoverTooltip } from "@codemirror/view";
import type { PluginEvent, PluginInfo, UiContribution } from "@/bindings";
import { loadMarkdown } from "@/editor/lsp/markdown";
import { provideEditorService, type EditorService } from "@/workbench/contributions";
import { emitLocalIdeEvent } from "@/platform/ipc";
import { editorContributions, useEditorRegistry, type EditorDocContext } from "@/editor/api";
import { pluginsBackend, setPluginsBackend } from "./backend";
import { clearUiContributions, syncUiContributions } from "./projection";
import { defineEditorAnnotationsPoint } from "./editorAnnotations";

const item = {
  pluginId: "example.annotations",
  point: "editorAnnotations",
  key: "attribution",
  decl: {
    id: "attribution",
    command: "annotations.snapshot",
    refreshView: "annotations",
    protocol: 1,
  },
} satisfies UiContribution;
const plugin = { id: item.pluginId } as PluginInfo;
const listeners = new Set<(event: PluginEvent) => void>();
const views: EditorView[] = [];
const disposers: (() => void)[] = [];
const runCommand = vi.fn();

function snapshot(raw: string, overrides: Record<string, unknown> = {}) {
  const request = JSON.parse(raw);
  return JSON.stringify({
    schemaVersion: 1,
    requestId: request.requestId,
    path: request.path,
    documentVersion: 1,
    state: "ready",
    mode: "line",
    lines: [
      { line: 0, promptId: "a" },
      { line: 1, promptId: "b" },
    ],
    prompts: [
      {
        id: "a",
        label: "model-A",
        markdown: "**Prompt A**",
        hasMessages: true,
      },
      {
        id: "b",
        label: "model-B",
        markdown: "**Prompt B**",
        hasMessages: true,
      },
    ],
    ...overrides,
  });
}

function editor(text = "alpha\nbeta\nhuman", path = "/project/file.ts", extra: Extension = []) {
  const ctx: EditorDocContext = {
    doc: 1,
    path,
    language: "typescript",
    uiMode: "JavaScript",
    readOnly: false,
  };
  const slot = new Compartment();
  const extensions = () => editorContributions().map((c) => c.extensions(ctx));
  const parent = document.body.appendChild(document.createElement("div"));
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: text,
      extensions: [slot.of(extensions()), extra],
    }),
  });
  views.push(view);
  disposers.push(
    useEditorRegistry.subscribe((s, prev) => {
      if (s.contributions !== prev.contributions) view.dispatch({ effects: slot.reconfigure(extensions()) });
    }),
  );
  return view;
}

async function hover(view: EditorView, target = view.dom.querySelector(".cm-editor-annotation")!) {
  target.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 400, clientY: 10 }));
  await vi.advanceTimersByTimeAsync(400);
}

beforeAll(async () => {
  await loadMarkdown();
});

beforeEach(() => {
  vi.useFakeTimers();
  runCommand.mockReset().mockImplementation((_plugin, _command, raw) => Promise.resolve(snapshot(raw)));
  setPluginsBackend({
    ...pluginsBackend(),
    runCommand,
    onEvent: (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  });
  disposers.push(defineEditorAnnotationsPoint());
  syncUiContributions([item], [plugin]);
});

afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose();
  for (const view of views.splice(0)) view.destroy();
  clearUiContributions();
  listeners.clear();
  setPluginsBackend(null);
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe("editor annotations through host snapshots and editor events", () => {
  it.each(["line", "all"])("keeps ready no-AI %s empty state distinct from unavailable and off", async (mode) => {
    const message = "No AI attribution for this document.";
    runCommand.mockImplementationOnce((_p, _c, raw) =>
      Promise.resolve(
        snapshot(raw, {
          mode,
          message,
          lines: [],
          prompts: [],
        }),
      ),
    );
    const view = editor();
    await vi.advanceTimersByTimeAsync(350);
    expect(view.dom.querySelector(".cm-editor-annotation")).toBeNull();
    expect(view.dom.querySelector('[role="status"]')?.textContent).toBe(message);
    expect(view.dom.textContent).not.toContain("Annotations unavailable");
    runCommand.mockImplementationOnce((_p, _c, raw) =>
      Promise.resolve(
        snapshot(raw, {
          mode: "off",
          message: "Annotations disabled.",
          lines: [],
          prompts: [],
        }),
      ),
    );
    listeners.forEach((fn) =>
      fn({
        type: "viewChanged",
        pluginId: item.pluginId,
        view: "annotations",
      }),
    );
    await vi.advanceTimersByTimeAsync(350);
    expect(
      view.dom.querySelector(".cm-editor-annotation, .cm-editor-annotation-status, .cm-editor-annotation-tooltip"),
    ).toBeNull();
    expect(runCommand).toHaveBeenCalledTimes(2);
  });

  it("highlights the generated-model label instead of muted body text", async () => {
    const view = editor();
    await vi.advanceTimersByTimeAsync(350);
    const label = view.dom.querySelector<HTMLElement>(".cm-editor-annotation");
    expect(label?.textContent).toBe(" + model-A");
    expect(label?.style.color).toBe("var(--accent)");
    expect(label?.style.fontWeight).toBe("600");
  });

  it("does not invent a failure message for an empty ready response without a protocol message", async () => {
    runCommand.mockImplementationOnce((_p, _c, raw) => Promise.resolve(snapshot(raw, { lines: [], prompts: [] })));
    const view = editor();
    await vi.advanceTimersByTimeAsync(350);
    expect(view.dom.querySelector(".cm-editor-annotation, [role=status]")).toBeNull();
    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  it("shows a successful conversation's budget message and clears it on the next snapshot", async () => {
    const message = "Conversation body truncated; attribution is complete.";
    runCommand
      .mockImplementationOnce((_p, _c, raw) =>
        Promise.resolve(
          snapshot(raw, {
            prompts: [
              {
                id: "a",
                label: "model-A",
                markdown: "Prompt A",
                hasMessages: false,
              },
              {
                id: "b",
                label: "model-B",
                markdown: "Prompt B",
                hasMessages: true,
              },
            ],
          }),
        ),
      )
      .mockImplementationOnce((_p, _c, raw) => Promise.resolve(snapshot(raw, { message })));
    const view = editor();
    await vi.advanceTimersByTimeAsync(350);
    await hover(view);
    expect(view.dom.querySelector('.cm-editor-annotation-tooltip [role="status"]')?.textContent).toBe(message);
    expect(view.dom.querySelector('.cm-editor-annotation-status[role="status"]')?.textContent).toBe(message);
    expect(view.dom.querySelector(".cm-editor-annotation")?.textContent).toBe(" + model-A");
    expect(runCommand).toHaveBeenCalledTimes(2);
    emitLocalIdeEvent({ type: "settingsChanged", key: "plugins" });
    await vi.advanceTimersByTimeAsync(350);
    expect(view.dom.querySelector(".cm-editor-annotation-status, .cm-editor-annotation-tooltip")).toBeNull();
    expect(view.dom.querySelector(".cm-editor-annotation")?.textContent).toBe(" + model-A");
  });

  it("preserves first-line fenced and inline code literally without consuming the next role heading", async () => {
    const code = String.raw`const value = "[]\\<>&";`;
    const markdown = [
      "```text",
      code,
      "```",
      "",
      "### Assistant",
      "",
      "`" + code + "`",
      "",
      '<img src=x onerror="alert(1)"><script>alert(1)</script><style>body{display:none}</style>',
    ].join("\n");
    runCommand.mockImplementationOnce((_p, _c, raw) =>
      Promise.resolve(
        snapshot(raw, {
          lines: [{ line: 0, promptId: "a" }],
          prompts: [{ id: "a", label: "model-A", markdown, hasMessages: true }],
        }),
      ),
    );
    const view = editor();
    await vi.advanceTimersByTimeAsync(350);
    await hover(view);
    const card = view.dom.querySelector(".cm-editor-annotation-tooltip")!;
    expect(card.querySelector("pre code")?.textContent).toBe(code);
    expect(card.querySelector("p > code")?.textContent).toBe(code);
    expect(card.querySelector("h3")?.textContent).toBe("Assistant");
    expect(card.querySelector("pre h3")).toBeNull();
    expect(card.querySelector("script, style, [onerror], [onclick]")).toBeNull();
  });

  it.each(["line", "all"])("shows the protocol budget notice alongside %s labels and in their hover", async (mode) => {
    const message =
      "Conversation bodies truncated to fit the 1 MiB annotation response limit; attribution is complete. <b>notice</b>";
    runCommand.mockImplementationOnce((_p, _c, raw) => Promise.resolve(snapshot(raw, { mode, message })));
    const view = editor();
    await vi.advanceTimersByTimeAsync(350);
    expect(view.dom.querySelectorAll(".cm-editor-annotation")).toHaveLength(mode === "all" ? 2 : 1);
    expect(view.dom.querySelector('.cm-editor-annotation-status[role="status"]')?.textContent).toBe(message);
    expect(view.dom.querySelector(".cm-editor-annotation-status b")).toBeNull();
    await hover(view);
    expect(view.dom.querySelector('.cm-editor-annotation-tooltip [role="status"]')?.textContent).toBe(message);
    expect(view.dom.querySelector(".cm-editor-annotation-tooltip b")).toBeNull();
  });

  it("retries a canceled queued hover once when reopened, without treating cancellation as failure", async () => {
    const prompts = ["a", "b", "c"].map((id) => ({
      id,
      label: id,
      markdown: id,
      hasMessages: false,
    }));
    const data = {
      mode: "all",
      lines: prompts.map((p, line) => ({ line, promptId: p.id })),
      prompts,
    };
    let resolveA!: (value: string) => void;
    runCommand.mockImplementation((_p, _c, raw) => {
      const request = JSON.parse(raw);
      if (request.operation === "snapshot") return Promise.resolve(snapshot(raw, data));
      if (request.promptId === "a")
        return new Promise<string>((done) => {
          resolveA = done;
        });
      return Promise.resolve(
        snapshot(raw, {
          ...data,
          prompts: prompts.map((p) => ({
            ...p,
            hasMessages: p.id !== "b" || request.promptId === "b",
            markdown: p.id === "b" && request.promptId === "b" ? "B conversation" : p.markdown,
          })),
        }),
      );
    });
    const view = editor();
    await vi.advanceTimersByTimeAsync(350);
    await hover(view, view.dom.querySelector('[data-prompt-id="a"]')!);
    await hover(view, view.dom.querySelector('[data-prompt-id="b"]')!);
    await hover(view, view.dom.querySelector('[data-prompt-id="c"]')!);
    resolveA(
      snapshot(runCommand.mock.calls[1]![2], {
        ...data,
        prompts: prompts.map((p) => ({ ...p, hasMessages: p.id === "a" })),
      }),
    );
    await vi.advanceTimersByTimeAsync(1);
    expect(runCommand).toHaveBeenCalledTimes(3);
    await hover(view, view.dom.querySelector('[data-prompt-id="b"]')!);
    expect(runCommand).toHaveBeenCalledTimes(4);
    expect(JSON.parse(runCommand.mock.calls[3]![2]).promptId).toBe("b");
    expect(view.dom.querySelector(".cm-editor-annotation-tooltip")?.textContent).toContain("B conversation");
    await hover(view, view.dom.querySelector('[data-prompt-id="c"]')!);
    await hover(view, view.dom.querySelector('[data-prompt-id="b"]')!);
    expect(runCommand).toHaveBeenCalledTimes(4);
  });
  it("accepts the full u64 document version without lossy number comparisons", async () => {
    runCommand.mockImplementationOnce((_p, _c, raw) =>
      Promise.resolve(snapshot(raw).replace('"documentVersion":1', '"documentVersion":18446744073709551615')),
    );
    const view = editor();
    await vi.advanceTimersByTimeAsync(350);
    expect(view.dom.querySelector(".cm-editor-annotation")?.textContent).toBe(" + model-A");
  });
  it("uses the main selection HEAD rather than range start or a secondary cursor", async () => {
    const view = editor("alpha\nbeta\nhuman", "/project/file.ts", EditorState.allowMultipleSelections.of(true));
    await vi.advanceTimersByTimeAsync(350);
    view.dispatch({
      selection: EditorSelection.create([EditorSelection.range(0, 8), EditorSelection.cursor(13)], 0),
    });
    expect(view.dom.querySelector(".cm-editor-annotation")?.textContent).toBe(" + model-B");
    view.dispatch({
      selection: EditorSelection.create([EditorSelection.range(8, 0), EditorSelection.cursor(13)], 0),
    });
    expect(view.dom.querySelector(".cm-editor-annotation")?.textContent).toBe(" + model-A");
    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  it.each(["unavailable", "stale"])("clears cached attribution and exposes %s as bounded status", async (state) => {
    const view = editor();
    await vi.advanceTimersByTimeAsync(350);
    await hover(view);
    const message = "<b>Protocol detail</b>".repeat(500);
    runCommand.mockImplementationOnce((_p, _c, raw) => Promise.resolve(snapshot(raw, { state, message })));
    listeners.forEach((fn) =>
      fn({
        type: "viewChanged",
        pluginId: item.pluginId,
        view: "annotations",
      }),
    );
    expect(view.dom.querySelector(".cm-editor-annotation")).toBeNull();
    expect(view.dom.querySelector(".cm-editor-annotation-tooltip")).toBeNull();
    await vi.advanceTimersByTimeAsync(350);
    expect(view.dom.querySelector('[role="status"]')?.textContent).toBe(
      state === "stale" ? "Annotations stale" : "Annotations unavailable",
    );
    expect(
      [...view.dom.querySelectorAll('.cm-editor-annotation-status[role="status"]')].map((node) => node.textContent),
    ).toEqual([state === "stale" ? "Annotations stale" : "Annotations unavailable", message]);
    expect(view.dom.querySelector(".cm-editor-annotation-status b")).toBeNull();
  });

  it.each([null, "not JSON", "[]", "null"])("clears annotations on a non-snapshot result: %j", async (raw) => {
    runCommand.mockResolvedValueOnce(raw);
    const view = editor();
    await vi.advanceTimersByTimeAsync(350);
    expect(view.dom.querySelector(".cm-editor-annotation")).toBeNull();
    expect(view.dom.querySelector('[role="status"]')?.textContent).toBe("Annotations unavailable");
  });

  it("does not send an over-1MiB UTF-8 document, then recovers after a smaller edit", async () => {
    const view = editor("界".repeat(350_000));
    await vi.advanceTimersByTimeAsync(350);
    expect(runCommand).not.toHaveBeenCalled();
    expect(view.dom.querySelector('[role="status"]')?.textContent).toBe("Annotations unavailable");
    view.dispatch({
      changes: {
        from: 0,
        to: view.state.doc.length,
        insert: "alpha\nbeta\nhuman",
      },
    });
    await vi.advanceTimersByTimeAsync(300);
    expect(view.dom.querySelector(".cm-editor-annotation")?.textContent).toBe(" + model-A");
    const request = JSON.parse(runCommand.mock.calls[0]![2]);
    expect(request.schemaVersion).toBe(1);
    expect(request.requestId.length).toBeLessThanOrEqual(128);
  });

  it("reports conversation failure once without retrying on repeated hover", async () => {
    runCommand
      .mockImplementationOnce((_p, _c, raw) =>
        Promise.resolve(
          snapshot(raw, {
            prompts: [
              {
                id: "a",
                label: "model-A",
                markdown: "Prompt A",
                hasMessages: false,
              },
              {
                id: "b",
                label: "model-B",
                markdown: "Prompt B",
                hasMessages: true,
              },
            ],
          }),
        ),
      )
      .mockRejectedValueOnce(new Error("do not display backend secrets"));
    const view = editor();
    await vi.advanceTimersByTimeAsync(350);
    await hover(view);
    expect(view.dom.querySelector(".cm-editor-annotation-tooltip")?.textContent).toContain("Conversation unavailable");
    expect(view.dom.textContent).not.toContain("backend secrets");
    view.dispatch({ selection: { anchor: 6 } });
    view.dispatch({ selection: { anchor: 0 } });
    await hover(view);
    expect(view.dom.querySelector(".cm-editor-annotation-tooltip")?.textContent).toContain("Conversation unavailable");
    expect(runCommand).toHaveBeenCalledTimes(2);
  });

  it("rejects old refresh results and never applies responses after disable or destroy", async () => {
    const resolvers: ((value: string) => void)[] = [];
    runCommand.mockImplementation(() => new Promise<string>((done) => resolvers.push(done)));
    const view = editor();
    await vi.advanceTimersByTimeAsync(1);
    listeners.forEach((fn) => fn({ type: "viewChanged", pluginId: item.pluginId, view: "annotations" }));
    await vi.advanceTimersByTimeAsync(1);
    expect(runCommand).toHaveBeenCalledTimes(1);
    resolvers[0]!(snapshot(runCommand.mock.calls[0]![2]));
    await vi.advanceTimersByTimeAsync(1);
    expect(runCommand).toHaveBeenCalledTimes(2);
    expect(view.dom.querySelector(".cm-editor-annotation")).toBeNull();
    syncUiContributions([], [plugin]);
    resolvers[1]!(snapshot(runCommand.mock.calls[1]![2]));
    await vi.advanceTimersByTimeAsync(350);
    expect(view.dom.querySelector(".cm-editor-annotation")).toBeNull();
    syncUiContributions([item], [plugin]);
    await vi.advanceTimersByTimeAsync(1);
    view.destroy();
    resolvers[2]!(snapshot(runCommand.mock.calls[2]![2]));
    await vi.advanceTimersByTimeAsync(350);
    expect(document.querySelector(".cm-editor-annotation")).toBeNull();
  });

  it("cancels a closed hover without treating cancellation as a failed conversation", async () => {
    let conversations = 0;
    runCommand.mockImplementation((_p, _c, raw, _editor, _paths, _scope, _chain, signal?: AbortSignal) => {
      const request = JSON.parse(raw);
      if (request.operation === "conversation" && ++conversations === 1)
        return new Promise<string>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true });
        });
      return Promise.resolve(
        snapshot(raw, {
          prompts: [
            { id: "a", label: "A", markdown: "Conversation A", hasMessages: request.operation === "conversation" },
            { id: "b", label: "B", markdown: "B", hasMessages: false },
          ],
        }),
      );
    });
    const view = editor();
    await vi.advanceTimersByTimeAsync(350);
    await hover(view);
    expect(runCommand).toHaveBeenCalledTimes(2);
    view.dispatch({ effects: closeHoverTooltips });
    await vi.advanceTimersByTimeAsync(1);
    expect(runCommand).toHaveBeenCalledTimes(2);
    await hover(view);
    expect(runCommand).toHaveBeenCalledTimes(3);
    expect(view.dom.querySelector(".cm-editor-annotation-tooltip")?.textContent).not.toContain(
      "Conversation unavailable",
    );
  });

  it("cancels a conversation when the caret moves and loads the newly hovered prompt", async () => {
    const prompts = ["a", "b"].map((id) => ({ id, label: id, markdown: id, hasMessages: false }));
    runCommand.mockImplementation((_p, _c, raw, _editor, _paths, _scope, _chain, signal?: AbortSignal) => {
      const request = JSON.parse(raw);
      if (request.operation === "conversation" && request.promptId === "a")
        return new Promise<string>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true });
        });
      return Promise.resolve(
        snapshot(raw, {
          prompts: prompts.map((prompt) => ({ ...prompt, hasMessages: request.promptId === prompt.id })),
        }),
      );
    });
    const view = editor();
    await vi.advanceTimersByTimeAsync(350);
    await hover(view);
    expect(runCommand).toHaveBeenCalledTimes(2);
    view.dispatch({ selection: { anchor: 6 } });
    await hover(view);
    expect(runCommand).toHaveBeenCalledTimes(3);
    expect(JSON.parse(runCommand.mock.calls[2]![2]).promptId).toBe("b");
    expect(view.dom.querySelector(".cm-editor-annotation-tooltip")?.textContent).not.toContain(
      "Conversation unavailable",
    );
  });

  it("cancels an obsolete snapshot and refreshes the edited buffer after the debounce", async () => {
    runCommand.mockImplementationOnce(
      (_p, _c, _raw, _editor, _paths, _scope, _chain, signal?: AbortSignal) =>
        new Promise<string>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true });
        }),
    );
    const view = editor();
    await vi.advanceTimersByTimeAsync(1);
    view.dispatch({ changes: { from: 0, to: 5, insert: "edited" } });
    await vi.advanceTimersByTimeAsync(299);
    expect(runCommand).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(runCommand).toHaveBeenCalledTimes(2);
    expect(JSON.parse(runCommand.mock.calls[1]![2]).documentText).toBe("edited\nbeta\nhuman");
    expect(view.dom.querySelector(".cm-editor-annotation")?.textContent).toContain("model-A");
  });

  it("cancels a disposed editor request so another editor can use the command lane", async () => {
    runCommand.mockImplementationOnce(
      (_p, _c, _raw, _editor, _paths, _scope, _chain, signal?: AbortSignal) =>
        new Promise<string>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true });
        }),
    );
    const first = editor("first\nbeta\nhuman");
    await vi.advanceTimersByTimeAsync(1);
    const second = editor("second\nbeta\nhuman", "/project/other.ts");
    await vi.advanceTimersByTimeAsync(1);
    expect(runCommand).toHaveBeenCalledTimes(1);
    first.destroy();
    await vi.advanceTimersByTimeAsync(1);
    expect(runCommand).toHaveBeenCalledTimes(2);
    expect(second.dom.querySelector(".cm-editor-annotation")?.textContent).toContain("model-A");
  });

  it("isolates same-URI split views and their UTF-16 editor context with only one command in flight", async () => {
    let resolve!: (value: string) => void;
    runCommand.mockImplementationOnce(
      () =>
        new Promise<string>((done) => {
          resolve = done;
        }),
    );
    const a = editor("a😀a\nbeta\nhuman");
    const b = editor("second\nbeta\nhuman");
    a.dispatch({ selection: { anchor: 3 } });
    b.dispatch({ selection: { anchor: 7 } });
    await vi.advanceTimersByTimeAsync(1);
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(runCommand.mock.calls[0]![3]).toMatchObject({
      path: "/project/file.ts",
      selections: [{ start: { line: 0, col: 3 }, end: { line: 0, col: 3 } }],
    });
    expect(runCommand.mock.calls[0]![7]).toBeInstanceOf(AbortSignal);
    expect(runCommand.mock.calls[0]![4]).toEqual([]);
    expect(runCommand.mock.calls[0]!.slice(0, 2)).toEqual([item.pluginId, item.decl.command]);
    resolve(snapshot(runCommand.mock.calls[0]![2]));
    await vi.advanceTimersByTimeAsync(1);
    expect(runCommand).toHaveBeenCalledTimes(2);
    expect(JSON.parse(runCommand.mock.calls[1]![2]).documentText).toBe("second\nbeta\nhuman");
    expect(runCommand.mock.calls[1]![3]).toMatchObject({
      selections: [{ start: { line: 1, col: 0 }, end: { line: 1, col: 0 } }],
    });
    expect(a.dom.querySelector(".cm-editor-annotation")?.textContent).toBe(" + model-A");
    expect(b.dom.querySelector(".cm-editor-annotation")?.textContent).toBe(" + model-B");
    await hover(a);
    await hover(b);
    expect(a.dom.querySelector(".cm-editor-annotation-tooltip")?.textContent).toContain("Prompt A");
    expect(b.dom.querySelector(".cm-editor-annotation-tooltip")?.textContent).toContain("Prompt B");
  });
  it("renders labels as text, sanitizes untrusted Markdown, and blocks file/jdt/command links", async () => {
    const openFile = vi.fn();
    provideEditorService({ openFile } as unknown as EditorService);
    runCommand.mockImplementationOnce((_p, _c, raw) =>
      Promise.resolve(
        snapshot(raw, {
          lines: [{ line: 0, promptId: "a" }],
          prompts: [
            {
              id: "a",
              label: '<img src=x onerror="alert(1)">',
              hasMessages: true,
              markdown:
                '<img src=x onerror="alert(1)"><b>raw</b> **safe bold** [source](file:///secret) [class](jdt://source) [run](command:delete) [site](https://example.test)',
            },
          ],
        }),
      ),
    );
    const view = editor();
    await vi.advanceTimersByTimeAsync(350);
    await hover(view);
    const card = view.dom.querySelector(".cm-editor-annotation-tooltip")!;
    expect(card.querySelector("script, style, [onerror], [onclick]")).toBeNull();
    expect(view.dom.querySelector(".cm-editor-annotation img")).toBeNull();
    expect(card.querySelector("strong")?.textContent).toBe("safe bold");
    for (const link of card.querySelectorAll("a"))
      link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(openFile).not.toHaveBeenCalled();
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(card.querySelector('a[href="https://example.test"]')).not.toBeNull();
  });
  it("hydrates only on hover, queues B behind A, and never shows a late A conversation on B", async () => {
    const prompts = [
      { id: "a", label: "model-A", markdown: "Prompt A", hasMessages: false },
      { id: "b", label: "model-B", markdown: "Prompt B", hasMessages: false },
    ];
    let resolveA!: (value: string) => void;
    runCommand.mockImplementation((_p, _c, raw) => {
      const request = JSON.parse(raw);
      if (request.operation === "snapshot") return Promise.resolve(snapshot(raw, { prompts }));
      if (request.promptId === "a")
        return new Promise<string>((done) => {
          resolveA = done;
        });
      return Promise.resolve(
        snapshot(raw, {
          prompts: prompts.map((p) => ({
            ...p,
            hasMessages: true,
            markdown: `${p.markdown} conversation`,
          })),
        }),
      );
    });
    const view = editor();
    await vi.advanceTimersByTimeAsync(350);
    view.dispatch({ selection: { anchor: 6 } });
    view.dispatch({ selection: { anchor: 0 } });
    expect(runCommand).toHaveBeenCalledTimes(1);
    await hover(view);
    expect(view.dom.querySelector(".cm-editor-annotation-tooltip")?.textContent).toContain("Loading conversation…");
    expect(runCommand).toHaveBeenCalledTimes(2);
    expect(JSON.parse(runCommand.mock.calls[1]![2]).operation).toBe("conversation");
    view.dispatch({ selection: { anchor: 6 } });
    await hover(view);
    expect(runCommand).toHaveBeenCalledTimes(2);
    resolveA(
      snapshot(runCommand.mock.calls[1]![2], {
        prompts: prompts.map((p) => ({
          ...p,
          hasMessages: true,
          markdown: "LATE A",
        })),
      }),
    );
    await vi.advanceTimersByTimeAsync(1);
    expect(runCommand).toHaveBeenCalledTimes(3);
    expect(JSON.parse(runCommand.mock.calls[2]![2]).promptId).toBe("b");
    expect(view.dom.querySelector(".cm-editor-annotation-tooltip")?.textContent).toContain("Prompt B conversation");
    expect(view.dom.textContent).not.toContain("LATE A");
  });
  it.each([
    { schemaVersion: 2 },
    { requestId: "wrong" },
    { path: "/other.ts" },
    { documentVersion: -1 },
    { documentVersion: 1.5 },
    { documentVersion: 2 ** 64 },
    { state: "unknown" },
    { mode: "unknown" },
    { message: {} },
    { extra: "unknown" },
    { lines: [{ line: -1, promptId: "a" }] },
    { lines: [{ line: 3, promptId: "a" }] },
    { lines: [{ line: 0.5, promptId: "a" }] },
    { lines: [{ line: 0, promptId: "missing" }] },
    {
      lines: [
        { line: 0, promptId: "a" },
        { line: 0, promptId: "b" },
      ],
    },
    {
      prompts: [
        { id: "a", label: "A", markdown: "A", hasMessages: true },
        { id: "a", label: "B", markdown: "B", hasMessages: true },
      ],
    },
    { prompts: [{ id: "a", label: {}, markdown: "A", hasMessages: true }] },
    { prompts: [{ id: "a", label: "A", markdown: "A", hasMessages: "true" }] },
    { message: "界".repeat(350_000) },
  ])("rejects malformed snapshots with visible bounded unavailable status: %j", async (invalid) => {
    runCommand.mockImplementationOnce((_p, _c, raw) => Promise.resolve(snapshot(raw, invalid)));
    const view = editor();
    await vi.advanceTimersByTimeAsync(350);
    expect(view.dom.querySelector(".cm-editor-annotation")).toBeNull();
    expect(view.dom.querySelector('[role="status"]')?.textContent).toBe("Annotations unavailable");
  });

  it("refreshes only matching plugin views and saved settings, clears off and disabled annotations", async () => {
    runCommand.mockImplementationOnce((_p, _c, raw) => Promise.resolve(snapshot(raw, { mode: "all" })));
    const view = editor();
    await vi.advanceTimersByTimeAsync(350);
    expect(view.dom.querySelectorAll(".cm-editor-annotation")).toHaveLength(2);
    for (const event of [
      { type: "viewChanged", pluginId: "other", view: "annotations" },
      { type: "viewChanged", pluginId: item.pluginId, view: "other" },
    ] as PluginEvent[])
      listeners.forEach((fn) => fn(event));
    await vi.advanceTimersByTimeAsync(350);
    expect(runCommand).toHaveBeenCalledTimes(1);
    runCommand.mockImplementationOnce((_p, _c, raw) => Promise.resolve(snapshot(raw, { mode: "off" })));
    listeners.forEach((fn) => fn({ type: "viewChanged", pluginId: item.pluginId, view: "annotations" }));
    await vi.advanceTimersByTimeAsync(350);
    expect(runCommand).toHaveBeenCalledTimes(2);
    expect(view.dom.querySelector(".cm-editor-annotation")).toBeNull();
    emitLocalIdeEvent({ type: "settingsChanged", key: "plugins" });
    await vi.advanceTimersByTimeAsync(350);
    expect(view.dom.querySelector(".cm-editor-annotation")?.textContent).toBe(" + model-A");
    await hover(view);
    expect(view.dom.querySelector(".cm-editor-annotation-tooltip")).not.toBeNull();
    syncUiContributions([], [plugin]);
    expect(view.dom.querySelector(".cm-editor-annotation")).toBeNull();
    expect(view.dom.querySelector(".cm-editor-annotation-tooltip")).toBeNull();
    emitLocalIdeEvent({ type: "settingsChanged", key: "plugins" });
    await vi.advanceTimersByTimeAsync(350);
    expect(runCommand).toHaveBeenCalledTimes(3);
    expect(listeners.size).toBe(0);
  });
  it("rejects an old exact document response and coalesces typing into the latest snapshot", async () => {
    let resolve!: (value: string) => void;
    runCommand.mockImplementationOnce(
      () =>
        new Promise<string>((done) => {
          resolve = done;
        }),
    );
    const view = editor();
    await vi.advanceTimersByTimeAsync(1);
    const oldRequest = runCommand.mock.calls[0]![2];
    view.dispatch({ changes: { from: 0, to: 5, insert: "new" } });
    await vi.advanceTimersByTimeAsync(100);
    view.dispatch({ changes: { from: 0, insert: "latest " } });
    await vi.advanceTimersByTimeAsync(299);
    expect(runCommand).toHaveBeenCalledTimes(1);
    resolve(snapshot(oldRequest));
    await vi.advanceTimersByTimeAsync(0);
    expect(view.dom.querySelector(".cm-editor-annotation")).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(runCommand).toHaveBeenCalledTimes(2);
    expect(JSON.parse(runCommand.mock.calls[1]![2]).documentText).toBe("latest new\nbeta\nhuman");
    expect(view.dom.querySelector(".cm-editor-annotation")?.textContent).toBe(" + model-A");
  });
  it("opens the widget's markdown hover, including empty lines, without taking ordinary code hover", async () => {
    const ordinary = vi.fn((_view: EditorView, pos: number) => ({
      pos,
      create: () => {
        const dom = document.createElement("div");
        dom.className = "ordinary-hover";
        dom.textContent = "Ordinary documentation";
        return { dom };
      },
    }));
    const view = editor("\nbeta\nhuman", "/project/file.ts", hoverTooltip(ordinary, { hideOnChange: true }));
    await vi.advanceTimersByTimeAsync(350);
    await hover(view);
    expect(view.dom.querySelector(".cm-editor-annotation-tooltip .cm-lsp-markdown")?.textContent).toContain("Prompt A");
    const card = view.dom.querySelector(".cm-editor-annotation-tooltip")!;
    vi.spyOn(card.closest(".cm-tooltip")!, "getBoundingClientRect").mockReturnValue(new DOMRect(350, 0, 200, 100));
    view.dom.dispatchEvent(new MouseEvent("mouseleave", { relatedTarget: card }));
    await hover(view, card);
    expect(view.dom.querySelector(".cm-editor-annotation-tooltip")).not.toBeNull();
    view.dispatch({ selection: { anchor: 1 } });
    expect(view.dom.querySelector(".cm-editor-annotation-tooltip")).toBeNull();
    await hover(view);
    expect(view.dom.querySelector(".cm-editor-annotation-tooltip")?.textContent).toContain("Prompt B");
    view.dispatch({ selection: { anchor: 6 } });
    vi.spyOn(view, "posAtCoords").mockReturnValue(6);
    vi.spyOn(view, "coordsAtPos").mockReturnValue({
      left: 400,
      right: 400,
      top: 0,
      bottom: 20,
    });
    ordinary.mockClear();
    await hover(view, view.contentDOM.querySelectorAll(".cm-line")[2]!);
    expect(ordinary).toHaveBeenCalled();
    expect(view.dom.querySelector(".ordinary-hover")?.textContent).toBe("Ordinary documentation");
    expect(view.dom.querySelector(".cm-editor-annotation-tooltip")).toBeNull();
  });
  it("projects only the main caret AI line and moves to B then human without another command", async () => {
    const view = editor();
    await vi.advanceTimersByTimeAsync(350);
    expect(view.dom.querySelector(".cm-editor-annotation")?.textContent).toBe(" + model-A");
    view.dispatch({ selection: { anchor: 6 } });
    expect(view.dom.querySelector(".cm-editor-annotation")?.textContent).toBe(" + model-B");
    view.dispatch({ selection: { anchor: 11 } });
    expect(view.dom.querySelector(".cm-editor-annotation")).toBeNull();
    expect(runCommand).toHaveBeenCalledTimes(1);
  });
});

describe("floating conversation card resize", () => {
  function drag(handle: HTMLElement, dx: number, dy: number) {
    const rect = handle.getBoundingClientRect();
    const x = rect.left || 120;
    const y = rect.top || 80;
    handle.dispatchEvent(
      new MouseEvent("mousedown", {
        bubbles: true,
        button: 0,
        buttons: 1,
        clientX: x,
        clientY: y,
      }),
    );
    window.dispatchEvent(
      new MouseEvent("mousemove", {
        bubbles: true,
        button: 0,
        buttons: 1,
        clientX: x + dx,
        clientY: y + dy,
      }),
    );
    window.dispatchEvent(
      new MouseEvent("mouseup", {
        bubbles: true,
        button: 0,
        buttons: 0,
        clientX: x + dx,
        clientY: y + dy,
      }),
    );
  }

  async function openCard() {
    const view = editor();
    await vi.advanceTimersByTimeAsync(350);
    await hover(view);
    const card = view.dom.querySelector<HTMLElement>(".cm-editor-annotation-tooltip")!;
    // jsdom has no layout: give the floating card the natural size a real hover gets.
    vi.spyOn(card, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 100, 560, 380));
    return { view, card };
  }

  it("wraps the conversation in a scrollable body with a handle for every resize direction", async () => {
    const { card } = await openCard();
    const content = card.querySelector<HTMLElement>(".cm-editor-annotation-content");
    expect(content).not.toBeNull();
    expect(content?.querySelector("strong")?.textContent).toBe("Prompt A");
    expect(getComputedStyle(content!).overflow).toBe("auto");
    expect(getComputedStyle(content!).maxHeight).toBe("380px");
    const edges = [...card.querySelectorAll<HTMLElement>(".cm-editor-annotation-resize")].map(
      (handle) => handle.dataset.edge,
    );
    expect(edges).toEqual(["n", "s", "e", "w", "ne", "nw", "se", "sw"]);
  });

  it("ends an active resize when the annotation contribution is disposed", async () => {
    const { card } = await openCard();
    card
      .querySelector<HTMLElement>('[data-edge="e"]')!
      .dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, buttons: 1, clientX: 120, clientY: 80 }));
    const width = card.style.width;
    clearUiContributions();
    expect(card.isConnected).toBe(false);
    window.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, buttons: 1, clientX: 320, clientY: 80 }));
    expect(card.style.width).toBe(width);
    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });

  it("resizes the floating card from its right edge and keeps the content inside the new width", async () => {
    const { view, card } = await openCard();
    drag(card.querySelector<HTMLElement>('[data-edge="e"]')!, 200, 0);
    expect(card.style.width).toBe("760px");
    expect(card.style.maxWidth).toBe("none");
    const content = card.querySelector<HTMLElement>(".cm-editor-annotation-content")!;
    expect(content.style.height).toBe("100%");
    expect(content.style.maxHeight).toBe("none");
    expect(getComputedStyle(content).overflow).toBe("auto");
    expect(view.dom.querySelector(".cm-editor-annotation-tooltip")).not.toBeNull();
  });

  it("resizes from the left and top edges so the opposite edges stay in place", async () => {
    const { card } = await openCard();
    card.style.left = "40px";
    card.style.top = "60px";
    drag(card.querySelector<HTMLElement>('[data-edge="w"]')!, 120, 0);
    expect(card.style.width).toBe("440px");
    expect(card.style.left).toBe("160px");
    drag(card.querySelector<HTMLElement>('[data-edge="n"]')!, 0, 100);
    expect(card.style.height).toBe("280px");
    expect(card.style.top).toBe("160px");
  });

  it("never shrinks the floating card below a usable size", async () => {
    const { card } = await openCard();
    drag(card.querySelector<HTMLElement>('[data-edge="e"]')!, -1000, 0);
    expect(card.style.width).toBe("320px");
    drag(card.querySelector<HTMLElement>('[data-edge="s"]')!, 0, -1000);
    expect(card.style.height).toBe("160px");
  });

  it("keeps the chosen size for the next conversation card", async () => {
    const { view, card } = await openCard();
    drag(card.querySelector<HTMLElement>('[data-edge="se"]')!, 160, 80);
    expect(card.style.width).toBe("720px");
    expect(card.style.height).toBe("460px");
    view.dom.dispatchEvent(new MouseEvent("mouseleave", { relatedTarget: document.body }));
    await vi.advanceTimersByTimeAsync(350);
    expect(view.dom.querySelector(".cm-editor-annotation-tooltip")).toBeNull();
    await hover(view);
    const next = view.dom.querySelector<HTMLElement>(".cm-editor-annotation-tooltip")!;
    expect(next).not.toBe(card);
    expect(next.style.width).toBe("720px");
    expect(next.style.height).toBe("460px");
  });
});
