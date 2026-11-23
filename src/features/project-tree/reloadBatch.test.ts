import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FileEntry } from "@/bindings";
import { setProjectFsForTests, type ProjectFs } from "./fs";
import { applyFsChange, initProjectTree, loadDir, selectModel, setSelection, useProjectTree } from "./store";

const ROOT = "/p";
const FILES = 3;
const FANOUT = 4;

const dirPath = (k: number) => `${ROOT}/${k}`;
const filePath = (k: number) => `${dirPath(k)}/f.txt`;

/** A tree of `count` folders (heap-numbered, `FANOUT` per folder) below the root; `f.txt` of each folder has a version. */
class TreeFs {
  readonly versions = new Map<number, number>();
  readonly removed = new Set<number>();
  readonly failing = new Set<string>();
  readonly gates = new Map<string, Promise<void>>();
  readonly reads: string[] = [];
  running = 0;
  peak = 0;

  constructor(readonly count: number) {}

  list(path: string): FileEntry[] {
    const entry = (p: string, kind: FileEntry["kind"], mtimeMs: number): FileEntry => ({
      name: p.slice(p.lastIndexOf("/") + 1),
      path: p,
      kind,
      size: 1,
      mtimeMs,
      ignored: false,
      excluded: false,
      hidden: false,
    });
    if (path === ROOT) return [entry(dirPath(0), "dir", 0)];
    const k = Number(path.slice(ROOT.length + 1));
    const out: FileEntry[] = [];
    for (let c = FANOUT * k + 1; c <= FANOUT * k + FANOUT && c < this.count; c++)
      if (!this.removed.has(c)) out.push(entry(dirPath(c), "dir", 0));
    out.push(filePath(k).length ? entry(filePath(k), "file", this.versions.get(k) ?? 0) : out[0]!);
    for (let i = 1; i < FILES; i++) out.push(entry(`${dirPath(k)}/g${i}.txt`, "file", 0));
    return out;
  }

  async readDir(path: string): Promise<FileEntry[]> {
    this.reads.push(path);
    this.running++;
    this.peak = Math.max(this.peak, this.running);
    const snapshot = this.list(path);
    try {
      await (this.gates.get(path) ?? new Promise<void>((r) => setTimeout(r, 0)));
      if (this.failing.has(path)) throw new Error("EIO");
      return snapshot;
    } finally {
      this.running--;
    }
  }

  asProjectFs = () => ({ readDir: (p: string) => this.readDir(p) }) as ProjectFs;
}

/** Starts a project with every folder loaded, as after the user expanded the whole tree. */
function loadedTree(fs: TreeFs) {
  setProjectFsForTests(fs.asProjectFs(), ROOT);
  initProjectTree(ROOT, "proj");
  const listings = new Map<string, readonly FileEntry[]>([[ROOT, fs.list(ROOT)]]);
  for (let k = 0; k < fs.count; k++) listings.set(dirPath(k), fs.list(dirPath(k)));
  useProjectTree.setState({ listings });
  fs.reads.length = 0;
  fs.peak = 0;
}

const modify = (fs: TreeFs, ks: number[]) => {
  for (const k of ks) fs.versions.set(k, (fs.versions.get(k) ?? 0) + 1);
  return { created: [], modified: ks.map(filePath), removed: [] };
};

/** What a mounted ProjectView does: select the model on every store notification. */
function watchModels() {
  let last = selectModel(useProjectTree.getState());
  let builds = 0;
  const unsubscribe = useProjectTree.subscribe((s) => {
    const model = selectModel(s);
    if (model !== last) {
      last = model;
      builds++;
    }
  });
  return { builds: () => builds, unsubscribe };
}

const range = (n: number) => Array.from({ length: n }, (_, i) => i);
const listingsOf = () => useProjectTree.getState().listings;

beforeEach(() => localStorage.clear());

afterEach(() => {
  setProjectFsForTests(null);
  initProjectTree(null);
});

describe("applyFsChange reload of many folders", () => {
  it("builds the model once and caps the concurrent reads, however many folders changed", async () => {
    const fs = new TreeFs(300);
    loadedTree(fs);
    const view = watchModels();

    await applyFsChange(modify(fs, range(300)));
    view.unsubscribe();

    expect(fs.reads).toHaveLength(300);
    expect(view.builds()).toBeLessThanOrEqual(2);
    expect(fs.peak).toBeGreaterThan(1);
    expect(fs.peak).toBeLessThanOrEqual(16);
    expect(
      listingsOf()
        .get(dirPath(299))
        ?.find((e) => e.name === "f.txt")?.mtimeMs,
    ).toBe(1);
  });

  it("leaves folders without changes untouched and does not notify when nothing differs", async () => {
    const fs = new TreeFs(20);
    loadedTree(fs);
    const before = listingsOf();
    const view = watchModels();
    let notified = 0;
    const unsubscribe = useProjectTree.subscribe(() => notified++);

    await applyFsChange({ created: [], modified: [filePath(3), filePath(4)], removed: [] });
    expect(listingsOf()).toBe(before);
    expect(notified).toBe(0);

    await applyFsChange(modify(fs, [3]));
    unsubscribe();
    view.unsubscribe();
    expect(listingsOf().get(dirPath(3))).not.toBe(before.get(dirPath(3)));
    for (const k of [0, 1, 2, 4, 5]) expect(listingsOf().get(dirPath(k))).toBe(before.get(dirPath(k)));
  });

  it("keeps the old listing of a folder whose read fails", async () => {
    const fs = new TreeFs(10);
    loadedTree(fs);
    const before = listingsOf();
    fs.failing.add(dirPath(2));

    await applyFsChange(modify(fs, [1, 2, 3]));

    expect(listingsOf().get(dirPath(2))).toBe(before.get(dirPath(2)));
    expect(
      listingsOf()
        .get(dirPath(1))
        ?.find((e) => e.name === "f.txt")?.mtimeMs,
    ).toBe(1);
    expect(
      listingsOf()
        .get(dirPath(3))
        ?.find((e) => e.name === "f.txt")?.mtimeMs,
    ).toBe(1);
  });

  it("drops a folder that vanished while the batch was reading and does not bring it back", async () => {
    const fs = new TreeFs(10);
    loadedTree(fs);

    const first = applyFsChange(modify(fs, [1, 2, 3]));
    fs.removed.add(3);
    await applyFsChange({ created: [], modified: [], removed: [dirPath(3)] });
    await first;

    expect(listingsOf().has(dirPath(3))).toBe(false);
    expect(listingsOf().has(dirPath(2))).toBe(true);
  });

  it("keeps a listing that a later event read while an earlier batch was still waiting for a slow folder", async () => {
    const fs = new TreeFs(10);
    loadedTree(fs);
    let release!: () => void;
    fs.gates.set(dirPath(9), new Promise<void>((r) => (release = r)));

    const first = applyFsChange(modify(fs, [1, 9]));
    await new Promise((r) => setTimeout(r, 5));
    await applyFsChange(modify(fs, [1]));
    release();
    await first;

    expect(
      listingsOf()
        .get(dirPath(1))
        ?.find((e) => e.name === "f.txt")?.mtimeMs,
    ).toBe(2);
    expect(
      listingsOf()
        .get(dirPath(9))
        ?.find((e) => e.name === "f.txt")?.mtimeMs,
    ).toBe(1);
  });

  it("ends with the listings and selection that reloading each folder on its own gives", async () => {
    const changed = [1, 2, 5, 7];
    const run = async (reload: (fs: TreeFs) => Promise<void>) => {
      const fs = new TreeFs(12);
      loadedTree(fs);
      useProjectTree.setState({ expanded: new Set([ROOT, dirPath(0), dirPath(1)]) });
      setSelection(new Set([filePath(1), dirPath(2)]), filePath(1));
      const before = listingsOf();
      modify(fs, changed);
      await reload(fs);
      const s = useProjectTree.getState();
      return { before, listings: s.listings, expanded: s.expanded, selected: s.selected, lead: s.lead };
    };

    const batched = await run((fs) =>
      applyFsChange({ created: [], modified: changed.map(filePath), removed: [] }).then(() => void fs),
    );
    const single = await run(async () => {
      for (const k of changed) await loadDir(dirPath(k), true);
    });

    expect(batched.listings).toEqual(single.listings);
    expect(batched.expanded).toEqual(single.expanded);
    expect([...batched.selected].sort()).toEqual([...single.selected].sort());
    expect(batched.lead).toBe(single.lead);
    for (const [path, listing] of batched.listings) {
      for (const [i, e] of listing.entries()) {
        const old = batched.before.get(path)?.find((o) => o.path === e.path);
        if (old && old.mtimeMs === e.mtimeMs && old.kind === e.kind && batched.before.get(path)?.[i] === old)
          expect(e).toBe(old);
      }
    }
    expect([...batched.selected].sort()).toEqual([filePath(1), dirPath(2)]);
  });
});
