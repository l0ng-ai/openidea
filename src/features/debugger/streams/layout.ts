/** Columns and links of a stream trace, from the host's `records` and `links`. No React, no IPC. */
import type { JvmValue, Link, TraceRecordView } from "@/platform/ipc";
import { tx as catalogTx } from "@/platform/i18n";

/** A component passes its `useTx()`, so the "Source" title follows the locale. */
type Tx = typeof catalogTx;

export type Column = { step: number; title: string; items: { index: number; value: JvmValue }[] };

/** `from` and `to` are record indexes: `from` is the element of the step before that `to` came from. */
export type Edge = { from: number; to: number; ambiguous: boolean };

/** One column per recorded step, values in recording order. `steps[0]` is empty for a stream held in a local. */
export function buildColumns(steps: string[], records: TraceRecordView[], tx: Tx = catalogTx): Column[] {
  const count = records.reduce((n, r) => Math.max(n, r.step + 1), steps.length);
  const columns: Column[] = Array.from({ length: count }, (_, step) => ({
    step,
    title: steps[step] || (step === 0 ? tx("Source") : ""),
    items: [],
  }));
  records.forEach((r, index) => columns[r.step]!.items.push({ index, value: r.value }));
  return columns;
}

export function buildEdges(links: Link[]): Edge[] {
  const edges: Edge[] = [];
  links.forEach((l, to) => {
    if (l.parent != null) edges.push({ from: l.parent, to, ambiguous: l.ambiguous });
  });
  return edges;
}

/**
 * `index`, what it came from and what it became. Each way is walked on its own, so the other
 * elements a `flatMap` made from the same source stay out.
 */
export function relatedTo(index: number, edges: Edge[]): Set<number> {
  const parents = new Map<number, number[]>();
  const children = new Map<number, number[]>();
  for (const e of edges) {
    (parents.get(e.to) ?? parents.set(e.to, []).get(e.to)!).push(e.from);
    (children.get(e.from) ?? children.set(e.from, []).get(e.from)!).push(e.to);
  }
  const out = new Set([index]);
  for (const next of [parents, children]) {
    const queue = [index];
    for (let at = 0; at < queue.length; at++)
      for (const j of next.get(queue[at]!) ?? [])
        if (!out.has(j)) {
          out.add(j);
          queue.push(j);
        }
  }
  return out;
}
