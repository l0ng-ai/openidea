import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BranchInfo } from "@/bindings";

const mocks = vi.hoisted(() => ({
  runRemote: vi.fn(),
  lastRemoteFailure: vi.fn(),
  saveAll: vi.fn(),
  ask: vi.fn(),
}));

vi.mock("../ops", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ops")>()),
  allRepos: () => [null],
  lastRemoteFailure: mocks.lastRemoteFailure,
  runRemote: mocks.runRemote,
  saveAll: mocks.saveAll,
}));
vi.mock("@/workbench/messages", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/workbench/messages")>()),
  ask: mocks.ask,
}));

import { useProject } from "@/platform/project";
import { pullCurrentBranch, pushCurrentBranch } from "../remoteUi";
import { useVcs } from "../store";

const branch = (patch: Partial<BranchInfo> = {}): BranchInfo => ({
  head: "main",
  headCommit: "c1",
  upstream: "origin/main",
  ahead: 2,
  behind: 0,
  operation: null,
  ...patch,
});

const rejected = "! [rejected]        main -> main (non-fast-forward)";

beforeEach(() => {
  vi.clearAllMocks();
  useProject.setState({ settings: null });
  useVcs.setState({ branch: branch(), repo: null });
  mocks.saveAll.mockResolvedValue(undefined);
});

describe("Git Log pull", () => {
  it("pulls with the configured update method", async () => {
    mocks.runRemote.mockResolvedValue(true);
    await expect(pullCurrentBranch(null)).resolves.toBe(true);
    expect(mocks.runRemote).toHaveBeenCalledWith({ op: "pull", rebase: false }, "main ← origin/main", [null]);
  });
});

describe("Git Log push", () => {
  it("pushes without asking when the remote has nothing new", async () => {
    mocks.runRemote.mockResolvedValue(true);
    await expect(pushCurrentBranch(null)).resolves.toBe(true);
    expect(mocks.runRemote).toHaveBeenCalledTimes(1);
    expect(mocks.runRemote.mock.calls[0]![0]).toMatchObject({ op: "push", force_with_lease: false });
    expect(mocks.ask).not.toHaveBeenCalled();
  });

  it("asks merge or rebase on every rejected push, even with auto-update enabled", async () => {
    useProject.setState({ settings: { vcs: { git: { autoUpdateOnPushRejected: true } } } as never });
    mocks.runRemote.mockResolvedValueOnce(false).mockResolvedValueOnce(true).mockResolvedValueOnce(true);
    mocks.lastRemoteFailure.mockReturnValue(rejected);
    mocks.ask.mockResolvedValue({ button: "rebase" });
    await expect(pushCurrentBranch(null)).resolves.toBe(true);
    expect(mocks.ask).toHaveBeenCalledOnce();
    expect(mocks.runRemote.mock.calls[1]![0]).toEqual({ op: "pull", rebase: true });
    expect(mocks.runRemote.mock.calls[2]![0]).toMatchObject({ op: "push" });
  });

  it("stops after the update leaves conflicts unresolved", async () => {
    mocks.runRemote.mockResolvedValueOnce(false).mockResolvedValueOnce(false);
    mocks.lastRemoteFailure.mockReturnValue(rejected);
    mocks.ask.mockResolvedValue({ button: "merge" });
    await expect(pushCurrentBranch(null)).resolves.toBe(false);
    expect(mocks.runRemote).toHaveBeenCalledTimes(2);
    expect(mocks.runRemote.mock.calls[1]![0]).toEqual({ op: "pull", rebase: false });
  });

  it("does nothing when the merge / rebase question is cancelled", async () => {
    mocks.runRemote.mockResolvedValueOnce(false);
    mocks.lastRemoteFailure.mockReturnValue(rejected);
    mocks.ask.mockResolvedValue({ button: "cancel" });
    await expect(pushCurrentBranch(null)).resolves.toBe(false);
    expect(mocks.runRemote).toHaveBeenCalledTimes(1);
  });
});
