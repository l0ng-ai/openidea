import { describe, expect, it } from "vitest";
import { registerAction } from "@/platform/actions";
import { resolveMenuItems } from "./Menu";

describe("menu row keys", () => {
  it("stay unique when one action appears with several object args", () => {
    const off = registerAction({ id: "test.menuKeys.executor", title: "Run With", run: () => {} });
    try {
      const rows = resolveMenuItems([
        { kind: "action", action: "test.menuKeys.executor", arg: { executor: "coverage" }, label: "Coverage" },
        { kind: "action", action: "test.menuKeys.executor", arg: { executor: "profiler" }, label: "Profile" },
        { label: "Same", id: "dup", run: () => {} },
        { label: "Same", id: "dup", run: () => {} },
      ]);
      const keys = rows.map((r) => r.key);
      expect(new Set(keys).size).toBe(keys.length);
      expect(keys[0]).toBe("test.menuKeys.executor");
    } finally {
      off();
    }
  });
});
