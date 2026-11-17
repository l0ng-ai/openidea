import { call, commands } from "@/platform/ipc";
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
  try {
    toolWindowService().show("profiler", true);
  } catch {
    // No workbench (tests).
  }
}
