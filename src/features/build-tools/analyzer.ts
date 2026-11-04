/**
 * Dependency Analyzer model: the artifacts of a Maven module's dependency tree
 * (read with `dependency:tree -Dverbose`, so it also lists the occurrences Maven
 * omitted) or of a Gradle configuration (`dependencies` report), which of them
 * conflict, and every path that brings them in.
 */
import type { ArtifactKey, GradleDependency, MavenDependency } from "@/platform/ipc";

/** One occurrence of an artifact in the tree, with the path from a direct dependency down to it. */
export interface DependencyUsage {
  /** `path[0]` is the module's direct dependency, the last element the occurrence. */
  path: MavenDependency[];
  dependency: MavenDependency;
}

export interface AnalyzedArtifact {
  /** `groupId:artifactId[:classifier]`. */
  key: string;
  groupId: string;
  artifactId: string;
  classifier: string | null;
  /** Version on the classpath; `null` when every occurrence was omitted. */
  version: string | null;
  /** Scope of the resolved occurrence (else of the first one). */
  scope: string;
  /** Distinct versions asked for (before conflict resolution and dependency management). */
  requested: string[];
  /** Several versions were asked for and some lost. */
  conflict: boolean;
  usages: DependencyUsage[];
}

export interface AnalyzerFilter {
  query: string;
  conflictsOnly: boolean;
  /** `null` = any scope. */
  scope: string | null;
}

/** A Gradle project of the build (`project :core`): no group, its path as the name. */
export const isBuildProject = (d: Pick<MavenDependency, "groupId" | "artifactId">) =>
  !d.groupId && d.artifactId.startsWith(":");

export const artifactKey = (d: Pick<MavenDependency, "groupId" | "artifactId" | "classifier">) =>
  [d.groupId, d.artifactId, d.classifier].filter(Boolean).join(":");

/** `groupId:artifactId[:classifier]:version`. */
export function coordinates(d: Pick<MavenDependency, "groupId" | "artifactId" | "classifier" | "version">): string {
  return [d.groupId, d.artifactId, d.classifier, d.version].filter(Boolean).join(":");
}

/**
 * A Gradle occurrence in the analyzer's terms: `version` is the one Gradle selected,
 * `requested` the one this path asked for when conflict resolution replaced it.
 */
type GradleOccurrence = MavenDependency & { requested?: string | null; unresolved?: boolean };

const isResolved = (d: MavenDependency) => d.omitted == null;

/** The version a usage asked for: before `<dependencyManagement>` (or Gradle) replaced it, if it did. */
export const requestedVersion = (d: MavenDependency) =>
  (d as GradleOccurrence).requested ?? d.managedFrom ?? d.version ?? null;

/** `{strictly 1.0}` / `{require 1.0}` / `{prefer 1.0}` → `1.0`. */
const plainVersion = (v: string) => v.replace(/^\{(?:strictly|require|prefer) ([^}]*)\}$/, "$1");

/** A version that names one release (not a range or dynamic version). */
const isExact = (v: string) => !/[[\](),+{}]|latest\./.test(v);

/**
 * A Gradle configuration's report as analyzer dependencies. Constraints (`(c)`) are left
 * out: they are not dependencies. A path whose exact request lost to another version
 * (`1.0 -> 1.1`) is a conflict.
 */
export function fromGradle(deps: readonly GradleDependency[]): MavenDependency[] {
  return deps
    .filter((d) => !d.constraint)
    .map((d): GradleOccurrence => {
      const requested = d.requested ? plainVersion(d.requested) : null;
      // A project of the build has no version (`""`, not `null`: it isn't omitted).
      const version = d.project ? (d.selected ? `project ${d.selected}` : "") : (d.selected ?? requested);
      return {
        groupId: d.group,
        artifactId: d.name,
        version,
        type: "jar",
        classifier: null,
        scope: "compile",
        optional: false,
        children: fromGradle(d.children),
        requested: !d.project && requested && version && requested !== version && isExact(requested) ? requested : null,
        unresolved: d.unresolved,
      };
    });
}

/** Every artifact of `deps` (a module's dependency tree), sorted by key. */
export function analyze(deps: readonly MavenDependency[]): AnalyzedArtifact[] {
  const byKey = new Map<string, AnalyzedArtifact>();
  const walk = (list: readonly MavenDependency[], parents: MavenDependency[]) => {
    for (const d of list) {
      const path = [...parents, d];
      const key = artifactKey(d);
      let a = byKey.get(key);
      if (!a) {
        a = {
          key,
          groupId: d.groupId,
          artifactId: d.artifactId,
          classifier: d.classifier ?? null,
          version: null,
          scope: d.scope,
          requested: [],
          conflict: false,
          usages: [],
        };
        byKey.set(key, a);
      }
      a.usages.push({ path, dependency: d });
      if (isResolved(d) && a.version == null) {
        a.version = d.version ?? null;
        a.scope = d.scope;
      }
      const requested = requestedVersion(d);
      if (requested && !a.requested.includes(requested)) a.requested.push(requested);
      if (d.omitted === "conflict" || (d as GradleOccurrence).requested) a.conflict = true;
      walk(d.children, path);
    }
  };
  walk(deps, []);
  return [...byKey.values()].sort((x, y) => x.key.localeCompare(y.key));
}

/** Scopes used in the tree, in Maven's order. */
export function scopesOf(artifacts: readonly AnalyzedArtifact[]): string[] {
  const order = ["compile", "provided", "runtime", "test", "system", "import"];
  const found = new Set(artifacts.flatMap((a) => a.usages.map((u) => u.dependency.scope)));
  return [...found].sort((x, y) => (order.indexOf(x) + 1 || 99) - (order.indexOf(y) + 1 || 99) || x.localeCompare(y));
}

function matchesQuery(d: Pick<MavenDependency, "groupId" | "artifactId" | "classifier" | "version">, query: string) {
  const q = query.trim().toLowerCase();
  return !q || coordinates(d).toLowerCase().includes(q);
}

export function filterArtifacts(artifacts: readonly AnalyzedArtifact[], f: AnalyzerFilter): AnalyzedArtifact[] {
  return artifacts.filter(
    (a) =>
      (!f.conflictsOnly || a.conflict) &&
      (f.scope == null || a.usages.some((u) => u.dependency.scope === f.scope)) &&
      (matchesQuery(a, f.query) || a.requested.some((v) => matchesQuery({ ...a, version: v }, f.query))),
  );
}

/** A node of the tree view; `key` is unique (index path). */
export interface DependencyTreeNode {
  key: string;
  dependency: MavenDependency;
  children: DependencyTreeNode[];
}

/**
 * The tree view: nodes that pass the filter, with their ancestors (so every match keeps
 * its path), and every descendant of a match when no filter narrows them.
 */
export function filterTree(
  deps: readonly MavenDependency[],
  f: AnalyzerFilter,
  conflicted: ReadonlySet<string>,
): DependencyTreeNode[] {
  const narrowing = f.conflictsOnly || f.scope != null || !!f.query.trim();
  const passes = (d: MavenDependency) =>
    (!f.conflictsOnly || conflicted.has(artifactKey(d))) &&
    (f.scope == null || d.scope === f.scope) &&
    matchesQuery(d, f.query);
  const build = (list: readonly MavenDependency[], parent: string): DependencyTreeNode[] =>
    list.flatMap((dependency, i) => {
      const key = `${parent}/${i}`;
      const children = build(dependency.children, key);
      return !narrowing || passes(dependency) || children.length ? [{ key, dependency, children }] : [];
    });
  return build(deps, "");
}

export type UsageStatus =
  | { kind: "resolved"; version: string | null; managedFrom: string | null; requested: string | null }
  | { kind: "unresolved"; version: string | null }
  | { kind: "conflict"; version: string | null; winner: string | null }
  | { kind: "duplicate"; version: string | null }
  | { kind: "cycle"; version: string | null };

export function usageStatus(d: MavenDependency): UsageStatus {
  const version = d.version ?? null;
  const gradle = d as GradleOccurrence;
  if (gradle.unresolved) return { kind: "unresolved", version };
  switch (d.omitted) {
    case "conflict":
      return { kind: "conflict", version, winner: d.conflictWith ?? null };
    case "duplicate":
      return { kind: "duplicate", version };
    case "cycle":
      return { kind: "cycle", version };
    default:
      return { kind: "resolved", version, managedFrom: d.managedFrom ?? null, requested: gradle.requested ?? null };
  }
}

/** Human-readable status, e.g. `omitted for conflict with 3.12.0`. */
export function statusText(s: UsageStatus): string | null {
  switch (s.kind) {
    case "conflict":
      return s.winner ? `omitted for conflict with ${s.winner}` : "omitted for conflict";
    case "duplicate":
      return "omitted for duplicate";
    case "cycle":
      return "omitted for cycle";
    case "unresolved":
      return "not resolved";
    default:
      if (s.requested) return `requested ${s.requested}`;
      return s.managedFrom ? `version managed from ${s.managedFrom}` : null;
  }
}

/** What Exclude on `usage` adds: an exclusion of the occurrence to the direct dependency bringing it in. */
export function exclusionFor(usage: DependencyUsage): { dependency: ArtifactKey; exclusion: ArtifactKey } | null {
  const [direct] = usage.path;
  if (!direct || usage.path.length < 2) return null;
  return {
    dependency: { groupId: direct.groupId, artifactId: direct.artifactId },
    exclusion: { groupId: usage.dependency.groupId, artifactId: usage.dependency.artifactId },
  };
}

/** The resolved usage first, then the ones that lost a conflict, then the rest; shorter paths first. */
export function sortedUsages(usages: readonly DependencyUsage[]): DependencyUsage[] {
  const rank = (u: DependencyUsage) => (isResolved(u.dependency) ? 0 : u.dependency.omitted === "conflict" ? 1 : 2);
  return [...usages].sort((a, b) => rank(a) - rank(b) || a.path.length - b.path.length);
}
