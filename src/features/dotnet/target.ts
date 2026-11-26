/**
 * Which .NET project or solution the current context means (#5635): the Project
 * tool window's selected `.csproj` / `.fsproj` / `.sln`, else the project of the
 * active editor's file, else the solution. The Project view context menu passes
 * its file explicitly; build, restore, clean and test resolve what is left.
 */
import { dirname } from "@/platform/project";

export interface DotnetTargetContext {
  /** Paths selected in the Project tool window, lead first. */
  selected: string[];
  /** The active editor's file, when one is open. */
  editorFile: string | null;
  /** The discovered .NET workspace; only the paths matter here. */
  model: {
    projects: Array<{ path: string }>;
    solutions: Array<{ path: string }>;
  };
}

export const isDotnetSolutionPath = (path: string) => /\.slnx?$/i.test(path);
export const isDotnetProjectPath = (path: string) => /\.(?:cs|fs|vb)proj$/i.test(path);

/** The project of `file`: the deepest enclosing project directory, if any. */
function projectOf(file: string, projects: DotnetTargetContext["model"]["projects"]) {
  const around = projects
    .filter((p) => file.startsWith(`${dirname(p.path)}/`))
    .sort((a, b) => dirname(b.path).length - dirname(a.path).length);
  return around[0]?.path ?? null;
}

export function contextDotnetTarget(ctx: DotnetTargetContext): string | null {
  const picked = ctx.selected.find((p) => isDotnetProjectPath(p) || isDotnetSolutionPath(p));
  if (picked) return picked;
  if (ctx.editorFile) {
    const project = projectOf(ctx.editorFile, ctx.model.projects);
    if (project) return project;
  }
  return ctx.model.solutions[0]?.path ?? null;
}
