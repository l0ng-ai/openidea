import { beforeEach, expect, it, vi } from "vitest";
import type { FileStatus } from "@/bindings";

const mocks = vi.hoisted(() => ({
  notify: vi.fn(),
  executeAction: vi.fn(),
  apply: vi.fn(),
}));
vi.mock("@/platform/actions", async (original) => ({
  ...(await original<typeof import("@/platform/actions")>()),
  executeAction: mocks.executeAction,
}));
vi.mock("@/workbench/contributions", async (original) => ({
  ...(await original<typeof import("@/workbench/contributions")>()),
  notifications: () => ({ notify: mocks.notify, expire: vi.fn() }),
  maybeEditorService: () => null,
}));
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  const ok = (data: unknown) => Promise.resolve({ status: "ok" as const, data });
  return {
    ...real,
    commands: { ...real.commands, vcsStashApply: mocks.apply, vcsStashes: () => ok([]) },
  };
});

import { applyStash } from "../changeOps";
import { useVcs } from "../store";

const file = (relPath: string, unstaged: FileStatus["unstaged"]): FileStatus => ({
  path: `/p/${relPath}`,
  relPath,
  staged: null,
  unstaged,
  renamedFrom: null,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.apply.mockResolvedValue({
    status: "error",
    error: { kind: "io", message: "CONFLICT (content): Merge conflict in src/a.txt" },
  });
  useVcs.setState({ root: "/p", repo: "/p", roots: ["/p"], available: false, status: [] });
});

it("opens the Conflicts dialog instead of an error when the unstashed changes conflict", async () => {
  useVcs.setState({ status: [file("src/a.txt", "conflicted")] });
  await applyStash(1, true, "/p");
  expect(mocks.executeAction).toHaveBeenCalledWith("vcs.resolveConflicts");
  expect(mocks.notify).not.toHaveBeenCalledWith(expect.objectContaining({ level: "error" }));
});

it("still reports an unstash that failed without conflicts", async () => {
  useVcs.setState({ status: [file("src/a.txt", "modified")] });
  await applyStash(0, false, "/p");
  expect(mocks.executeAction).not.toHaveBeenCalledWith("vcs.resolveConflicts");
  expect(mocks.notify).toHaveBeenCalledWith(
    expect.objectContaining({ level: "error", title: "Apply stash@{0} failed" }),
  );
});
