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
import { useProjectRoots } from "@/platform/projectRoots";

const change = (relPath: string) => ({
  path: `/p/${relPath}`,
  relPath,
  staged: null,
  unstaged: "modified" as const,
  renamedFrom: null,
});

/** The tree row (`role=treeitem`) showing `name`. */
const row = (name: string) => screen.getByText(name).closest('[role="treeitem"]') as HTMLElement;

describe("test files in the changes tree (#931)", () => {
  beforeEach(() => {
    localStorage.clear();
    useProject.setState({
      project: { name: "p", root: "/p", trusted: true, isGit: true, settings: {} } as never,
      settings: {} as never,
    });
    useProjectRoots.setState({
      root: "/p",
      detected: [{ path: "src/test/java", kind: "test", detectedFrom: "pom.xml" }],
    });
    useVcs.setState({
      root: "/p",
      repo: "/p",
      roots: ["/p"],
      status: [
        change("src/main/java/App.java"),
        change("src/test/java/AppTest.java"),
        change("web/button.test.ts"),
        change("web/button.ts"),
      ],
    });
  });

  it("tints files under a test root or named like a test, as IDEA's Tests scope does", () => {
    render(<ChangesTree mode="local" />);
    expect(row("AppTest.java").className).toMatch(/testFile/);
    expect(row("button.test.ts").className).toMatch(/testFile/);
    expect(row("App.java").className).not.toMatch(/testFile/);
    expect(row("button.ts").className).not.toMatch(/testFile/);
  });

  it("follows a folder being marked as test sources", () => {
    render(<ChangesTree mode="local" />);
    expect(row("App.java").className).not.toMatch(/testFile/);
    act(() => useProjectRoots.setState({ detected: [{ path: "src/main/java", kind: "test", detectedFrom: null }] }));
    expect(row("App.java").className).toMatch(/testFile/);
  });
});
