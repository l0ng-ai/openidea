import { describe, expect, it } from "vitest";
import { initialTabsState, moveTabToNewSplit, openTab, paneIds, splitPane, togglePin, type TabsState } from "./tabs";
import { loadSession, parseSession, restoreTabsState, serializeSession, slashPath } from "./session";

const file = (path: string) => ({ kind: "file", key: `file:${path}`, path });
const fileKey = (p: string) => `file:${p}`;
const open = (s: TabsState, path: string, opts = {}) => openTab(s, s.activePane, file(path), opts).state;
const paths = (s: TabsState, pane: string) => s.panes[pane]!.tabs.map((t) => t.input.path);

describe("editor session", () => {
  it("round-trips tabs, flags, splits, active pane and carets", () => {
    let s = initialTabsState();
    s = open(s, "/p/a.ts");
    s = open(s, "/p/b.ts");
    s = togglePin(s, s.activePane, s.panes[s.activePane]!.tabs[1]!.id);
    s = openTab(s, s.activePane, { kind: "diff", key: "diff:x", data: { big: true } }).state;
    // A regular tab opened later would close the preview: open it in the background last.
    s = open(s, "/p/c.ts", { preview: true, activate: false });
    const first = s.activePane;
    s = splitPane(s, first, "column").state;
    s = open(s, "/p/d.ts");
    const session = serializeSession(s, { "/p/a.ts": { anchor: 3, head: 5, topLine: 10 }, "/p/zzz.ts": { anchor: 0, head: 0 } })!;
    expect(session.layout.kind).toBe("split");
    expect(session.activePane).toBe(1);
    expect(Object.keys(session.files)).toEqual(["/p/a.ts"]);

    const parsed = parseSession(JSON.parse(JSON.stringify(session)))!;
    const r = restoreTabsState(parsed, fileKey);
    const [p1, p2] = paneIds(r);
    expect(paths(r, p1!)).toEqual(paths(s, first).filter(Boolean));
    expect(r.panes[p1!]!.tabs.map((t) => [t.input.path, t.pinned, t.preview])).toEqual([
      ["/p/b.ts", true, false],
      ["/p/c.ts", false, true],
      ["/p/a.ts", false, false],
    ]);
    // The diff tab was active in pane 1 before splitting; restoring falls back to the first file tab.
    expect(paths(r, p2!)).toEqual(["/p/d.ts"]);
    expect(r.activePane).toBe(p2);
    expect(r.layout).toMatchObject({ kind: "split", dir: "column" });
  });

  it("saves tabs of restorable editor kinds with their input", () => {
    let s = initialTabsState();
    s = open(s, "/p/a.ts");
    s = openTab(s, s.activePane, { kind: "agent-session", key: "agent:1", data: { task: "1" } }).state;
    s = openTab(s, s.activePane, { kind: "diff", key: "diff:x", data: { big: true } }).state;
    s = openTab(s, s.activePane, { kind: "agent-session", key: "agent:1", data: { task: "1" } }).state;
    const restorable = (i: { kind: string }) => i.kind === "agent-session";
    const session = serializeSession(s, {}, restorable)!;
    expect(session.layout).toMatchObject({ kind: "pane", active: 1 });
    const r = restoreTabsState(parseSession(JSON.parse(JSON.stringify(session)))!, fileKey);
    const pane = r.panes[paneIds(r)[0]!]!;
    expect(pane.tabs.map((t) => t.input)).toEqual([file("/p/a.ts"), { kind: "agent-session", key: "agent:1", data: { task: "1" } }]);
    expect(pane.active).toBe(pane.tabs[1]!.id);
    // Only restorable tabs: still a session. Junk inputs (file kind, no key) are dropped.
    const empty = initialTabsState();
    const only = openTab(empty, empty.activePane, { kind: "agent-session", key: "agent:2", data: {} }).state;
    expect(serializeSession(only, {}, restorable)).not.toBeNull();
    expect(serializeSession(only, {})).toBeNull();
    const junk = parseSession({
      version: 1,
      layout: { kind: "pane", tabs: [{ input: { kind: "file", key: "k" } }, { input: { kind: "x" } }, { input: { kind: "x", key: "y" } }], active: 0 },
    })!;
    expect(junk.layout).toEqual({ kind: "pane", tabs: [{ input: { kind: "x", key: "y" } }], active: 0 });
  });

  it("returns null for sessions without file tabs and rejects junk", () => {
    expect(serializeSession(initialTabsState(), {})).toBeNull();
    expect(parseSession({ version: 2 })).toBeNull();
    expect(parseSession({ version: 1, layout: { kind: "pane", tabs: [{ nope: 1 }], active: 0 } })).toBeNull();
    const ok = parseSession({
      version: 1,
      activePane: 7,
      layout: { kind: "split", dir: "row", children: [{ kind: "pane", tabs: [{ path: "/x" }], active: 9 }, { kind: "bogus" }] },
      files: { "/x": { anchor: 1, head: -1 } },
    })!;
    expect(ok.layout).toEqual({ kind: "pane", tabs: [{ path: "/x" }], active: 0 });
    expect(ok.files).toEqual({});
    expect(paneIds(restoreTabsState(ok, fileKey))).toHaveLength(1);
  });
});

describe("moveTabToNewSplit", () => {
  it("moves a tab into a new pane on the given edge", () => {
    let s = initialTabsState();
    s = open(s, "/a");
    s = open(s, "/b");
    const pane = s.activePane;
    const b = s.panes[pane]!.tabs[1]!;
    const r = moveTabToNewSplit(s, pane, b.id, pane, "left")!;
    expect(paneIds(r.state)).toEqual([r.paneId, pane]);
    expect(r.state.panes[r.paneId]!.tabs[0]!.id).toBe(b.id);
    expect(paths(r.state, pane)).toEqual(["/a"]);
    expect(r.state.activePane).toBe(r.paneId);
    expect(r.state.closed).toEqual([]);
  });

  it("is a no-op for the only tab of the target pane", () => {
    let s = initialTabsState();
    s = open(s, "/a");
    const pane = s.activePane;
    expect(moveTabToNewSplit(s, pane, s.panes[pane]!.tabs[0]!.id, pane, "right")).toBeNull();
  });

  it("splits the target when the source pane empties and collapses", () => {
    let s = initialTabsState();
    s = open(s, "/a");
    const first = s.activePane;
    const split = splitPane(s, first, "row");
    s = open(split.state, "/b");
    const bTab = s.panes[split.paneId]!.tabs.find((t) => t.input.path === "/b")!;
    s = { ...s, panes: { ...s.panes, [split.paneId]: { ...s.panes[split.paneId]!, tabs: [bTab], active: bTab.id, mru: [bTab.id] } } };
    const r = moveTabToNewSplit(s, split.paneId, bTab.id, first, "bottom")!;
    expect(r.state.panes[split.paneId]).toBeUndefined();
    expect(r.state.layout).toMatchObject({ kind: "split", dir: "column" });
    expect(paneIds(r.state)).toEqual([first, r.paneId]);
  });
});

describe("sessions saved with Windows backslash paths", () => {
  const raw = String.raw;

  it("slashPath rewrites drive and verbatim paths only", () => {
    expect(slashPath(raw`C:\p\a.ts`)).toBe("C:/p/a.ts");
    expect(slashPath(raw`\\?\C:\p\a.ts`)).toBe("C:/p/a.ts");
    expect(slashPath("C:/p/a.ts")).toBe("C:/p/a.ts");
    expect(slashPath(raw`/p/a\b.ts`)).toBe(raw`/p/a\b.ts`);
  });

  it("loads the old key and normalises tab and caret paths", () => {
    const old = {
      version: 1,
      layout: { kind: "pane", tabs: [{ path: raw`C:\p\a.ts` }, { path: raw`\\?\C:\p\b.ts` }], active: 1 },
      activePane: 0,
      files: { [raw`C:\p\a.ts`]: { anchor: 1, head: 2 } },
    };
    const key = raw`openidea.editorSession.v1:C:\p`;
    localStorage.setItem(key, JSON.stringify(old));
    try {
      const s = loadSession("C:/p")!;
      expect(s.layout).toEqual({ kind: "pane", tabs: [{ path: "C:/p/a.ts" }, { path: "C:/p/b.ts" }], active: 1 });
      expect(s.files).toEqual({ "C:/p/a.ts": { anchor: 1, head: 2 } });
    } finally {
      localStorage.removeItem(key);
    }
  });
});
