import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { BranchInfo } from "@/bindings";

const mocks = vi.hoisted(() => ({ pull: vi.fn(), push: vi.fn() }));

vi.mock("../remoteUi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../remoteUi")>()),
  pullCurrentBranch: mocks.pull,
  pushCurrentBranch: mocks.push,
}));

import { SyncButtons } from "../GitLog";
import { useVcs } from "../store";

const branch = (patch: Partial<BranchInfo> = {}): BranchInfo => ({
  head: "main",
  headCommit: "c1",
  upstream: "origin/main",
  ahead: 0,
  behind: 0,
  operation: null,
  ...patch,
});

beforeEach(() => {
  vi.clearAllMocks();
  useVcs.setState({ branch: branch(), remoteBusy: null });
});

describe("Git Log pull / push buttons", () => {
  it("shows the distance to the upstream and runs the operation", () => {
    useVcs.setState({ branch: branch({ ahead: 3, behind: 2 }) });
    render(<SyncButtons />);
    const push = screen.getByRole("button", { name: "Push to origin/main" });
    const pull = screen.getByRole("button", { name: "Pull from origin/main" });
    expect(push).toHaveTextContent("3");
    expect(pull).toHaveTextContent("2");
    expect(push).not.toHaveAttribute("aria-disabled");
    expect(pull).not.toHaveAttribute("aria-disabled");
    fireEvent.click(push);
    expect(mocks.push).toHaveBeenCalledOnce();
    fireEvent.click(pull);
    expect(mocks.pull).toHaveBeenCalledOnce();
  });

  it("greys out what has nothing to send or receive, keeping the tooltip", () => {
    render(<SyncButtons />);
    const push = screen.getByRole("button", { name: "Push to origin/main" });
    const pull = screen.getByRole("button", { name: "Pull from origin/main" });
    for (const button of [push, pull]) {
      expect(button).toHaveAttribute("aria-disabled", "true");
      expect(button).toHaveAttribute("data-tooltip");
      expect(button).not.toHaveTextContent("0");
    }
    fireEvent.click(push);
    fireEvent.click(pull);
    expect(mocks.push).not.toHaveBeenCalled();
    expect(mocks.pull).not.toHaveBeenCalled();
  });

  it("disables both while a merge or rebase is in progress", () => {
    useVcs.setState({ branch: branch({ ahead: 2, behind: 1, operation: "rebase" }) });
    render(<SyncButtons />);
    const buttons = screen.getAllByRole("button", { name: "Finish the Git operation in progress first" });
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      expect(button).toHaveAttribute("aria-disabled", "true");
      fireEvent.click(button);
    }
    expect(mocks.push).not.toHaveBeenCalled();
    expect(mocks.pull).not.toHaveBeenCalled();
  });

  it("disables both without an upstream branch", () => {
    useVcs.setState({ branch: branch({ upstream: null, ahead: 2 }) });
    render(<SyncButtons />);
    const buttons = screen.getAllByRole("button", { name: "No upstream branch" });
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      expect(button).toHaveAttribute("aria-disabled", "true");
      fireEvent.click(button);
    }
    expect(mocks.push).not.toHaveBeenCalled();
    expect(mocks.pull).not.toHaveBeenCalled();
  });
});
