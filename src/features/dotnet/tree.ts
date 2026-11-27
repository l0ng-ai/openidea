/**
 * Discovered .NET solutions and projects (#5635) as Project view nodes: one
 * `Solution '<name>'` group per solution with a leaf per project, standalone
 * projects as roots of their own — above the project folder, like the module
 * groups of a build. The model comes from the one shared workspace scan
 * (`ensureDotnetModel`, the scan the NuGet window and context actions share);
 * roots re-register in place on change (as External Libraries does) and nothing
 * registers while the model is empty. The scan starts only when the file index
 * shows .NET files (a cheap index lookup, retried once indexing finishes), so a
 * workspace without .NET pays nothing on open. Discovery states (loading /
 * empty / failure) are the second slice of #5635.
 */
import type { DotnetWorkspace } from "@/platform/dotnet";
import { tx } from "@/platform/i18n";
import { call, commands, onIdeEvent } from "@/platform/ipc";
import { basename, useProject } from "@/platform/project";
import { registerProjectViewRoot, type ProjectViewRootContribution } from "@/workbench/contributions";
import { ensureDotnetModel, useDotnet } from "./store";
import { isDotnetProjectPath, isDotnetSolutionPath } from "./target";

const ICON = "project-dotnet";

const solutionId = (path: string) => `dotnetSolution:${path}`;
const projectId = (path: string) => `dotnetProject:${path}`;

/** The name a solution node shows: the file's name without its extension. */
const solutionName = (path: string) => {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
};

/** File-index queries for the candidate check: the solutions by extension, `proj` fuzzy-matches every project kind. */
const CANDIDATE_QUERIES = [".sln", ".slnx", "proj"];
const CANDIDATE_LIMIT = 10000;

/**
 * Whether the file index holds .NET files. The index's search is fuzzy (`proj`
 * matches `App.csproj`), so the hits are matched by extension exactly. Cheap:
 * index lookups, no tree walk — unlike `dotnetWorkspace`, which reads every
 * directory and evaluates every project with MSBuild.
 */
async function dotnetCandidates(): Promise<string[]> {
  const hits = await Promise.all(CANDIDATE_QUERIES.map((q) => call(commands.findFiles(q, CANDIDATE_LIMIT))));
  return [...new Set(hits.flat().map((hit) => hit.path))].filter(
    (path) => isDotnetSolutionPath(path) || isDotnetProjectPath(path),
  );
}

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
      label: tx`Solution '${solutionName(solution.path)}'`,
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
  // An empty index while it was still building: one retry when indexing finishes.
  let retryWhenIndexed = false;
  const clear = () => {
    const prev = disposals;
    disposals = [];
    shown = "";
    retryWhenIndexed = false;
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
  /**
   * Starts the one shared scan only when the file index shows .NET files — the
   * scan itself stays behind `ensureDotnetModel`, which the NuGet window and
   * the context actions share. Without candidates (and with indexing done) the
   * workspace has no .NET and pays nothing; the model still loads on demand.
   */
  const scanIfDotnet = async () => {
    // Armed first: an index pass that settles while this check runs asks again.
    retryWhenIndexed = true;
    try {
      const status = await call(commands.indexStatus());
      const dotnet = (await dotnetCandidates()).length > 0;
      // Settled before the lookup, so its answer is final. An empty index that isn't indexing
      // belongs to a project that just opened, before its first index pass started.
      if (dotnet || (!status.indexing && status.files > 0)) retryWhenIndexed = false;
      if (dotnet) void ensureDotnetModel();
    } catch {
      // No index to ask yet: the armed retry asks again once it settles.
    }
  };
  const subscriptions = [
    useDotnet.subscribe(sync),
    useProject.subscribe((s, prev) => {
      if (s.project?.root === prev.project?.root) return;
      // Another project's solutions must not show while this one is scanned.
      clear();
      if (s.project) void scanIfDotnet();
    }),
    // A fresh open raced the index: candidates may be there once indexing ends.
    onIdeEvent("indexState", (event) => {
      if (event.indexing || !retryWhenIndexed) return;
      retryWhenIndexed = false;
      void scanIfDotnet();
    }),
  ];
  if (useProject.getState().project) void scanIfDotnet();
  return () => {
    clear();
    subscriptions.forEach((d) => d());
  };
}
