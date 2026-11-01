import { describe, expect, it, vi } from "vitest";
import { classFileBreakpointReason, isClassFile } from "./classFiles";
import { isVirtualUri } from "./virtualDocs";
import { canPlaceBreakpoint } from "@/features/debugger/breakpoints/languages";
vi.mock("@/platform/workflowSettings", () => ({
  workflowSettings: () => ({ debugger: { breakpointsAnyFile: true } }),
}));

describe("compiled class routing and breakpoint policy", () => {
  it.each([
    "/p/target/classes/p/C.class",
    "/p/build/classes/java/main/p/C$1.class",
    "C:\\p\\out\\C.class",
    "file:///p/out/C.class",
  ])("disables output breakpoints even with any-file enabled: %s", (path) => {
    expect(isClassFile(path)).toBe(true);
    expect(classFileBreakpointReason(path)).toBeTruthy();
    expect(canPlaceBreakpoint("java", path)).toBe(false);
  });
  it.each([
    "jdt://contents/a.jar/p/C.class?=p/a.jar%3Cp%28C.class",
    "jdt://contents/a.jar/p/C.java?=p/a.jar%3Cp%28C.class",
    "/p/src/main/java/p/C.java",
  ])("keeps source and JDT breakpoints enabled: %s", (path) => {
    expect(isClassFile(path)).toBe(false);
    expect(classFileBreakpointReason(path)).toBeNull();
    expect(canPlaceBreakpoint("java", path)).toBe(true);
  });
  it("treats disk class URIs as read-only server documents", () => {
    expect(isVirtualUri("file:///p/out/C.class")).toBe(true);
    expect(isVirtualUri("file:///p/src/C.java")).toBe(false);
    expect(isClassFile("/m2/a.jar!/p/C.class")).toBe(true);
  });
});
