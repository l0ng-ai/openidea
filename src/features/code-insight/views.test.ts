import { describe, expect, it } from "vitest";
import { groupUsages, trimPreview, usageCount } from "./usages";
import { serversSummary, type ServerEntry } from "./servers";
import { buildProblemNodes } from "./ProblemsView";
import { mergeDiagnostics, sortProblems } from "./problemsStore";
import { toggleExcludedUsages } from "./UsagesView";
import { childId, directionLabel } from "./hierarchy";

const loc = (path: string, line: number, col: number, endCol: number) => ({
  path,
  range: { start: { line, col }, end: { line, col: endCol } },
});

describe("usages", () => {
  it("groups by file with previews, sorted and de-duplicated", () => {
    const files = new Map<string, string[] | null>([
      ["/p/b.ts", ["", "  const x = foo();"]],
      ["/p/a.ts", null],
    ]);
    const groups = groupUsages(
      [loc("/p/b.ts", 1, 12, 15), loc("/p/a.ts", 4, 0, 3), loc("/p/b.ts", 1, 12, 15), loc("/p/b.ts", 0, 0, 0)],
      files,
    );
    expect(groups.map((g) => [g.path, g.usages.map((u) => u.line)])).toEqual([
      ["/p/a.ts", [4]],
      ["/p/b.ts", [0, 1]],
    ]);
    expect(usageCount(groups)).toBe(3);
    expect(groups[0]!.usages[0]!.text).toBe("");
    expect(trimPreview(groups[1]!.usages[1]!)).toEqual({ text: "const x = foo();", textCol: 2, from: 10, to: 13 });
  });
});

describe("serversSummary", () => {
  const s = (name: string, status: ServerEntry["status"]): ServerEntry => ({
    id: Math.random(),
    name,
    status,
    message: null,
    languages: [],
    root: null,
  });
  it("summarises names and the worst state", () => {
    expect(serversSummary([])).toBeNull();
    expect(serversSummary([s("rust-analyzer", "ready")])).toEqual({ text: "rust-analyzer", tone: "ok" });
    expect(serversSummary([s("vtsls", "ready"), s("eslint", "starting")])).toEqual({ text: "vtsls +1", tone: "busy" });
    expect(serversSummary([s("gopls", "missing")])!.tone).toBe("error");
    expect(serversSummary([s("jdtls", "misconfigured")])!.tone).toBe("error");
  });
});

describe("buildProblemNodes", () => {
  it("lists files with errors first and applies the severity filter", () => {
    const diag = (severity: "error" | "warning" | "hint") => ({
      range: { start: { line: 0, col: 0 }, end: { line: 0, col: 1 } },
      severity,
      message: severity,
      source: null,
      code: null,
    });
    let map = mergeDiagnostics(new Map(), "/a", "s", [diag("warning")]);
    map = mergeDiagnostics(map, "/b", "s", [diag("error"), diag("hint")]);
    const all = buildProblemNodes(map, ["/a", "/b"], { error: true, warning: true, info: true });
    expect(all.map((n) => n.key)).toEqual(["/b", "/a"]);
    const errorsOnly = buildProblemNodes(map, ["/a", "/b"], { error: true, warning: false, info: false });
    expect(errorsOnly.map((n) => n.key)).toEqual(["/b"]);
    expect(errorsOnly[0]!.kind === "file" && errorsOnly[0]!.items.length).toBe(1);
  });
});

describe("hierarchy", () => {
  it("labels directions and builds unique child ids", () => {
    expect(directionLabel("call", "incoming")).toBe("Callers");
    expect(directionLabel("type", "outgoing")).toBe("Subtypes");
    const item = {
      name: "f",
      kind: "function" as const,
      detail: null,
      path: "/a.rs",
      range: { start: { line: 1, col: 0 }, end: { line: 3, col: 1 } },
      selectionRange: { start: { line: 1, col: 3 }, end: { line: 1, col: 4 } },
      fromRanges: [],
    };
    expect(childId("root", item)).toBe("root//a.rs:1:3:f");
  });
});

describe("sortProblems", () => {
  const d = (severity: "error" | "warning", line: number, message: string) => ({
    range: { start: { line, col: 0 }, end: { line, col: 1 } },
    severity,
    message,
    source: null,
    code: null,
  });
  const items = [d("warning", 1, "b"), d("error", 5, "c"), d("warning", 0, "z"), d("error", 2, "a")];
  const lines = (order: { bySeverity: boolean; byName: boolean }) =>
    sortProblems(items, order).map((x) => x.range.start.line);

  it("orders by severity, then position (IDEA's default)", () => {
    expect(lines({ bySeverity: true, byName: false })).toEqual([2, 5, 0, 1]);
  });
  it("orders by position or by name when asked", () => {
    expect(lines({ bySeverity: false, byName: false })).toEqual([0, 1, 2, 5]);
    expect(lines({ bySeverity: false, byName: true })).toEqual([2, 1, 5, 0]);
  });
});

describe("toggleExcludedUsages", () => {
  const u = (line: number) => ({ path: "/a", line, col: 0, endCol: 1, text: "" });
  it("excludes a group unless all of it is excluded already", () => {
    const one = toggleExcludedUsages(new Set(), [u(1)]);
    expect([...one]).toEqual(["/a:1:0"]);
    const both = toggleExcludedUsages(one, [u(1), u(2)]);
    expect([...both].sort()).toEqual(["/a:1:0", "/a:2:0"]);
    expect(toggleExcludedUsages(both, [u(1), u(2)]).size).toBe(0);
  });
});
