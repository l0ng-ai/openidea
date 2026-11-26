/**
 * Discovered .NET solutions and projects (#5635) as Project view nodes: one
 * `Solution '<name>'` group per solution with a leaf per project, standalone
 * projects as roots of their own — above the project folder, like the module
 * groups of a build. The model comes from the one shared workspace scan
 * (`ensureDotnetModel`, the scan the NuGet window and context actions share);
 * roots re-register in place on change (as External Libraries does) and nothing
 * registers while the model is empty. Discovery states (loading / empty /
 * failure) are the second slice of #5635.
 */
import type { DotnetWorkspace } from "@/platform/dotnet";
import { basename, useProject } from "@/platform/project";
import { registerProjectViewRoot, type ProjectViewRootContribution } from "@/workbench/contributions";
import { ensureDotnetModel, useDotnet } from "./store";

const ICON = "project-dotnet";

const solutionId = (path: string) => `dotnetSolution:${path}`;
const projectId = (path: string) => `dotnetProject:${path}`;

/** The name a solution node shows: the file's name without its extension. */
const solutionName = (path: string) => {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
};

/** One group per solution (a leaf per project), standalone projects as roots of their own. */
export function treeRoots(model: DotnetWorkspace): ProjectViewRootContribution[] {
  if (!model.projects.length && !model.solutions.length) return [];
  const projectName = (path: string) => model.projects.find((p) => p.path === path)?.name ?? solutionName(path);
  const leaf = (path: string) => ({ label: projectName(path), icon: ICON, path, file: true });
  const grouped = new Set(model.solutions.flatMap((s) => s.projects));
  const roots: ProjectViewRootContribution[] = [];
  for (const solution of model.solutions) {
    if (!solution.projects.length) continue;
    roots.push({
      id: solutionId(solution.path),
      label: `Solution '${solutionName(solution.path)}'`,
      icon: ICON,
      beforeProject: true,
      children: solution.projects.map(leaf),
    });
  }
  for (const project of model.projects)
    if (!grouped.has(project.path))
      roots.push({
        id: projectId(project.path),
        label: project.name,
        icon: ICON,
        beforeProject: true,
        path: project.path,
        file: true,
      });
  return roots.map((root, i) => ({ ...root, order: -200 + i }));
}

/** Keeps the Project view roots in step with the discovered workspace model. */
export function activateTree(): () => void {
  let disposals: (() => void)[] = [];
  let shown = "";
  const clear = () => {
    const prev = disposals;
    disposals = [];
    shown = "";
    prev.reverse().forEach((d) => d());
  };
  const sync = () => {
    const roots = treeRoots(useDotnet.getState().model);
    const key = JSON.stringify(roots);
    if (key === shown) return;
    shown = key;
    // The new roots register before the old ones dispose: removing them first
    // would drop the nodes from the tree until the new ones render (and collapse).
    const prev = disposals;
    disposals = roots.map((root) => registerProjectViewRoot(root));
    prev.reverse().forEach((d) => d());
  };
  const subscriptions = [
    useDotnet.subscribe(sync),
    useProject.subscribe((s, prev) => {
      if (s.project?.root === prev.project?.root) return;
      // Another project's solutions must not show while this one is scanned.
      clear();
      if (s.project) void ensureDotnetModel();
    }),
  ];
  if (useProject.getState().project) void ensureDotnetModel();
  return () => {
    clear();
    subscriptions.forEach((d) => d());
  };
}
