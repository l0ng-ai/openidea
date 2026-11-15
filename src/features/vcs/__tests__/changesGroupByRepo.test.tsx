import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return { ...real, call: vi.fn() };
});

vi.mock("../DiffEditor", () => ({ DiffEditor: () => <div /> }));

import { ChangesTree } from "../CommitView";
import { setGroupByRepo, useCommit } from "../commitStore";
import { useVcs } from "../store";
import { useProject } from "@/platform/project";
import { useContextMenuStore, type MenuItem } from "@/ui/Menu";

const change = (path: string) => ({
  path,
  relPath: path.split("/").slice(3).join("/"),
  staged: null,
  unstaged: "modified" as const,
  renamedFrom: null,
});

/** The Group By items of the View Options menu: label → checked. */
function groupByItems(): Record<string, boolean> {
  act(() => {
    fireEvent.click(screen.getByRole("button", { name: "View Options" }));
  });
  const items = useContextMenuStore.getState().menu!.items as Array<MenuItem & { label?: string; checked?: boolean }>;
  act(() => useContextMenuStore.setState({ menu: null }));
  const end = items.findIndex((i) => i.kind === "separator");
  return Object.fromEntries(
    items
      .slice(0, end < 0 ? undefined : end)
      .filter((i) => i.kind !== "header" && i.label)
      .map((i) => [i.label!, !!i.checked]),
  );
}

function runItem(label: string) {
  act(() => {
    fireEvent.click(screen.getByRole("button", { name: "View Options" }));
  });
  const item = useContextMenuStore.getState().menu!.items.find((i) => "label" in i && i.label === label) as {
    run: () => void;
  };
  act(() => {
    item.run();
    useContextMenuStore.setState({ menu: null });
  });
}

describe("Group By › Repository in the changes tree", () => {
  beforeEach(() => {
    localStorage.clear();
    useCommit.setState({
      groupByDir: false,
      groupByStaging: false,
      groupByRepo: true,
      checks: new Map(),
      selection: [],
    });
    useProject.setState({
      project: { name: "p", root: "/p", trusted: true, isGit: true, settings: {} } as never,
      settings: {} as never,
    });
    useVcs.setState({
      root: "/p",
      repo: "/p",
      roots: ["/p", "/p/orders"],
      status: [change("/p/src/App.kt"), change("/p/orders/src/App.kt")],
      heads: {},
    });
  });

  it("is offered, checked, with several repositories", () => {
    render(<ChangesTree mode="commit" />);
    expect(groupByItems()).toEqual({ Directory: false, Repository: true, "Staging State": false });
  });

  it("is not offered with one repository", () => {
    useVcs.setState({ roots: ["/p"], status: [change("/p/src/App.kt")] });
    render(<ChangesTree mode="commit" />);
    expect(groupByItems()).toEqual({ Directory: false, "Staging State": false });
  });

  it("unchecked, lists both repositories' files together and remembers the choice", () => {
    render(<ChangesTree mode="commit" />);
    expect(screen.getByText("orders")).toBeTruthy();
    runItem("Repository");
    expect(useCommit.getState().groupByRepo).toBe(false);
    expect(localStorage.getItem("openidea.vcs.groupByRepo")).toBe("false");
    expect(screen.queryByText("orders")).toBeNull();
    expect(screen.getAllByText("App.kt")).toHaveLength(2);
    expect(screen.getByText("orders/src")).toBeTruthy();
    expect(groupByItems().Repository).toBe(false);
    // Each file keeps its own checkbox.
    const boxes = screen.getAllByRole("checkbox", { name: "Include App.kt in commit" });
    expect(boxes).toHaveLength(2);
    act(() => {
      fireEvent.mouseDown(boxes[0]!);
    });
    expect([...useCommit.getState().checks]).toEqual([["/p/orders/src/App.kt", "none"]]);
    runItem("Repository");
    expect(localStorage.getItem("openidea.vcs.groupByRepo")).toBe("true");
    expect(screen.getByText("orders")).toBeTruthy();
  });
});

describe("Group By › Repository persistence", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it("starts on when nothing is stored", async () => {
    const { useCommit: fresh } = await import("../commitStore");
    expect(fresh.getState().groupByRepo).toBe(true);
  });

  it("starts with the stored choice", async () => {
    setGroupByRepo(false);
    const { useCommit: fresh } = await import("../commitStore");
    expect(fresh.getState().groupByRepo).toBe(false);
  });
});
