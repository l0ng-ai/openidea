import { afterEach, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";
import { invalidateNavigationProviders } from "@/editor/navigationProviders";
const ipc = vi.hoisted(() => ({
  pluginLanguageVisuals: vi.fn(),
  lspExecuteCommand: vi.fn(async () => ({ status: "ok", data: null })),
}));
vi.mock("@/platform/ipc", async (original) => ({
  ...(await original<typeof import("@/platform/ipc")>()),
  commands: ipc,
}));
const { injectedHighlights, pluginLanguageVisuals } = await import("./languageVisuals");
const ctx = { doc: 7, path: "/p/a.txt", language: "text", uiMode: null, readOnly: false };
const views: EditorView[] = [];
afterEach(() => {
  views.splice(0).forEach((v) => v.destroy());
  vi.useRealTimers();
  ipc.pluginLanguageVisuals.mockReset();
  vi.clearAllMocks();
});
it("highlights only the embedded slice with its own parser and the editor theme", async () => {
  const state = EditorState.create({
    doc: "host SELECT a FROM t host",
    extensions: [syntaxHighlighting(defaultHighlightStyle)],
  });
  const deco = await injectedHighlights(state, [
    { range: { start: { line: 0, col: 5 }, end: { line: 0, col: 20 } }, language: "sql" },
  ]);
  expect(deco.size).toBeGreaterThan(0);
  const cursor = deco.iter();
  while (cursor.value) {
    expect(cursor.from).toBeGreaterThanOrEqual(5);
    expect(cursor.to).toBeLessThanOrEqual(20);
    expect(cursor.value.spec.class).toMatch(/\S/);
    cursor.next();
  }
});
it("renders owned gutter commands and drops answers to superseded buffers", async () => {
  vi.useFakeTimers();
  let answer!: (v: unknown) => void;
  ipc.pluginLanguageVisuals.mockImplementationOnce(
    () =>
      new Promise((r) => {
        answer = r;
      }),
  );
  const visual = {
    version: 2,
    injections: [],
    colors: [],
    gutterActions: [["test", { line: 0, icon: "run", tooltip: "Run test", command: "run", argument: "value" }]],
  };
  ipc.pluginLanguageVisuals.mockResolvedValue({ status: "ok", data: visual });
  const view = new EditorView({
    state: EditorState.create({ doc: "before", extensions: pluginLanguageVisuals(ctx) }),
    parent: document.body,
  });
  views.push(view);
  await vi.advanceTimersByTimeAsync(300);
  view.dispatch({ changes: { from: 0, to: 6, insert: "after" } });
  answer({ status: "ok", data: visual });
  await vi.advanceTimersByTimeAsync(0);
  expect(view.dom.querySelector(".cm-plugin-gutter-action")).toBeNull();
  await vi.advanceTimersByTimeAsync(300);
  const button = view.dom.querySelector<HTMLButtonElement>(".cm-plugin-gutter-action")!;
  expect(button.getAttribute("aria-label")).toBe("Run test");
  button.click();
  expect(ipc.lspExecuteCommand).toHaveBeenCalledWith(
    7,
    expect.objectContaining({ command: "openidea.plugin-language:test:run", arguments: ['"value"'] }),
  );
});

it("keeps Run buttons mounted while edits and delayed refreshes move their lines", async () => {
  vi.useFakeTimers();
  const action = { line: 0, icon: "run", tooltip: "Run sum", command: "run", argument: "sum" };
  const visual = { version: 1, injections: [], colors: [], gutterActions: [["riscv", action]] };
  ipc.pluginLanguageVisuals.mockResolvedValueOnce({ status: "ok", data: visual });
  const view = new EditorView({
    state: EditorState.create({ doc: "sum: ret", extensions: pluginLanguageVisuals(ctx) }),
    parent: document.body,
  });
  views.push(view);
  await vi.advanceTimersByTimeAsync(300);
  const button = view.dom.querySelector<HTMLButtonElement>(".cm-plugin-gutter-action")!;
  expect(button).not.toBeNull();
  const column = view.dom.querySelector(".cm-plugin-gutter-actions");
  let answer!: (value: unknown) => void;
  ipc.pluginLanguageVisuals.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
  view.dispatch({ changes: { from: 8, insert: " " } });
  expect(view.dom.querySelector(".cm-plugin-gutter-action")).toBe(button);
  await vi.advanceTimersByTimeAsync(300);
  expect(view.dom.querySelector(".cm-plugin-gutter-action")).toBe(button);
  answer({ status: "ok", data: visual });
  await vi.advanceTimersByTimeAsync(0);
  expect(view.dom.querySelector(".cm-plugin-gutter-action")).toBe(button);
  expect(view.dom.querySelector(".cm-plugin-gutter-actions")).toBe(column);

  ipc.pluginLanguageVisuals.mockResolvedValueOnce({ status: "ok", data: visual });
  invalidateNavigationProviders();
  await vi.advanceTimersByTimeAsync(0);
  expect(view.dom.querySelector(".cm-plugin-gutter-action")).toBe(button);
  await vi.advanceTimersByTimeAsync(300);
  expect(view.dom.querySelector(".cm-plugin-gutter-action")).toBe(button);

  ipc.pluginLanguageVisuals.mockResolvedValueOnce({
    status: "ok",
    data: { ...visual, gutterActions: [["riscv", { ...action, line: 1 }]] },
  });
  view.dispatch({ changes: { from: 0, insert: "\n" } });
  expect(view.dom.querySelector(".cm-plugin-gutter-action")).toBe(button);
  await vi.advanceTimersByTimeAsync(300);
  expect(view.dom.querySelector(".cm-plugin-gutter-action")).toBe(button);
  button.click();
  expect(ipc.lspExecuteCommand).toHaveBeenLastCalledWith(
    7,
    expect.objectContaining({ command: "openidea.plugin-language:riscv:run", arguments: ['"sum"'] }),
  );
});

it("retains buttons on refresh failures and removes them when the provider confirms removal", async () => {
  vi.useFakeTimers();
  const visual = {
    version: 1,
    injections: [],
    colors: [],
    gutterActions: [["test", { line: 0, icon: "run", tooltip: "Run test", command: "run", argument: null }]],
  };
  ipc.pluginLanguageVisuals.mockResolvedValueOnce({ status: "ok", data: visual });
  const view = new EditorView({
    state: EditorState.create({ doc: "main: ret", extensions: pluginLanguageVisuals(ctx) }),
    parent: document.body,
  });
  views.push(view);
  await vi.advanceTimersByTimeAsync(300);
  const button = view.dom.querySelector(".cm-plugin-gutter-action");
  expect(button).not.toBeNull();
  ipc.pluginLanguageVisuals.mockRejectedValueOnce(new Error("refresh interrupted"));
  view.dispatch({ changes: { from: 9, insert: " " } });
  await vi.advanceTimersByTimeAsync(300);
  expect(view.dom.querySelector(".cm-plugin-gutter-action")).toBe(button);

  ipc.pluginLanguageVisuals.mockResolvedValueOnce({ status: "ok", data: { ...visual, gutterActions: [] } });
  view.dispatch({ changes: { from: 0, to: view.state.doc.length } });
  expect(view.dom.querySelector(".cm-plugin-gutter-action")).toBe(button);
  await vi.advanceTimersByTimeAsync(300);
  expect(view.dom.querySelector(".cm-plugin-gutter-action")).toBeNull();
  expect(view.dom.querySelector(".cm-plugin-gutter-actions")).toBeNull();
});
