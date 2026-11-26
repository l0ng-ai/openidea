/**
 * Run with Profiler (IDEA's "Profile" executor): samples a run with an external
 * profiler and shows the snapshot as a flame graph, call tree and method list.
 */
import { executeAction, registerActions } from "@/platform/actions";
import { useProject } from "@/platform/project";
import {
  registerEditorBanner,
  registerMenuGroup,
  registerRunExecutor,
  registerToolWindow,
  type EditorBanner,
} from "@/workbench/contributions";
import { isCpuProfilePath, openCpuProfileFiles, showCpuProfiles } from "./cpuProfiles";
import { profilerExecutor } from "./executor";
import { ProfilerHeaderActions, ProfilerTabs, ProfilerView } from "./ProfilerView";
import { resetProfiler } from "./store";

function useCpuProfileBanner(path: string): EditorBanner | null {
  if (!isCpuProfilePath(path)) return null;
  return {
    text: "This file is a V8 CPU profile",
    icon: "profile",
    actions: [{ label: "Open in Profiler", run: () => void openCpuProfileFiles(path) }],
  };
}

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
      headerActions: ProfilerHeaderActions,
    }),
    registerEditorBanner({ id: "profiler.cpuProfile", order: 30, useBanner: useCpuProfileBanner }),
    registerMenuGroup({
      id: "profiler.openInProfiler",
      menus: ["projectView", "editor", "editorTab"],
      order: 45,
      items: (_menu, { paths, dirs }) =>
        paths.length && paths.every((p, i) => !dirs?.[i] && isCpuProfilePath(p))
          ? [{ kind: "action", action: "profiler.openInProfiler", arg: paths }]
          : [],
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
        id: "profiler.showCpuProfiles",
        title: "Show CPU Profile",
        description:
          "Opens the V8 .cpuprofile files of a directory as a snapshot (arg: { name, dir, root, profiler? }).",
        category: "Run",
        icon: "profile",
        hidden: true,
        run: ({ arg }) => showCpuProfiles(arg),
      },
      {
        id: "profiler.openSnapshot",
        title: "Open Snapshot…",
        description: "Open V8 .cpuprofile files saved by node --cpu-prof or Chrome DevTools in the Profiler",
        category: "Profiler",
        icon: "profile",
        when: "projectOpen",
        keywords: ["cpuprofile", "profiler", "snapshot", "flame graph"],
        run: () => openCpuProfileFiles(undefined),
      },
      {
        id: "profiler.openInProfiler",
        title: "Open in Profiler",
        description: "Open the selected .cpuprofile files as Profiler snapshots",
        category: "Profiler",
        icon: "profile",
        hidden: true,
        when: "projectOpen",
        run: ({ arg }) => (arg === undefined ? undefined : openCpuProfileFiles(arg)),
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
