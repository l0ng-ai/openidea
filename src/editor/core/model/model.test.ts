import { describe, expect, it } from "vitest";
import {
  changeSplitOrientation,
  closeAll,
  closeKey,
  closeOthers,
  closeTab,
  closeToLeft,
  closeToRight,
  closeUnmodified,
  cycleTab,
  findTab,
  initialTabsState,
  moveTab,
  openTab,
  paneIds,
  promoteTab,
  reopenClosed,
  sortTabs,
  splitPane,
  tabOptions,
  togglePin,
  unsplitAll,
  type TabsState,
} from "./tabs";
import { NavigationHistory } from "./navHistory";
import { emptyStack, extendSelection, shrinkSelection } from "./selectionStack";
import { humpLeft, humpRight } from "./camelHumps";

const file = (path: string) => ({ kind: "file", key: `file:${path}`, path });
const labels = (s: TabsState, pane = s.activePane) =>
  s.panes[pane]!.tabs.map((t) => `${t.input.path}${t.preview ? "*" : ""}${t.pinned ? "^" : ""}`);
const active = (s: TabsState) => {
  const p = s.panes[s.activePane]!;
  return p.tabs.find((t) => t.id === p.active)?.input.path;
};

function open(s: TabsState, path: string, opts = {}) {
  return openTab(s, s.activePane, file(path), opts).state;
}

describe("tab model", () => {
  it("opens new tabs right of the active one and reuses existing tabs", () => {
    let s = initialTabsState();
    s = open(s, "a");
    s = open(s, "b");
    s = open(s, "c");
    s = openTab(s, s.activePane, file("a")).state;
    s = open(s, "d");
    expect(labels(s)).toEqual(["a", "d", "b", "c"]);
    expect(active(s)).toBe("d");
  });

  it("keeps a single preview tab that the next preview replaces", () => {
    let s = initialTabsState();
    s = open(s, "a");
    s = open(s, "p1", { preview: true });
    s = open(s, "p2", { preview: true });
    expect(labels(s)).toEqual(["a", "p2*"]);
    // Opening explicitly (or editing) promotes the preview.
    s = open(s, "p2");
    expect(labels(s)).toEqual(["a", "p2"]);
    s = open(s, "p3", { preview: true });
    const tab = s.panes[s.activePane]!.tabs.find((t) => t.preview)!;
    s = promoteTab(s, s.activePane, tab.id);
    expect(labels(s)).toEqual(["a", "p2", "p3"]);
  });

  it("pins tabs to the front and protects them from bulk close", () => {
    let s = initialTabsState();
    for (const p of ["a", "b", "c", "d"]) s = open(s, p);
    const pane = s.panes[s.activePane]!;
    const c = pane.tabs[2]!;
    s = togglePin(s, s.activePane, c.id);
    expect(labels(s)).toEqual(["c^", "a", "b", "d"]);
    const b = s.panes[s.activePane]!.tabs[2]!;
    s = closeOthers(s, s.activePane, b.id);
    expect(labels(s)).toEqual(["c^", "b"]);
    expect(active(s)).toBe("b");
    s = open(s, "e");
    s = closeToRight(s, s.activePane, s.panes[s.activePane]!.tabs[0]!.id);
    expect(labels(s)).toEqual(["c^"]);
    s = open(s, "f");
    s = closeAll(s, s.activePane, true);
    expect(labels(s)).toEqual(["c^"]);
    s = closeAll(s, s.activePane);
    expect(labels(s)).toEqual([]);
  });

  it("closes tabs to the left and unmodified tabs, keeping pinned ones", () => {
    let s = initialTabsState();
    for (const p of ["a", "b", "c", "d"]) s = open(s, p);
    s = togglePin(s, s.activePane, s.panes[s.activePane]!.tabs[0]!.id);
    s = closeToLeft(s, s.activePane, s.panes[s.activePane]!.tabs[2]!.id);
    expect(labels(s)).toEqual(["a^", "c", "d"]);
    s = open(s, "e");
    s = closeUnmodified(s, s.activePane, (t) => t.input.path === "d");
    expect(labels(s)).toEqual(["a^", "d"]);
  });

  it("activates the left neighbour when closing the active tab (IDEA default)", () => {
    let s = initialTabsState();
    for (const p of ["a", "b", "c"]) s = open(s, p);
    s = openTab(s, s.activePane, file("a")).state;
    s = openTab(s, s.activePane, file("c")).state;
    s = closeTab(s, s.activePane, findTab(s, "file:c")!.tab.id);
    expect(active(s)).toBe("b");
    // The first tab has no left neighbour: the right one.
    s = openTab(s, s.activePane, file("a")).state;
    s = closeTab(s, s.activePane, findTab(s, "file:a")!.tab.id);
    expect(active(s)).toBe("b");
  });

  it("activates the most recently used tab when closing the active one if set", () => {
    tabOptions.activateOnClose = "mru";
    try {
      let s = initialTabsState();
      for (const p of ["a", "b", "c"]) s = open(s, p);
      s = openTab(s, s.activePane, file("a")).state;
      s = openTab(s, s.activePane, file("c")).state;
      const c = findTab(s, "file:c")!.tab;
      s = closeTab(s, s.activePane, c.id);
      expect(active(s)).toBe("a");
    } finally {
      tabOptions.activateOnClose = "left";
    }
  });

  it("closes the preview tab when a regular tab opens", () => {
    let s = initialTabsState();
    s = open(s, "a");
    s = open(s, "p", { preview: true });
    s = open(s, "b");
    expect(labels(s)).toEqual(["a", "b"]);
    expect(active(s)).toBe("b");
    expect(s.panes[s.activePane]!.mru).toHaveLength(2);
    // Reopening an existing regular tab keeps the preview.
    s = open(s, "q", { preview: true });
    s = open(s, "a");
    expect(labels(s)).toEqual(["a", "b", "q*"]);
  });

  it("reopens closed tabs at their position, most recent first", () => {
    let s = initialTabsState();
    for (const p of ["a", "b", "c"]) s = open(s, p);
    s = closeTab(s, s.activePane, findTab(s, "file:b")!.tab.id);
    s = closeTab(s, s.activePane, findTab(s, "file:c")!.tab.id);
    s = reopenClosed(s)!.state;
    expect(labels(s)).toEqual(["a", "c"]);
    s = reopenClosed(s)!.state;
    expect(labels(s)).toEqual(["a", "b", "c"]);
    expect(reopenClosed(s)).toBeNull();
  });

  it("splits, moves tabs across panes and collapses empty panes", () => {
    let s = initialTabsState();
    s = open(s, "a");
    s = open(s, "b");
    const first = s.activePane;
    const split = splitPane(s, first, "row");
    s = split.state;
    expect(paneIds(s)).toEqual([first, split.paneId]);
    expect(labels(s, split.paneId)).toEqual(["b"]);
    expect(s.activePane).toBe(split.paneId);
    s = moveTab(s, first, findTab(s, "file:a", first)!.tab.id, split.paneId, 0);
    expect(labels(s, split.paneId)).toEqual(["a", "b"]);
    expect(labels(s, first)).toEqual(["b"]);
    s = closeTab(s, first, s.panes[first]!.tabs[0]!.id);
    expect(paneIds(s)).toEqual([split.paneId]);
    expect(s.layout).toEqual({ kind: "pane", paneId: split.paneId });
  });

  it("flips the orientation of a split and unsplits everything", () => {
    let s = open(initialTabsState(), "a");
    const first = s.activePane;
    const right = splitPane(s, first, "row");
    const below = splitPane(right.state, right.paneId, "column");
    s = below.state;
    const dirs = (st: TabsState) =>
      st.layout.kind === "split"
        ? [st.layout.dir, ...st.layout.children.map((c) => (c.kind === "split" ? c.dir : "pane"))]
        : [];
    expect(dirs(s)).toEqual(["row", "pane", "column"]);
    // The nested split turns side by side and merges into the outer row.
    s = changeSplitOrientation(s, below.paneId);
    expect(dirs(s)).toEqual(["row", "pane", "pane", "pane"]);
    s = changeSplitOrientation(s, first);
    expect(dirs(s)).toEqual(["column", "pane", "pane", "pane"]);
    expect(changeSplitOrientation(open(initialTabsState(), "x"), "nope").layout.kind).toBe("pane");
    s = unsplitAll(s, right.paneId);
    expect(paneIds(s)).toEqual([right.paneId]);
    expect(s.activePane).toBe(right.paneId);
    expect(labels(s)).toEqual(["a"]);
  });

  it("closes a key everywhere and cycles tabs", () => {
    let s = initialTabsState();
    s = open(s, "a");
    s = open(s, "b");
    s = splitPane(s, s.activePane, "column").state;
    s = closeKey(s, "file:b");
    expect(paneIds(s)).toHaveLength(1);
    expect(labels(s)).toEqual(["a"]);
    s = open(s, "c");
    s = cycleTab(s, 1);
    expect(active(s)).toBe("a");
    s = cycleTab(s, -1);
    expect(active(s)).toBe("c");
  });

  it("sorts tabs alphabetically, pinned ones first", () => {
    let s = initialTabsState();
    for (const p of ["c", "B", "a", "d"]) s = open(s, p);
    s = togglePin(s, s.activePane, s.panes[s.activePane]!.tabs.find((t) => t.input.path === "d")!.id);
    s = sortTabs(s, s.activePane, (t) => t.input.path!);
    expect(labels(s)).toEqual(["d^", "a", "B", "c"]);
    expect(sortTabs(s, s.activePane, (t) => t.input.path!)).toBe(s);
  });
});

describe("navigation history", () => {
  it("records file switches and navigations, not plain caret moves", () => {
    let t = 0;
    const h = new NavigationHistory(() => ++t);
    h.update({ path: "a", line: 1, col: 0 });
    h.update({ path: "a", line: 5, col: 2 });
    // Arrows / paging / typing move the current place, however far.
    h.update({ path: "a", line: 300, col: 0 });
    expect(h.entries).toHaveLength(1);
    h.update({ path: "a", line: 100, col: 0 }, true);
    h.update({ path: "b", line: 0, col: 0 });
    expect(h.entries.map((e) => `${e.path}:${e.line}`)).toEqual(["a:300", "a:100", "b:0"]);
    expect(h.back()).toMatchObject({ path: "a", line: 100 });
    expect(h.back()).toMatchObject({ path: "a", line: 300 });
    expect(h.back()).toBeNull();
    expect(h.forward()).toMatchObject({ path: "a", line: 100 });
    // Navigating somewhere new from the middle drops the forward stack.
    h.update({ path: "c", line: 3, col: 0 });
    expect(h.entries.map((e) => e.path)).toEqual(["a", "a", "c"]);
    expect(h.canGoForward()).toBe(false);
    h.removePath("a");
    expect(h.snapshot()).toMatchObject({ index: 0, entries: [{ path: "c" }] });
  });

  it("a navigation on the same line records nothing", () => {
    const h = new NavigationHistory();
    h.update({ path: "a", line: 7, col: 0 });
    h.update({ path: "a", line: 7, col: 9 }, true);
    expect(h.entries).toHaveLength(1);
  });

  it("merges back places less than four lines apart", () => {
    const h = new NavigationHistory();
    h.update({ path: "a", line: 10, col: 0 });
    h.update({ path: "a", line: 50, col: 0 }, true);
    h.update({ path: "a", line: 12, col: 0 });
    h.update({ path: "a", line: 80, col: 0 }, true);
    // a:10 and a:12 are one place: the newer one stays.
    expect(h.entries.map((e) => e.line)).toEqual([12, 80]);
    h.update({ path: "a", line: 20, col: 0 }, true);
    expect(h.entries.map((e) => e.line)).toEqual([12, 80, 20]);
  });

  it("arriving at a back target updates it in place", () => {
    const h = new NavigationHistory();
    h.update({ path: "a", line: 0, col: 0 });
    h.update({ path: "b", line: 0, col: 0 });
    const target = h.back()!;
    h.update({ path: target.path, line: target.line, col: 4 });
    expect(h.entries).toHaveLength(2);
    expect(h.index).toBe(0);
  });
});

describe("selection stack", () => {
  const cands = [
    { from: 4, to: 7 },
    { from: 0, to: 20 },
    { from: 3, to: 9 },
  ];
  it("extends to the innermost containing range and shrinks back", () => {
    let st = emptyStack();
    let cur = { from: 5, to: 5 };
    let r = extendSelection(st, cur, cands);
    expect(r.next).toEqual({ from: 4, to: 7 });
    st = r.state;
    cur = r.next!;
    r = extendSelection(st, cur, cands);
    expect(r.next).toEqual({ from: 3, to: 9 });
    st = r.state;
    cur = r.next!;
    r = shrinkSelection(st, cur);
    expect(r.next).toEqual({ from: 4, to: 7 });
    r = shrinkSelection(r.state, r.next!);
    expect(r.next).toEqual({ from: 5, to: 5 });
    expect(shrinkSelection(r.state, r.next!).next).toBeNull();
  });

  it("resets when the selection changed in between", () => {
    const r = extendSelection(emptyStack(), { from: 5, to: 5 }, cands);
    expect(shrinkSelection(r.state, { from: 0, to: 1 }).next).toBeNull();
  });
});

describe("camel humps", () => {
  const stops = (text: string, dir: "left" | "right") => {
    const out: number[] = [];
    let pos = dir === "right" ? 0 : text.length;
    for (let i = 0; i < 20; i++) {
      const next = dir === "right" ? humpRight(text, pos) : humpLeft(text, pos);
      if (next === pos) break;
      out.push((pos = next));
    }
    return out;
  };
  it("stops at camel-case, acronym and underscore boundaries", () => {
    expect(stops("parseHTMLDocument", "right")).toEqual([5, 9, 17]);
    expect(stops("parseHTMLDocument", "left")).toEqual([9, 5, 0]);
    expect(stops("snake_case_name", "right")).toEqual([6, 11, 15]);
    expect(stops("foo.barBaz(x)", "right")).toEqual([3, 4, 7, 10, 11, 12, 13]);
    expect(stops("  value2Go", "right")).toEqual([7, 8, 10]);
  });
});
