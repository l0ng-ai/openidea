/** Module resolution for Commit tool window grouping (`Group By › Module`). */
import { useMemo } from "react";
import type { RootFolder } from "@/platform/languageSettings";
import { useProject } from "@/platform/project";
import { useBuildPresentation, useProjectPresentation, type BuildPresentation } from "@/platform/projectPresentation";
import { useDetectedRoots, useProjectRoots, type AttachedProject } from "@/platform/projectRoots";
import { baseName, stripSlash } from "./model";

export interface ChangeModule {
  /** Absolute path of the module root directory (no trailing slash). */
  path: string;
  /** Display name (Maven displayName/artifactId, Gradle name, sbt id, or folder basename). */
  name: string;
  /** Build tool when known. */
  tool?: "maven" | "gradle";
}

export interface ChangeModulesInput {
  projectRoot: string | null;
  projectName?: string;
  workspaceProjects?: readonly string[];
  detected?: readonly RootFolder[];
  attached?: readonly AttachedProject[];
  build?: BuildPresentation;
}

const EMPTY_ATTACHED: AttachedProject[] = [];

const isAbsolute = (path: string) => path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);

function absPath(base: string, dir: string): string {
  if (isAbsolute(dir)) return stripSlash(dir);
  const cleanBase = stripSlash(base);
  const cleanDir = stripSlash(dir);
  return !cleanDir ? cleanBase : cleanBase ? `${cleanBase}/${cleanDir}` : cleanDir;
}

function detectedModuleDir(detectedFrom: string): string {
  const clean = stripSlash(detectedFrom);
  const i = clean.lastIndexOf("/");
  return i < 0 ? "" : clean.slice(0, i);
}

/** Collects project/build modules with display names, sorted by path. */
export function resolveChangeModules({
  projectRoot,
  projectName,
  workspaceProjects,
  detected = [],
  attached = [],
  build,
}: ChangeModulesInput): ChangeModule[] {
  const byPath = new Map<string, ChangeModule>();
  const cleanProjectRoot = projectRoot ? stripSlash(projectRoot) : null;

  const add = (path: string, name?: string, tool?: "maven" | "gradle") => {
    const p = stripSlash(path);
    if (!p) return;
    const prev = byPath.get(p);
    const fallback = cleanProjectRoot && p === cleanProjectRoot && projectName ? projectName : baseName(p) || p;
    byPath.set(p, {
      path: p,
      name: name?.trim() || prev?.name || fallback,
      tool: tool ?? prev?.tool,
    });
  };

  if (cleanProjectRoot) {
    for (const r of detected) {
      if (!r.detectedFrom) continue;
      add(absPath(cleanProjectRoot, detectedModuleDir(r.detectedFrom)));
    }
  }
  for (const m of attached) {
    add(m.root);
    for (const r of m.detected) {
      if (!r.detectedFrom) continue;
      add(absPath(m.root, detectedModuleDir(r.detectedFrom)));
    }
  }
  for (const memberRoot of workspaceProjects ?? []) {
    add(memberRoot);
  }
  if (build) {
    for (const [dir, tool] of build.modules) {
      if (cleanProjectRoot || isAbsolute(dir)) {
        add(absPath(cleanProjectRoot ?? "", dir), build.moduleNames?.get(dir), tool);
      }
    }
    for (const [dir, name] of build.moduleNames ?? []) {
      if (!build.modules.has(dir) && (cleanProjectRoot || isAbsolute(dir))) {
        add(absPath(cleanProjectRoot ?? "", dir), name);
      }
    }
  }

  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/** Resolved modules for the open project (reactive). */
export function useChangeModules(): ChangeModule[] {
  const project = useProject((s) => s.project);
  const detected = useDetectedRoots();
  const projectRoot = project?.root ?? null;
  const attached = useProjectRoots((s) => (s.root === projectRoot ? s.attached : EMPTY_ATTACHED));
  const build = useProjectPresentation();
  return useMemo(
    () =>
      resolveChangeModules({
        projectRoot,
        projectName: project?.name,
        workspaceProjects: project?.workspace?.projects,
        detected,
        attached,
        build,
      }),
    [projectRoot, project?.name, project?.workspace?.projects, detected, attached, build],
  );
}

/** Non-reactive snapshot of resolved modules for action helpers. */
export function currentChangeModules(): ChangeModule[] {
  const project = useProject.getState().project;
  const projectRoot = project?.root ?? null;
  const rootsState = useProjectRoots.getState();
  const sameRoot = rootsState.root === projectRoot;
  return resolveChangeModules({
    projectRoot,
    projectName: project?.name,
    workspaceProjects: project?.workspace?.projects,
    detected: sameRoot ? rootsState.detected : [],
    attached: sameRoot ? rootsState.attached : [],
    build: useBuildPresentation.getState(),
  });
}
