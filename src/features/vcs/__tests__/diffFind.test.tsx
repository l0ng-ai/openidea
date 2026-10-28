import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import type { EditorInput } from "@/workbench/contributions";
import { useKeymap } from "@/platform/keymap";

const texts: Record<string, string> = { HEAD: "foo\nbar\nfoo\n", abc123: "foo\nbaz\nfoo\n" };

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: {
      ...real.commands,
      fsProbe: () => Promise.resolve({ status: "ok", data: { size: 3, binary: false, tooLarge: false } }),
      vcsFileAt: (_path: string, rev: string) => Promise.resolve({ status: "ok", data: texts[rev] }),
      fsReadText: () => Promise.resolve({ status: "ok", data: "foo\nqux\nfoo\n" }),
    },
  };
});

vi.mock("@/workbench/contributions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/workbench/contributions")>()),
  editorService: () => ({ openFile: vi.fn() }),
}));

/** The working file: an editable document. */
vi.mock("@/editor/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/editor/api")>()),
  attachDocument: (path: string) =>
    Promise.resolve({
      path,
      text: () => "foo\nqux\nfoo\n",
      readOnly: false,
      extension: [],
      save: () => Promise.resolve(),
      release: () => {},
    }),
}));

import { DiffEditor } from "../DiffEditor";

const diff = (right: object) =>
  ({
    kind: "diff",
    key: `diff:${JSON.stringify(right)}`,
    data: { path: "/p/a.ts", left: { type: "rev", rev: "HEAD" }, right },
  }) as unknown as EditorInput;

const revisions = diff({ type: "rev", rev: "abc123" });
const working = diff({ type: "worktree" });

const KEYMAP = {
  "find.inFile": ["Meta+F"],
  "find.replaceInFile": ["Meta+R"],
  "find.next": ["Meta+G"],
  "find.previous": ["Meta+Shift+G"],
};

const pane = async (index: number) => {
  await waitFor(() => expect(document.querySelectorAll(".cm-mergeViewEditor .cm-editor").length).toBe(2));
  return EditorView.findFromDOM(document.querySelectorAll<HTMLElement>(".cm-mergeViewEditor .cm-editor")[index]!)!;
};

/** Focuses side `index` and presses `code` with ⌘ (and `shift`). */
const press = async (index: number, code: string, shift = false) => {
  const v = await pane(index);
  v.contentDOM.dispatchEvent(new FocusEvent("focus"));
  fireEvent.keyDown(v.contentDOM, { code, key: code.slice(3).toLowerCase(), metaKey: true, shiftKey: shift });
  return v;
};

afterEach(() => useKeymap.setState({ overrides: {} }));

describe("Find in the diff viewer", () => {
  it("opens the editor's find bar from the keymap and closes it with Esc", async () => {
    useKeymap.setState({ overrides: KEYMAP });
    render(<DiffEditor input={revisions} />);
    await press(1, "KeyF");
    const bar = await screen.findByRole("search", { name: "Find in file" });
    expect(document.querySelector(".cm-search")).toBeNull();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Find" }), { key: "Escape" });
    await waitFor(() => expect(bar.isConnected).toBe(false));
  });

  it("closes with Esc in the editor while a found match is selected", async () => {
    useKeymap.setState({ overrides: KEYMAP });
    render(<DiffEditor input={revisions} />);
    const v = await press(1, "KeyF");
    fireEvent.change(await screen.findByRole("textbox", { name: "Find" }), { target: { value: "foo" } });
    await waitFor(() => expect(v.state.selection.main.empty).toBe(false));
    v.focus();
    fireEvent.keyDown(v.contentDOM, { key: "Escape", code: "Escape", keyCode: 27 });
    await waitFor(() => expect(screen.queryByRole("search")).toBeNull());
    expect(document.querySelectorAll(".cm-openidea-findMatch")).toHaveLength(0);
  });

  it("follows a rebound shortcut", async () => {
    useKeymap.setState({ overrides: { ...KEYMAP, "find.inFile": ["Meta+J"] } });
    render(<DiffEditor input={revisions} />);
    await press(1, "KeyF");
    expect(screen.queryByRole("search")).toBeNull();
    await press(1, "KeyJ");
    await screen.findByRole("search", { name: "Find in file" });
  });

  it("only finds on a revision side", async () => {
    useKeymap.setState({ overrides: KEYMAP });
    render(<DiffEditor input={revisions} />);
    await press(1, "KeyR");
    await screen.findByRole("search", { name: "Find in file" });
    expect(screen.queryByRole("button", { name: "Show Replace" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Replace" })).toBeNull();
  });

  it("offers Replace on the working copy but not on the revision beside it", async () => {
    useKeymap.setState({ overrides: KEYMAP });
    render(<DiffEditor input={working} />);
    await press(1, "KeyR");
    await screen.findByRole("search", { name: "Replace in file" });
    await press(0, "KeyR");
    await screen.findByRole("search", { name: "Find in file" });
    expect(screen.queryByRole("button", { name: "Show Replace" })).toBeNull();
  });

  it("finds the next occurrence of the last search with ⌘G", async () => {
    useKeymap.setState({ overrides: KEYMAP });
    render(<DiffEditor input={revisions} />);
    const v = await press(1, "KeyF");
    const field = await screen.findByRole("textbox", { name: "Find" });
    fireEvent.change(field, { target: { value: "foo" } });
    await waitFor(() => expect(v.state.selection.main.from).toBe(0));
    await press(1, "KeyG");
    expect(v.state.selection.main.from).toBe(8);
  });
});
