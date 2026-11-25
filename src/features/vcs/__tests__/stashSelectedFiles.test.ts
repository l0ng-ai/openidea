import { describe, expect, it, vi } from "vitest";
import type { FileStatus } from "@/bindings";
import type { ChangeNode } from "../changes";

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return { ...real, call: vi.fn() };
});

import { nodeMenu } from "../CommitView";

const file = (rel: string): ChangeNode => {
  const f: FileStatus = { path: `/p/${rel}`, relPath: rel, staged: null, unstaged: "modified", renamedFrom: null };
  return { key: f.path, type: "file", label: rel, group: "changes", files: [f], path: f.path };
};

const stashSelected = (nodes: ChangeNode[]) =>
  nodeMenu(nodes, ["/p"]).find((m) => m.kind === "action" && m.action === "vcs.stashSelected");

describe("Stash Selected Files in the changes tree", () => {
  it("targets the selected files", () => {
    expect(stashSelected([file("src/a.ts"), file("b.md")])).toMatchObject({
      arg: ["/p/src/a.ts", "/p/b.md"],
      disabled: false,
    });
  });

  it("is disabled when no file is selected", () => {
    expect(stashSelected([])).toMatchObject({ disabled: true });
  });
});
