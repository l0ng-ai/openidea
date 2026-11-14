import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return { ...real, call: vi.fn() };
});

vi.mock("../DiffEditor", () => ({ DiffEditor: () => <div /> }));

import { ChangesTree } from "../CommitView";
import { useVcs } from "../store";
import { useProject } from "@/platform/project";

const change = (path: string) => ({
  path,
  relPath: path.slice("/p/".length),
  staged: null,
  unstaged: "modified" as const,
  renamedFrom: null,
});

/** The tree row (`role=treeitem`) showing `name`. */
const row = (name: string) => screen.getByText(name).closest('[role="treeitem"]') as HTMLElement;

describe("repository nodes in the changes tree", () => {
  beforeEach(() => {
    localStorage.clear();
    useProject.setState({
      project: { name: "p", root: "/p", trusted: true, isGit: true, settings: {} } as never,
      settings: {} as never,
    });
    useVcs.setState({
      root: "/p",
      repo: "/p",
      roots: ["/p", "/p/orders"],
      status: [change("/p/App.kt"), change("/p/orders/Order.kt")],
      heads: {},
    });
  });

  it("shows the branch each repository is on and follows branch switches", () => {
    render(<ChangesTree mode="commit" />);
    expect(row("orders").textContent).toBe("orders");
    act(() =>
      useVcs.setState({
        heads: {
          "/p": { head: "main", headCommit: "1111111111" },
          "/p/orders": { head: "feature/ABC-123", headCommit: "2222222222" },
        },
      }),
    );
    expect(row("orders").textContent).toBe("ordersfeature/ABC-123");
    expect(row("p").textContent).toBe("pmain");
    act(() =>
      useVcs.setState({
        heads: { ...useVcs.getState().heads, "/p/orders": { head: null, headCommit: "abcdef0123456789" } },
      }),
    );
    expect(row("orders").textContent).toBe("ordersabcdef01");
  });

  it("puts a decorative icon before the branch, on repository rows only", () => {
    useVcs.setState({
      status: [change("/p/App.kt"), change("/p/orders/src/Order.kt")],
      heads: { "/p/orders": { head: "feature/ABC-123", headCommit: "2222222222" } },
    });
    render(<ChangesTree mode="commit" />);
    const hintIcons = (name: string) => row(name).querySelectorAll('svg[class*="detailIcon"]');
    expect(hintIcons("orders")).toHaveLength(1);
    expect(hintIcons("orders")[0]!.getAttribute("aria-hidden")).toBe("true");
    // No head info for the project's repository yet: no icon.
    expect(hintIcons("p")).toHaveLength(0);
    expect(hintIcons("Order.kt")).toHaveLength(0);
  });
});
