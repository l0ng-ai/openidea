import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return { ...real, call: vi.fn(async () => null) };
});

vi.mock("../DiffEditor", () => ({ DiffEditor: () => <div /> }));

import { ChangesTree } from "../CommitView";
import { initialChangelists, useChangelists } from "../changelists";
import { useCommit } from "../commitStore";
import { useVcs } from "../store";

const change = (path: string) => ({
  path,
  relPath: path.replace(/^\/p\//, ""),
  staged: null,
  unstaged: "modified" as const,
  renamedFrom: null,
});

/** The `.nodeRow` carrying the changelist group's label (the drag source / drop target). */
function groupRow(name: string): HTMLElement {
  const label = screen.getByText(name, { exact: true });
  const row = label.closest("span[class*='nodeRow']");
  if (!row) throw new Error(`no change-list row for ${name}`);
  return row as HTMLElement;
}

/** The registered drop target is the group row's wrapper; point elementFromPoint at it. */
function hit(row: HTMLElement) {
  return () => row;
}

describe("dragging a change-list folder onto another change list", () => {
  const originalElementFromPoint = document.elementFromPoint;

  beforeEach(() => {
    localStorage.clear();
    useCommit.setState({ groupByDir: false, checks: new Map(), selection: [] });
    useChangelists.setState({
      state: {
        ...initialChangelists(),
        lists: [
          { id: "default", name: "Changes", comment: "" },
          { id: "dd", name: "dd", comment: "" },
        ],
        files: { "src/a.ts": "default", "src/b.ts": "default" },
      },
    });
    useVcs.setState({
      root: "/p",
      repo: "/p",
      roots: ["/p"],
      heads: {},
      status: [change("/p/src/a.ts"), change("/p/src/b.ts")],
    });
  });

  afterEach(() => {
    document.elementFromPoint = originalElementFromPoint;
  });

  it("moves every file of the dragged list into the target list", () => {
    render(<ChangesTree mode="commit" />);
    const source = groupRow("Changes");
    const target = groupRow("dd");
    // Drop targets are found by elementFromPoint walking up ancestors.
    document.elementFromPoint = hit(target);

    fireEvent(source, new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
    act(() => {
      window.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, buttons: 1, clientX: 60, clientY: 60 }));
    });
    // The whole folder is picked up: the drag ghost follows the pointer.
    expect(document.querySelector("[aria-hidden='true'][class*='ghost']")).not.toBeNull();
    act(() => {
      window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 60, clientY: 60 }));
    });

    expect(useChangelists.getState().state.files).toEqual({ "src/a.ts": "dd", "src/b.ts": "dd" });
  });

  it("does nothing when a list is dropped on itself", () => {
    render(<ChangesTree mode="commit" />);
    const source = groupRow("dd");
    document.elementFromPoint = hit(source);

    fireEvent(source, new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
    act(() => {
      window.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, buttons: 1, clientX: 60, clientY: 60 }));
    });
    act(() => {
      window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 60, clientY: 60 }));
    });

    expect(useChangelists.getState().state.files).toEqual({ "src/a.ts": "default", "src/b.ts": "default" });
  });
});
