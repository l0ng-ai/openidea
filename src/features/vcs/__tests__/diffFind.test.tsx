import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EditorView } from "@codemirror/view";
import type { EditorInput } from "@/workbench/contributions";
import { useKeymap } from "@/platform/keymap";
import { useFindOptions, useFindSessions } from "@/editor/core/view/FindBar";
import { useProject } from "@/platform/project";

const externalCalls: unknown[][] = [];
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
      diffExternalTool: (...args: unknown[]) => {
        externalCalls.push(args);
        return Promise.resolve({ status: "ok", data: null });
      },
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
import type { DiffData } from "../diffInput";

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

afterEach(() => {
  useKeymap.setState({ overrides: {} });
  useFindOptions.setState({ search: "", replace: "" });
  useFindSessions.setState({}, true);
});

describe("Find in the diff viewer", () => {
  it("preserves external focus when loading and changing a working-tree preview", async () => {
    const preview = (input: EditorInput) => (
      <>
        <button>Changes tree</button>
        <DiffEditor input={input} />
      </>
    );
    const { rerender } = render(preview(working));
    const tree = screen.getByRole("button", { name: "Changes tree" });
    tree.focus();
    const oldPane = await pane(1);
    expect(tree).toHaveFocus();
    rerender(preview({ ...working, key: "diff:b.ts", data: { ...(working.data as DiffData), path: "/p/b.ts" } }));
    await waitFor(() => expect(oldPane.dom.isConnected).toBe(false));
    await pane(1);
    expect(tree).toHaveFocus();
  });

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

  it.each(["Meta", "Ctrl"])("opens collapsed with %s+F and expanded with Replace", async (modifier) => {
    useKeymap.setState({
      overrides: {
        ...KEYMAP,
        "find.inFile": [`${modifier}+F`],
        "find.replaceInFile": [`${modifier}+R`],
      },
    });
    render(<DiffEditor input={working} />);
    const v = await pane(1);
    const pressKey = (key: string) => {
      v.contentDOM.dispatchEvent(new FocusEvent("focus"));
      fireEvent.keyDown(v.contentDOM, {
        code: `Key${key}`,
        key: key.toLowerCase(),
        metaKey: modifier === "Meta",
        ctrlKey: modifier === "Ctrl",
      });
    };
    pressKey("F");
    expect(await screen.findByRole("button", { name: "Show Replace" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("textbox", { name: "Replace" })).toBeNull();
    pressKey("R");
    expect(await screen.findByRole("button", { name: "Hide Replace" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("textbox", { name: "Replace" })).toBeInTheDocument();
    pressKey("F");
    expect(await screen.findByRole("button", { name: "Show Replace" })).toHaveAttribute("aria-expanded", "false");
  });

  it("toggles with pointer and keyboard while preserving query, options, and focus", async () => {
    const user = userEvent.setup();
    useKeymap.setState({ overrides: KEYMAP });
    render(<DiffEditor input={working} />);
    const v = await press(1, "KeyF");
    const field = await screen.findByRole("textbox", { name: "Find" });
    fireEvent.change(field, { target: { value: "foo" } });
    const matchCase = screen.getByRole("button", { name: "Match Case" });
    await user.click(matchCase);
    const pressed = matchCase.getAttribute("aria-pressed");
    field.focus();
    (field as HTMLInputElement).setSelectionRange(1, 2);
    const disclosure = screen.getByRole("button", { name: "Show Replace" });
    expect(screen.getByRole("search").firstElementChild).toBe(disclosure);
    await user.click(disclosure);
    expect(field).toHaveFocus();
    expect((field as HTMLInputElement).selectionStart).toBe(1);
    expect((field as HTMLInputElement).selectionEnd).toBe(2);
    expect(field).toHaveValue("foo");
    expect(matchCase).toHaveAttribute("aria-pressed", pressed);
    const replacement = screen.getByRole("textbox", { name: "Replace" });
    await user.type(replacement, "baz");
    await user.click(screen.getByRole("button", { name: "Hide Replace" }));
    expect(field).toHaveFocus();
    expect(screen.queryByRole("textbox", { name: "Replace" })).toBeNull();
    const toggle = screen.getByRole("button", { name: "Show Replace" });
    toggle.focus();
    await user.keyboard("{Enter}");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveFocus();
    expect(screen.getByRole("textbox", { name: "Replace" })).toHaveValue("baz");
    await user.keyboard(" ");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.keyboard(" ");
    field.focus();
    await user.tab();
    expect(screen.getByRole("textbox", { name: "Replace" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Replace All" }));
    expect(v.state.doc.toString()).toBe("baz\nqux\nbaz\n");
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

describe("Esc and the opposite pane", () => {
  const escape = (v: EditorView) => fireEvent.keyDown(v.contentDOM, { key: "Escape", code: "Escape", keyCode: 27 });

  it("closes the tab with Esc only once nothing in the diff takes it", async () => {
    useKeymap.setState({ overrides: KEYMAP });
    const onClose = vi.fn();
    render(<DiffEditor input={revisions} onClose={onClose} />);
    const v = await press(1, "KeyF");
    fireEvent.change(await screen.findByRole("textbox", { name: "Find" }), { target: { value: "foo" } });
    await waitFor(() => expect(v.state.selection.main.empty).toBe(false));
    v.focus();
    escape(v); // closes the find bar
    await waitFor(() => expect(screen.queryByRole("search")).toBeNull());
    escape(v); // collapses the found match
    expect(v.state.selection.main.empty).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    escape(v);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("leaves Esc alone where the diff isn't a tab", async () => {
    render(<DiffEditor input={revisions} />);
    const v = await pane(1);
    v.focus();
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    v.contentDOM.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("moves focus to the other side with Select Opposite Diff Pane", async () => {
    const { focusedDiffNavigator } = await import("../diffNavigator");
    render(<DiffEditor input={revisions} />);
    const left = await pane(0);
    const right = await pane(1);
    right.focus();
    await waitFor(() => expect(focusedDiffNavigator()).not.toBeNull());
    expect(focusedDiffNavigator()!.focusOpposite()).toBe(true);
    expect(left.hasFocus).toBe(true);
    expect(focusedDiffNavigator()!.focusOpposite()).toBe(true);
    expect(right.hasFocus).toBe(true);
  });
});

describe("Search In Changes", () => {
  it("limits the find bar to the changed lines of the diff, and not while replacing", async () => {
    useKeymap.setState({ overrides: KEYMAP });
    render(<DiffEditor input={working} />);
    const v = await press(1, "KeyF");
    fireEvent.change(await screen.findByRole("textbox", { name: "Find" }), { target: { value: "foo" } });
    await screen.findByText("1/2");
    fireEvent.click(screen.getByRole("button", { name: "Filter Search Results" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Search In Changes" }));
    await screen.findByText("0 results");
    fireEvent.change(screen.getByRole("textbox", { name: "Find" }), { target: { value: "qu" } });
    await screen.findByText("1/1");
    // Replace searches the whole side, and doesn't offer the filter.
    await press(1, "KeyR");
    fireEvent.change(await screen.findByRole("textbox", { name: "Find" }), { target: { value: "foo" } });
    await waitFor(() => expect(screen.getByText(/\/2$/)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Filter Search Results" }));
    await screen.findByRole("menuitem", { name: /Search In Selection/ });
    expect(screen.queryByText("Search In Changes")).toBeNull();
    expect(v.state.doc.toString()).toBe("foo\nqux\nfoo\n");
  });
});

describe("Blank diff and Swap Sides", () => {
  const blank = (swappable = true) =>
    ({
      kind: "diff",
      key: "diff:blank",
      data: {
        path: "blank-diff:1",
        left: { type: "text", text: "one\n", label: "", editable: true },
        right: { type: "text", text: "", label: "", editable: true },
        swappable,
      },
    }) as unknown as EditorInput;

  it("lets both sides be typed into, and swaps them with what was typed", async () => {
    render(<DiffEditor input={blank()} />);
    const left = await pane(0);
    const right = await pane(1);
    expect(left.state.readOnly).toBe(false);
    expect(right.state.readOnly).toBe(false);
    right.dispatch({ changes: { from: 0, insert: "two\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Swap Sides" }));
    await waitFor(() => expect(left.dom.isConnected).toBe(false));
    expect((await pane(0)).state.doc.toString()).toBe("two\n");
    expect((await pane(1)).state.doc.toString()).toBe("one\n");
    (await pane(1)).dispatch({ changes: { from: 0, insert: "1 " } });
    const { focusedDiffNavigator } = await import("../diffNavigator");
    (await pane(0)).focus();
    await waitFor(() => expect(focusedDiffNavigator()).not.toBeNull());
    const before = await pane(0);
    expect(focusedDiffNavigator()!.swapSides()).toBe(true);
    await waitFor(() => expect(before.dom.isConnected).toBe(false));
    expect((await pane(0)).state.doc.toString()).toBe("1 one\n");
    expect((await pane(1)).state.doc.toString()).toBe("two\n");
  });

  it("offers Swap Sides only where the user picked both sides", async () => {
    render(<DiffEditor input={revisions} />);
    await pane(1);
    expect(screen.queryByRole("button", { name: "Swap Sides" })).toBeNull();
    const right = await pane(1);
    expect(right.state.readOnly).toBe(true);
  });
});

describe("Show Diff in External Tool", () => {
  afterEach(() => {
    useProject.setState({ settings: null });
    externalCalls.length = 0;
  });

  it("is offered once a tool is set, and passes the working file and the revision's text", async () => {
    render(<DiffEditor input={working} />);
    await pane(1);
    expect(screen.queryByRole("button", { name: "Show Diff in External Tool" })).toBeNull();
    useProject.setState({ settings: { externalDiff: { enabled: true, path: "/usr/bin/opendiff" } } as never });
    fireEvent.click(await screen.findByRole("button", { name: "Show Diff in External Tool" }));
    await waitFor(() => expect(externalCalls).toHaveLength(1));
    expect(externalCalls[0]).toEqual([
      { path: null, text: "foo\nbar\nfoo\n", name: "a.ts" },
      { path: "/p/a.ts", text: null, name: "a.ts" },
      "a.ts (HEAD ↔ Your version)",
    ]);
  });
});
