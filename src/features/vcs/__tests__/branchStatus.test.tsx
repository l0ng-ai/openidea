import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BranchStatus, GIT_BRANCH_STATUS } from "../BranchStatus";
import { useBranchesPopup } from "../BranchWidget";
import { useVcs } from "../store";
import { isStatusItemVisible } from "@/workbench/statusBarWidgets";

vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return { ...real, commands: { ...real.commands, vcsTags: async () => ({ status: "ok", data: [] }) } };
});

afterEach(() => {
  useBranchesPopup.setState({ open: false, anchorEl: null });
  useVcs.setState({ available: false, branch: null, roots: [], repo: null, heads: {}, operations: {} });
});

describe("Git Branch status bar widget", () => {
  it("is toggleable via the status bar widgets menu by default", () => {
    expect(isStatusItemVisible(GIT_BRANCH_STATUS, undefined)).toBe(true);
    expect(isStatusItemVisible(GIT_BRANCH_STATUS, { [GIT_BRANCH_STATUS.id]: false })).toBe(false);
  });

  it("shows the current branch and opens the Branches popup", () => {
    useVcs.setState({
      available: true,
      repo: "/p",
      roots: ["/p"],
      heads: {},
      operations: {},
      branch: { head: "main", headCommit: "abc12345", upstream: "origin/main", ahead: 1, behind: 0, operation: null },
    });
    render(<BranchStatus />);
    expect(screen.getByRole("button", { name: /Git branch: main/ })).toHaveTextContent("main");
    act(() => fireEvent.click(screen.getByRole("button", { name: /Git branch: main/ })));
    expect(useBranchesPopup.getState().open).toBe(true);
    expect(useBranchesPopup.getState().anchorEl).toBeInstanceOf(HTMLElement);
  });

  it("hides when Git is unavailable", () => {
    useVcs.setState({ available: false, branch: null });
    const { container } = render(<BranchStatus />);
    expect(container).toBeEmptyDOMElement();
  });
});
