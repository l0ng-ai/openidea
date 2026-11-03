import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeAll,
  closeTab,
  getSession,
  groupTabs,
  moveTab,
  neighbourGroup,
  newTab,
  splitTab,
  topRightGroup,
  unsplit,
  useTerminals,
  type GroupLayout,
} from "./store";

vi.mock("./session", () => ({
  TerminalSession: class {
    key: string;
    state: { cwd: string };
    constructor(opts: { key: string; cwd: string }) {
      this.key = opts.key;
      this.state = { cwd: opts.cwd };
    }
    dispose() {}
  },
}));

const state = () => useTerminals.getState();
const tab = (id: string) => state().tabs.find((t) => t.id === id)!;
const strip = (group: string) => groupTabs(state().tabs, group).map((t) => t.id);

beforeEach(() => closeAll());

describe("terminal tab groups", () => {
  it("splits right into a new group with a session in the tab's directory", () => {
    const a = newTab("/repo/app");
    const b = splitTab(a.id, "horizontal")!;
    const g2 = tab(b).group;
    expect(g2).not.toBe(a.group);
    expect(state().layout).toMatchObject({ orientation: "horizontal", children: [a.group, g2] });
    expect(tab(b).name).toBe("Local (2)");
    expect(getSession(tab(b).session)?.state.cwd).toBe("/repo/app");
    expect(state().selected).toEqual({ [a.group]: a.id, [g2]: b });
    expect(state().activeTab).toBe(b);
    // New tabs open in the active group.
    expect(newTab("/repo").group).toBe(g2);
  });

  it("collapses a group when its last tab closes, activating the neighbour", () => {
    const a = newTab("/p");
    const b = splitTab(a.id, "vertical")!;
    closeTab(b);
    expect(state().layout).toBe(a.group);
    expect(state().activeTab).toBe(a.id);
    expect(Object.keys(state().selected)).toEqual([a.group]);
    closeTab(a.id);
    expect(state().layout).toBe(a.group);
    expect(state().activeTab).toBeNull();
  });

  it("moves the tab itself with Split and Move, which needs another tab left behind", () => {
    const a = newTab("/p");
    expect(splitTab(a.id, "vertical", true)).toBeNull();
    const c = newTab("/p").id;
    expect(splitTab(c, "vertical", true)).toBe(c);
    expect(tab(c).group).not.toBe(a.group);
    expect(strip(a.group)).toEqual([a.id]);
    expect(state().selected[a.group]).toBe(a.id);
    expect(state().layout).toMatchObject({ orientation: "vertical", children: [a.group, tab(c).group] });
  });

  it("unsplits into the neighbouring group, in layout order, keeping the group's selection", () => {
    const a = newTab("/p");
    const b = splitTab(a.id, "horizontal")!;
    const g2 = tab(b).group;
    const c = newTab("/p").id;
    unsplit(a.group);
    expect(state().layout).toBe(g2);
    expect(strip(g2)).toEqual([a.id, b, c]);
    expect(state().selected).toEqual({ [g2]: a.id });
    expect(state().activeTab).toBe(a.id);
  });

  it("drags tabs between groups and within one", () => {
    const a = newTab("/p");
    const b = splitTab(a.id, "horizontal")!;
    moveTab(b, a.group, 0);
    expect(state().layout).toBe(a.group);
    expect(strip(a.group)).toEqual([b, a.id]);
    expect(state().activeTab).toBe(b);
    moveTab(b, a.group, 2);
    expect(strip(a.group)).toEqual([a.id, b]);
    // A group's only tab dropped on its own strip stays put.
    const d = splitTab(a.id, "horizontal")!;
    moveTab(d, tab(d).group, 0);
    expect(typeof state().layout).toBe("object");
  });
});

describe("group layout", () => {
  const l: GroupLayout = {
    id: "s1",
    orientation: "horizontal",
    children: ["A", { id: "s2", orientation: "vertical", children: ["B", "C"] }],
  };

  it("finds the group an unsplit merges into: the one before, else after, in the same split", () => {
    expect(neighbourGroup(l, "A")).toBe("B");
    expect(neighbourGroup(l, "B")).toBe("C");
    expect(neighbourGroup(l, "C")).toBe("B");
    expect(neighbourGroup("A", "A")).toBeNull();
  });

  it("finds the top right group", () => {
    expect(topRightGroup(l)).toBe("B");
    expect(topRightGroup({ id: "s", orientation: "vertical", children: [l, "D"] })).toBe("B");
    expect(topRightGroup("A")).toBe("A");
  });
});
