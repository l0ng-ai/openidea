import { describe, expect, it, vi } from "vitest";
import type { FileMatches, ReplaceEvent, SearchQuery } from "@/platform/ipc";
import { preserveCase } from "@/platform/search";
import { matchRows, previewReplacement } from "../find/session";
import {
  NO_MARKS,
  confirmText,
  countUsages,
  groupState,
  markDone,
  nextPending,
  pendingUsages,
  replacePreviewLines,
  replaceTargets,
  startReplace,
  summaryText,
  toggleExcluded,
  type ReplaceDeps,
} from "../find/replaceFlow";
import { buildFindTree, nodeGroups } from "../find/FindToolWindow";

const q: SearchQuery = {
  pattern: "foo",
  isRegex: false,
  caseSensitive: false,
  wholeWord: false,
  include: [],
  exclude: [],
  scope: { kind: "project" },
  maxMatches: 100,
};

const files: FileMatches[] = [
  {
    path: "/p/a.ts",
    relPath: "a.ts",
    matches: [
      {
        line: 0,
        text: "foo foo",
        ranges: [
          [0, 3],
          [4, 7],
        ],
        textOffset: 0,
      },
      { line: 3, text: "  x foo", ranges: [[4, 7]], textOffset: 0 },
    ],
  },
  { path: "/p/b.ts", relPath: "b.ts", matches: [{ line: 1, text: "foo", ranges: [[0, 3]], textOffset: 10 }] },
];

describe("replace flow model", () => {
  const rows = matchRows(files);

  it("rows carry the start of every usage on the line", () => {
    expect(rows.map((r) => r.starts)).toEqual([
      [
        { line: 0, col: 0 },
        { line: 0, col: 4 },
      ],
      [{ line: 3, col: 4 }],
      [{ line: 1, col: 10 }],
    ]);
  });

  it("builds one target per file with explicit positions", () => {
    const usages = pendingUsages(rows, NO_MARKS);
    expect(countUsages(usages)).toEqual({ usages: 4, files: 2 });
    expect(replaceTargets(usages)).toEqual([
      {
        path: "/p/a.ts",
        only: [
          { line: 0, col: 0 },
          { line: 0, col: 4 },
          { line: 3, col: 4 },
        ],
      },
      { path: "/p/b.ts", only: [{ line: 1, col: 10 }] },
    ]);
  });

  it("excluded (⌫) and replaced usages are skipped; exclusion toggles", () => {
    let marks = toggleExcluded(NO_MARKS, [rows[1]!]);
    expect(groupState(rows[1]!, marks)).toBe("excluded");
    marks = markDone(marks, pendingUsages([rows[0]!], marks));
    expect(groupState(rows[0]!, marks)).toBe("done");
    expect(pendingUsages(rows, marks)).toEqual([{ path: "/p/b.ts", line: 1, col: 10 }]);
    // Skip / Replace move to the next row with something left to do.
    expect(nextPending(rows, 0, marks)).toBe(2);
    expect(nextPending(rows, 2, marks)).toBe(-1);
    marks = toggleExcluded(marks, [rows[1]!]);
    expect(groupState(rows[1]!, marks)).toBe("pending");
  });

  it("excluding a file node excludes all of its usages", () => {
    const [dir] = buildFindTree(files);
    const fileNode = dir!.kind === "dir" ? dir!.children[0]! : dir!;
    const marks = toggleExcluded(NO_MARKS, nodeGroups(fileNode));
    expect(pendingUsages(rows, marks)).toEqual([{ path: "/p/b.ts", line: 1, col: 10 }]);
  });

  it("confirmation and summary texts carry the counts", () => {
    expect(confirmText({ usages: 3, files: 1 }, "foo", "bar")).toBe(
      "Replace 3 occurrences of 'foo' with 'bar' in 1 file?",
    );
    expect(summaryText({ files: 2, replacements: 1, failed: 0, cancelled: false, elapsedMs: 3 })).toBe(
      "Replaced 1 occurrence in 2 files",
    );
    expect(summaryText({ files: 1, replacements: 4, failed: 1, cancelled: true, elapsedMs: 3 })).toBe(
      "Stopped after replacing 4 occurrences in 1 file (1 failed)",
    );
  });
});

describe("startReplace", () => {
  function deps(events: ReplaceEvent[]) {
    const d: ReplaceDeps = {
      synced: vi.fn(async () => {}),
      start: vi.fn(async (_req, _r, onEvent) => events.forEach(onEvent)),
      cancel: vi.fn(),
      nextRequestId: () => 7,
    };
    return d;
  }

  it("waits for editor sync, streams progress and resolves with the summary", async () => {
    const summary = { files: 1, replacements: 2, failed: 1, cancelled: false, elapsedMs: 1 };
    const d = deps([
      { type: "file", path: "/p/a.ts", replacements: 2, done: 1, total: 2 },
      { type: "failed", path: "/p/b.ts", message: "read-only", done: 2, total: 2 },
      { type: "done", summary },
    ]);
    const progress = vi.fn();
    const targets = [{ path: "/p/a.ts", only: null }];
    const run = startReplace({ query: q, replacement: "bar", preserveCase: true, targets }, progress, d);
    await expect(run.result).resolves.toEqual(summary);
    expect(d.synced).toHaveBeenCalledWith(["/p/a.ts"]);
    expect(d.start).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ preserveCase: true, targets }),
      expect.any(Function),
    );
    expect(progress).toHaveBeenLastCalledWith({
      done: 2,
      total: 2,
      replacements: 2,
      failures: [{ path: "/p/b.ts", message: "read-only" }],
    });
  });

  it("cancel goes to the backend request", async () => {
    const d = deps([]);
    const run = startReplace({ query: q, replacement: "x", preserveCase: false, targets: [] }, undefined, d);
    run.cancel();
    expect(d.cancel).toHaveBeenCalledWith(7);
    await expect(run.result).resolves.toMatchObject({ cancelled: true });
  });
});

describe("replace previews", () => {
  it("preserve case and regex groups in the inline preview", () => {
    expect(preserveCase("FOO", "bar")).toBe("BAR");
    expect(preserveCase("Foo", "bar")).toBe("Bar");
    expect(preserveCase("foo", "Bar")).toBe("bar");
    expect(
      previewReplacement("Foo1", { pattern: "foo(\\d)", isRegex: true, caseSensitive: false }, "bar$1", true),
    ).toBe("Bar1");
  });

  it("unified line preview of the edits", () => {
    const before = "a\nfoo x foo\nb\nfoo";
    const edits = [
      { range: { start: { line: 1, col: 0 }, end: { line: 1, col: 3 } }, new_text: "bar" },
      { range: { start: { line: 1, col: 6 }, end: { line: 1, col: 9 } }, new_text: "q\nq" },
      { range: { start: { line: 3, col: 0 }, end: { line: 3, col: 3 } }, new_text: "z" },
    ];
    expect(replacePreviewLines(before, edits)).toEqual([
      { kind: "same", line: 0, text: "a" },
      { kind: "del", line: 1, text: "foo x foo" },
      { kind: "add", line: 1, text: "bar x q" },
      { kind: "add", line: 2, text: "q" },
      { kind: "same", line: 2, text: "b" },
      { kind: "del", line: 3, text: "foo" },
      { kind: "add", line: 4, text: "z" },
    ]);
  });
});
