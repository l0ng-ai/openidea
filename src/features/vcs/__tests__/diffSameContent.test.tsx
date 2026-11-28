import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import type { EditorInput } from "@/workbench/contributions";

const texts: Record<string, string> = { HEAD: "foo\nbar\nfoo\n", abc123: "foo\nbaz\nfoo\n" };

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: {
      ...real.commands,
      fsProbe: () => Promise.resolve({ status: "ok", data: { size: 3, binary: false, tooLarge: false } }),
      vcsFileAt: (_path: string, rev: string) => Promise.resolve({ status: "ok", data: texts[rev] ?? texts.HEAD }),
      fsReadText: () => Promise.resolve({ status: "ok", data: "foo\nqux\nfoo\n" }),
    },
  };
});

/** The working file: an editable document. */
vi.mock("@/editor/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/editor/api")>()),
  attachDocument: (path: string) =>
    Promise.resolve({
      path,
      text: () => "foo\nqux\nfoo\n",
      lineEnding: () => "lf",
      readOnly: false,
      subscribeReadOnly: () => () => {},
      subscribeExternalChanges: () => () => {},
      extension: [],
      context: () => ({ doc: 1, path, language: "plaintext", uiMode: null, readOnly: false }),
      save: () => Promise.resolve(),
      release: () => {},
    }),
}));

import { DiffEditor } from "../DiffEditor";
import { CommitToolWindow } from "../CommitView";
import { setCommitDiffPreview, useCommit } from "../commitStore";
import { diffInput, type DiffData } from "../diffInput";
import { useVcs } from "../store";

afterEach(cleanup);

const panes = () => document.querySelectorAll<HTMLElement>(".cm-mergeViewEditor .cm-editor");
const pane = async (index: number) => {
  await waitFor(() => expect(panes().length).toBe(2));
  return EditorView.findFromDOM(panes()[index]!)!;
};

/** A new request object each call, as a host building it while rendering does. */
const request = (rev = "abc123"): EditorInput =>
  diffInput({
    path: "/p/a.ts",
    left: { type: "rev", rev: "HEAD" },
    right: { type: "rev", rev },
    annotations: [{ side: "right", line: 1, author: "ann", body: "note" }],
  });

/** Puts the caret at `pos` of the right pane and returns the pane. */
const withCaret = async (pos: number) => {
  const view = await pane(1);
  act(() => view.dispatch({ selection: { anchor: pos } }));
  return view;
};

/** Lets pending loads and their effects settle, so a rebuild that would happen has happened. */
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));

describe("DiffEditor given the same request again", () => {
  it("keeps its views when a new request object has the same content", async () => {
    const { rerender } = render(<DiffEditor input={request()} />);
    const before = await withCaret(5);
    rerender(<DiffEditor input={request()} />);
    await settle();
    expect(before.dom.isConnected).toBe(true);
    expect(await pane(1)).toBe(before);
    expect(before.state.selection.main.head).toBe(5);
  });

  it("rebuilds its views when a side changes", async () => {
    texts.def456 = "other\n";
    const { rerender } = render(<DiffEditor input={request()} />);
    const before = await pane(1);
    rerender(<DiffEditor input={request("def456")} />);
    await waitFor(() => expect(before.dom.isConnected).toBe(false));
    expect((await pane(1)).state.doc.toString()).toBe("other\n");
  });

  it("rebuilds its views when the annotations change", async () => {
    const { rerender } = render(<DiffEditor input={request()} />);
    const before = await pane(1);
    const next = request();
    (next.data as DiffData).annotations = [{ side: "right", line: 0, author: "ann", body: "another" }];
    rerender(<DiffEditor input={next} />);
    await waitFor(() => expect(before.dom.isConnected).toBe(false));
    await waitFor(() => expect(document.body.textContent).toContain("another"));
  });

  it("still swaps sides that have the same content", async () => {
    const blank = {
      kind: "diff",
      key: "diff:blank",
      data: {
        path: "blank-diff:1",
        left: { type: "text", text: "", label: "", editable: true },
        right: { type: "text", text: "", label: "", editable: true },
        swappable: true,
      },
    } as unknown as EditorInput;
    render(<DiffEditor input={blank} />);
    const left = await pane(0);
    act(() => left.dispatch({ changes: { from: 0, insert: "typed" } }));
    fireEvent.click(screen.getByRole("button", { name: "Swap Sides" }));
    await waitFor(() => expect(left.dom.isConnected).toBe(false));
    expect((await pane(1)).state.doc.toString()).toBe("typed");
    expect((await pane(0)).state.doc.toString()).toBe("");
  });
});

describe("hosts that build the diff request while rendering", () => {
  const modified = (path: string) => ({
    path,
    relPath: path.slice(3),
    staged: null,
    unstaged: "modified" as const,
    renamedFrom: null,
  });

  beforeEach(() => {
    localStorage.clear();
    useCommit.setState({ commitDiffPreview: false, selection: [] });
    useVcs.setState({ available: true, root: "/p", repo: "/p", roots: ["/p"], status: [modified("/p/a.ts")] });
  });

  it("keeps the Commit preview's views across a Git status refresh", async () => {
    render(<CommitToolWindow />);
    act(() => useCommit.setState({ selection: ["/p/a.ts"] }));
    act(() => setCommitDiffPreview(true));
    const before = await withCaret(5);
    act(() => useVcs.setState({ status: [modified("/p/a.ts")] }));
    await settle();
    expect(before.dom.isConnected).toBe(true);
    expect(before.state.selection.main.head).toBe(5);
  });
});
