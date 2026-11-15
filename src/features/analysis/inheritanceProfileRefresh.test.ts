import { describe, expect, it, vi } from "vitest";
import type { EditorDocContext } from "@/editor/api";

// Toggling an inspection in Settings must reach the open documents: the rules read the
// profile when they run, so the extension subscribes to profile changes and schedules one.
const listeners: (() => void)[] = [];
vi.mock("@/platform/inspections", async (orig) => {
  const real = await orig<typeof import("@/platform/inspections")>();
  return {
    ...real,
    subscribeInspectionProfile: (listener: () => void) => {
      listeners.push(listener);
      return () => listeners.splice(listeners.indexOf(listener), 1);
    },
  };
});
vi.mock("@/editor/lsp/diagnostics", async (orig) => ({
  ...(await orig<object>()),
  setFileDiagnostics: () => {},
}));

const { pythonInheritanceExtension } = await import("./inheritanceInspections");

const ctx = (language: string): EditorDocContext =>
  ({ doc: 1, path: "/p/a.py", language, uiMode: "Python", readOnly: false, virtual: false }) as EditorDocContext;

describe("Python inheritance inspections follow the profile", () => {
  it("subscribes to profile changes, and only for Python", () => {
    expect(listeners).toHaveLength(0);
    pythonInheritanceExtension(ctx("typescript"));
    expect(listeners).toHaveLength(0);
    pythonInheritanceExtension(ctx("python"));
    expect(listeners).toHaveLength(1);
    // A change schedules a run; the schedule itself is debounced, so calling it is safe here.
    expect(() => listeners[0]!()).not.toThrow();
  });
});
