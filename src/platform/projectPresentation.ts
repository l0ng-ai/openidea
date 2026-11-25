/** Read-only build context shared by file and folder presentation consumers. */
import { useEffect } from "react";
import { create } from "zustand";
import { call, commands, isTauri, onIdeEvent, type BuildModel } from "./ipc";
import { useProject } from "./project";

export interface BuildPresentation {
  modules: ReadonlyMap<string, "maven" | "gradle">;
  /** Module dir key (same key space as `modules`, plus sbt) → display name. */
  moduleNames?: ReadonlyMap<string, string>;
  spring: boolean;
}
const EMPTY: BuildPresentation = { modules: new Map(), moduleNames: new Map(), spring: false };
export const useBuildPresentation = create<BuildPresentation>(() => EMPTY);

export function buildPresentation(model: BuildModel): BuildPresentation {
  const modules = new Map<string, "maven" | "gradle">();
  const moduleNames = new Map<string, string>();
  for (const p of model.maven?.projects ?? []) {
    modules.set(p.dir, "maven");
    const name = p.displayName?.trim() || p.artifactId?.trim();
    if (name) moduleNames.set(p.dir, name);
  }
  for (const p of (model.gradle ?? []).flatMap((g) => g.projects)) {
    modules.set(p.dir, "gradle");
    const name = p.name?.trim();
    if (name) moduleNames.set(p.dir, name);
  }
  for (const b of model.sbt ?? []) {
    for (const p of b.projects) {
      const dir = !b.dir ? p.dir : !p.dir ? b.dir : `${b.dir.replace(/\/+$/, "")}/${p.dir}`;
      const name = p.id?.trim();
      if (name && !moduleNames.has(dir)) moduleNames.set(dir, name);
    }
  }
  const spring =
    (model.maven?.projects ?? []).some(
      (p) =>
        p.dependencies.some((d) => d.groupId.startsWith("org.springframework")) ||
        p.plugins.some((p) => p.groupId.startsWith("org.springframework")),
    ) || (model.gradle ?? []).some((g) => g.projects.some((p) => p.tasks.some((t) => t.name === "bootRun")));
  return { modules, moduleNames, spring };
}

/** A Maven / Gradle module folder below the project root: IDEA shows its name in bold. */
export function isModuleFolder(rel: string, root: boolean, modules: BuildPresentation["modules"]): boolean {
  return !root && rel !== "" && modules.has(rel);
}

export function moduleFolderIcon(rel: string, root: boolean, modules: BuildPresentation["modules"]): string | null {
  const tool = modules.get(rel);
  return tool ? `${tool}-${root ? "project" : "module"}` : null;
}

let users = 0;
let generation = 0;
let dispose: (() => void) | undefined;
async function load() {
  const gen = ++generation;
  if (!useProject.getState().project || !isTauri()) {
    useBuildPresentation.setState(EMPTY);
    return;
  }
  try {
    const model = await call(commands.buildModel());
    if (generation === gen) useBuildPresentation.setState(buildPresentation(model));
  } catch {
    /* Presentation keeps its filename fallback. */
  }
}

export function useProjectPresentation(): BuildPresentation {
  useEffect(() => {
    if (users++ === 0) {
      void load();
      const project = useProject.subscribe((s, prev) => {
        if (s.project === prev.project) return;
        useBuildPresentation.setState(EMPTY);
        void load();
      });
      const roots = onIdeEvent("projectRootsChanged", () => void load());
      let timer: ReturnType<typeof setTimeout> | undefined;
      const files = onIdeEvent("fsChanged", (e) => {
        if (
          ![...e.created, ...e.modified, ...e.removed].some((p) =>
            /(?:^|\/)(pom\.xml|(?:build|settings)\.gradle(?:\.kts)?)$/.test(p),
          )
        )
          return;
        clearTimeout(timer);
        timer = setTimeout(() => void load(), 100);
      });
      dispose = () => {
        project();
        roots();
        files();
        clearTimeout(timer);
        generation++;
      };
    }
    return () => {
      if (--users === 0) dispose?.();
    };
  }, []);
  return useBuildPresentation();
}
