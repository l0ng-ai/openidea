import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { EditorInput } from "@/workbench/contributions";
import { Chunk } from "@codemirror/merge";
import { Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { ContextMenuHost, iconMarkup } from "@/ui";

const probe = vi.fn();
const openFile = vi.fn();
const texts: Record<string, string> = { HEAD: "a\n", abc123: "a\n" };
let working = "a\n";

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
  editorService: () => ({ openFile }),
}));

vi.mock("@/editor/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/editor/api")>()),
  attachDocument: (path: string) =>
    Promise.resolve({
      path,
      text: () => working,
      readOnly: false,
      extension: [],
      save: () => Promise.resolve(),
      release: () => {},
    }),
}));

import { DiffEditor, mapLine } from "../DiffEditor";

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
  probe.mockReset();
  openFile.mockReset();
  texts.HEAD = texts.abc123 = working = "a\n";
  probe.mockResolvedValue({ status: "ok", data: { size: 3, binary: false, tooLarge: false } });
});

describe("Diff toolbar", () => {
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

  it("has no Jump to Source when the file is gone from the working tree", async () => {
    probe.mockRejectedValue(new Error("no such file"));
    render(<DiffEditor input={input} />);
    await waitFor(() => expect(probe).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole("button", { name: "Jump to Source" })).toBeNull());
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
