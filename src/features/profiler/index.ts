/**
 * Run with Profiler (IDEA's "Profile" executor): samples a run with an external
 * profiler and shows the snapshot as a flame graph, call tree and method list.
 */
import { executeAction, registerActions } from "@/platform/actions";
import { useProject } from "@/platform/project";
import { registerRunExecutor, registerToolWindow } from "@/workbench/contributions";
import { profilerExecutor } from "./executor";
import { ProfilerTabs, ProfilerView } from "./ProfilerView";
import { resetProfiler } from "./store";

export function activate(): () => void {
  const disposers: Array<() => void> = [
    registerRunExecutor(profilerExecutor("cpu")),
    registerRunExecutor(profilerExecutor("allocations")),
    registerRunExecutor(profilerExecutor("liveObjects")),
    registerToolWindow({
      id: "profiler",
      title: "Profiler",
      icon: "toolwindow-profiler",
      anchor: "bottom",
      stripe: "onUse",
      order: 25,
      component: ProfilerView,
      headerContent: ProfilerTabs,
    }),
    registerActions([
      {
        id: "run.profile",
        title: "Profile",
        description: "Run the selected configuration under a sampling profiler",
        category: "Run",
        icon: "profile",
        when: "projectOpen",
        keywords: ["profiler", "flame graph", "cpu"],
        run: () => executeAction("run.withExecutor", { executor: "profiler" }).then(() => undefined),
      },
      {
        id: "run.profileAllocations",
        title: "Profile Allocations",
        description: "Run the selected configuration and record where it allocates memory",
        category: "Run",
        icon: "profile",
        when: "projectOpen",
        keywords: ["allocation", "memory", "async-profiler"],
        run: () => executeAction("run.withExecutor", { executor: "profilerAllocations" }).then(() => undefined),
      },
      {
        id: "run.profileLiveObjects",
        title: "Profile Live Objects",
        description:
          "Run the selected configuration and record where the objects still alive when it stops were allocated",
        category: "Run",
        icon: "profile",
        when: "projectOpen",
        keywords: ["allocation", "live objects", "memory leak"],
        run: () => executeAction("run.withExecutor", { executor: "profilerLiveObjects" }).then(() => undefined),
      },
      {
        id: "run.profileContext",
        title: "Profile Context Configuration",
        description: "Profile the program or test in the active file",
        category: "Run",
        icon: "profile",
        when: "projectOpen",
        keywords: ["profiler", "flame graph"],
        run: ({ arg }) =>
          executeAction("run.withExecutor", { executor: "profiler", context: arg ?? true }).then(() => undefined),
      },
    ]),
    useProject.subscribe((s, prev) => {
      if (s.project?.root !== prev.project?.root) resetProfiler();
    }),
  ];
  return () => {
    disposers.reverse().forEach((d) => d());
    resetProfiler();
  };
}
