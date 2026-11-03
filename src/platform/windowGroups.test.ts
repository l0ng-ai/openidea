import { describe, expect, it } from "vitest";
import { reorderedTabs } from "./windowGroups";

describe("project window order", () => {
  const tabs = ["a", "b", "c"].map((label) => ({ label, name: label, current: label === "b", root: `/${label}` }));
  it("moves a tab across its neighbours without changing the source or active window", () => {
    expect(reorderedTabs(tabs, "a", "c")).toEqual(["b", "c", "a"]);
    expect(reorderedTabs(tabs, "c", "a")).toEqual(["c", "a", "b"]);
    expect(tabs.map((t) => t.label)).toEqual(["a", "b", "c"]);
    expect(tabs.find((t) => t.current)?.label).toBe("b");
  });
  it("ignores external drags and missing targets", () => {
    expect(reorderedTabs(tabs, "outside", "b")).toEqual(["a", "b", "c"]);
    expect(reorderedTabs(tabs, "a", "outside")).toEqual(["a", "b", "c"]);
  });
});
