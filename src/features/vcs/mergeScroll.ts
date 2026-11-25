/**
 * Synchronized scrolling of the merge editor's three panes. Each side pane lines up with
 * the result through the changes between them (the diff viewer's SyncScrollSupport
 * mapping), and one side follows the other through the result. Horizontally they all keep
 * the same offset.
 */
import { Chunk } from "@codemirror/merge";
import type { Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { bandAt, docOffset, extent, transferY } from "./diffScroll";
import { ideaDiffConfig } from "./diffOptions";

export type MergePane = "ours" | "result" | "theirs";
const PANES: readonly MergePane[] = ["ours", "result", "theirs"];

/**
 * Scroll positions a pane was moved to by another one. A pane's scroll event arrives a
 * frame after the move, so it must be recognized as that move's echo: following it would
 * write back to the pane the user is scrolling and cancel the scroll in progress.
 */
export class ScrollEchoes<K> {
  private readonly moved = new Map<K, number>();

  /** `pane` was moved to `top`. */
  mark(pane: K, top: number) {
    this.moved.set(pane, top);
  }

  /** Whether a scroll event of `pane` at `top` is the echo of the last move (consumed either way). */
  take(pane: K, top: number): boolean {
    const moved = this.moved.get(pane);
    this.moved.delete(pane);
    return moved !== undefined && Math.abs(top - moved) <= 1;
  }
}

// Lined up by IDEA's line comparison. `Chunk.build` with no config runs an unbounded
// character diff, which takes minutes on a long file such as a lockfile.
const LINES = ideaDiffConfig("none", "lines");

/** Starts scrolling `views` together; returns the function that stops it. */
export function syncMergeScroll(views: Record<MergePane, EditorView>): () => void {
  const built = new Map<MergePane, { a: Text; b: Text; chunks: readonly Chunk[] }>();
  const chunks = (side: MergePane) => {
    const a = views[side].state.doc;
    const b = views.result.state.doc;
    const hit = built.get(side);
    if (hit && hit.a === a && hit.b === b) return hit.chunks;
    const fresh = Chunk.build(a, b, LINES);
    built.set(side, { a, b, chunks: fresh });
    return fresh;
  };
  /** Document y of `side` → the result (`toResult`), or back. */
  const transfer = (side: MergePane, y: number, toResult: boolean) => {
    const a = views[side];
    const b = views.result;
    const from = toResult ? "a" : "b";
    const band = bandAt(
      chunks(side),
      (c) => extent(a, c.fromA, c.toA),
      (c) => extent(b, c.fromB, c.toB),
      a.lineBlockAt(a.state.doc.length).bottom,
      b.lineBlockAt(b.state.doc.length).bottom,
      y,
      from,
    );
    return transferY([band], y, from);
  };
  const map = (from: MergePane, to: MergePane, y: number) => {
    if (to === "result") return transfer(from, y, true);
    if (from === "result") return transfer(to, y, false);
    return transfer(to, transfer(from, y, true), false);
  };

  const echoes = new ScrollEchoes<MergePane>();
  /** Scrolls the other panes to match `from`, anchored a third down the pane. */
  const follow = (from: MergePane) => {
    const master = views[from];
    const anchor = master.scrollDOM.clientHeight / 3;
    const at = master.scrollDOM.scrollTop + anchor - docOffset(master);
    for (const to of PANES) {
      if (to === from) continue;
      const el = views[to].scrollDOM;
      const top = Math.max(
        0,
        Math.min(map(from, to, at) + docOffset(views[to]) - anchor, el.scrollHeight - el.clientHeight),
      );
      if (Math.abs(el.scrollTop - top) < 1) continue;
      const before = el.scrollTop;
      el.scrollTop = top;
      if (el.scrollTop !== before) echoes.mark(to, el.scrollTop);
    }
  };

  const lefts = new ScrollEchoes<MergePane>();
  /** Gives the other panes `from`'s horizontal offset. */
  const followLeft = (from: MergePane) => {
    const left = views[from].scrollDOM.scrollLeft;
    for (const to of PANES) {
      if (to === from) continue;
      const el = views[to].scrollDOM;
      if (Math.abs(el.scrollLeft - left) < 1) continue;
      const before = el.scrollLeft;
      el.scrollLeft = left;
      if (el.scrollLeft !== before) lefts.mark(to, el.scrollLeft);
    }
  };

  const offs = PANES.map((pane) => {
    const el = views[pane].scrollDOM;
    // A scroll event doesn't say which way it went: compare with the last one.
    let last = { top: el.scrollTop, left: el.scrollLeft };
    const onScroll = () => {
      const { scrollTop: top, scrollLeft: left } = el;
      const moved = { top: top !== last.top, left: left !== last.left };
      last = { top, left };
      if (moved.left && !lefts.take(pane, left)) followLeft(pane);
      if (moved.top && !echoes.take(pane, top)) follow(pane);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  });
  return () => offs.forEach((off) => off());
}
