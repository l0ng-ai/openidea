import { beforeEach, describe, expect, it, vi } from "vitest";

const sent: Array<[number, string[], string[]]> = [];
let refuse: number | null = null;
vi.mock("@/platform/ipc", async (orig) => {
  const real = await orig<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: {
      ...real.commands,
      debugJsCustomBreakpoints: (session: number, ids: string[], xhr: string[]) => {
        sent.push([session, ids, xhr]);
        return Promise.resolve(
          session === refuse
            ? { status: "error", error: { kind: "unavailable", message: "refused" } }
            : { status: "ok", data: null },
        );
      },
    },
  };
});

const { useDebug } = await import("../state");
const {
  addRequestBreakpoint,
  customBreakpointArgs,
  loadJsBreakpoints,
  removeRequestBreakpoint,
  setEventBreakpoint,
  stopNote,
  syncJsBreakpoints,
  toggleRequestBreakpoint,
  useJsBreakpoints,
  watchPageSessions,
} = await import("../js/eventBreakpoints");
const { filterHint } = await import("../breakpoints/exceptions");
const { refusedIn } = await import("../js/refusals");

type Sessions = ReturnType<typeof useDebug.getState>["sessions"];
function sessions(list: Array<{ id: number; page: boolean; status?: string }>) {
  const out: Record<number, unknown> = {};
  for (const s of list)
    out[s.id] = { id: s.id, name: `s${s.id}`, status: s.status ?? "running", caps: { jsPage: s.page } };
  useDebug.setState({ sessions: out as Sessions });
}

beforeEach(async () => {
  localStorage.clear();
  sessions([]);
  loadJsBreakpoints(null);
  await Promise.resolve();
  sent.length = 0;
  refuse = null;
});

describe("JavaScript event and request breakpoints", () => {
  it("sends only what is enabled", () => {
    const args = customBreakpointArgs({
      events: { "listener:click": true, "listener:keydown": false },
      requests: [
        { pattern: "api/", enabled: true },
        { pattern: "cdn", enabled: false },
      ],
    });
    expect(args).toEqual({ ids: ["listener:click"], xhr: ["api/"] });
  });

  it("ignores ids outside the known list", () => {
    expect(customBreakpointArgs({ events: { "listener:nonsense": true }, requests: [] }).ids).toEqual([]);
  });

  it("request patterns are trimmed, unique and never empty", () => {
    loadJsBreakpoints("/a");
    addRequestBreakpoint("  api/ ");
    addRequestBreakpoint("api/");
    addRequestBreakpoint("   ");
    expect(useJsBreakpoints.getState().requests).toEqual([{ pattern: "api/", enabled: true }]);
    toggleRequestBreakpoint("api/", false);
    expect(useJsBreakpoints.getState().requests).toEqual([{ pattern: "api/", enabled: false }]);
    removeRequestBreakpoint("api/");
    expect(useJsBreakpoints.getState().requests).toEqual([]);
  });

  it("is stored per project", () => {
    loadJsBreakpoints("/a");
    setEventBreakpoint("listener:click", true);
    loadJsBreakpoints("/b");
    expect(customBreakpointArgs(useJsBreakpoints.getState()).ids).toEqual([]);
    loadJsBreakpoints("/a");
    expect(customBreakpointArgs(useJsBreakpoints.getState()).ids).toEqual(["listener:click"]);
  });

  it("syncs every live page session and swallows a refusal", async () => {
    sessions([
      { id: 1, page: true },
      { id: 2, page: false },
      { id: 3, page: true },
      { id: 4, page: true, status: "terminated" },
    ]);
    loadJsBreakpoints("/a");
    await Promise.resolve();
    sent.length = 0;
    refuse = 1;
    useJsBreakpoints.setState({ events: { "listener:submit": true }, requests: [] });
    await expect(syncJsBreakpoints()).resolves.toBeUndefined();
    expect(sent).toEqual([
      [1, ["listener:submit"], []],
      [3, ["listener:submit"], []],
    ]);
    // The page whose debugger refused is remembered, so that the dialog can say so.
    expect([1, 3].map((id) => refusedIn(id, "eventBreakpoints"))).toEqual(["refused", undefined]);
    refuse = null;
    await syncJsBreakpoints();
    expect(refusedIn(1, "eventBreakpoints")).toBeUndefined();
  });

  it("does not take a page that ended meanwhile for one that refused", async () => {
    sessions([{ id: 6, page: true }]);
    refuse = 6;
    const syncing = syncJsBreakpoints();
    sessions([{ id: 6, page: true, status: "terminated" }]);
    await syncing;
    expect(refusedIn(6, "eventBreakpoints")).toBeUndefined();
  });

  it("forgets what a page's debugger refused when its session is removed", async () => {
    loadJsBreakpoints("/a");
    setEventBreakpoint("listener:submit", true);
    const stop = watchPageSessions();
    sessions([{ id: 8, page: true }]);
    refuse = 8;
    await syncJsBreakpoints();
    expect(refusedIn(8, "eventBreakpoints")).toBe("refused");
    sessions([]);
    expect(refusedIn(8, "eventBreakpoints")).toBeUndefined();
    stop();
  });

  it("gives a page that starts later the current breakpoints, once", async () => {
    loadJsBreakpoints("/a");
    setEventBreakpoint("listener:click", true);
    const stop = watchPageSessions();
    sent.length = 0;
    sessions([{ id: 7, page: true }]);
    sessions([{ id: 7, page: true }]);
    await Promise.resolve();
    expect(sent).toEqual([[7, ["listener:click"], []]]);
    stop();
  });

  it("says why a session stopped at an event or request breakpoint", () => {
    const stop = (stopReason: string, stopDescription: string | null, status = "paused") =>
      stopNote({ status, stopReason, stopDescription } as Parameters<typeof stopNote>[0]);
    expect(stop("function breakpoint", "button.click")).toBe("button.click");
    expect(stop("data breakpoint", "Paused on XMLHttpRequest or fetch")).toBe("Paused on XMLHttpRequest or fetch");
    // A line breakpoint or a step needs no note: the line says it.
    expect(stop("breakpoint", "Paused on breakpoint")).toBeNull();
    expect(stop("step", "Paused")).toBeNull();
    expect(stop("function breakpoint", null)).toBeNull();
    expect(stop("function breakpoint", "button.click", "running")).toBeNull();
  });

  it("explains js-debug's caught exceptions filter and no other", () => {
    expect(filterHint("js-debug", "all")).toMatch(/framework catches/);
    expect(filterHint("js-debug", "uncaught")).toBeNull();
    expect(filterHint("debugpy", "all")).toBeNull();
  });
});
