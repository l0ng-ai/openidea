import { registerActions } from "@/platform/actions";
import { useProject } from "@/platform/project";
import { lazyComponent } from "@/ui";
import { registerMenuGroup, registerToolWindow, toolWindowService } from "@/workbench/contributions";
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
import { isDotnetProjectPath, isDotnetSolutionPath } from "./target";
import { activateTree } from "./tree";

const NUGET = "nuget";

export function activate() {
  const disposers = [
    registerToolWindow({
      id: NUGET,
      title: "NuGet Packages",
      icon: "library",
      anchor: "bottom",
      // Listed under the stripe's "…" until first opened: most projects are not .NET ones.
      stripe: "onUse",
      order: 29,
      component: lazyComponent(() => import("./NugetView").then((m) => m.NugetView)),
    }),
    registerActions([
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
        run: ({ arg }: { arg?: unknown }) => buildDotnet(op, arg),
      })),
      {
        id: "dotnet.packages",
        title: "Refresh NuGet Packages",
        category: "Build",
        when: "projectOpen",
        run: () => {
          toolWindowService().show(NUGET, true);
          return listPackages();
        },
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
    ]),
    useProject.subscribe((s, old) => {
      if (s.project?.root !== old.project?.root) resetDotnet();
    }),
    // #5635: build / restore / clean act on the right-clicked solution or project.
    registerMenuGroup({
      id: "dotnet.project",
      menus: ["projectView"],
      order: 45,
      items: (_menu, { paths, dirs }) => {
        const path = paths.length === 1 && !dirs?.[0] ? paths[0]! : null;
        if (!path || !(isDotnetProjectPath(path) || isDotnetSolutionPath(path))) return [];
        return [
          { kind: "action", action: "dotnet.build", arg: path },
          { kind: "action", action: "dotnet.restore", arg: path },
          { kind: "action", action: "dotnet.clean", arg: path },
        ];
      },
    }),
    // #5635: discovered solutions and projects as Project view nodes.
    activateTree(),
  ];
  return () => {
    resetDotnet();
    disposers.reverse().forEach((d) => d());
  };
}
