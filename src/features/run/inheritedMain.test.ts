import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HierarchyItem } from "@/platform/ipc";
import {
  clearInheritedMain,
  hasInheritedMain,
  resolveCandidates,
  resolveInheritedMain,
  unresolvedCandidates,
  type InheritedMainDeps,
} from "./inheritedMain";

const item = (name: string, path: string, kind: HierarchyItem["kind"] = "class"): HierarchyItem => ({
  name,
  kind,
  detail: null,
  path,
  range: { start: { line: 0, col: 0 }, end: { line: 5, col: 1 } },
  selectionRange: { start: { line: 0, col: 6 }, end: { line: 0, col: 6 + name.length } },
  fromRanges: [],
});
const MAIN = "public static void main(String[] a) {}";

function deps(supers: Record<string, HierarchyItem[] | Error>, texts: Record<string, string>) {
  const d: InheritedMainDeps = {
    supertypes: vi.fn(async (path) => {
      const r = supers[path];
      if (r instanceof Error) throw r;
      return r ?? [];
    }),
    text: vi.fn(async (i) => {
      const t = texts[i.uri ?? i.path];
      if (t === undefined) throw new Error("unreadable");
      return t;
    }),
  };
  return d;
}
const at = { line: 3, col: 13 };

beforeEach(() => clearInheritedMain());

describe("resolveInheritedMain", () => {
  it("finds main in a direct superclass inside a jar", async () => {
    const jar = "jdt://contents/lib.jar/pkg/AtomStarter.class";
    const d = deps(
      { "/p/App.java": [item("AtomStarter", jar)] },
      { [jar]: `package pkg; class AtomStarter { ${MAIN} }` },
    );
    expect(await resolveInheritedMain("/p/App.java", at, d)).toBe(true);
  });

  it("walks two levels", async () => {
    const d = deps(
      { "/p/App.java": [item("Mid", "/p/Mid.java")], "/p/Mid.java": [item("Base", "/p/Base.java")] },
      { "/p/Mid.java": "class Mid extends Base {}", "/p/Base.java": `class Base { ${MAIN} }` },
    );
    expect(await resolveInheritedMain("/p/App.java", at, d)).toBe(true);
  });

  it("ignores interfaces and instance main", async () => {
    const d = deps(
      { "/p/App.java": [item("Iface", "/p/Iface.java", "interface"), item("Inst", "/p/Inst.java")] },
      { "/p/Iface.java": `interface Iface { ${MAIN} }`, "/p/Inst.java": "class Inst { void main() {} }" },
    );
    expect(await resolveInheritedMain("/p/App.java", at, d)).toBe(false);
  });

  it("stops on cycles", async () => {
    const d = deps(
      { "/p/A.java": [item("B", "/p/B.java")], "/p/B.java": [item("B", "/p/B.java")] },
      { "/p/B.java": "class B {}" },
    );
    expect(await resolveInheritedMain("/p/A.java", at, d)).toBe(false);
    expect(d.supertypes).toHaveBeenCalledTimes(2);
  });

  it("is undefined when the server cannot answer, false when a deeper level fails", async () => {
    expect(await resolveInheritedMain("/p/A.java", at, deps({ "/p/A.java": new Error("x") }, {}))).toBeUndefined();
    const d = deps(
      { "/p/A.java": [item("B", "/p/B.java")], "/p/B.java": new Error("x") },
      { "/p/B.java": "class B {}" },
    );
    expect(await resolveInheritedMain("/p/A.java", at, d)).toBe(false);
  });

  it("treats an unreadable supertype as no main", async () => {
    const d = deps({ "/p/A.java": [item("B", "/p/B.java")] }, {});
    expect(await resolveInheritedMain("/p/A.java", at, d)).toBe(false);
  });

  it("reads each supertype's text once", async () => {
    const d = deps(
      { "/p/A.java": [item("B", "/p/B.java")], "/p/C.java": [item("B", "/p/B.java")] },
      { "/p/B.java": "class B {}" },
    );
    await resolveInheritedMain("/p/A.java", at, d);
    await resolveInheritedMain("/p/C.java", at, d);
    expect(d.text).toHaveBeenCalledTimes(1);
  });
});

describe("resolveCandidates", () => {
  const src = "package demo;\n\npublic class App extends Base {}\n";
  it("records answers for fileTargets and skips them next time", async () => {
    const d = deps({ "/p/App.java": [item("Base", "/p/Base.java")] }, { "/p/Base.java": `class Base { ${MAIN} }` });
    expect(unresolvedCandidates("/p/App.java", src)).toHaveLength(1);
    expect(await resolveCandidates("/p/App.java", unresolvedCandidates("/p/App.java", src), d)).toBe(true);
    expect(hasInheritedMain("/p/App.java", { className: "demo.App", base: "Base" })).toBe(true);
    expect(unresolvedCandidates("/p/App.java", src)).toHaveLength(0);
  });

  it("asks again when the extends clause changes", async () => {
    const d = deps({ "/p/App.java": [item("Base", "/p/Base.java")] }, { "/p/Base.java": `class Base { ${MAIN} }` });
    await resolveCandidates("/p/App.java", unresolvedCandidates("/p/App.java", src), d);
    const edited = src.replace("extends Base", "extends Other");
    expect(hasInheritedMain("/p/App.java", { className: "demo.App", base: "Other" })).toBe(false);
    expect(unresolvedCandidates("/p/App.java", edited)).toHaveLength(1);
  });

  it("leaves a candidate pending while the server is unavailable", async () => {
    const d = deps({ "/p/App.java": new Error("unavailable") }, {});
    expect(await resolveCandidates("/p/App.java", unresolvedCandidates("/p/App.java", src), d)).toBe(false);
    expect(unresolvedCandidates("/p/App.java", src)).toHaveLength(1);
  });
});
