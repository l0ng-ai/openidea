import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Profile, ProfileSpec } from "@/platform/ipc";

const collected: ProfileSpec[] = [];
let fails = false;
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
          fails
            ? { status: "error", error: { kind: "invalidInput", message: "no samples" } }
            : { status: "ok", data: profile },
        );
      },
    },
  };
});

const { showCpuProfiles } = await import("./cpuProfiles");
const { resetProfiler, useProfiler } = await import("./store");

beforeEach(() => {
  collected.length = 0;
  fails = false;
  resetProfiler();
});

describe("CPU profiles recorded elsewhere", () => {
  it("open as a snapshot named after what was profiled", async () => {
    await showCpuProfiles({ name: "localhost:5173", dir: "/tmp/p", root: "/work/shop" });
    expect(collected).toEqual([{ kind: "cpuProfiles", dir: "/tmp/p", root: "/work/shop" }]);
    expect(useProfiler.getState().snapshots.map((s) => [s.name, s.profile.total])).toEqual([["localhost:5173", 3]]);
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
