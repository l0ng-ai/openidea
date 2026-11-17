import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JsResponseRule } from "@/platform/ipc";

const sent: Array<[number, JsResponseRule[]]> = [];
let refuse: number | null = null;
vi.mock("@/platform/ipc", async (orig) => {
  const real = await orig<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: {
      ...real.commands,
      debugJsResponseOverrides: (session: number, rules: JsResponseRule[]) => {
        sent.push([session, rules]);
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
  activeRules,
  answeredBy,
  loadResponseOverrides,
  overriddenBy,
  removeOverride,
  saveOverride,
  syncResponseOverrides,
  toggleOverride,
  useResponseOverrides,
  watchOverrideSessions,
} = await import("../js/responseOverrides");

const { refusedIn } = await import("../js/refusals");

type Sessions = ReturnType<typeof useDebug.getState>["sessions"];
function sessions(list: Array<{ id: number; page: boolean; status?: string }>) {
  const out: Record<number, unknown> = {};
  for (const s of list)
    out[s.id] = { id: s.id, name: `s${s.id}`, status: s.status ?? "running", caps: { jsPage: s.page } };
  useDebug.setState({ sessions: out as Sessions });
}
const rules = () => useResponseOverrides.getState().rules;
const items = { pattern: "/api/items", status: 200, contentType: "application/json", body: "[]", enabled: true };

beforeEach(async () => {
  localStorage.clear();
  sessions([]);
  loadResponseOverrides(null);
  await Promise.resolve();
  sent.length = 0;
  refuse = null;
});

describe("response overrides", () => {
  it("sends the rules that are on and name a part of a URL", () => {
    const sentRules = activeRules([
      { id: "a", ...items },
      { id: "b", ...items, pattern: "/api/off", enabled: false },
      { id: "c", ...items, pattern: "   " },
    ]);
    expect(sentRules).toEqual([
      { urlContains: "/api/items", status: 200, contentType: "application/json", body: "[]" },
    ]);
  });

  it("adds a rule, and updates it under the same id", () => {
    loadResponseOverrides("/a");
    const id = saveOverride({ ...items, pattern: "  /api/items " });
    expect(rules()).toEqual([{ id, ...items }]);
    expect(saveOverride({ ...items, id, body: "[1]" })).toBe(id);
    expect(rules()).toEqual([{ id, ...items, body: "[1]" }]);
    toggleOverride(id, false);
    expect(rules()[0]!.enabled).toBe(false);
    removeOverride(id);
    expect(rules()).toEqual([]);
  });

  it("answers 200 when the status is not an HTTP status", () => {
    loadResponseOverrides("/a");
    saveOverride({ ...items, status: 99 });
    saveOverride({ ...items, pattern: "/b", status: 600 });
    saveOverride({ ...items, pattern: "/c", status: Number.NaN });
    saveOverride({ ...items, pattern: "/d", status: 404 });
    expect(rules().map((r) => r.status)).toEqual([200, 200, 200, 404]);
  });

  it("is stored per project", () => {
    loadResponseOverrides("/a");
    saveOverride(items);
    loadResponseOverrides("/b");
    expect(rules()).toEqual([]);
    loadResponseOverrides("/a");
    expect(rules().map((r) => r.pattern)).toEqual(["/api/items"]);
  });

  it("tells which rule replaces a URL's response", () => {
    const list = [
      { id: "off", ...items, pattern: "/api", enabled: false },
      { id: "on", ...items },
    ];
    expect(overriddenBy("http://h/api/items?x=1", list)?.id).toBe("on");
    expect(overriddenBy("http://h/api/users", list)).toBeNull();
  });

  it("marks only the requests sent after a rule came into force", async () => {
    const { networkSerial } = await import("../js/network");
    const before = { url: "http://x/api/items?page=1", seq: networkSerial() - 1 };
    const id = saveOverride({
      pattern: "/api/items",
      status: 200,
      contentType: "application/json",
      body: "[]",
      enabled: true,
    });
    const rules = useResponseOverrides.getState().rules;
    const after = { url: "http://x/api/items?page=2", seq: networkSerial() };
    expect(answeredBy(before, rules)).toBe(false);
    expect(answeredBy(after, rules)).toBe(true);
    // Rules the project has when it opens answer every request of its sessions.
    loadResponseOverrides(useResponseOverrides.getState().root);
    const loaded = useResponseOverrides.getState().rules;
    expect(answeredBy(before, loaded)).toBe(loaded.some((r) => r.id === id));
  });

  it("syncs every live page session and swallows a refusal", async () => {
    sessions([
      { id: 1, page: true },
      { id: 2, page: false },
      { id: 3, page: true },
      { id: 4, page: true, status: "terminated" },
    ]);
    loadResponseOverrides("/a");
    useResponseOverrides.setState({ rules: [{ id: "a", ...items }] });
    await Promise.resolve();
    sent.length = 0;
    refuse = 1;
    await expect(syncResponseOverrides()).resolves.toBeUndefined();
    expect(sent.map(([id, r]) => [id, r.length])).toEqual([
      [1, 1],
      [3, 1],
    ]);
    // The page whose responses are not replaced is remembered, with the reason.
    expect([1, 3].map((id) => refusedIn(id, "overrides"))).toEqual(["refused", undefined]);
    refuse = null;
    await syncResponseOverrides();
    expect(refusedIn(1, "overrides")).toBeUndefined();
  });

  it("gives a page that starts later the rules, once, and nothing when none is on", async () => {
    loadResponseOverrides("/a");
    const stop = watchOverrideSessions();
    sessions([{ id: 5, page: true }]);
    await Promise.resolve();
    expect(sent).toEqual([]);

    saveOverride(items);
    await Promise.resolve();
    sent.length = 0;
    sessions([
      { id: 5, page: true },
      { id: 7, page: true },
    ]);
    sessions([
      { id: 5, page: true },
      { id: 7, page: true },
    ]);
    await Promise.resolve();
    expect(sent.map(([id]) => id)).toEqual([7]);
    stop();
  });

  it("gives a new page the rules when its session id was used before", async () => {
    loadResponseOverrides("/a");
    saveOverride(items);
    const stop = watchOverrideSessions();
    sessions([{ id: 1, page: true }]);
    await Promise.resolve();
    // Ids start over after the backend restarts.
    sessions([]);
    sent.length = 0;
    sessions([{ id: 1, page: true }]);
    await Promise.resolve();
    expect(sent.map(([id]) => id)).toEqual([1]);
    stop();
  });
});
