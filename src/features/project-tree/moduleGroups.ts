/**
 * IDEA's module groups in the Project view, for Gradle builds whose modules live outside
 * the project folder (`includeFlat`, computed `projectDir`s). Mirrors IntelliJ's
 * `AbstractProjectNode.modulesAndGroups`, `ModuleGroup.modulesInGroup` / `childGroups`
 * and the `QualifiedNameGrouper` of qualified module names (`<root project>.billing.core`).
 */
import type { ExtraRoot } from "./model";
import { isSameOrInside, nameOf } from "./paths";

interface Module {
  /** Qualified name: `<root project>.<path segments>`. */
  name: string;
  dir: string;
}

const isAbsolute = (p: string) => p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p);
const segments = (name: string) => name.split(".");
const groupOf = (m: Module) => segments(m.name).slice(0, -1);
const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const isChild = (parent: readonly string[], d: readonly string[]) =>
  d.length > parent.length && same(d.slice(0, parent.length), parent);
const byLabel = (a: ExtraRoot, b: ExtraRoot) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" });

/**
 * Group nodes to list beside the project folder: none while the project folder is the only
 * top-level module root (every module inside it), as in IDEA.
 */
export function gradleModuleGroups(
  projects: readonly { path: string; dir: string }[],
  rootName: string,
  projectRoot: string,
): ExtraRoot[] {
  const modules: Module[] = projects.map((p) => ({
    name: [rootName, ...p.path.split(":").filter(Boolean)].join("."),
    dir: isAbsolute(p.dir) ? p.dir : p.dir ? `${projectRoot}/${p.dir}` : projectRoot,
  }));
  // A content root is top level when no other content root contains it (`isTopLevelRoot`).
  const roots = [projectRoot, ...modules.map((m) => m.dir)];
  const topLevel = modules.filter(
    (m) => m.dir === projectRoot || !roots.some((r) => r !== m.dir && isSameOrInside(m.dir, r)),
  );
  if (topLevel.length <= 1) return [];
  const asGroups = modules.map((m) => segments(m.name));
  const isModulePath = (path: readonly string[]) => asGroups.some((g) => same(g, path));

  // `modulesAndGroups`: one node for the common group path of the grouped top-level modules.
  const grouped = topLevel.map(groupOf).filter((g) => g.length);
  if (!grouped.length) return [];
  let common = grouped[0]!;
  for (const g of grouped.slice(1)) {
    let n = 0;
    while (n < Math.min(common.length, g.length) && common[n] === g[n]) n++;
    common = common.slice(0, n);
  }
  const tops = common.length ? [common] : [...new Map(grouped.map((g) => [g[0]!, [g[0]!]])).values()];

  const node = (group: readonly string[]): ExtraRoot => {
    // `childGroups`: direct subgroups not named like a module (those fold into this group).
    const childGroups = new Map<string, string[]>();
    for (const m of modules) {
      const g = groupOf(m);
      const direct = [...group, g[group.length]!];
      if (isChild(group, g) && !isModulePath(direct)) childGroups.set(direct.join("."), direct);
    }
    // `modulesInGroup`: this group's modules, and those under a subgroup named like a module.
    const members = modules.filter((m) => {
      const g = groupOf(m);
      return same(g, group) || (isChild(group, g) && isModulePath(g.slice(0, group.length + 1)));
    });
    const seen = new Set<string>();
    const moduleNodes: ExtraRoot[] = members
      .filter((m) => !seen.has(m.dir) && !!seen.add(m.dir))
      .map((m) => {
        const label = nameOf(m.dir) || m.dir;
        return { id: m.name, label, detail: m.name === label ? undefined : m.name, icon: "gradle-module", path: m.dir };
      });
    return {
      id: `gradleGroup:${group.join(".")}`,
      label: group[group.length - 1]!,
      icon: "gradle-project",
      children: [...[...childGroups.values()].map(node).sort(byLabel), ...moduleNodes.sort(byLabel)],
    };
  };
  return tops.map(node);
}
