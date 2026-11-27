/**
 * Where a run's JVM stack frames can come from: the module a run configuration belongs to and
 * the modules it depends on. A multi-module build compiles the same package and class name in
 * several modules, so a frame's file name alone doesn't say which copy ran — only the run's
 * classpath does.
 */
import type { BuildModel, MavenModel, MavenProject } from "@/platform/ipc";

/** Folders `dir` of the model's projects, as the IDE reports paths: absolute, `/`-separated. */
function absolute(root: string, dir: string): string {
  const base = root.replace(/\/+$/, "");
  const rest = dir.replace(/^\/+/, "").replace(/\/+$/, "");
  return rest ? `${base}/${rest}` : base;
}

/** The project a run configuration's module refers to (`""` = the project root). */
function projectOf(projects: MavenProject[], root: string, module: string): MavenProject | undefined {
  const wanted = module.startsWith("/") ? module.replace(/\/+$/, "") : absolute(root, module);
  return projects.find((p) => absolute(root, p.dir) === wanted);
}

/**
 * Folders (absolute) of the run module and its Maven module dependencies, transitively, or
 * `null` when the model doesn't say — no build model, a module it doesn't list — in which case
 * callers keep their name-only lookup.
 */
export function mavenModuleScope(
  root: string | null,
  module: string | null | undefined,
  model: BuildModel | null,
): string[] | null {
  const maven: MavenModel | null | undefined = model?.maven;
  if (!root || !maven) return null;
  // Linked builds carry another project's folders: their `dir` isn't relative to this root.
  const projects = maven.projects.filter((p) => !p.projectRoot || p.projectRoot === root);
  const start = projectOf(projects, root, module ?? "");
  if (!start) return null;
  const byCoordinates = new Map(projects.map((p) => [`${p.groupId}:${p.artifactId}`, p]));
  const scope = new Set<MavenProject>([start]);
  const queue = [start];
  while (queue.length) {
    const project = queue.pop()!;
    for (const dep of project.dependencies) {
      // Every scope counts: a test run compiles against test dependencies too, and a folder left
      // out here would send a frame to another module's copy of the class.
      const next = byCoordinates.get(`${dep.groupId}:${dep.artifactId}`);
      if (next && !scope.has(next)) {
        scope.add(next);
        queue.push(next);
      }
    }
  }
  return [...scope].map((p) => absolute(root, p.dir));
}

/**
 * `hits` narrowed to the run's module scope: a same-named file of a module the run doesn't
 * depend on is another module's copy. Unchanged when the scope is unknown or matches nothing,
 * so a lookup never gets worse than the name-only one it replaces.
 */
export function scopeToRunModule(
  hits: string[],
  root: string | null,
  module: string | null | undefined,
  model: BuildModel | null,
): string[] {
  if (module == null) return hits;
  const dirs = mavenModuleScope(root, module, model);
  if (!dirs) return hits;
  const scoped = hits.filter((path) => dirs.some((dir) => path.startsWith(`${dir}/`)));
  return scoped.length ? scoped : hits;
}
