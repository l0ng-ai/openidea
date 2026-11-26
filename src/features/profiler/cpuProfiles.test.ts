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
const profile = { profiler: "v8", unit: "samples", mode: "cpu", total: 3, frames: [] } as unknown as Profile;
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

const { isCpuProfilePath, openCpuProfileFiles, showCpuProfiles } = await import("./cpuProfiles");
const { resetProfiler, useProfiler } = await import("./store");

beforeEach(() => {
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
    await openCpuProfileFiles(["/work/app/CPU.1.cpuprofile", "C:\\ci\\run.cpuprofile"]);
    expect(collected).toEqual([
      { kind: "cpuProfileFile", path: "/work/app/CPU.1.cpuprofile" },
      { kind: "cpuProfileFile", path: "C:\\ci\\run.cpuprofile" },
    ]);
    expect(names()).toEqual(["run.cpuprofile", "CPU.1.cpuprofile"]);
  });

  it("asks for the files when the action has none, and opens nothing when cancelled", async () => {
    await openCpuProfileFiles(undefined);
    expect(collected).toEqual([]);
    picked = ["/tmp/a.cpuprofile"];
    await openCpuProfileFiles(undefined);
    expect(names()).toEqual(["a.cpuprofile"]);
  });

  it("skips a file that is not a CPU profile and still opens the others", async () => {
    fails = (spec) => spec.kind === "cpuProfileFile" && spec.path.endsWith("bad.cpuprofile");
    await expect(openCpuProfileFiles(["/tmp/bad.cpuprofile", "/tmp/good.cpuprofile"])).resolves.toBeUndefined();
    expect(names()).toEqual(["good.cpuprofile"]);
  });

  it("replaces the snapshot of a file opened again", async () => {
    await openCpuProfileFiles(["/tmp/a.cpuprofile", "/tmp/b.cpuprofile"]);
    const first = useProfiler.getState().snapshots.find((s) => s.name === "a.cpuprofile")!.id;
    await openCpuProfileFiles("/tmp/a.cpuprofile");
    const state = useProfiler.getState();
    expect(names()).toEqual(["a.cpuprofile", "b.cpuprofile"]);
    expect(state.activeId).toBe(first);
  });

  it("says which snapshots it closed to stay within the limit, recordings included", async () => {
    await showCpuProfiles({ name: "localhost:5173", dir: "/tmp/p", root: "/work/shop" });
    await openCpuProfileFiles([1, 2, 3, 4, 5].map((n) => `/tmp/${n}.cpuprofile`));
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

  it("recognises .cpuprofile files by extension", () => {
    expect(isCpuProfilePath("/a/CPU.20261126.cpuprofile")).toBe(true);
    expect(isCpuProfilePath("/a/X.CPUPROFILE")).toBe(true);
    expect(isCpuProfilePath("/a/cpuprofile.json")).toBe(false);
  });
});
