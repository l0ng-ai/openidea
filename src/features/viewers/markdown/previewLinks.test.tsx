import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { _addEditor, _removeEditor, editorContributions, type EditorDocContext } from "@/editor/api";
import { fontZoom } from "@/editor/core/cm/prefs";
import { useContextKeys } from "@/platform/context";
import { registerMarkdownLiveSource, useLiveMarkdown } from "./live";
import { MarkdownEditor } from "./MarkdownEditor";
import { useMarkdownModes } from "./modes";

const openFile = vi.fn(async () => {});
const disk: Record<string, string> = {
  "/p/b.md": "# 成交对账\n\n正文\n\n## 5.2 状态机\n",
  "/p/c.txt": "## 5.2 状态机\n",
};

vi.mock("@/workbench/contributions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/workbench/contributions")>()),
  maybeEditorService: () => ({ openFile }),
}));
vi.mock("@/platform/ipc", async (importOriginal) => {
  const ipc = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...ipc,
    commands: { ...ipc.commands, fsReadText: (path: string) => ({ readText: path }) },
    call: (request: unknown) => {
      const path = (request as { readText?: string } | null)?.readText;
      if (path === undefined) return ipc.call(request as never);
      return path in disk ? Promise.resolve(disk[path]) : Promise.reject(new Error("missing"));
    },
  };
});

const ctx: EditorDocContext = { doc: 1, path: "/p/a.md", language: "markdown", uiMode: null, readOnly: false };
const doc = [
  "[disk](b.md#52-%E7%8A%B6%E6%80%81%E6%9C%BA)",
  "[open](d.md#52-状态机)",
  "[line](b.md#L3)",
  "[none](b.md#missing)",
  "[text](c.txt#52-状态机)",
  "",
].join("\n\n");

describe("preview links to a heading in another file", () => {
  const disposers: Array<() => void> = [];
  const views: EditorView[] = [];

  beforeEach(() => {
    openFile.mockClear();
    disposers.push(registerMarkdownLiveSource());
    useContextKeys.setState({ projectOpen: true, textEditorActive: true });
    const live = editorContributions().find((c) => c.id === "viewers.markdownLive")!;
    const view = new EditorView({ state: EditorState.create({ doc, extensions: [fontZoom, live.extensions(ctx)] }) });
    // An open editor's unsaved text wins over the file on disk.
    const other = new EditorView({ state: EditorState.create({ doc: "# D\n\nnew line\n\n## 5.2 状态机\n" }) });
    views.push(view, other);
    for (const handle of [
      { view, ctx },
      { view: other, ctx: { ...ctx, doc: 2, path: "/p/d.md" } },
    ]) {
      _addEditor(handle);
      disposers.push(() => _removeEditor(handle));
    }
    act(() => useMarkdownModes.setState((s) => ({ byTab: { ...s.byTab, t: "preview" } })));
  });
  afterEach(() => {
    cleanup();
    for (const view of views.splice(0)) view.destroy();
    for (const dispose of disposers.splice(0).reverse()) dispose();
    useLiveMarkdown.setState({}, true);
    useContextKeys.setState({}, true);
  });

  it("opens the file at the heading line", async () => {
    render(
      <MarkdownEditor path={ctx.path} tabId="t">
        <div />
      </MarkdownEditor>,
    );
    const preview = screen.getByRole("document", { name: "Markdown preview" });
    await waitFor(() => expect(preview.querySelectorAll("a")).toHaveLength(5));
    const click = async (name: string) => {
      openFile.mockClear();
      fireEvent.click(screen.getByText(name));
      await waitFor(() => expect(openFile).toHaveBeenCalledTimes(1));
      return openFile.mock.calls[0];
    };
    expect(await click("disk")).toEqual(["/p/b.md", { focus: true, selection: { line: 4, col: 0 } }]);
    expect(await click("open")).toEqual(["/p/d.md", { focus: true, selection: { line: 4, col: 0 } }]);
    expect(await click("line")).toEqual(["/p/b.md", { focus: true, selection: { line: 2, col: 0 } }]);
    expect(await click("none")).toEqual(["/p/b.md", { focus: true }]);
    expect(await click("text")).toEqual(["/p/c.txt", { focus: true }]);
  });
});
