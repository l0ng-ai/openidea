import { Text } from "@codemirror/state";
import { call, commands } from "@/platform/ipc";
import { ideaChunks, type IgnorePolicy } from "./diffOptions";
import { chainNeighbour, loadSide, sideFile, type DiffData } from "./diffInput";
import { gitlinkDiffSides } from "./gitDiffEntries";
import { imageDiffKind } from "./imageDiffInput";

/** Find the next image or textual change in the chain. */
export async function changedChainNeighbour(
  data: DiffData,
  dir: 1 | -1,
  ignore: IgnorePolicy,
): Promise<DiffData | null> {
  for (let next = chainNeighbour(data, dir); next; next = chainNeighbour(next, dir)) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- walk the chain one neighbour at a time; an unusable link is skipped, a textual change returns
      const [left, right] = await gitlinkDiffSides(next);
      if (imageDiffKind({ ...next, left, right })) return next;
      const paths = [sideFile(left, next.path), sideFile(right, next.path)].filter((p): p is string => !!p);
      // oxlint-disable-next-line no-await-in-loop -- probes for this neighbour must finish before deciding to skip it
      const probes = await Promise.all(paths.map((path) => call(commands.fsProbe(path))));
      if (probes.some((probe) => probe.binary || probe.tooLarge)) continue;
      // oxlint-disable-next-line no-await-in-loop -- both sides must load before the text-change check can return this neighbour
      const [a, b] = await Promise.all([loadSide(next.path, left), loadSide(next.path, right)]);
      if (a.includes("\0") || b.includes("\0")) continue;
      if (ideaChunks(Text.of(a.split(/\r\n?|\n/)), Text.of(b.split(/\r\n?|\n/)), ignore, "none").length) return next;
    } catch {
      // A stale chain can contain a file that was deleted or is no longer readable.
    }
  }
  return null;
}
