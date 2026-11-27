import { choosePaths } from "@/platform/choosePath";
import { tx } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { notifications, toolWindowService } from "@/workbench/contributions";
import { addSnapshot } from "./store";

/** A directory of V8 `.cpuprofile` files recorded by another feature (the debugger, for a page). */
interface CpuProfiles {
  /** What was profiled: the snapshot's name. */
  name: string;
  dir: string;
  /** The project root, which tells the project's frames from library ones. */
  root: string;
  /** What recorded the profile, shown in the snapshot's header (default: `node --cpu-prof`). */
  profiler?: string;
}

function isCpuProfiles(arg: unknown): arg is CpuProfiles {
  const a = arg as Partial<CpuProfiles> | null | undefined;
  return (
    typeof a?.name === "string" &&
    typeof a.dir === "string" &&
    typeof a.root === "string" &&
    (a.profiler === undefined || typeof a.profiler === "string")
  );
}

/** Opens the recording as a snapshot in the Profiler tool window (`profiler.showCpuProfiles`). */
export async function showCpuProfiles(arg: unknown): Promise<void> {
  if (!isCpuProfiles(arg)) return;
  try {
    const profile = await call(commands.profilerCollect({ kind: "cpuProfiles", dir: arg.dir, root: arg.root }));
    addSnapshot(arg.name, arg.profiler ? { ...profile, profiler: arg.profiler } : profile);
  } catch (e) {
    notifications().notify({
      group: "run",
      level: "warning",
      title: "No CPU profile to show",
      body: e instanceof Error ? e.message : String(e),
    });
    return;
  }
  showProfiler();
}

function showProfiler() {
  try {
    toolWindowService().show("profiler", true);
  } catch {
    // No workbench (tests).
  }
}

// `.pstat` is what PyCharm saves; other names (`profile.out`) open through "All files".
const SNAPSHOT_EXTENSIONS = ["cpuprofile", "pstats", "pstat", "prof"];

/** A file the Profiler offers to open: a V8 `.cpuprofile` or a cProfile `.pstats` / `.pstat` / `.prof`. */
export const isSnapshotPath = (path: string) =>
  SNAPSHOT_EXTENSIONS.includes(path.split(".").pop()?.toLowerCase() ?? "");

/** The paths to open: the action's arg (a path or paths), else the ones picked in a file dialog. */
async function snapshotPaths(arg: unknown): Promise<string[]> {
  if (typeof arg === "string") return [arg];
  if (Array.isArray(arg)) return arg.filter((p): p is string => typeof p === "string");
  return choosePaths({
    directory: false,
    title: tx("Open Snapshot"),
    filters: [
      { name: tx("Profiler snapshots"), extensions: SNAPSHOT_EXTENSIONS },
      { name: tx("All files"), extensions: ["*"] },
    ],
  });
}

/** Opens snapshot files (`node --cpu-prof`, Chrome DevTools, cProfile), each as its own snapshot. */
export async function openSnapshotFiles(arg: unknown): Promise<void> {
  const root = useProject.getState().project?.root ?? null;
  let opened = false;
  for (const path of await snapshotPaths(arg)) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- one snapshot per file, in the order picked
      const profile = await call(commands.profilerCollect({ kind: "snapshotFile", path, root }));
      // A call-graph profile (cProfile) has exact edges but only an estimated call tree.
      const notice = profile.calls.length
        ? "cProfile records callers and callees, not whole stacks: the flame graph and call tree are estimated from them. The method list is exact."
        : null;
      addSnapshot(path.split(/[/\\]/).pop() ?? path, profile, notice, path);
      opened = true;
    } catch (e) {
      notifications().notify({
        group: "run",
        level: "error",
        title: "Cannot open the profiler snapshot",
        body: e instanceof Error ? e.message : String(e),
      });
    }
  }
  if (opened) showProfiler();
}
