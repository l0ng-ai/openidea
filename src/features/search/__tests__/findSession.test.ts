import { describe, expect, it, vi } from "vitest";
import type { FileMatches, SearchQuery, SearchSummary } from "@/platform/ipc";
import {
  FindSession,
  matchRows,
  previewReplacement,
  rangesToIndices,
  type FindDeps,
  type FindState,
} from "../find/session";

const q = (pattern: string, extra: Partial<SearchQuery> = {}): SearchQuery => ({
  pattern,
  isRegex: false,
  caseSensitive: false,
  wholeWord: false,
  include: [],
  exclude: [],
  scope: { kind: "project" },
  maxMatches: 100,
  ...extra,
});
const file = (rel: string, lines: number[]): FileMatches => ({
  path: `/p/${rel}`,
  relPath: rel,
  matches: lines.map((line) => ({ line, text: "  foo bar", ranges: [[2, 5]], textOffset: 0 })),
});
const summary = (matches: number): SearchSummary => ({
  files: 1,
  matches,
  limitHit: false,
  cancelled: false,
  elapsedMs: 1,
});
const flush = () => new Promise((r) => setTimeout(r, 0));

interface Running {
  id: number;
  onFile: (f: FileMatches) => void;
  finish: (s: SearchSummary | null) => void;
  fail: (e: unknown) => void;
}

function setup() {
  const running: Running[] = [];
  let next = 0;
  const deps: FindDeps = {
    validate: vi.fn(async (query: SearchQuery) => {
      if (query.isRegex && query.pattern === "(") throw { kind: "invalidInput", message: "unclosed group" };
    }),
    start: vi.fn(
      (id, _q, onFile) =>
        new Promise<SearchSummary | null>((finish, fail) => {
          running.push({ id, onFile, finish, fail });
        }),
    ),
    cancel: vi.fn(),
    nextRequestId: () => ++next,
  };
  const states: FindState[] = [];
  const session = new FindSession(deps, (s) => states.push(s));
  return { session, deps, running, states, last: () => states[states.length - 1]! };
}

describe("FindSession", () => {
  it("validates, searches, streams files and completes", async () => {
    const { session, running, last } = setup();
    void session.search(q("foo"));
    expect(last().status).toBe("validating");
    await flush();
    expect(last().status).toBe("searching");
    running[0]!.onFile(file("a.kt", [1, 2]));
    running[0]!.onFile(file("b.kt", [5]));
    await flush();
    expect(last().files).toHaveLength(2);
    expect(last().matchCount).toBe(3);
    running[0]!.finish(summary(3));
    await flush();
    expect(last().status).toBe("done");
    expect(last().summary?.matches).toBe(3);
  });

  it("cancels the previous request when the query changes and drops its late events", async () => {
    const { session, deps, running, last } = setup();
    void session.search(q("foo"));
    await flush();
    void session.search(q("bar"));
    expect(deps.cancel).toHaveBeenCalledWith(1);
    await flush();
    running[0]!.onFile(file("stale.kt", [1]));
    running[0]!.finish(summary(1));
    running[1]!.onFile(file("fresh.kt", [1]));
    await flush();
    expect(last().query?.pattern).toBe("bar");
    expect(last().files.map((f) => f.relPath)).toEqual(["fresh.kt"]);
    expect(last().status).toBe("searching");
  });

  it("invalidates before debounce, drops old events, and keeps rows until the first new file", async () => {
    const { session, deps, running, last } = setup();
    void session.search(q("foo"));
    await flush();
    running[0]!.onFile(file("old.kt", [1, 2]));
    await flush();
    const oldFiles = last().files;
    session.invalidate();
    expect(deps.cancel).toHaveBeenCalledWith(1);
    expect(last()).toMatchObject({ stale: true, matchCount: 0, summary: null });
    expect(last().files).toBe(oldFiles);
    running[0]!.onFile(file("late.kt", [3]));
    running[0]!.finish(summary(3));
    await flush();
    expect(last().files).toBe(oldFiles);
    let validate!: () => void;
    vi.mocked(deps.validate).mockImplementationOnce(
      () =>
        new Promise<void>((r) => {
          validate = r;
        }),
    );
    void session.search(q("bar"));
    expect(last().stale).toBe(true);
    expect(last().files).toBe(oldFiles);
    validate();
    await flush();
    expect(last().status).toBe("searching");
    expect(last().stale).toBe(true);
    expect(last().files).toBe(oldFiles);
    running[1]!.onFile(file("new.kt", [4]));
    await flush();
    expect(last().stale).toBe(false);
    expect(last().files.map((f) => f.relPath)).toEqual(["new.kt"]);
    expect(last().matchCount).toBe(1);
  });

  it("clears retained rows on completion without results", async () => {
    const { session, running, last } = setup();
    void session.search(q("foo"));
    await flush();
    running[0]!.onFile(file("old.kt", [1]));
    running[0]!.finish(summary(1));
    await flush();
    void session.search(q("absent"));
    await flush();
    expect(last().stale).toBe(true);
    expect(last().files).toHaveLength(1);
    running[1]!.finish({ ...summary(0), files: 0 });
    await flush();
    expect(last()).toMatchObject({ status: "done", stale: false, files: [], matchCount: 0 });
  });

  it("reports invalid patterns without starting a search", async () => {
    const { session, deps, last } = setup();
    await session.search(q("(", { isRegex: true }));
    expect(last().status).toBe("invalid");
    expect(last().error).toBe("unclosed group");
    expect(deps.start).not.toHaveBeenCalled();
  });

  it("ignores a stale validation result", async () => {
    const { session, deps, running, last } = setup();
    let release!: () => void;
    (deps.validate as ReturnType<typeof vi.fn>).mockImplementationOnce(() => new Promise<void>((r) => (release = r)));
    void session.search(q("slow"));
    void session.search(q("fast"));
    await flush();
    release();
    await flush();
    expect(running).toHaveLength(1);
    expect(last().query?.pattern).toBe("fast");
  });

  it("an empty pattern resets to idle and cancels", async () => {
    const { session, deps, last } = setup();
    void session.search(q("foo"));
    await flush();
    await session.search(q(""));
    expect(deps.cancel).toHaveBeenCalledWith(1);
    expect(last().status).toBe("idle");
    expect(last().files).toHaveLength(0);
  });

  it("cancel() keeps results; backend cancellation is not an error", async () => {
    const { session, running, last } = setup();
    void session.search(q("foo"));
    await flush();
    running[0]!.onFile(file("a.kt", [1]));
    session.cancel();
    expect(last().status).toBe("done");
    expect(last().files).toHaveLength(1);

    void session.search(q("baz"));
    await flush();
    running[1]!.fail({ kind: "cancelled", message: "cancelled" });
    await flush();
    expect(last().status).toBe("done");
  });

  it("surfaces backend errors", async () => {
    const { session, running, last } = setup();
    void session.search(q("foo"));
    await flush();
    running[0]!.fail({ kind: "io", message: "disk on fire" });
    await flush();
    expect(last().status).toBe("error");
    expect(last().error).toBe("disk on fire");
  });
});

describe("result helpers", () => {
  it("matchRows trims indentation and keeps real columns", () => {
    const rows = matchRows([
      {
        path: "/p/a",
        relPath: "a",
        matches: [{ line: 3, text: "    let foo = 1", ranges: [[8, 11]], textOffset: 10 }],
      },
    ]);
    expect(rows[0]).toMatchObject({ text: "let foo = 1", ranges: [[4, 7]], col: 18, endCol: 21, matched: ["foo"] });
  });

  it("previewReplacement supports Rust-style regex groups", () => {
    const re = { pattern: "(\\w+)=(\\d+)", isRegex: true, caseSensitive: true };
    expect(previewReplacement("a=1", re, "${2}:$1")).toBe("1:a");
    expect(previewReplacement("key=7", { ...re, pattern: "(?<k>\\w+)=\\d+" }, "${k}")).toBe("key");
    expect(previewReplacement("foo", { pattern: "foo", isRegex: false, caseSensitive: false }, "bar")).toBe("bar");
  });

  it("rangesToIndices flattens and dedupes", () => {
    expect(
      rangesToIndices([
        [0, 2],
        [1, 3],
      ]),
    ).toEqual([0, 1, 2]);
  });
});
