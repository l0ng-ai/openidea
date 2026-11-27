import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteOp, RequestId, UnfetchedBranch } from "@/bindings";

/** Remotes by repository, including repositories with no configured upstream. */
const remotes: Record<string, string[]> = { "/ws/a": ["private", "public"], "/ws/b": ["origin"], "/ws/c": ["origin"] };
const ROOTS = Object.keys(remotes);
let failing: Set<string>;
let calls: Array<{ root: string | null; skip: string[]; background: boolean; request: RequestId }>;
let cancelled: RequestId[];
let pending: Promise<void> | null;
let observed: Record<string, UnfetchedBranch[]>;

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  Channel: class {
    onmessage: (line: string) => void = () => {};
  },
}));

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    isTauri: () => true,
    commands: {
      ...real.commands,
      vcsBranchInfo: async () => ({
        status: "ok",
        data: { head: "main", headCommit: "c1", upstream: null, ahead: 0, behind: 0 },
      }),
      vcsCheckIncoming: async (root: string) => ({
        status: "ok",
        data: { branches: observed[root] ?? [], errors: [] },
      }),
      vcsRemote: async (root: string | null, request: RequestId, op: RemoteOp) => {
        if (op.op !== "fetch") throw new Error(`Unexpected remote operation ${op.op}`);
        const { background = false, skipRemotes: skip = [] } = op;
        calls.push({ root, skip, background, request });
        if (background && pending) {
          await pending;
          return { status: "error", error: { kind: "cancelled", message: "cancelled" } };
        }
        const results = (remotes[root ?? ""] ?? [])
          .filter((remote) => !skip.includes(remote))
          .map((remote) => ({
            remote,
            pruned: [],
            error: failing.has(remote) ? { kind: "permissionDenied", message: "denied" } : null,
          }));
        return { status: "ok", data: { remotes: results } };
      },
      cancelRequest: async (request: RequestId) => {
        cancelled.push(request);
        return { status: "ok", data: null };
      },
      vcsRoots: async () => ({
        status: "ok",
        data: ROOTS.map((root) => ({ root, operation: null, head: "main", headCommit: "c1", hasRemotes: true })),
      }),
      vcsStatus: async () => ({ status: "ok", data: [] }),
      vcsBranches: async () => ({ status: "ok", data: [] }),
      vcsStashes: async () => ({ status: "ok", data: [] }),
    },
  };
});

import { useProject } from "@/platform/project";
import { provideNotificationService } from "@/workbench/contributions";
import { fetchIncoming, installIncomingCheck } from "../incoming";
import { runRemote } from "../ops";
import { unfetchedBranch, useVcs } from "../store";

beforeEach(() => {
  provideNotificationService({ notify: () => undefined, expire: () => undefined });
  failing = new Set();
  calls = [];
  cancelled = [];
  pending = null;
  observed = {};
  useVcs.setState({
    available: true,
    root: "/ws",
    roots: ROOTS,
    repo: "/ws/a",
    remoteBusy: null,
    branch: null,
    hasRemotes: true,
    unfetched: new Map(),
  });
});

afterEach(() => {
  vi.useRealTimers();
  useProject.setState({ settings: null });
  useVcs.setState({ available: false, root: null, roots: [], repo: null, remoteBusy: null, hasRemotes: null });
});

describe("fetchIncoming", () => {
  it("checks configured remotes even when the current branch has no upstream", async () => {
    expect(await fetchIncoming(ROOTS, new Map())).toBe(true);
    expect(calls.map(({ root }) => root)).toEqual(ROOTS);
    expect(calls.every(({ background }) => background)).toBe(true);
  });

  it("skips only the failed remote for one check and then retries it", async () => {
    failing.add("private");
    const deferred = new Map<string, Set<string | null>>();
    expect(await fetchIncoming(ROOTS, deferred)).toBe(true);
    expect(deferred.get(ROOTS[0]!)).toEqual(new Set(["private"]));
    calls = [];
    await fetchIncoming(ROOTS, deferred);
    expect(calls.map(({ root, skip }) => [root, skip])).toEqual([
      ["/ws/a", ["private"]],
      ["/ws/b", []],
      ["/ws/c", []],
    ]);
    failing.clear();
    calls = [];
    await fetchIncoming(ROOTS, deferred);
    expect(calls.every(({ skip }) => skip.length === 0)).toBe(true);
    expect(deferred.size).toBe(0);
  });

  it("leaves the remotes alone while an interactive Git operation is running", async () => {
    useVcs.setState({ remoteBusy: "Fetching" });
    expect(await fetchIncoming(ROOTS, new Map())).toBe(false);
    expect(calls).toEqual([]);
  });

  it("waits for an interrupted background fetch to exit before starting a manual fetch", async () => {
    let finish!: () => void;
    pending = new Promise((resolve) => (finish = resolve));
    try {
      const checking = fetchIncoming(ROOTS, new Map());
      const backgroundRequest = calls[0]!.request;
      const manual = runRemote({ op: "fetch" }, undefined, ["/ws/a"]);
      expect(cancelled).toEqual([backgroundRequest]);
      expect(calls).toHaveLength(1);
      finish();
      expect(await checking).toBe(false);
      expect(await manual).toBe(true);
      expect(calls.map(({ root, background }) => [root, background])).toEqual([
        ["/ws/a", true],
        ["/ws/a", false],
      ]);
    } finally {
      finish();
    }
  });
});

describe("installIncomingCheck", () => {
  it("publishes only matching observations in check-only mode and clears them when disabled", async () => {
    vi.useFakeTimers();
    const root = ROOTS[0]!;
    const trackedTip = { tracking: { remote: "fork", branch: "release" }, commit: "old" };
    const pendingBranch = { branch: "main", trackedTip, advertisedCommit: "new" };
    observed[root] = [pendingBranch];
    useProject.setState({ settings: { vcs: { git: { incomingCheck: "check" } } } } as never);
    const dispose = installIncomingCheck();
    try {
      await vi.advanceTimersByTimeAsync(20_000);
      expect(calls).toHaveLength(0);
      const { unfetched } = useVcs.getState();
      expect(unfetchedBranch(unfetched, root, "main", trackedTip)).toEqual(pendingBranch);
      expect(unfetchedBranch(unfetched, root, "main", { ...trackedTip, commit: "new" })).toBeUndefined();
      expect(unfetchedBranch(unfetched, ROOTS[1]!, "main", trackedTip)).toBeUndefined();
      expect(
        unfetchedBranch(unfetched, root, "main", {
          ...trackedTip,
          tracking: { ...trackedTip.tracking, remote: "different" },
        }),
      ).toBeUndefined();
      useProject.setState({ settings: { vcs: { git: { incomingCheck: "never" } } } } as never);
      expect(useVcs.getState().unfetched.size).toBe(0);
    } finally {
      dispose();
    }
  });

  it("retries even a failing remote at the configured interval in Always mode", async () => {
    vi.useFakeTimers();
    failing.add("private");
    useProject.setState({ settings: { vcs: { git: { incomingCheck: "always", incomingCheckInterval: 5 } } } } as never);
    const dispose = installIncomingCheck();
    try {
      await vi.advanceTimersByTimeAsync(20_000);
      expect(calls.map(({ root }) => root)).toEqual(ROOTS);
      calls = [];
      await vi.advanceTimersByTimeAsync(4 * 60_000);
      expect(calls).toEqual([]);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(calls.map(({ root, skip }) => [root, skip])).toEqual(ROOTS.map((root) => [root, []]));
    } finally {
      dispose();
    }
  });

  it("cancels a running check when background checks are turned off", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    pending = new Promise((resolve) => (finish = resolve));
    const dispose = installIncomingCheck();
    try {
      await vi.advanceTimersByTimeAsync(20_000);
      expect(calls).toHaveLength(1);
      useProject.setState({ settings: { vcs: { git: { incomingCheck: "never" } } } } as never);
      expect(cancelled).toEqual([calls[0]!.request]);
      finish();
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(calls).toHaveLength(1);
    } finally {
      dispose();
    }
  });
});
