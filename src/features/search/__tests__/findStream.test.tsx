import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import type { FileMatches, SearchQuery, SearchSummary } from "@/platform/ipc";
import { FindToolWindow } from "../find/FindToolWindow";
import { FindTreeBuilder, buildFindTree } from "../find/findTree";
import type { FindDeps } from "../find/session";
import { disposeFindWindow, openInFindWindow, useFindViewOptions } from "../find/windowStore";

const query: SearchQuery = {
  pattern: "needle",
  isRegex: false,
  caseSensitive: false,
  wholeWord: false,
  include: [],
  exclude: [],
  scope: { kind: "project" },
  maxMatches: 0,
};

/** A deterministic pseudo-random order, so batches interleave paths and directories. */
const shuffled = <T,>(items: readonly T[], seed = 7): T[] => {
  const out = [...items];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
};

const file = (i: number): FileMatches => {
  const dir = i % 9 === 0 ? "" : `src/pkg${i % 13}/sub${i % 4}`;
  const relPath = `${dir ? `${dir}/` : ""}${i % 5 === 0 ? "File" : "file"}${i}.ts`;
  return {
    path: `/proj/${relPath}`,
    relPath,
    matches: [
      { line: 1, text: `  needle ${i}`, ranges: [[2, 8]], textOffset: 0 },
      {
        line: 4 + (i % 3),
        text: "needle needle",
        ranges: [
          [0, 6],
          [7, 13],
        ],
        textOffset: 0,
      },
    ],
  };
};

afterEach(disposeFindWindow);

describe("FindTreeBuilder", () => {
  const files = shuffled(Array.from({ length: 300 }, (_, i) => file(i)));

  /** The files in their final order, by the same rule the view documents: sorted by path. */
  const sortedRels = (list: readonly FileMatches[]) =>
    [...list].map((f) => f.relPath).sort((a, b) => a.localeCompare(b));

  for (const group of [false, true]) {
    it(`builds the same tree incrementally as from scratch (${group ? "grouped by directory" : "flat"})`, () => {
      const builder = new FindTreeBuilder(group);
      let roots = builder.sync([]);
      // Uneven batch sizes, including a batch that changes nothing.
      for (const end of [1, 2, 2, 30, 31, 100, 299, 300]) roots = builder.sync(files.slice(0, end));
      expect(roots).toEqual(buildFindTree(files, group));
      expect(builder.sync(files)).toBe(roots);

      if (group) {
        expect(roots.map((n) => (n.kind === "dir" ? n.label : ""))).toEqual(
          [...new Set(files.map((f) => f.relPath.split("/").slice(0, -1).join("/") || "/"))].sort((a, b) =>
            a.localeCompare(b),
          ),
        );
        expect(roots.reduce((n, r) => n + (r.kind === "dir" ? r.count : 0), 0)).toBe(300 * 3);
      } else {
        expect(roots.map((n) => (n.kind === "file" ? n.path : ""))).toEqual(
          sortedRels(files).map((rel) => `/proj/${rel}`),
        );
      }
    });
  }

  it("keeps the lookup tables in step with the roots", () => {
    const builder = new FindTreeBuilder(true);
    builder.sync(files.slice(0, 120));
    const roots = builder.sync(files);
    const fresh = new FindTreeBuilder(true);
    fresh.sync(files);
    expect([...builder.byKey.keys()].sort()).toEqual([...fresh.byKey.keys()].sort());
    expect([...builder.expandable].sort()).toEqual([...fresh.expandable].sort());
    expect(builder.filesByPath.size).toBe(300);
    for (const root of roots) expect(builder.byKey.get(root.key)).toBe(root);
  });

  it("replaces only the directories that gained files", () => {
    const builder = new FindTreeBuilder(true);
    const list = [file(1), file(2), file(3)];
    const before = builder.sync(list);
    const after = builder.sync([...list, file(53)]); // same dir as file(1)
    const byLabel = (roots: typeof before) => new Map(roots.map((n) => [n.kind === "dir" ? n.label : "", n]));
    const [a, b] = [byLabel(before), byLabel(after)];
    expect(b.get("src/pkg1/sub1")).not.toBe(a.get("src/pkg1/sub1"));
    expect(b.get("src/pkg1/sub1")).toMatchObject({ count: 6 });
    expect(b.get("src/pkg2/sub2")).toBe(a.get("src/pkg2/sub2"));
    expect(b.get("src/pkg3/sub3")).toBe(a.get("src/pkg3/sub3"));
  });

  it("rebuilds when the list is not an extension of the previous one", () => {
    const builder = new FindTreeBuilder(false);
    builder.sync(files.slice(0, 50));
    const other = files.slice(100, 120);
    expect(builder.sync(other)).toEqual(buildFindTree(other, false));
    expect(builder.sync([])).toEqual([]);
    expect(builder.byKey.size).toBe(0);
    const swapped = [...files.slice(0, 5)];
    builder.sync(swapped);
    swapped[4] = files[40]!;
    expect(builder.sync(swapped)).toEqual(buildFindTree(swapped, false));
  });
});

describe("streaming results into the Find tool window", () => {
  const F = 2000;
  const BATCHES = 40;

  beforeEach(() => {
    vi.useFakeTimers();
    useFindViewOptions.setState({ preview: false, groupByDirectory: false });
  });
  afterEach(() => vi.useRealTimers());

  /** Files whose `matches` list counts how often a consumer reads it, i.e. how often a file is processed. */
  const counted = (reads: { n: number }) =>
    Array.from({ length: F }, (_, i) => {
      const { matches, ...rest } = file(i);
      return Object.defineProperty({ ...rest } as FileMatches, "matches", {
        get() {
          reads.n++;
          return matches;
        },
        enumerable: true,
      });
    });

  it("processes each streamed file a bounded number of times, not once per update", async () => {
    const reads = { n: 0 };
    const all = counted(reads);
    let push!: (f: FileMatches) => void;
    let finish!: (s: SearchSummary) => void;
    const deps: FindDeps = {
      validate: async () => {},
      start: (_id, _q, onFile) =>
        new Promise<SearchSummary | null>((resolve) => {
          push = onFile;
          finish = resolve;
        }),
      cancel: () => {},
      nextRequestId: () => 1,
    };
    openInFindWindow(query, "needle", { deps });
    render(<FindToolWindow />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    let updates = 0;
    for (let b = 0; b < BATCHES; b++) {
      await act(async () => {
        for (const f of all.slice((b * F) / BATCHES, ((b + 1) * F) / BATCHES)) push(f);
        await vi.advanceTimersByTimeAsync(60);
      });
      updates++;
    }
    await act(async () => {
      finish({ files: F, matches: F * 3, limitHit: false, cancelled: false, elapsedMs: 1 });
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(updates).toBe(BATCHES);
    expect(screen.getByText(/6.?000 matches in 2.?000 files/)).toBeInTheDocument();
    // Counting matches and building nodes read each file's matches once each; rebuilding the tree on
    // every one of the 40 updates would read them about 20 times each.
    expect(reads.n).toBeLessThanOrEqual(3 * F);
  });
});
