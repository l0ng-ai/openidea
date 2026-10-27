import { beforeEach, describe, expect, it } from "vitest";
import type { Diagnostic } from "@/bindings";
import {
  applyDiagnosticsEvent,
  clearProblems,
  countSeverities,
  fileDiagnostics,
  mergeDiagnostics,
  profiledProblems,
  projectCounts,
  useProblems,
  worstSeverity,
} from "./problemsStore";
import { problemDecorations } from "./decorations";

const d = (line: number, severity: Diagnostic["severity"] = "error", source: string | null = null): Diagnostic => ({
  range: { start: { line, col: 0 }, end: { line, col: 1 } },
  severity,
  message: `line ${line}`,
  source,
  code: null,
});

describe("mergeDiagnostics", () => {
  it("replaces per (file, source) and keeps other sources", () => {
    let map = mergeDiagnostics(new Map(), "/a", "ra", [d(3), d(1)]);
    map = mergeDiagnostics(map, "/a", "clippy", [d(2, "warning")]);
    expect(fileDiagnostics(map, "/a").map((x) => [x.range.start.line, x.source])).toEqual([
      [1, "ra"],
      [2, "clippy"],
      [3, "ra"],
    ]);
    map = mergeDiagnostics(map, "/a", "ra", [d(5, "info")]);
    expect(fileDiagnostics(map, "/a").map((x) => x.range.start.line)).toEqual([2, 5]);
  });

  it("drops files whose sources are all empty and is a no-op for unknown clears", () => {
    const a = mergeDiagnostics(new Map(), "/a", "ra", [d(1)]);
    expect(mergeDiagnostics(a, "/a", "other", [])).toBe(a);
    expect(mergeDiagnostics(a, "/b", "ra", [])).toBe(a);
    const cleared = mergeDiagnostics(a, "/a", "ra", []);
    expect(cleared.has("/a")).toBe(false);
  });

  it("keeps an item's own source", () => {
    const map = mergeDiagnostics(new Map(), "/a", "eslint", [d(1, "error", "eslint/no-undef")]);
    expect(fileDiagnostics(map, "/a")[0]!.source).toBe("eslint/no-undef");
  });
});

describe("counts", () => {
  it("counts per severity", () => {
    let map = mergeDiagnostics(new Map(), "/a", "ra", [d(1), d(2, "warning")]);
    map = mergeDiagnostics(map, "/b", "ra", [d(1, "warning"), d(2, "hint")]);
    expect(projectCounts(map)).toEqual({ error: 1, warning: 2, info: 0, hint: 1 });
    expect(countSeverities(fileDiagnostics(map, "/b"))).toEqual({ error: 0, warning: 1, info: 0, hint: 1 });
    expect(worstSeverity(fileDiagnostics(map, "/b"))).toBe("warning");
    expect(worstSeverity([])).toBeNull();
  });
});

describe("store + decorations", () => {
  beforeEach(() => clearProblems());

  it("applies events and decorates only files with errors", () => {
    applyDiagnosticsEvent("/p/src/a.rs", "ra", [d(1), d(2, "warning")]);
    applyDiagnosticsEvent("/p/src/b.rs", "ra", [d(1, "warning")]);
    const deco = problemDecorations(useProblems.getState().map);
    expect([...deco.keys()]).toEqual(["/p/src/a.rs"]);
    expect(deco.get("/p/src/a.rs")).toEqual({ error: true, propagate: true, tooltip: "1 error, 1 warning" });
  });
});

describe("profiledProblems", () => {
  it("applies the inspection profile per producer", () => {
    let raw = mergeDiagnostics(new Map(), "/a", "ra", [d(1), d(2, "warning")]);
    raw = mergeDiagnostics(raw, "/b", "eslint", [d(3)]);
    const out = profiledProblems(raw, { "lsp:eslint": { enabled: false }, "lsp:ra": { severity: "weakWarning" } });
    expect([...out.keys()]).toEqual(["/a"]);
    expect(fileDiagnostics(out, "/a").map((x) => x.severity)).toEqual(["info", "info"]);
    expect(fileDiagnostics(profiledProblems(raw, {}), "/b")).toHaveLength(1);
  });
});

describe("local inspections (issue #42)", () => {
  it("reach Problems and clear there too, with their inspection known", async () => {
    const { installProblemsEvents, producerFor } = await import("./problemsStore");
    const { setFileDiagnostics } = await import("@/editor/lsp/diagnostics");
    const { diagnosticInspection } = await import("@/platform/inspections");
    clearProblems();
    const off = installProblemsEvents();
    try {
      setFileDiagnostics("/p/a.py", "spelling", [{ ...d(0, "info"), message: "Typo: In word 'mesage'", source: "Spelling" }]);
      const [typo] = fileDiagnostics(useProblems.getState().map, "/p/a.py");
      expect(typo).toMatchObject({ message: "Typo: In word 'mesage'", typo: true });
      const producer = producerFor(useProblems.getState().map, "/p/a.py", typo!);
      expect(producer).toBe("spelling");
      expect(diagnosticInspection(producer!, typo!)?.id).toBe("builtin:spelling");
      setFileDiagnostics("/p/a.py", "spelling", []);
      expect(useProblems.getState().map.size).toBe(0);
    } finally {
      off();
    }
  });
});
