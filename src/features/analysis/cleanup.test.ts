import { describe, expect, it } from "vitest";
import type { FileEntry } from "@/platform/ipc";
import { maskMatcher, reformatTargets, type ReformatSources } from "./cleanup";

const entry = (path: string, kind: "file" | "dir" = "file", extra: Partial<FileEntry> = {}): FileEntry => ({
  name: path.slice(path.lastIndexOf("/") + 1),
  path,
  kind,
  size: 1,
  mtimeMs: null,
  ignored: false,
  excluded: false,
  hidden: false,
  ...extra,
});

/** project-a/bin with Bash scripts (one without extension), a nested folder, an image and ignored output. */
const TREE: Record<string, FileEntry[]> = {
  "/p/bin": [
    entry("/p/bin/build.sh"),
    entry("/p/bin/deploy"),
    entry("/p/bin/logo.png"),
    entry("/p/bin/tool.py"),
    entry("/p/bin/lib", "dir"),
    entry("/p/bin/out", "dir", { ignored: true }),
    entry("/p/bin/.cache", "dir", { hidden: true }),
  ],
  "/p/bin/lib": [entry("/p/bin/lib/common.sh"), entry("/p/bin/lib/vendor.min.sh")],
  "/p/bin/out": [entry("/p/bin/out/gen.sh")],
  "/p/bin/.cache": [entry("/p/bin/.cache/x.sh")],
};

const sources = (changed: string[] = []): ReformatSources => ({
  readDir: async (path) => TREE[path] ?? [],
  isText: (path) => !path.endsWith(".png"),
  changedFiles: async () => changed,
});

const all = { recursive: true, mask: "", changedTextOnly: false };

describe("Reformat Code on a directory or several files", () => {
  it("takes every text file under a directory, skipping ignored, hidden and binary files", async () => {
    expect(await reformatTargets([{ path: "/p/bin", dir: true }], all, sources())).toEqual([
      "/p/bin/build.sh",
      "/p/bin/deploy",
      "/p/bin/lib/common.sh",
      "/p/bin/lib/vendor.min.sh",
      "/p/bin/tool.py",
    ]);
  });

  it("stays out of subdirectories unless Include subdirectories is on", async () => {
    expect(await reformatTargets([{ path: "/p/bin", dir: true }], { ...all, recursive: false }, sources())).toEqual([
      "/p/bin/build.sh",
      "/p/bin/deploy",
      "/p/bin/tool.py",
    ]);
  });

  it("limits the files to the file mask, for found and selected files alike", async () => {
    const targets = [
      { path: "/p/bin", dir: true },
      { path: "/p/README.md", dir: false },
    ];
    expect(await reformatTargets(targets, { ...all, mask: "*.sh, !*.min.sh" }, sources())).toEqual([
      "/p/bin/build.sh",
      "/p/bin/lib/common.sh",
    ]);
  });

  it("takes selected files as they are and lists a file selected with its folder once", async () => {
    const targets = [
      { path: "/p/bin/lib", dir: true },
      { path: "/p/bin/lib/common.sh", dir: false },
      { path: "/p/notes.custom", dir: false },
    ];
    expect(await reformatTargets(targets, all, sources())).toEqual([
      "/p/bin/lib/common.sh",
      "/p/bin/lib/vendor.min.sh",
      "/p/notes.custom",
    ]);
  });

  it("keeps only files with uncommitted changes for Only VCS changed text", async () => {
    const changed = sources(["/p/bin/deploy", "/p/bin/lib/common.sh", "/p/elsewhere.sh"]);
    expect(await reformatTargets([{ path: "/p/bin", dir: true }], { ...all, changedTextOnly: true }, changed)).toEqual([
      "/p/bin/deploy",
      "/p/bin/lib/common.sh",
    ]);
  });
});

describe("file masks", () => {
  it("matches names against comma-separated globs, case-insensitively, with ! excluding", () => {
    const m = maskMatcher("*.sh, *.PY; !test_*");
    expect(["a.sh", "b.py", "C.SH"].every(m)).toBe(true);
    expect(["a.js", "test_a.py", "sh"].some(m)).toBe(false);
    expect(maskMatcher("")("anything.bin")).toBe(true);
    expect(maskMatcher("!*.min.js")("app.js")).toBe(true);
    expect(maskMatcher("!*.min.js")("app.min.js")).toBe(false);
    expect(maskMatcher("?.c")("a.c")).toBe(true);
    expect(maskMatcher("?.c")("ab.c")).toBe(false);
  });
});
