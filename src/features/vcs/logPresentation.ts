import {
  collapseLinear,
  compactLanes,
  computeGraph,
  hideLongEdges,
  linearizeMerges,
  pruneFilteredEdges,
  straightenLaneChanges,
} from "./graph";
import { commitKey, graphCommit, type RepoCommit } from "./multiRoot";
import type { LogOptions } from "./logOptions";

/** The same displayed adjacency drives painting, navigation and fragment actions. */
export function presentLogGraph(
  all: readonly RepoCommit[],
  options: LogOptions,
  fragments: { expanded: ReadonlySet<string>; collapsed: ReadonlySet<string>; merges: ReadonlySet<string> },
  keep: ReadonlySet<string>,
) {
  const source = all.map(graphCommit);
  const collapsed =
    options.collapseLinear || fragments.collapsed.size
      ? collapseLinear(
          source,
          new Set([...keep, ...fragments.expanded]),
          options.collapseLinear ? undefined : fragments.collapsed,
        )
      : null;
  const expanded = fragments.merges.has("*")
    ? new Set(source.filter((c) => !fragments.merges.has(c.id)).map((c) => c.id))
    : fragments.merges;
  const linear = options.linearizeMerges ? linearizeMerges(collapsed?.graph ?? source, expanded) : null;
  const graph = pruneFilteredEdges(linear?.graph ?? collapsed?.graph ?? source);
  const byId = new Map(all.map((c) => [commitKey(c), c]));
  const commits = graph.map((c) => byId.get(c.id)!);
  const laid = computeGraph(graph).rows;
  const rows = straightenLaneChanges(compactLanes(options.longEdges ? laid : hideLongEdges(laid)));
  return { commits, graph, rows, linear, collapsed };
}
