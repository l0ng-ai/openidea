import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return { ...real, call: vi.fn(async () => null) };
});

vi.mock("../DiffEditor", () => ({ DiffEditor: () => <div /> }));

import { call } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { useContextMenuStore } from "@/ui/Menu";
import { ChangesTree } from "../CommitView";
import { initialChangelists, useChangelists } from "../changelists";
import { setShowUnversionedSeparately, useCommit } from "../commitStore";
import { useVcs } from "../store";

const label = "Show Unversioned Files Separately";

function toggleSeparate() {
  fireEvent.click(screen.getByRole("button", { name: "View Options" }));
  const item = useContextMenuStore.getState().menu!.items.find((i) => "label" in i && i.label === label);
  expect(item).toMatchObject({ checked: useCommit.getState().showUnversionedSeparately });
  act(() => {
    (item as { run: () => void }).run();
    useContextMenuStore.setState({ menu: null });
  });
}

describe("unversioned grouping in View Options", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    useCommit.setState({
      groupByDir: false,
      groupByStaging: false,
      groupByRepo: true,
      showUnversionedSeparately: true,
      diffPreview: false,
      commitDiffPreview: false,
      checks: new Map(),
      selection: [],
    });
    useChangelists.setState({ state: initialChangelists() });
    useProject.setState({
      project: { name: "p", root: "/p", trusted: true, isGit: true, settings: {} } as never,
      settings: {} as never,
    });
    useVcs.setState({
      root: "/p",
      repo: "/p",
      roots: ["/p"],
      heads: {},
      status: [
        { path: "/p/old.txt", relPath: "old.txt", staged: null, unstaged: "modified", renamedFrom: null },
        { path: "/p/new.txt", relPath: "new.txt", staged: null, unstaged: "untracked", renamedFrom: null },
      ],
    });
  });

  it.each([false, true])("merges and separates without changing staging grouping (%s)", (groupByStaging) => {
    useCommit.setState({ groupByStaging });
    render(<ChangesTree mode="local" />);
    expect(screen.getByText("Unversioned Files")).toBeTruthy();
    toggleSeparate();
    expect(screen.queryByText("Unversioned Files")).toBeNull();
    expect(screen.getByText("new.txt")).toBeTruthy();
    expect(screen.getByText(groupByStaging ? "Unstaged Changes" : "Changes")).toBeTruthy();
    expect(useCommit.getState().groupByStaging).toBe(groupByStaging);
    expect(localStorage.getItem("openidea.vcs.showUnversionedSeparately")).toBe("false");
    expect(call).not.toHaveBeenCalled();
    toggleSeparate();
    expect(screen.getByText("Unversioned Files")).toBeTruthy();
    expect(localStorage.getItem("openidea.vcs.showUnversionedSeparately")).toBe("true");
  });

  it("keeps merged untracked files unchecked in the Commit tool window", () => {
    render(<ChangesTree mode="commit" />);
    toggleSeparate();
    const checkbox = screen.getByRole("checkbox", { name: "Include new.txt in commit" });
    expect(checkbox.getAttribute("aria-checked")).toBe("false");
  });

  it("also merges untracked files when the Git staging area forces staging groups", () => {
    useProject.setState({ settings: { vcs: { git: { stagingArea: true } } } as never });
    render(<ChangesTree mode="commit" />);
    toggleSeparate();
    expect(screen.queryByText("Unversioned Files")).toBeNull();
    expect(screen.getByText("Unstaged Changes")).toBeTruthy();
    expect(screen.getByText("new.txt")).toBeTruthy();
    expect(useCommit.getState().groupByStaging).toBe(false);
  });

  it("remembers the choice when remounting the tree", () => {
    const view = render(<ChangesTree mode="local" />);
    toggleSeparate();
    view.unmount();
    render(<ChangesTree mode="local" />);
    expect(screen.queryByText("Unversioned Files")).toBeNull();
    expect(screen.getByText("new.txt")).toBeTruthy();
  });
});

describe("unversioned grouping persistence", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it("starts on with no stored choice", async () => {
    const { useCommit: fresh } = await import("../commitStore");
    expect(fresh.getState().showUnversionedSeparately).toBe(true);
  });

  it("loads a disabled choice from storage", async () => {
    setShowUnversionedSeparately(false);
    const { useCommit: fresh } = await import("../commitStore");
    expect(fresh.getState().showUnversionedSeparately).toBe(false);
  });
});
