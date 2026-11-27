import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A tiny backend: staging flips a file to `added`, and status reads answer with
 * the very array the store holds, so a refresh after Add to VCS sees the flip.
 */
const backend = vi.hoisted(() => {
  const state: { files: Array<{ path: string; staged: string | null; unstaged: string | null }> } = { files: [] };
  const stage = vi.fn(async (paths: string[]) => {
    for (const f of state.files) {
      if (paths.includes(f.path)) {
        f.staged = "added";
        f.unstaged = null;
      }
    }
    return { status: "ok", data: null };
  });
  return { state, stage };
});

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: {
      ...real.commands,
      vcsStage: backend.stage,
      vcsStatus: async () => ({ status: "ok", data: backend.state.files }),
      vcsBranchInfo: async () => ({ status: "ok", data: null }),
      vcsRoots: async () => ({ status: "ok", data: [{ root: "/p", operation: null }] }),
    },
  };
});

vi.mock("../DiffEditor", () => ({ DiffEditor: () => <div /> }));

import { ChangesTree } from "../CommitView";
import { initialChangelists, useChangelists } from "../changelists";
import { useCommit } from "../commitStore";
import { useVcs } from "../store";

/** The `.nodeRow` carrying a label (a drag source or drop target). */
function row(name: string): HTMLElement {
  const label = screen.getByText(name, { exact: true });
  const r = label.closest("span[class*='nodeRow']");
  if (!r) throw new Error(`no node row for ${name}`);
  return r as HTMLElement;
}

function treeItem(name: string): HTMLElement {
  return (screen.getByText(name, { exact: true }).closest('[role="treeitem"]') as HTMLElement)!;
}

/** The registered drop target is the row's wrapper; point elementFromPoint at it. */
function hit(target: HTMLElement) {
  return () => target;
}

/** Presses `source` and drags it onto `target` with pointer events. */
function drag(source: HTMLElement, target: HTMLElement) {
  document.elementFromPoint = hit(target);
  fireEvent(source, new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
  act(() => {
    window.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, buttons: 1, clientX: 60, clientY: 60 }));
  });
  act(() => {
    window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 60, clientY: 60 }));
  });
}

async function expandUnversioned() {
  // Unversioned Files starts collapsed; expand it via its chevron.
  const group = await screen.findByText("Unversioned Files");
  act(() => fireEvent.mouseDown(group.closest('[role="treeitem"]')!.querySelector("[data-tree-toggle]")!));
}

describe("dragging unversioned rows onto a change list", () => {
  const originalElementFromPoint = document.elementFromPoint;

  beforeEach(() => {
    backend.stage.mockClear();
    localStorage.clear();
    useCommit.setState({ groupByDir: false, checks: new Map(), selection: [] });
    useChangelists.setState({
      state: {
        ...initialChangelists(),
        lists: [
          { id: "default", name: "Changes", comment: "" },
          { id: "dd", name: "dd", comment: "" },
        ],
        files: { "src/a.ts": "default" },
      },
    });
    backend.state.files = [
      { path: "/p/src/a.ts", staged: null, unstaged: "modified" },
      { path: "/p/new1.txt", staged: null, unstaged: "untracked" },
      { path: "/p/new2.txt", staged: null, unstaged: "untracked" },
    ] as never;
    useVcs.setState({
      available: true,
      root: "/p",
      repo: "/p",
      roots: ["/p"],
      heads: {},
      status: backend.state.files as never,
    });
  });

  afterEach(() => {
    document.elementFromPoint = originalElementFromPoint;
  });

  it("drags the Unversioned Files header: every file is added to Git and joins the list", async () => {
    render(<ChangesTree mode="commit" />);
    // The collapsed group's header row drags whole.
    const source = row("Unversioned Files");
    const target = row("dd");
    await act(async () => drag(source, target));

    expect(backend.stage).toHaveBeenCalledWith(["/p/new1.txt", "/p/new2.txt"]);
    expect(useChangelists.getState().state.files).toEqual({
      "src/a.ts": "default",
      "new1.txt": "dd",
      "new2.txt": "dd",
    });
  });

  it("does nothing when the Unversioned Files header is dropped on itself", async () => {
    render(<ChangesTree mode="commit" />);
    const source = row("Unversioned Files");
    await act(async () => drag(source, source));

    expect(backend.stage).not.toHaveBeenCalled();
    expect(useChangelists.getState().state.files).toEqual({ "src/a.ts": "default" });
  });

  it("drags a multi-selection of unversioned files onto the list", async () => {
    render(<ChangesTree mode="commit" />);
    await expandUnversioned();

    // Multi-select the two files with a Meta-click, as in the tree.
    const first = row("new1.txt");
    const target = row("dd");
    act(() => fireEvent.mouseDown(treeItem("new1.txt")));
    act(() => fireEvent.mouseDown(treeItem("new2.txt"), { metaKey: true }));

    await act(async () => drag(first, target));

    expect(backend.stage).toHaveBeenCalledWith(["/p/new1.txt", "/p/new2.txt"]);
    expect(useChangelists.getState().state.files).toEqual({
      "src/a.ts": "default",
      "new1.txt": "dd",
      "new2.txt": "dd",
    });
  });

  it("drags a single unversioned file without touching its neighbours", async () => {
    render(<ChangesTree mode="commit" />);
    await expandUnversioned();

    const source = row("new1.txt");
    const target = row("dd");
    await act(async () => drag(source, target));

    expect(backend.stage).toHaveBeenCalledWith(["/p/new1.txt"]);
    expect(useChangelists.getState().state.files).toEqual({ "src/a.ts": "default", "new1.txt": "dd" });
  });
});
