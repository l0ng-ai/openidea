import { describe, expect, it } from "vitest";
import { survivingRowShift } from "../logScrollAnchor";
import { commitKey, type RepoCommit } from "../multiRoot";

let reads = 0;
const row = (id: string, repo: string | null = "/repo"): RepoCommit =>
  ({
    get id() {
      reads++;
      return id;
    },
    repo,
  }) as unknown as RepoCommit;
const rows = (prefix: string, n: number, repo?: string | null) =>
  Array.from({ length: n }, (_, i) => row(`${prefix}${i}`, repo));

describe("survivingRowShift", () => {
  it("shifts by where the first surviving row at or below the top moved", () => {
    const [a, b, c, d] = rows("c", 4);
    expect(survivingRowShift([a!, b!, c!, d!], [row("new"), c!, d!], 0)).toBe(-1);
    expect(survivingRowShift([a!, b!, c!, d!], [row("x"), row("y"), a!, b!], 1)).toBe(2);
  });

  it("takes the first match of a commit listed twice, and repositories apart", () => {
    expect(survivingRowShift([row("a")], [row("b"), row("a"), row("a")], 0)).toBe(1);
    expect(survivingRowShift([row("a", "/one")], [row("a", "/two"), row("a", "/one")], 0)).toBe(1);
  });

  it("is null when no row survives or the top is past the end", () => {
    expect(survivingRowShift(rows("old", 3), rows("new", 3), 0)).toBeNull();
    expect(survivingRowShift(rows("c", 2), rows("c", 2), 5)).toBeNull();
  });

  // Checkout from main to an older commit: the newest ~21k rows of the old list are gone.
  // Searching the new list once per old row froze the window for minutes.
  it("reads each row a bounded number of times when the leading rows are gone", () => {
    const kept = rows("kept", 3000);
    const previous = [...rows("gone", 3000), ...kept];
    reads = 0;
    expect(survivingRowShift(previous, kept, 0)).toBe(-3000);
    // Per-row search on main: 3000 × 3000 × 2 = 18M reads.
    expect(reads).toBeLessThan(20 * (previous.length + kept.length));
  });

  it("reads only up to the match when the top row survives, like a plain search", () => {
    const list = rows("c", 3000);
    reads = 0;
    expect(survivingRowShift(list, [...list, ...rows("more", 1000)], 2)).toBe(0);
    expect(reads).toBeLessThan(10);
  });

  // The per-row search it replaces, kept as the oracle.
  const searchPerRow = (previous: readonly RepoCommit[], commits: readonly RepoCommit[], top: number) => {
    for (let i = top; i < previous.length; i++) {
      const next = commits.findIndex((c) => commitKey(c) === commitKey(previous[i]!));
      if (next >= 0) return next - i;
    }
    return null;
  };

  it("matches the per-row search on generated lists", () => {
    let seed = 1;
    const random = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    const repos = [null, "", "/one", "/two"];
    const pick = (ids: number) => ({ id: `c${random(ids)}`, repo: repos[random(4)] }) as unknown as RepoCommit;
    const list = (length: number, ids: number) => Array.from({ length: random(length) }, () => pick(ids));
    for (let run = 0; run < 5000; run++) {
      // Long previous lists with ids missing from `commits` also cover the indexed lookups.
      const previous = run % 2 ? list(15, 12) : list(80, 40);
      const commits = run % 2 ? list(15, 12) : list(15, 4);
      const top = random(previous.length + 3);
      expect(survivingRowShift(previous, commits, top)).toBe(searchPerRow(previous, commits, top));
    }
  });
});
