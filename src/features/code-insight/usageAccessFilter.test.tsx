import { afterEach, describe, expect, it } from "vitest";
import { filterUsageAccess, loadAccessOptions, toggleUsageAccess, useUsageAccessOptions } from "./UsageAccessFilter";
import type { Usage } from "./usages";
const rows: Usage[] = ["read", "write", "readWrite", "unknown", undefined].map((access, line) => ({
  path: "/Bean.java",
  line,
  col: 0,
  endCol: 1,
  text: "x",
  access: access as Usage["access"],
}));
afterEach(() => {
  localStorage.clear();
  useUsageAccessOptions.setState({ read: true, write: true });
});
describe("read/write visibility", () => {
  it("matches all three reachable states and retains unknown/legacy rows", () => {
    expect(filterUsageAccess(rows, { read: true, write: true })).toHaveLength(5);
    expect(filterUsageAccess(rows, { read: true, write: false }).map((u) => u.line)).toEqual([0, 2, 3, 4]);
    expect(filterUsageAccess(rows, { read: false, write: true }).map((u) => u.line)).toEqual([1, 2, 3, 4]);
    expect(filterUsageAccess([{ ...rows[4]!, kind: "getter" }], { read: false, write: true })).toHaveLength(1);
  });
  it("turns the other button on when the last visible access is turned off", () => {
    toggleUsageAccess("write");
    expect(useUsageAccessOptions.getState()).toEqual({ read: true, write: false });
    toggleUsageAccess("read");
    expect(useUsageAccessOptions.getState()).toEqual({ read: false, write: true });
    toggleUsageAccess("write");
    expect(useUsageAccessOptions.getState()).toEqual({ read: true, write: false });
    expect(loadAccessOptions()).toEqual({ read: true, write: false });
  });
  it("starts with both on and repairs invalid persisted state", () => {
    expect(loadAccessOptions()).toEqual({ read: true, write: true });
    localStorage.setItem("openidea.usages.accessFilter.v1", '{"read":false,"write":false}');
    expect(loadAccessOptions()).toEqual({ read: true, write: true });
  });
});
