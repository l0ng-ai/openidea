/** Scroll-ratio sync for the three merge panes (pure). */

interface ScrollInfo {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/**
 * Where to scroll the other panes so they sit at the source pane's ratio.
 * Returns `null` for a source without a scroll range (document shorter than
 * the viewport): reading its ratio as 0 would yank every pane to the top
 * (issue #790). Panes without a scroll range target 0, which is a no-op.
 */
export function syncScrollTargets(source: ScrollInfo, others: readonly ScrollInfo[]): number[] | null {
  const range = source.scrollHeight - source.clientHeight;
  if (range <= 0) return null;
  const ratio = source.scrollTop / range;
  return others.map((o) => ratio * Math.max(0, o.scrollHeight - o.clientHeight));
}
