import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Profile, ProfileSpec } from "@/platform/ipc";

const collected: ProfileSpec[] = [];
let fails: boolean | ((spec: ProfileSpec) => boolean) = false;
let picked: string[] = [];
const notified: Array<{ title: string; body?: string }> = [];
vi.mock("@/workbench/contributions", () => ({
  notifications: () => ({ notify: (n: { title: string; body?: string }) => notified.push(n) }),
  toolWindowService: () => ({ show: () => undefined }),
}));
vi.mock("@/platform/choosePath", () => ({ choosePaths: () => Promise.resolve(picked) }));
let profile = { profiler: "v8", unit: "samples", mode: "cpu", total: 3, frames: [], calls: [] } as unknown as Profile;
vi.mock("@/platform/project", () => ({ useProject: { getState: () => ({ project: { root: "/work/app" } }) } }));
vi.mock("@/platform/ipc", async (orig) => {
  const real = await orig<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: {
      ...real.commands,
      profilerCollect: (spec: ProfileSpec) => {
        collected.push(spec);
        return Promise.resolve(
          (typeof fails === "function" ? fails(spec) : fails)
            ? { status: "error", error: { kind: "invalidInput", message: "no samples" } }
            : { status: "ok", data: profile },
        );
      },
    },
  };
});

const { isSnapshotPath, openSnapshotFiles, showCpuProfiles } = await import("./cpuProfiles");
const { resetProfiler, useProfiler } = await import("./store");

beforeEach(() => {
  profile = { ...profile, calls: [] };
  collected.length = 0;
  fails = false;
  picked = [];
  notified.length = 0;
  resetProfiler();
});

describe("CPU profiles recorded elsewhere", () => {
  it("open as a snapshot named after what was profiled", async () => {
    await showCpuProfiles({ name: "localhost:5173", dir: "/tmp/p", root: "/work/shop" });
    expect(collected).toEqual([{ kind: "cpuProfiles", dir: "/tmp/p", root: "/work/shop" }]);
    expect(useProfiler.getState().snapshots.map((s) => [s.name, s.profile.total])).toEqual([["localhost:5173", 3]]);
  });

  it("name what recorded them when the caller says", async () => {
    await showCpuProfiles({ name: "page", dir: "/tmp/p", root: "/work/shop", profiler: "js-debug" });
    await showCpuProfiles({ name: "script", dir: "/tmp/q", root: "/work/shop" });
    expect(useProfiler.getState().snapshots.map((s) => s.profile.profiler)).toEqual(["v8", "js-debug"]);
  });

  it("add nothing when the directory can't be read as a profile, or isn't named", async () => {
    fails = true;
    await expect(showCpuProfiles({ name: "page", dir: "/tmp/p", root: "/work/shop" })).resolves.toBeUndefined();
    await showCpuProfiles({ name: "page" });
    await showCpuProfiles(undefined);
    expect(collected).toHaveLength(1);
    expect(useProfiler.getState().snapshots).toEqual([]);
  });
});

describe("Open Snapshot", () => {
  const names = () => useProfiler.getState().snapshots.map((s) => s.name);

  it("opens each .cpuprofile file as its own snapshot", async () => {
    await openSnapshotFiles(["/work/app/CPU.1.cpuprofile", "C:\\ci\\run.cpuprofile"]);
    expect(collected).toEqual([
      { kind: "snapshotFile", path: "/work/app/CPU.1.cpuprofile", root: "/work/app" },
      { kind: "snapshotFile", path: "C:\\ci\\run.cpuprofile", root: "/work/app" },
    ]);
    expect(names()).toEqual(["run.cpuprofile", "CPU.1.cpuprofile"]);
  });

  it("asks for the files when the action has none, and opens nothing when cancelled", async () => {
    await openSnapshotFiles(undefined);
    expect(collected).toEqual([]);
    picked = ["/tmp/a.cpuprofile"];
    await openSnapshotFiles(undefined);
    expect(names()).toEqual(["a.cpuprofile"]);
  });

  it("skips a file that is not a CPU profile and still opens the others", async () => {
    fails = (spec) => spec.kind === "snapshotFile" && spec.path.endsWith("bad.cpuprofile");
    await expect(openSnapshotFiles(["/tmp/bad.cpuprofile", "/tmp/good.cpuprofile"])).resolves.toBeUndefined();
    expect(names()).toEqual(["good.cpuprofile"]);
  });

  it("replaces the snapshot of a file opened again", async () => {
    await openSnapshotFiles(["/tmp/a.cpuprofile", "/tmp/b.cpuprofile"]);
    const first = useProfiler.getState().snapshots.find((s) => s.name === "a.cpuprofile")!.id;
    await openSnapshotFiles("/tmp/a.cpuprofile");
    const state = useProfiler.getState();
    expect(names()).toEqual(["a.cpuprofile", "b.cpuprofile"]);
    expect(state.activeId).toBe(first);
  });

  it("says which snapshots it closed to stay within the limit, recordings included", async () => {
    await showCpuProfiles({ name: "localhost:5173", dir: "/tmp/p", root: "/work/shop" });
    await openSnapshotFiles([1, 2, 3, 4, 5].map((n) => `/tmp/${n}.cpuprofile`));
    expect(names()).toEqual(["5.cpuprofile", "4.cpuprofile", "3.cpuprofile", "2.cpuprofile", "1.cpuprofile"]);
    expect(notified).toEqual([
      {
        group: "run",
        level: "info",
        title: "Closed older profiler snapshots",
        body: "The Profiler keeps the last 5 snapshots open; closed localhost:5173.",
      },
    ]);
  });

  it("recognises snapshot files by extension", () => {
    expect(isSnapshotPath("/a/CPU.20261126.cpuprofile")).toBe(true);
    expect(isSnapshotPath("/a/X.CPUPROFILE")).toBe(true);
    expect(isSnapshotPath("/a/cpuprofile.json")).toBe(false);
    expect(["/a/out.pstats", "/a/run.PROF", "/a/app.pstat", "/a/prof"].map(isSnapshotPath)).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });

  it("says that a cProfile snapshot's call tree is estimated", async () => {
    await openSnapshotFiles("/tmp/a.cpuprofile");
    profile = { ...profile, calls: [{ caller: 1, callee: 2, selfWeight: 1, total: 2, calls: 3, primitiveCalls: 3 }] };
    await openSnapshotFiles("/tmp/out.pstats");
    const notices = useProfiler.getState().snapshots.map((s) => [s.name, s.notice !== null]);
    expect(notices).toEqual([
      ["out.pstats", true],
      ["a.cpuprofile", false],
    ]);
  });
});
