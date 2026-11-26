import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return { ...real, call: vi.fn() };
});

vi.mock("../DiffEditor", () => ({ DiffEditor: () => <div /> }));

import { ChangesTree } from "../CommitView";
import { useVcs } from "../store";
import { useProject } from "@/platform/project";

const NAME = "some_long_service_implementation_with_a_very_long_name.ts";

describe("changes tree width (#6080)", () => {
  beforeEach(() => {
    localStorage.clear();
    useProject.setState({
      project: { name: "p", root: "/p", trusted: true, isGit: true, settings: {} } as never,
      settings: {} as never,
    });
    useVcs.setState({
      root: "/p",
      repo: "/p",
      roots: ["/p"],
      status: [
        {
          path: `/p/src/features/some_long_module_name/${NAME}`,
          relPath: `src/features/some_long_module_name/${NAME}`,
          staged: null,
          unstaged: "modified" as const,
          renamedFrom: null,
        },
      ],
    });
  });

  it.each(["commit", "local"] as const)("scrolls horizontally in %s mode instead of clipping rows", (mode) => {
    render(<ChangesTree mode={mode} />);
    const tree = screen.getByRole("tree", { name: "Changes" });
    // The rows keep their natural width and the tree tracks the widest one for its scroll range.
    expect(tree.querySelector("[data-content-width]")).not.toBeNull();
    const row = screen.getByText(NAME).closest("[data-row]") as HTMLElement;
    expect(row.className).toMatch(/wideRow/);
  });
});
