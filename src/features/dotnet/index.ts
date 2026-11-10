import { registerActions } from "@/platform/actions";
import { useProject } from "@/platform/project";
import { registerToolWindow, toolWindowService } from "@/workbench/contributions";
import { DotnetView } from "./DotnetView";
import {
  buildDotnet,
  cancelDotnet,
  changePackage,
  discoverTests,
  installTrx,
  listPackages,
  reloadDotnet,
  resetDotnet,
  runTests,
  searchPackages,
  selectDotnet,
} from "./store";

export function activate() {
  const offWindow = registerToolWindow({
    id: "dotnet",
    title: ".NET",
    icon: "file-csharp",
    anchor: "right",
    stripe: "onUse",
    component: DotnetView,
  });
  const show = () => toolWindowService().show("dotnet", true);
  const offActions = registerActions([
    {
      id: "dotnet.show",
      title: ".NET Workspace",
      category: "Build",
      when: "projectOpen",
      run: () => {
        show();
        return reloadDotnet();
      },
    },
    {
      id: "dotnet.reload",
      title: "Reload .NET Workspace",
      category: "Build",
      when: "projectOpen",
      run: () => reloadDotnet(),
    },
    { id: "dotnet.cancel", title: "Cancel .NET Operation", category: "Build", run: () => cancelDotnet() },
    {
      id: "dotnet.select",
      title: "Select .NET Project",
      category: "Build",
      hidden: true,
      run: ({ arg }) => {
        const a = arg as { path: string; configuration?: string; framework?: string };
        return selectDotnet(a.path, a.configuration, a.framework);
      },
    },
    ...(["build", "restore", "clean"] as const).map((op) => ({
      id: `dotnet.${op}`,
      title: op === "build" ? "Build .NET Project" : op === "restore" ? "Restore .NET Project" : "Clean .NET Project",
      category: "Build",
      when: "projectOpen",
      run: () => buildDotnet(op),
    })),
    {
      id: "dotnet.packages",
      title: "Refresh NuGet Packages",
      category: "Build",
      when: "projectOpen",
      run: () => listPackages(),
    },
    {
      id: "dotnet.search",
      title: "Search NuGet Packages",
      category: "Build",
      hidden: true,
      run: ({ arg }) => {
        const a = arg as { query: string; exact?: boolean };
        return searchPackages(a.query, a.exact);
      },
    },
    {
      id: "dotnet.packageChange",
      title: "Change NuGet Package",
      category: "Build",
      hidden: true,
      run: ({ arg }) => {
        const a = arg as { id: string; version: string | null };
        return changePackage(a.id, a.version);
      },
    },
    {
      id: "dotnet.discover",
      title: "Discover .NET Tests",
      category: "Run",
      when: "projectOpen",
      run: () => discoverTests(),
    },
    {
      id: "dotnet.test",
      title: "Run .NET Tests",
      category: "Run",
      when: "projectOpen",
      run: async ({ arg }) => {
        await runTests(typeof arg === "string" ? arg : undefined);
      },
    },
    {
      id: "dotnet.installTrx",
      title: "Install TRX reporting",
      category: "Build",
      when: "projectOpen",
      run: () => installTrx(),
    },
  ]);
  const offProject = useProject.subscribe((s, old) => {
    if (s.project?.root !== old.project?.root) resetDotnet();
  });
  return () => {
    resetDotnet();
    offProject();
    offActions();
    offWindow();
  };
}
