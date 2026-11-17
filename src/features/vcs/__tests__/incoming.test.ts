import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Root → upstream of its branch (`null` = none). */
let upstreams: Record<string, string | null> = {};
/** Roots whose fetch fails. */
let failing = new Set<string>();
let fetched: (string | null)[] = [];

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
      vcsBranchInfo: async (root: string) => ({
        status: "ok",
        data: { head: "main", headCommit: "c1", upstream: upstreams[root] ?? null, ahead: 0, behind: 0 },
      }),
      vcsRemote: async (root: string | null) => {
        fetched.push(root);
        if (root && failing.has(root)) return { status: "error", error: { kind: "auth", message: "denied" } };
        return { status: "ok", data: null };
      },
      vcsRoots: async () => ({
        status: "ok",
        data: Object.keys(upstreams).map((root) => ({ root, operation: null, head: "main", headCommit: "c1" })),
      }),
      vcsStatus: async () => ({ status: "ok", data: [] }),
      vcsBranches: async () => ({ status: "ok", data: [] }),
      vcsStashes: async () => ({ status: "ok", data: [] }),
    },
  };
});

import { useProject } from "@/platform/project";
import { fetchIncoming, installIncomingCheck } from "../incoming";
import { useVcs } from "../store";

const ROOTS = ["/ws/a", "/ws/b", "/ws/c"];

beforeEach(() => {
  upstreams = { "/ws/a": "origin/main", "/ws/b": "origin/main", "/ws/c": "origin/dev" };
  failing = new Set();
  fetched = [];
  useVcs.setState({ available: true, root: "/ws", roots: ROOTS, repo: "/ws/a", remoteBusy: null, branch: null });
});

afterEach(() => {
  vi.useRealTimers();
  useProject.setState({ settings: null });
  useVcs.setState({ available: false, root: null, roots: [], repo: null, remoteBusy: null });
});

describe("fetchIncoming", () => {
  it("fetches every repository with an upstream, not only the selected one", async () => {
    upstreams["/ws/b"] = null;
    expect(await fetchIncoming(ROOTS, new Set())).toBe(true);
    expect(fetched).toEqual(["/ws/a", "/ws/c"]);
  });

  it("stops checking only the repository that failed", async () => {
    failing.add("/ws/a");
    const failed = new Set<string>();
    await fetchIncoming(ROOTS, failed);
    expect(fetched).toEqual(ROOTS);
    expect([...failed]).toEqual(["/ws/a"]);
    fetched = [];
    await fetchIncoming(ROOTS, failed);
    expect(fetched).toEqual(["/ws/b", "/ws/c"]);
  });

  it("leaves the remotes alone while the user's own remote operation runs", async () => {
    useVcs.setState({ remoteBusy: "Fetching" });
    expect(await fetchIncoming(ROOTS, new Set())).toBe(false);
    expect(fetched).toEqual([]);
  });
});

describe("installIncomingCheck", () => {
  it("checks after the configured interval", async () => {
    vi.useFakeTimers();
    useProject.setState({ settings: { vcs: { git: { incomingCheckInterval: 5 } } } } as never);
    const dispose = installIncomingCheck();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetched).toEqual(ROOTS);
    fetched = [];
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(fetched).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetched).toEqual(ROOTS);
    dispose();
  });
});
