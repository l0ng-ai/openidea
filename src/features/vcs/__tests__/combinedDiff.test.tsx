import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../DiffEditor", () => ({
  ResolvedDiffEditor: ({ input, fit }: { input: { data: { path: string; mode?: string } }; fit?: boolean }) => (
    <div data-testid="block-diff" data-path={input.data.path} data-mode={input.data.mode} data-fit={String(!!fit)} />
  ),
}));

import { provideEditorService, type EditorInput } from "@/workbench/contributions";
import { useProject } from "@/platform/project";
import { allInOneDiff, combinedOf, setAllInOneDiff } from "../allInOneDiff";
import { CombinedDiffTab, blockKind } from "../CombinedDiff";
import { COMBINED_DIFF_KIND } from "../allInOneDiff";
import { combinedDiffInput, openDiff, withChain, type DiffData } from "../diffInput";

const diff = (path: string, extra: Partial<DiffData> = {}): DiffData => ({
  path,
  left: { type: "rev", rev: "HEAD" },
  right: { type: "worktree" },
  ...extra,
});
const items = [diff("/r/src/a.ts"), diff("/r/src/b.ts"), diff("/r/c.md")];

const openInput = vi.fn(async (_input: EditorInput, _opts?: unknown) => undefined);
const closeInput = vi.fn();
const openFile = vi.fn(async () => undefined);
provideEditorService({ openInput, openFile, closeInput } as never);

beforeEach(() => {
  localStorage.clear();
  useProject.setState({ project: { name: "r", root: "/r", trusted: true, isGit: true, settings: {} } as never });
  openInput.mockClear();
  closeInput.mockClear();
});

describe("all-in-one diff", () => {
  it("is off by default; on, a diff of a change with several files opens all of them", () => {
    expect(allInOneDiff()).toBe(false);
    expect(combinedOf(withChain(items, 1))).toBeNull();
    setAllInOneDiff(true);
    expect(combinedOf(withChain(items, 1))).toMatchObject({ reveal: "/r/src/b.ts" });
    expect(combinedOf(withChain(items, 1))!.items).toHaveLength(3);
    // One file, or a diff shown inside another view, stays as it is.
    expect(combinedOf(diff("/r/a"))).toBeNull();
    expect(combinedOf({ ...withChain(items, 0), embedded: true })).toBeNull();
  });

  it("opens one tab per change, whichever of its files asked", async () => {
    setAllInOneDiff(true);
    await openDiff(withChain(items, 0));
    await openDiff({ ...withChain(items, 2), line: 4 });
    const [first, second] = openInput.mock.calls.map((c) => c[0]);
    expect(first!.kind).toBe(COMBINED_DIFF_KIND);
    expect(second!.key).toBe(first!.key);
    expect(second!.path).toBe("/r/c.md");
    // The blocks don't carry the chain or the reveal of the file that opened them.
    const blocks = (first!.data as { items: DiffData[] }).items;
    expect(blocks.every((b) => !b.chain && b.line === undefined)).toBe(true);
  });

  it("keeps one diff per file while off", async () => {
    await openDiff(withChain(items, 0));
    expect(openInput.mock.calls[0]![0].kind).toBe("diff");
  });

  it("tells added and deleted files from the absent side", () => {
    expect(blockKind(diff("/r/a", { left: { type: "text", text: "", label: "", absent: true } }))).toBe("added");
    expect(blockKind(diff("/r/a", { right: { type: "text", text: "", label: "", absent: true } }))).toBe("deleted");
    expect(blockKind(diff("/r/a"))).toBe("modified");
  });
});

describe("the all-in-one diff tab", () => {
  const input = combinedDiffInput({ items });

  it("shows a block per file, each diff fitted to its content", () => {
    render(<CombinedDiffTab input={input} />);
    expect(screen.getByText("3 files")).toBeTruthy();
    const blocks = screen.getAllByTestId("block-diff");
    expect(blocks.map((b) => b.dataset.path)).toEqual(["/r/src/a.ts", "/r/src/b.ts", "/r/c.md"]);
    expect(blocks.every((b) => b.dataset.fit === "true")).toBe(true);
    expect(screen.getAllByText("src")).toHaveLength(2);
  });

  it("collapses a file and all files, keeping their diffs (and unsaved edits) loaded", () => {
    render(<CombinedDiffTab input={input} />);
    const shown = () => screen.queryAllByTestId("block-diff").filter((b) => !b.closest("[hidden]"));
    const first = screen.getAllByTestId("block-diff")[0]!;
    act(() => {
      fireEvent.click(screen.getAllByRole("button", { name: "Collapse File" })[0]!);
    });
    expect(shown()).toHaveLength(2);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Collapse All Files" }));
    });
    expect(shown()).toHaveLength(0);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Expand All Files" }));
    });
    expect(shown()).toHaveLength(3);
    // The same diff all along: collapsing never released its document.
    expect(screen.getAllByTestId("block-diff")[0]).toBe(first);
  });

  it("switches every block between side-by-side and unified, collapsed ones too, in place", () => {
    render(<CombinedDiffTab input={input} />);
    const before = screen.getAllByTestId("block-diff");
    act(() => {
      fireEvent.click(screen.getAllByRole("button", { name: "Collapse File" })[0]!);
    });
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Unified Viewer" }));
    });
    const after = screen.getAllByTestId("block-diff");
    expect(after.every((b) => b.dataset.mode === "unified")).toBe(true);
    // The same diffs: switching never released their documents (and unsaved edits).
    expect(after).toEqual(before);
    after.forEach((b, i) => expect(b).toBe(before[i]));
  });

  it("opens a file's own diff, and goes back to one tab per file", async () => {
    setAllInOneDiff(true);
    render(<CombinedDiffTab input={input} />);
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: "Open in Separate Tab" })[1]!);
    });
    const own = openInput.mock.calls[0]![0];
    expect(own).toMatchObject({ kind: "diff", path: "/r/src/b.ts" });
    expect((own.data as DiffData).chain).toHaveLength(3);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Show Files in Separate Diff Tabs" }));
    });
    expect(allInOneDiff()).toBe(false);
    expect(openInput.mock.calls[1]![0].kind).toBe("diff");
    expect(closeInput).toHaveBeenCalledWith(input.key);
  });
});
