import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { ProjectInfo, WorkbenchEvent } from "@/bindings";
import { _emitEditorEvent, _setActiveEditor, type TextEditorHandle } from "@/editor/api";
import { useProject } from "@/platform/project";
import { createMemoryPluginsBackend, setPluginsBackend } from "../backend";
import { startRuntimeUi } from "../runtimeUi";

const project: ProjectInfo = { root: "/work", name: "work", trusted: true, isGit: false, settings: {} };
let received: WorkbenchEvent[];
let views: EditorView[];
let a: TextEditorHandle;
let stop: () => void;

function editor(doc: number, path: string): TextEditorHandle {
  const view = new EditorView({ state: EditorState.create({ doc: "one\ntwo\nthree" }) });
  views.push(view);
  return { view, ctx: { doc, path, language: "typescript", uiMode: null, readOnly: false } };
}

function activate(handle: TextEditorHandle | null) {
  _setActiveEditor(handle);
  _emitEditorEvent({ type: "activeEditorChanged", path: handle?.ctx.path ?? null, doc: handle?.ctx.doc ?? null });
}

function move(handle = a, line = 1, col = 2) {
  _emitEditorEvent({ type: "caretMoved", doc: handle.ctx.doc, path: handle.ctx.path, line, col, offset: 6 });
}

beforeEach(async () => {
  vi.useFakeTimers();
  received = [];
  views = [];
  useProject.setState({ project });
  a = editor(1, "/work/a.ts");
  activate(a);
  setPluginsBackend({
    ...createMemoryPluginsBackend(),
    eventKinds: async () => ["caret-moved", "file-closed", "file-saved"],
    postEvents: async (events) => {
      received.push(...events);
    },
  });
  stop = startRuntimeUi();
  await Promise.resolve();
});

afterEach(() => {
  stop();
  activate(null);
  views.forEach((view) => view.destroy());
  useProject.setState({ project: null });
  setPluginsBackend(null);
  vi.useRealTimers();
});

describe("runtime UI caret event lifetime", () => {
  it("drops queued and delayed caret events when their active document closes", async () => {
    move();
    await vi.advanceTimersByTimeAsync(40);
    activate(null);
    _emitEditorEvent({ type: "docClosed", doc: 1, path: "/work/a.ts" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(received).toEqual([{ kind: "fileClosed", value: "/work/a.ts" }]);
  });
});

const transitions = [
  {
    name: "closing the active document",
    run: () => {
      activate(null);
      _emitEditorEvent({ type: "docClosed", doc: 1, path: "/work/a.ts" });
    },
  },
  { name: "a non-text tab", run: () => activate(null) },
  {
    name: "a non-text tab with the same path",
    run: () => {
      _setActiveEditor(null);
      _emitEditorEvent({ type: "activeEditorChanged", doc: null, path: "/work/a.ts" });
    },
  },
  { name: "another document", run: () => activate(editor(2, "/work/b.ts")) },
  { name: "another editor of the same document", run: () => activate(editor(1, "/work/a.ts")) },
  { name: "another document with the same path", run: () => activate(editor(2, "/work/a.ts")) },
  { name: "a different project", run: () => useProject.setState({ project: { ...project, root: "/other" } }) },
  { name: "a replacement project at the same root", run: () => useProject.setState({ project: { ...project } }) },
  { name: "closing the project", run: () => useProject.setState({ project: null }) },
  {
    name: "rapid document A to B to A",
    run: () => {
      activate(editor(2, "/work/b.ts"));
      activate(a);
    },
  },
  {
    name: "rapid editor A to B to A on the same document",
    run: () => {
      activate(editor(1, "/work/a.ts"));
      activate(a);
    },
  },
  {
    name: "rapid project A to B to A",
    run: () => {
      useProject.setState({ project: { ...project, root: "/other" } });
      useProject.setState({ project });
    },
  },
];

describe.each(transitions)("caret lifetime after $name", ({ run }) => {
  it.each([
    { phase: "before the fast batch", elapsed: 40 },
    { phase: "while the settled timer waits", elapsed: 200 },
    { phase: "after the settled event is queued", elapsed: 650 },
  ])("invalidates work $phase without requiring another caret move", async ({ elapsed }) => {
    move();
    await vi.advanceTimersByTimeAsync(elapsed);
    expect(received.filter((event) => event.kind === "caretMoved")).toHaveLength(elapsed < 120 ? 0 : 1);
    received = [];
    run();
    await vi.advanceTimersByTimeAsync(1000);
    expect(received.filter((event) => event.kind === "caretMoved")).toEqual([]);
  });
});

describe("runtime UI caret scheduling contract", () => {
  it("coalesces movement into the 120ms batch and settles 600ms after the last move", async () => {
    move();
    await vi.advanceTimersByTimeAsync(80);
    move(a, 2, 1);
    await vi.advanceTimersByTimeAsync(39);
    expect(received).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(received).toEqual([{ kind: "caretMoved", value: { path: "/work/a.ts", line: 2, col: 1, settled: false } }]);
    await vi.advanceTimersByTimeAsync(559);
    expect(received).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(120);
    expect(received).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(received).toEqual([
      { kind: "caretMoved", value: { path: "/work/a.ts", line: 2, col: 1, settled: false } },
      { kind: "caretMoved", value: { path: "/work/a.ts", line: 2, col: 1, settled: true } },
    ]);
  });

  it("replaces an already queued settled position when movement resumes", async () => {
    move();
    await vi.advanceTimersByTimeAsync(650);
    received = [];
    move(a, 2, 0);
    await vi.advanceTimersByTimeAsync(70);
    expect(received).toEqual([{ kind: "caretMoved", value: { path: "/work/a.ts", line: 2, col: 0, settled: false } }]);
    await vi.advanceTimersByTimeAsync(650);
    expect(received).toEqual([
      { kind: "caretMoved", value: { path: "/work/a.ts", line: 2, col: 0, settled: false } },
      { kind: "caretMoved", value: { path: "/work/a.ts", line: 2, col: 0, settled: true } },
    ]);
  });

  it("preserves non-caret events when invalidating a mixed fast batch", async () => {
    _emitEditorEvent({ type: "docSaved", doc: 1, path: "/work/a.ts" });
    move();
    await vi.advanceTimersByTimeAsync(40);
    activate(null);
    await vi.advanceTimersByTimeAsync(79);
    expect(received).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(received).toEqual([{ kind: "fileSaved", value: "/work/a.ts" }]);
  });

  it("keeps the 500ms batch interval for ordinary file events", async () => {
    _emitEditorEvent({ type: "docSaved", doc: 1, path: "/work/a.ts" });
    await vi.advanceTimersByTimeAsync(499);
    expect(received).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(received).toEqual([{ kind: "fileSaved", value: "/work/a.ts" }]);
  });

  it("does not invalidate the active caret when an unrelated document closes", async () => {
    move();
    await vi.advanceTimersByTimeAsync(40);
    _emitEditorEvent({ type: "docClosed", doc: 2, path: "/work/b.ts" });
    await vi.advanceTimersByTimeAsync(680);
    expect(received).toEqual([
      { kind: "caretMoved", value: { path: "/work/a.ts", line: 1, col: 2, settled: false } },
      { kind: "fileClosed", value: "/work/b.ts" },
      { kind: "caretMoved", value: { path: "/work/a.ts", line: 1, col: 2, settled: true } },
    ]);
  });

  it("allows a fresh move after A to B to A without replaying A's previous position", async () => {
    move();
    await vi.advanceTimersByTimeAsync(40);
    activate(editor(2, "/work/b.ts"));
    activate(a);
    move(a, 2, 1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(received).toEqual([
      { kind: "caretMoved", value: { path: "/work/a.ts", line: 2, col: 1, settled: false } },
      { kind: "caretMoved", value: { path: "/work/a.ts", line: 2, col: 1, settled: true } },
    ]);
  });

  it("ignores late caret events from an inactive document", async () => {
    const b = editor(2, "/work/b.ts");
    activate(b);
    move(b, 2, 0);
    move(a);
    await vi.advanceTimersByTimeAsync(1000);
    expect(received).toEqual([
      { kind: "caretMoved", value: { path: "/work/b.ts", line: 2, col: 0, settled: false } },
      { kind: "caretMoved", value: { path: "/work/b.ts", line: 2, col: 0, settled: true } },
    ]);
  });

  it("ignores late caret events while a non-text editor is active", async () => {
    activate(null);
    move();
    await vi.advanceTimersByTimeAsync(1000);
    expect(received).toEqual([]);
  });

  it("does not cancel the caret for settings changes or the same editor being refocused", async () => {
    move();
    await vi.advanceTimersByTimeAsync(40);
    useProject.setState({ settings: {} });
    activate(a);
    await vi.advanceTimersByTimeAsync(680);
    expect(received).toEqual([
      { kind: "caretMoved", value: { path: "/work/a.ts", line: 1, col: 2, settled: false } },
      { kind: "caretMoved", value: { path: "/work/a.ts", line: 1, col: 2, settled: true } },
    ]);
  });

  it("unsubscribes and drops queued work when runtime UI stops, then starts cleanly", async () => {
    move();
    await vi.advanceTimersByTimeAsync(40);
    stop();
    move();
    await vi.advanceTimersByTimeAsync(1000);
    expect(received).toEqual([]);
    stop = startRuntimeUi();
    await Promise.resolve();
    move(a, 2, 0);
    await vi.advanceTimersByTimeAsync(720);
    expect(received).toEqual([
      { kind: "caretMoved", value: { path: "/work/a.ts", line: 2, col: 0, settled: false } },
      { kind: "caretMoved", value: { path: "/work/a.ts", line: 2, col: 0, settled: true } },
    ]);
  });
});

describe("runtime UI caret identity revalidation", () => {
  it("does not let a new caret overwrite the identity guarding an older queued document", async () => {
    move();
    await vi.advanceTimersByTimeAsync(40);
    a.ctx = { ...a.ctx, doc: 2, path: "/work/b.ts" };
    move(a, 2, 0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(received).toEqual([
      { kind: "caretMoved", value: { path: "/work/b.ts", line: 2, col: 0, settled: false } },
      { kind: "caretMoved", value: { path: "/work/b.ts", line: 2, col: 0, settled: true } },
    ]);
  });
});

describe.each([
  {
    name: "document id",
    change: () => {
      a.ctx = { ...a.ctx, doc: 2 };
    },
  },
  {
    name: "document path",
    change: () => {
      a.ctx = { ...a.ctx, path: "/work/renamed.ts" };
    },
  },
])("runtime UI dispatch revalidates $name", ({ change }) => {
  it.each([40, 200, 650])(
    "drops obsolete caret work after %ims even when the handle stays the same",
    async (elapsed) => {
      move();
      await vi.advanceTimersByTimeAsync(elapsed);
      received = [];
      change();
      await vi.advanceTimersByTimeAsync(1000);
      expect(received).toEqual([]);
    },
  );
});

it("invalidates a matching document-close event independently of an active-editor notification", async () => {
  move();
  await vi.advanceTimersByTimeAsync(40);
  _emitEditorEvent({ type: "docClosed", doc: 1, path: "/work/a.ts" });
  await vi.advanceTimersByTimeAsync(1000);
  expect(received).toEqual([{ kind: "fileClosed", value: "/work/a.ts" }]);
});
