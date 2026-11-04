import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: {
      ...real.commands,
      vcsFileAt: async (_path: string, rev: string) => ({
        status: "ok",
        data: `const value = ${rev === "merge" ? 3 : rev === "left" ? 1 : 2};\n`,
      }),
    },
  };
});
import { GitMergeDiff } from "../GitMergeDiff";
describe("historical merge comparison", () => {
  it("shows and highlights both parents and the immutable result without an editable worktree pane", async () => {
    const { container, unmount } = render(
      <GitMergeDiff
        input={{
          kind: "git-merge-diff",
          key: "merge:file",
          data: {
            repo: "/repo",
            path: "a.ts",
            revision: "merge",
            parents: [
              { rev: "left", path: "a.ts" },
              { rev: "right", path: "a.ts" },
            ],
          },
        }}
      />,
    );
    await waitFor(() => expect(container.querySelectorAll(".cm-editor")).toHaveLength(3));
    expect(container.querySelectorAll('.cm-content[contenteditable="false"]')).toHaveLength(3);
    expect(container.querySelectorAll(".cm-diffLine-modified").length).toBeGreaterThanOrEqual(3);
    unmount();
  });
});
