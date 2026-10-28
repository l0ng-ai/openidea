import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Branch, BranchInfo } from "@/bindings";
import { isMacHost } from "@/platform/keymap";

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: {
      ...real.commands,
      vcsLog: () => Promise.resolve({ status: "ok", data: [] }),
      vcsConfigGet: () => Promise.resolve({ status: "ok", data: null }),
    },
  };
});

import { BranchesPanel } from "../GitLog";
import { emptyFilters, useGitLog } from "../logStore";
import { useVcs } from "../store";

const b = (name: string, opts: Partial<Branch> = {}): Branch => ({
  name,
  remote: false,
  current: false,
  upstream: null,
  ahead: 0,
  behind: 0,
  lastCommitMs: 0,
  commit: "",
  ...opts,
});

const branches = [b("main", { current: true, commit: "1" }), b("feature", { commit: "2" })];

const head: BranchInfo = {
  head: "main",
  headCommit: "1",
  upstream: null,
  ahead: 0,
  behind: 0,
  operation: null,
};

const writeText = vi.fn().mockResolvedValue(undefined);
/** The copy modifier on this host: ⌘ on macOS, Ctrl elsewhere. */
const cmd = () => (isMacHost() ? { metaKey: true } : { ctrlKey: true });

beforeEach(() => {
  writeText.mockClear();
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  useVcs.setState({ root: "/p", repo: "/p", branches, branchesLoaded: true, branch: head });
  useGitLog.setState({ filters: emptyFilters() });
});

describe("Git Log branches pane", () => {
  it("one click only selects the branch", () => {
    render(<BranchesPanel />);
    fireEvent.mouseDown(screen.getByText("feature"));
    expect(useGitLog.getState().filters.branches).toEqual([]);
    expect(screen.getByText("feature").closest("[data-row]")).toHaveAttribute("aria-selected", "true");
  });

  it("double click switches the log to that branch", () => {
    render(<BranchesPanel />);
    fireEvent.doubleClick(screen.getByText("feature"));
    expect(useGitLog.getState().filters.branches).toEqual(["feature"]);
  });

  it("double click on the current branch switches to its log too", () => {
    render(<BranchesPanel />);
    fireEvent.doubleClick(screen.getByText("main"));
    expect(useGitLog.getState().filters.branches).toEqual(["main"]);
  });

  it("double click on HEAD shows HEAD's log", () => {
    render(<BranchesPanel />);
    fireEvent.doubleClick(screen.getByText("HEAD (Current Branch)"));
    expect(useGitLog.getState().filters.branches).toEqual(["HEAD"]);
  });

  it("Enter switches the log to every selected branch, in tree order", () => {
    useVcs.setState({ branches: [b("main", { current: true }), b("beta"), b("alpha")] });
    render(<BranchesPanel />);
    fireEvent.mouseDown(screen.getByText("beta"));
    fireEvent.mouseDown(screen.getByText("alpha"), cmd());
    expect(useGitLog.getState().filters.branches).toEqual([]);
    fireEvent.keyDown(screen.getByRole("tree", { name: "Branches" }), { key: "Enter" });
    expect(useGitLog.getState().filters.branches).toEqual(["alpha", "beta"]);
  });

  it("follows the log filter when it changes elsewhere", () => {
    render(<BranchesPanel />);
    fireEvent.mouseDown(screen.getByText("main"));
    act(() => useGitLog.setState({ filters: { ...emptyFilters(), branches: ["feature"] } }));
    expect(screen.getByText("feature").closest("[data-row]")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("main").closest("[data-row]")).toHaveAttribute("aria-selected", "false");
  });

  it("copies the selected branch name", async () => {
    render(<BranchesPanel />);
    fireEvent.mouseDown(screen.getByText("feature"));
    fireEvent.keyDown(screen.getByText("feature"), { key: "c", ...cmd() });
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("feature"));
  });

  it("copies HEAD as HEAD", async () => {
    render(<BranchesPanel />);
    fireEvent.mouseDown(screen.getByText("HEAD (Current Branch)"));
    fireEvent.keyDown(screen.getByText("HEAD (Current Branch)"), { key: "c", ...cmd() });
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("HEAD"));
  });

  it("copies the folder path along with the branch name", async () => {
    useVcs.setState({
      branches: [b("feat/idea-parity", { current: true, commit: "1" })],
      branch: { ...head, head: "feat/idea-parity" },
    });
    render(<BranchesPanel />);
    fireEvent.mouseDown(screen.getByText("idea-parity"));
    fireEvent.keyDown(screen.getByText("idea-parity"), { key: "c", ...cmd() });
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("feat/idea-parity"));
  });

  it("copies every selected branch, one per line, in tree order", async () => {
    useVcs.setState({ branches: [b("main", { current: true }), b("beta"), b("alpha")] });
    render(<BranchesPanel />);
    fireEvent.mouseDown(screen.getByText("beta"), cmd());
    fireEvent.mouseDown(screen.getByText("alpha"), cmd());
    fireEvent.keyDown(screen.getByText("alpha"), { key: "c", ...cmd() });
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("alpha\nbeta"));
  });

  it("leaves Cmd/Ctrl+C in the branch search field alone", async () => {
    render(<BranchesPanel />);
    fireEvent.mouseDown(screen.getByText("feature"));
    fireEvent.keyDown(screen.getByLabelText("Filter branches and tags"), { key: "c", ...cmd() });
    await Promise.resolve();
    expect(writeText).not.toHaveBeenCalled();
  });
});
