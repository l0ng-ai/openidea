import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { EditorInput } from "@/workbench/contributions";
import { Chunk, getChunks } from "@codemirror/merge";
import { Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { ContextMenuHost, iconMarkup } from "@/ui";

const probe = vi.fn();
const openFile = vi.fn();
const openInput = vi.fn();
const texts: Record<string, string> = { HEAD: "a\n", abc123: "a\n" };
let working = "a\n";
let workingEol = "lf";

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: {
      ...real.commands,
      fsProbe: (path: string) => probe(path),
      vcsFileAt: (_path: string, rev: string) => Promise.resolve({ status: "ok", data: texts[rev] }),
      fsReadText: () => Promise.resolve({ status: "ok", data: working }),
    },
  };
});

vi.mock("@/workbench/contributions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/workbench/contributions")>()),
  editorService: () => ({ openFile, openInput }),
}));

vi.mock("@/editor/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/editor/api")>()),
  attachDocument: (path: string) =>
    Promise.resolve({
      path,
      text: () => working,
      lineEnding: () => workingEol,
      readOnly: false,
      extension: [],
      save: () => Promise.resolve(),
      release: () => {},
    }),
}));

import { DiffEditor, mapLine } from "../DiffEditor";
import { DiffEditorTab } from "../diff-editor-tab";
import { diffInput, withChain, type DiffData } from "../diffInput";
import { useToolWindowLayout } from "@/workbench/toolwindows/store";
import { useProject } from "@/platform/project";
import { applyKeymapSettings, installKeyboardDispatcher, useKeymap } from "@/platform/keymap";
import { setContext } from "@/platform/context";
import { registerCompareActions } from "../compare";

/** Git Log opens a commit's file: both sides are revisions. */
const input = {
  kind: "diff",
  key: "diff:test",
  data: {
    path: "/p/a.ts",
    left: { type: "rev", rev: "HEAD" },
    right: { type: "rev", rev: "abc123" },
  },
} as unknown as EditorInput;

/** `d` attributes of an SVG, which is what tells two icons apart. */
const paths = (html: string) => [...html.matchAll(/ d="([^"]+)"/g)].map((m) => m[1]);

beforeEach(() => {
  workingEol = "lf";
  probe.mockReset();
  openFile.mockReset();
  openInput.mockReset();
  texts.HEAD = texts.abc123 = working = "a\n";
  probe.mockResolvedValue({ status: "ok", data: { size: 3, binary: false, tooLarge: false } });
});

describe("Diff toolbar", () => {
  it("can start an embedded comparison side by side without overwriting saved viewer preferences", async () => {
    localStorage.setItem("openidea.vcs.diffOptions", JSON.stringify({ mode: "unified" }));
    const mounted = render(<DiffEditor input={{ ...input, data: { ...(input.data as object), mode: "split" } }} />);
    await waitFor(() => expect(mounted.container.querySelectorAll(".cm-editor")).toHaveLength(2));
    expect(JSON.parse(localStorage.getItem("openidea.vcs.diffOptions")!).mode).toBe("unified");
    mounted.unmount();
    localStorage.removeItem("openidea.vcs.diffOptions");
  });
  it("shows a binary notice for disk comparisons instead of identical empty text", async () => {
    probe.mockResolvedValue({ status: "ok", data: { size: 3, binary: true, tooLarge: false } });
    const binaryInput = {
      ...input,
      data: { path: "/p/right.bin", left: { type: "file", path: "/p/left.bin" }, right: { type: "worktree" } },
    } as EditorInput;
    render(<DiffEditor input={binaryInput} />);
    expect(await screen.findByText("Binary files cannot be shown as text")).toBeInTheDocument();
    expect(screen.queryByText("Contents are identical")).toBeNull();
    expect(screen.queryByRole("region", { name: /left.bin/ })).toBeNull();
    probe.mockResolvedValue({ status: "ok", data: { size: 3, binary: false, tooLarge: false } });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.queryByText("Binary files cannot be shown as text")).toBeNull());
  });

  it.each([
    ["CRLF", "a\r\n", "a\n"],
    ["CR", "a\r", "a\n"],
    ["mixed with the same dominant ending", "a\r\nb\nc\n", "a\nb\nc\n"],
    ["mixed with a different dominant ending", "a\r\nb\r\nc\n", "a\nb\nc\n"],
  ])("reports %s line-separator-only differences", async (_name, a, b) => {
    texts.HEAD = a;
    texts.abc123 = b;
    render(<DiffEditor input={input} />);
    expect(await screen.findByText("Contents differ only in line separators")).toBeInTheDocument();
    expect(screen.queryByText("No differences")).toBeNull();
    expect(screen.queryByText("Contents are identical")).toBeNull();
  });

  it.each(["a\n", "a\r\n", "a\r\nb\n", ""])("recognizes identical contents %j", async (text) => {
    texts.HEAD = texts.abc123 = text;
    render(<DiffEditor input={input} />);
    expect(await screen.findByText("Contents are identical")).toBeInTheDocument();
    expect(screen.queryByText("Contents differ only in line separators")).toBeNull();
  });

  it("does not describe ignored whitespace as only line separators", async () => {
    localStorage.setItem("openidea.vcs.diffOptions", JSON.stringify({ ignore: "whitespace" }));
    texts.HEAD = "a \r\n";
    texts.abc123 = "a\n";
    const mounted = render(<DiffEditor input={input} />);
    await waitFor(() => expect(mounted.container.querySelectorAll(".cm-editor")).toHaveLength(2));
    expect(screen.queryByText("Contents differ only in line separators")).toBeNull();
    mounted.unmount();
    localStorage.removeItem("openidea.vcs.diffOptions");
  });

  it("compares a normalized live CRLF document with a raw CRLF revision", async () => {
    texts.HEAD = "a\r\n";
    workingEol = "crLf";
    render(
      <DiffEditor
        input={diffInput({ path: "/p/a.ts", left: { type: "rev", rev: "HEAD" }, right: { type: "worktree" } })}
      />,
    );
    expect(await screen.findByText("Contents are identical")).toBeInTheDocument();
    expect(screen.queryByText("Contents differ only in line separators")).toBeNull();
  });

  it("puts Jump to Source right after Next Difference, in the navigation group", async () => {
    render(<DiffEditor input={input} />);
    await screen.findByRole("button", { name: "Jump to Source" });
    const toolbar = screen.getByRole("toolbar", { name: "Diff" });
    const buttons = within(toolbar).getAllByRole("button");
    expect(buttons.slice(0, 3).map((b) => b.getAttribute("aria-label"))).toEqual([
      "Previous Difference",
      "Next Difference",
      "Jump to Source",
    ]);
    // One group: no separator between the three, one after them.
    expect(buttons[1]!.nextElementSibling).toBe(buttons[2]);
    expect(buttons[2]!.nextElementSibling).not.toBe(buttons[3]);
  });

  it("shows a pencil for Jump to Source", async () => {
    render(<DiffEditor input={input} />);
    const button = await screen.findByRole("button", { name: "Jump to Source" });
    expect(paths(button.querySelector("svg")!.innerHTML)).toEqual(paths(iconMarkup("edit", 14)!));
  });

  it("jumps to the working copy of a file shown at a revision", async () => {
    render(<DiffEditor input={input} />);
    await screen.findByRole("button", { name: "Jump to Source" });
    expect(probe).toHaveBeenCalledWith("/p/a.ts");
  });

  it("turns on aligned changes from the settings menu (off by default)", async () => {
    localStorage.clear();
    texts.HEAD = "a\nb\n";
    texts.abc123 = "a\nnew\nb\n";
    render(
      <>
        <DiffEditor input={input} />
        <ContextMenuHost />
      </>,
    );
    await waitFor(() => expect(document.querySelectorAll(".cm-mergeViewEditor .cm-editor")).toHaveLength(2));
    // Unpadded panes joined by the divider.
    await waitFor(() => expect(document.querySelector(".cm-diffDivider")).not.toBeNull());
    expect(document.querySelector(".cm-changeGutter")).toBeNull();
    expect(document.querySelector(".cm-merge-b .cm-lineNumbers .cm-diffGutter-inserted")?.textContent).toBe("2");
    // The lock turns scrolling together off without rebuilding the panes.
    const divider = document.querySelector(".cm-diffDivider");
    (await screen.findByRole("button", { name: "Synchronize Scrolling" })).click();
    await waitFor(() => expect(JSON.parse(localStorage.getItem("openidea.vcs.diffOptions")!).syncScroll).toBe(false));
    expect(document.querySelector(".cm-diffDivider")).toBe(divider);
    (await screen.findByRole("button", { name: "Settings" })).click();
    const item = await screen.findByRole("menuitemcheckbox", { name: "Align Changes" });
    expect(item.getAttribute("aria-checked")).toBe("false");
    item.click();
    // Padded panes, the changed lines' gutters still tinted as in IDEA.
    await waitFor(() => expect(document.querySelector(".cm-diffDivider")).toBeNull());
    expect(document.querySelector(".cm-merge-b .cm-lineNumbers .cm-diffGutter-inserted")?.textContent).toBe("2");
    expect(JSON.parse(localStorage.getItem("openidea.vcs.diffOptions")!)).toMatchObject({
      alignChanges: true,
      syncScroll: false,
    });
    localStorage.clear();
  });

  describe("soft wraps", () => {
    const wrapped = () =>
      [...document.querySelectorAll(".cm-editor .cm-content")].map((c) => c.classList.contains("cm-lineWrapping"));
    const editorSettings = (softWrap: boolean, softWrapFiles?: string) =>
      useProject.setState({
        settings: { editor: { softWrap, ...(softWrapFiles ? { general: { softWrapFiles } } : {}) } } as never,
      });

    beforeEach(() => {
      localStorage.clear();
      texts.HEAD = "a\nb\n";
      texts.abc123 = "a\nnew\nb\n";
    });

    it.each([
      { name: "the file matches Soft-wrap files", softWrap: true, files: "*.ts", mode: "split", expected: true },
      { name: "the file matches, unified viewer", softWrap: true, files: "*.ts", mode: "unified", expected: true },
      { name: "the file is not in Soft-wrap files", softWrap: true, files: undefined, mode: "split", expected: false },
      { name: "soft wraps are off in the editor", softWrap: false, files: "*.ts", mode: "split", expected: false },
    ] as const)("follow the editor's setting when $name", async ({ softWrap, files, mode, expected }) => {
      editorSettings(softWrap, files);
      localStorage.setItem("openidea.vcs.diffOptions", JSON.stringify({ mode }));
      render(<DiffEditor input={input} />);
      const panes = mode === "split" ? 2 : 1;
      await waitFor(() => expect(document.querySelectorAll(".cm-editor")).toHaveLength(panes));
      expect(wrapped()).toEqual(Array(panes).fill(expected));
      useProject.setState({ settings: null as never });
    });

    it.each([
      { mode: "split", alignChanges: false },
      { mode: "split", alignChanges: true },
      { mode: "unified", alignChanges: false },
    ])("reconfigures $mode (aligned: $alignChanges) without losing selection", async ({ mode, alignChanges }) => {
      editorSettings(true, "*.ts");
      localStorage.setItem("openidea.vcs.diffOptions", JSON.stringify({ mode, alignChanges }));
      const mounted = render(
        <>
          <DiffEditor input={input} />
          <ContextMenuHost />
        </>,
      );
      const count = mode === "split" ? 2 : 1;
      await waitFor(() => expect(document.querySelectorAll(".cm-editor")).toHaveLength(count));
      const views = [...document.querySelectorAll<HTMLElement>(".cm-editor")].map((dom) =>
        EditorView.findFromDOM(dom)!,
      );
      for (const view of views) view.dispatch({ selection: { anchor: 1 } });
      expect(wrapped()).toEqual(Array(count).fill(true));
      // Settings changes still apply until an explicit viewer override is made.
      editorSettings(false);
      await waitFor(() => expect(wrapped()).toEqual(Array(count).fill(false)));
      editorSettings(true, "*.ts");
      await waitFor(() => expect(wrapped()).toEqual(Array(count).fill(true)));
      fireEvent.click(screen.getByRole("button", { name: "Settings" }));
      fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Use Soft Wraps" }));
      await waitFor(() => expect(wrapped()).toEqual(Array(count).fill(false)));
      expect(JSON.parse(localStorage.getItem("openidea.vcs.diffOptions")!).softWrap).toBe(false);
      editorSettings(true, "*");
      await waitFor(() => expect(wrapped()).toEqual(Array(count).fill(false)));
      for (const view of views) {
        expect(view.dom.isConnected).toBe(true);
        expect(EditorView.findFromDOM(view.dom)).toBe(view);
        expect(view.state.selection.main.head).toBe(1);
      }
      mounted.unmount();
      render(<DiffEditor input={input} />);
      await waitFor(() => expect(document.querySelectorAll(".cm-editor")).toHaveLength(count));
      expect(wrapped()).toEqual(Array(count).fill(false));
      useProject.setState({ settings: null as never });
      localStorage.clear();
    });

    it("turn on from the settings menu and stay on", async () => {
      editorSettings(true);
      const mounted = render(
        <>
          <DiffEditor input={input} />
          <ContextMenuHost />
        </>,
      );
      await waitFor(() => expect(document.querySelectorAll(".cm-mergeViewEditor .cm-editor")).toHaveLength(2));
      expect(wrapped()).toEqual([false, false]);
      (await screen.findByRole("button", { name: "Settings" })).click();
      const item = await screen.findByRole("menuitemcheckbox", { name: "Use Soft Wraps" });
      expect(item.getAttribute("aria-checked")).toBe("false");
      item.click();
      await waitFor(() => expect(wrapped()).toEqual([true, true]));
      expect(JSON.parse(localStorage.getItem("openidea.vcs.diffOptions")!).softWrap).toBe(true);
      // The next diff opens wrapped although the editor would not wrap this file.
      mounted.unmount();
      render(<DiffEditor input={input} />);
      await waitFor(() => expect(document.querySelectorAll(".cm-mergeViewEditor .cm-editor")).toHaveLength(2));
      expect(wrapped()).toEqual([true, true]);
      useProject.setState({ settings: null as never });
      localStorage.clear();
    });
  });

  it("has no Jump to Source when the file is gone from the working tree", async () => {
    probe.mockRejectedValue(new Error("no such file"));
    render(<DiffEditor input={input} />);
    await waitFor(() => expect(probe).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole("button", { name: "Jump to Source" })).toBeNull());
  });
});

it.each([null, "bottom"] as const)(
  "maximizes a diff tab and restores the %s layout without rebuilding its editor",
  async (maximized) => {
    const layout = useToolWindowLayout.getState();
    const visible = { ...layout.visible, left: "project", bottom: "git" };
    useToolWindowLayout.setState({ visible, stashed: null, maximized });
    const mounted = render(<DiffEditorTab input={input} />);
    try {
      await waitFor(() => expect(document.querySelectorAll(".cm-mergeViewEditor .cm-editor")).toHaveLength(2));
      const dom = document.querySelectorAll<HTMLElement>(".cm-mergeViewEditor .cm-editor")[1]!;
      const view = EditorView.findFromDOM(dom)!;
      view.dispatch({ selection: { anchor: 1 } });
      fireEvent.click(screen.getByRole("button", { name: "Maximize Editor" }));
      expect(Object.values(useToolWindowLayout.getState().visible).every((id) => id === null)).toBe(true);
      expect(screen.getByRole("button", { name: "Restore Size" })).toHaveAttribute("aria-pressed", "true");
      expect(EditorView.findFromDOM(dom)).toBe(view);
      expect(view.state.selection.main.head).toBe(1);
      fireEvent.click(screen.getByRole("button", { name: "Restore Size" }));
      expect(useToolWindowLayout.getState().visible).toEqual(visible);
      expect(useToolWindowLayout.getState().maximized).toBe(maximized);
      expect(EditorView.findFromDOM(dom)).toBe(view);
      expect(view.state.selection.main.head).toBe(1);
    } finally {
      mounted.unmount();
      useToolWindowLayout.setState(layout);
    }
  },
);

it("does not offer editor maximization in an embedded diff", async () => {
  render(<DiffEditor input={input} />);
  await screen.findByRole("button", { name: "Jump to Source" });
  expect(screen.queryByRole("button", { name: "Maximize Editor" })).toBeNull();
});

it("restores the shared layout after the diff tab is remounted", async () => {
  const layout = useToolWindowLayout.getState();
  const visible = { ...layout.visible, left: "project", bottom: "git" };
  useToolWindowLayout.setState({ visible, stashed: null, maximized: "bottom" });
  const first = render(<DiffEditorTab input={input} />);
  fireEvent.click(screen.getByRole("button", { name: "Maximize Editor" }));
  first.unmount();
  const second = render(<DiffEditorTab input={input} />);
  try {
    fireEvent.click(screen.getByRole("button", { name: "Restore Size" }));
    expect(useToolWindowLayout.getState()).toMatchObject({ visible, maximized: "bottom" });
  } finally {
    second.unmount();
    useToolWindowLayout.setState(layout);
  }
});

it.each([
  {
    index: 0,
    dir: 1 as const,
    button: "Next Difference",
    hint: "Press again to go to the next file",
    path: "/p/b.ts",
    reveal: "first",
  },
  {
    index: 1,
    dir: -1 as const,
    button: "Previous Difference",
    hint: "Press again to go to the previous file",
    path: "/p/a.ts",
    reveal: "last",
  },
])("moves across files after the $button boundary hint", async ({ index, dir, button, hint, path, reveal }) => {
  texts.HEAD = "same\nold\n";
  texts.abc123 = "same\nnew\n";
  const items: DiffData[] = ["/p/a.ts", "/p/b.ts"].map((path) => ({
    path,
    left: { type: "rev", rev: "HEAD" },
    right: { type: "rev", rev: "abc123" },
  }));
  render(<DiffEditor input={diffInput(withChain(items, index))} />);
  await waitFor(() => expect(document.querySelectorAll(".cm-mergeViewEditor .cm-editor")).toHaveLength(2));
  const view = EditorView.findFromDOM(document.querySelectorAll<HTMLElement>(".cm-mergeViewEditor .cm-editor")[1]!)!;
  const chunks = getChunks(view.state)!.chunks;
  const chunk = dir === 1 ? chunks[chunks.length - 1]! : chunks[0]!;
  view.dispatch({ selection: { anchor: chunk.fromB } });
  fireEvent.click(screen.getByRole("button", { name: button }));
  expect(await screen.findByText(hint)).toBeInTheDocument();
  expect(openInput).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: button }));
  await waitFor(() => expect(openInput).toHaveBeenCalledOnce());
  expect(openInput.mock.calls[0]![0].data).toMatchObject({ path, reveal });
});

describe("Compare Previous / Next File buttons (#2492)", () => {
  const chained = (index: number) => {
    texts.HEAD = "same\nold\n";
    texts.abc123 = "same\nnew\n";
    const items: DiffData[] = ["/p/a.ts", "/p/b.ts", "/p/c.ts"].map((path) => ({
      path,
      left: { type: "rev", rev: "HEAD" },
      right: { type: "rev", rev: "abc123" },
    }));
    return diffInput(withChain(items, index));
  };
  const fileButtons = () => [
    screen.getByRole("button", { name: "Compare Previous File" }),
    screen.getByRole("button", { name: "Compare Next File" }),
  ];

  it("follows Next Difference in the toolbar and steps to the next file at once", async () => {
    render(<DiffEditor input={chained(1)} />);
    const toolbar = screen.getByRole("toolbar", { name: "Diff" });
    expect(
      within(toolbar)
        .getAllByRole("button")
        .slice(0, 4)
        .map((b) => b.getAttribute("aria-label")),
    ).toEqual(["Previous Difference", "Next Difference", "Compare Previous File", "Compare Next File"]);
    fireEvent.click(fileButtons()[1]!);
    await waitFor(() => expect(openInput).toHaveBeenCalledOnce());
    expect(openInput.mock.calls[0]![0].data).toMatchObject({
      path: "/p/c.ts",
      reveal: "first",
    });
  });

  it.each([
    [0, [true, false]],
    [1, [false, false]],
    [2, [false, true]],
  ])("disables the direction without a file at index %i", (index, disabled) => {
    render(<DiffEditor input={chained(index)} />);
    expect(fileButtons().map((b) => b.hasAttribute("disabled"))).toEqual(disabled);
  });

  it("has no file buttons for a single diff", () => {
    render(<DiffEditor input={input} />);
    expect(screen.queryByRole("button", { name: "Compare Next File" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Compare Previous File" })).toBeNull();
  });
});

const doc = (s: string) => Text.of(s.split("\n"));

describe("mapLine", () => {
  const from = doc("a\nb\nc\nd\ne\nf\ng\n");
  const to = doc("a\nX\nY\nb\nc\ne\nF1\nF2\ng\n");
  const map = (line: number) => mapLine(Chunk.build(from, to), line, from, to);

  it("shifts lines past an insertion and keeps lines before it", () => {
    expect(map(0)).toBe(0);
    expect(map(1)).toBe(3);
    expect(map(2)).toBe(4);
  });

  it("lands on the line after a removed block", () => {
    expect(map(3)).toBe(5);
    expect(map(4)).toBe(5);
  });

  it("keeps the offset inside a changed block and shifts past it", () => {
    expect(map(5)).toBe(6);
    expect(map(6)).toBe(8);
  });
});

describe("Jump to Source of a revision diff", () => {
  /** Parent, commit and working copy each add a line above the previous. */
  const setUp = () => {
    texts.HEAD = "a\nb\nc\nd\n";
    texts.abc123 = "a\nX\nY\nb\nc\nd\n";
    working = "new\na\nX\nY\nb\nc\nd\n";
  };
  const pane = async (index: number) => {
    await waitFor(() => expect(document.querySelectorAll(".cm-mergeViewEditor .cm-editor").length).toBe(2));
    return EditorView.findFromDOM(document.querySelectorAll<HTMLElement>(".cm-mergeViewEditor .cm-editor")[index]!)!;
  };
  const jumpFrom = async (index: number, line: number) => {
    const v = await pane(index);
    v.dispatch({ selection: { anchor: v.state.doc.line(line + 1).from + 1 } });
    v.contentDOM.dispatchEvent(new FocusEvent("focus"));
    (await screen.findByRole("button", { name: "Jump to Source" })).click();
    await waitFor(() => expect(openFile).toHaveBeenCalled());
    return openFile.mock.calls[0];
  };

  it("maps a line of the commit to the working copy", async () => {
    setUp();
    render(<DiffEditor input={input} />);
    expect(await jumpFrom(1, 2)).toEqual(["/p/a.ts", { selection: { line: 3, col: 1 }, focus: true }]);
  });

  it("maps a line of the parent through the diff to the working copy", async () => {
    setUp();
    render(<DiffEditor input={input} />);
    expect(await jumpFrom(0, 2)).toEqual(["/p/a.ts", { selection: { line: 5, col: 1 }, focus: true }]);
  });

  it("jumps on ⌘↓ in the IntelliJ macOS keymap only while a diff pane has focus", async () => {
    setUp();
    const keymap = useKeymap.getState();
    applyKeymapSettings("intellij-macos", {});
    const unregister = registerCompareActions();
    const uninstall = installKeyboardDispatcher(window);
    const cmdDown = (target: EventTarget) => {
      const e = new KeyboardEvent("keydown", {
        key: "ArrowDown",
        code: "ArrowDown",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      });
      target.dispatchEvent(e);
      return e;
    };
    try {
      render(<DiffEditor input={input} />);
      const v = await pane(1);
      v.dispatch({ selection: { anchor: v.state.doc.line(3).from + 1 } });
      v.contentDOM.dispatchEvent(new FocusEvent("focus"));
      v.contentDOM.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      expect(cmdDown(v.contentDOM).defaultPrevented).toBe(true);
      await waitFor(() => expect(openFile).toHaveBeenCalled());
      expect(openFile.mock.calls[0]).toEqual(["/p/a.ts", { selection: { line: 3, col: 1 }, focus: true }]);

      setContext("diffEditorFocus", false);
      const plain = document.body.appendChild(document.createElement("div"));
      expect(cmdDown(plain).defaultPrevented).toBe(false);
      plain.remove();
    } finally {
      uninstall();
      unregister();
      useKeymap.setState(keymap);
    }
  });
});

describe("Unified Revert", () => {
  for (const control of ["toolbar", "chunk"] as const) {
    it.each([
      ["a\nb", "a"],
      ["same", "same\n"],
      ["same\n", "same"],
      ["", "added"],
      ["deleted", ""],
    ])(`${control} restores %j from %j`, async (original, changed) => {
      localStorage.setItem("openidea.vcs.diffOptions", JSON.stringify({ mode: "unified", collapse: false }));
      texts.HEAD = original;
      working = changed;
      const mounted = render(
        <DiffEditor
          input={
            {
              ...input,
              data: {
                path: "/p/a.ts",
                left: { type: "rev", rev: "HEAD" },
                right: { type: "worktree" },
              },
            } as EditorInput
          }
        />,
      );
      try {
        await waitFor(() => expect(document.querySelectorAll(".cm-editor")).toHaveLength(1));
        const view = EditorView.findFromDOM(document.querySelector<HTMLElement>(".cm-editor")!)!;
        if (control === "toolbar") {
          const button = await screen.findByRole("button", { name: "Revert Change" });
          await waitFor(() => expect(button).not.toBeDisabled());
          fireEvent.click(button);
        } else {
          fireEvent.mouseDown(await screen.findByRole("button", { name: /^Revert$/ }));
        }
        await waitFor(() => expect(view.state.doc.toString()).toBe(original));
      } finally {
        mounted.unmount();
        localStorage.clear();
      }
    });
  }
});

describe("Diff navigation caret", () => {
  // @codemirror/view hides `.cm-cursor` unless its editor carries `.cm-focused`, and that class
  // follows `view.hasFocus`, false while the document itself is unfocused. jsdom reports a
  // focused document only when told to, so the caret these tests are about is asserted the same way.
  let documentFocused: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    localStorage.clear();
    documentFocused = vi.spyOn(document, "hasFocus").mockReturnValue(true);
  });
  afterEach(() => {
    documentFocused.mockRestore();
    localStorage.clear();
  });

  /** One change on line 2 of the right (or only) pane. */
  const reveal = async (mode: "split" | "unified") => {
    localStorage.setItem("openidea.vcs.diffOptions", JSON.stringify({ mode }));
    texts.HEAD = "a\nb\nc\n";
    texts.abc123 = "a\nB\nc\n";
    const mounted = render(<DiffEditor input={input} />);
    const panes = mode === "split" ? 2 : 1;
    await waitFor(() => expect(document.querySelectorAll(".cm-editor")).toHaveLength(panes));
    const view = () => EditorView.findFromDOM([...document.querySelectorAll<HTMLElement>(".cm-editor")][panes - 1]!)!;
    return { mounted, view };
  };

  it.each([
    ["Next Difference", "split", false],
    ["Previous Difference", "split", true],
    ["Next Difference", "unified", false],
    ["Previous Difference", "unified", true],
  ] as const)("keeps the caret visible for %s in the %s viewer", async (label, mode, fromEnd) => {
    const { mounted, view } = await reveal(mode);
    try {
      const button = await screen.findByRole("button", { name: label });
      if (fromEnd) view().dispatch({ selection: { anchor: view().state.doc.length } });
      // A click leaves focus on the button, outside the panes.
      button.focus();
      expect(view().hasFocus).toBe(false);
      fireEvent.click(button);
      expect(view().state.doc.lineAt(view().state.selection.main.head).number).toBe(2);
      expect(view().hasFocus).toBe(true);
    } finally {
      mounted.unmount();
    }
  });

  it("keeps the caret visible when F7 runs while focus is outside the panes", async () => {
    const keymap = useKeymap.getState();
    applyKeymapSettings("intellij-macos", {});
    const unregister = registerCompareActions();
    const uninstall = installKeyboardDispatcher(window);
    const { mounted, view } = await reveal("split");
    try {
      const next = await screen.findByRole("button", { name: "Next Difference" });
      next.focus();
      expect(view().hasFocus).toBe(false);
      next.dispatchEvent(new KeyboardEvent("keydown", { key: "F7", code: "F7", bubbles: true, cancelable: true }));
      await waitFor(() => expect(view().state.doc.lineAt(view().state.selection.main.head).number).toBe(2));
      expect(view().hasFocus).toBe(true);
    } finally {
      mounted.unmount();
      uninstall();
      unregister();
      useKeymap.setState(keymap);
    }
  });
});
