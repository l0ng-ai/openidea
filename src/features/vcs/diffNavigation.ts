import { Text } from "@codemirror/state";
import { call, commands } from "@/platform/ipc";
import { ideaChunks, type IgnorePolicy } from "./diffOptions";
import { chainNeighbour, loadSide, sideFile, type DiffData } from "./diffInput";

/** Find a textual change without opening binary, unreadable or unchanged siblings. */
export async function changedChainNeighbour(
  data: DiffData,
  dir: 1 | -1,
  ignore: IgnorePolicy,
): Promise<DiffData | null> {
  for (let next = chainNeighbour(data, dir); next; next = chainNeighbour(next, dir)) {
    try {
      const paths = [sideFile(next.left, next.path), sideFile(next.right, next.path)].filter((p): p is string => !!p);
      const probes = await Promise.all(paths.map((path) => call(commands.fsProbe(path))));
      if (probes.some((probe) => probe.binary || probe.tooLarge)) continue;
      const [a, b] = await Promise.all([loadSide(next.path, next.left), loadSide(next.path, next.right)]);
      if (a.includes("\0") || b.includes("\0")) continue;
      if (ideaChunks(Text.of(a.split(/\r\n?|\n/)), Text.of(b.split(/\r\n?|\n/)), ignore, "none").length) return next;
    } catch {
      // A stale chain can contain a file that was deleted or is no longer readable.
    }
  }
  return null;
}
