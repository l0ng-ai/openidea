import { describe, expect, it } from "vitest";
import type { FileEntry, OutlineItem } from "@/platform/ipc";
import { dirChildren, navSegments, stepSegment, symbolChildren } from "./navBar";

const r = { start: { line: 0, col: 0 }, end: { line: 9, col: 0 } };
const sym = (name: string, children: OutlineItem[] = []): OutlineItem => ({
  name,
  kind: "class",
  detail: null,
  range: r,
  selection_range: r,
  children,
});

describe("navigation bar popup model", () => {
  it("lists project › dirs › file › symbols, skipping the class named like its file", () => {
    const segs = navSegments({ root: "/p", name: "proj" }, "/p/src/a/Foo.java", [sym("Foo"), sym("run")]);
    expect(segs.map((s) => `${s.kind}:${s.label}`)).toEqual([
      "dir:proj",
      "dir:src",
      "dir:a",
      "file:Foo.java",
      "symbol:run",
    ]);
    expect(segs[2]).toMatchObject({ path: "/p/src/a" });
  });

  it("shows only the parent folder outside the project (scratches)", () => {
    expect(navSegments({ root: "/p", name: "proj" }, "/data/scratches/scratch.py", []).map((s) => s.label)).toEqual([
      "scratches",
      "scratch.py",
    ]);
  });

  it("navigates folders and the project root without adding a file segment", () => {
    const project = { root: "/p", name: "proj" };
    expect(navSegments(project, "/p", [], true).map((s) => s.label)).toEqual(["proj"]);
    expect(navSegments(project, "/p/src/lib", [], true).map((s) => s.label)).toEqual(["proj", "src", "lib"]);
    expect(navSegments(project, "/external/lib", [], true)).toEqual([
      { kind: "dir", path: "/external/lib", label: "lib" },
    ]);
  });

  it("lists folder children without IDE-hidden names, and symbol children", () => {
    const e = (name: string, kind: FileEntry["kind"]) =>
      ({
        name,
        path: `/p/${name}`,
        kind,
        size: 0,
        mtimeMs: 0,
        ignored: false,
        excluded: false,
        hidden: false,
      }) as FileEntry;
    expect(
      dirChildren([e(".git", "dir"), e("src", "dir"), e("a.ts", "file")]).map((c) => `${c.kind}:${c.label}`),
    ).toEqual(["dir:src", "file:a.ts"]);
    expect(symbolChildren("/p/a.ts", [sym("A", [sym("b")])]).map((c) => c.label)).toEqual(["A"]);
  });

  it("clamps ←/→ at the ends", () => {
    expect(stepSegment(0, 3, -1)).toBe(0);
    expect(stepSegment(1, 3, 1)).toBe(2);
    expect(stepSegment(2, 3, 1)).toBe(2);
  });
});
