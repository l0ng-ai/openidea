import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: Array<[string, number]> = [];
let stopFails = false;
vi.mock("@/platform/ipc", async (orig) => {
  const real = await orig<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: {
      ...real.commands,
      debugJsStartProfile: (session: number) => {
        calls.push(["start", session]);
        return Promise.resolve({ status: "ok", data: null });
      },
      debugJsStopProfile: (session: number) => {
        calls.push(["stop", session]);
        return Promise.resolve(
          stopFails
            ? { status: "error", error: { kind: "unavailable", message: "the session ended" } }
            : { status: "ok", data: "/tmp/openidea-js-profile-1" },
        );
      },
    },
  };
});

const shown = vi.fn(async (_id: string, _arg?: unknown) => true);
vi.mock("@/platform/actions", async (orig) => {
  const real = await orig<typeof import("@/platform/actions")>();
  return { ...real, executeAction: (id: string, arg?: unknown) => shown(id, arg) };
});

const { useProject } = await import("@/platform/project");
const { useDebug } = await import("../state");
const { isPageProfiled, pageProfileItems, startPageProfile, stopPageProfile, useJsProfile, watchProfiledSessions } =
  await import("../js/profile");

type DebugState = ReturnType<typeof useDebug.getState>;
function sessions(list: Array<{ id: number; page: boolean; status?: string }>, active: number | null) {
  const out: Record<number, unknown> = {};
  for (const s of list)
    out[s.id] = { id: s.id, name: `page ${s.id}`, status: s.status ?? "running", caps: { jsPage: s.page } };
  useDebug.setState({ sessions: out as DebugState["sessions"], active });
}

beforeEach(() => {
  calls.length = 0;
  stopFails = false;
  shown.mockClear();
  useJsProfile.setState({ recording: {} });
  useProject.setState({ project: { root: "/work/shop" } as ReturnType<typeof useProject.getState>["project"] });
  sessions([{ id: 4, page: true }], 4);
});

describe("CPU profile of a debugged page", () => {
  it("starts recording in the selected page session", async () => {
    await startPageProfile();
    expect(calls).toEqual([["start", 4]]);
    expect(isPageProfiled(4)).toBe(true);
    // Already recording: not started twice.
    await startPageProfile();
    expect(calls).toHaveLength(1);
  });

  it("does nothing in a session that is not a page", async () => {
    sessions([{ id: 9, page: false }], 9);
    await startPageProfile();
    await stopPageProfile();
    expect(calls).toEqual([]);
  });

  it("stops, and hands the recording to the Profiler", async () => {
    await startPageProfile();
    await stopPageProfile();
    expect(calls).toEqual([
      ["start", 4],
      ["stop", 4],
    ]);
    expect(shown).toHaveBeenCalledWith("profiler.showCpuProfiles", {
      name: "page 4",
      dir: "/tmp/openidea-js-profile-1",
      root: "/work/shop",
    });
    expect(isPageProfiled(4)).toBe(false);
  });

  it("gives up quietly when the recording can't be had", async () => {
    await startPageProfile();
    stopFails = true;
    await expect(stopPageProfile()).resolves.toBeUndefined();
    expect(shown).not.toHaveBeenCalled();
    expect(isPageProfiled(4)).toBe(false);
  });

  it("offers the one of Start and Stop that applies, in a page's More menu only", () => {
    const action = (recording: boolean) =>
      pageProfileItems(true, recording).flatMap((i) => (i.kind === "action" ? [i.action] : []));
    expect(action(false)).toEqual(["debug.startPageProfile"]);
    expect(action(true)).toEqual(["debug.stopPageProfile"]);
    expect(pageProfileItems(false, false)).toEqual([]);
  });

  it("forgets a recording whose session ended", async () => {
    const stop = watchProfiledSessions();
    await startPageProfile();
    sessions([{ id: 4, page: true, status: "terminated" }], 4);
    expect(isPageProfiled(4)).toBe(false);
    stop();
  });
});
