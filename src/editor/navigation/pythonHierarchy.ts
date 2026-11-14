/**
 * Type hierarchy, super methods and implementations for Python from the IDE's inheritance
 * graph. basedpyright and pyrefly declare no `typeHierarchyProvider` and analyse a single
 * root, so those features cannot be answered by the server; the graph knows every
 * `class X(Base)` of the project, attached dependency roots included.
 */
import { type ClassInheritance, type HierarchyItem, type Location, type OutlineItem, type Pos } from "@/platform/ipc";
import {
  ancestors,
  baseDeclarations,
  classLocation,
  declarationKey,
  inheritanceIndex,
  methodInOutline,
  projectPythonIndex,
  subclassMap,
  type InheritanceDeps,
  type InheritanceIndex,
} from "./inheritanceGraph";
import { baseName, memberAt, type SuperDeps } from "./structureNav";

/** The project's classes with their base names, indexed for lookups. */
export interface PythonHierarchy {
  index: InheritanceIndex;
  /** Classes by `path:line`, so a position lookup does not scan the whole project graph. */
  byLine: ReadonlyMap<string, ClassInheritance[]>;
  /** Direct subclasses by [`declarationKey`] of the base they write (from the shared index). */
  subclasses?: ReadonlyMap<string, ClassInheritance[]>;
}

/** Indexes `classes`; `deps` reads the files an ambiguous base name's imports point at. */
export function pythonHierarchy(classes: readonly ClassInheritance[], deps: InheritanceDeps): PythonHierarchy {
  const byLine = new Map<string, ClassInheritance[]>();
  for (const cls of classes) {
    const key = `${cls.path}:${cls.line}`;
    byLine.set(key, [...(byLine.get(key) ?? []), cls]);
  }
  return { index: inheritanceIndex(classes, deps), byLine };
}

/** Whether `path` is a Python source the inheritance graph covers. */
export const isPythonPath = (path: string) => /\.pyi?$/.test(path);

let cache: { classes: readonly ClassInheritance[]; byLine: Map<string, ClassInheritance[]> } | null = null;

/** The open project's graph, indexed once and shared with the gutter and the inspections. */
export async function projectPythonHierarchy(): Promise<PythonHierarchy> {
  const project = await projectPythonIndex();
  if (cache?.classes !== project.classes) {
    const byLine = new Map<string, ClassInheritance[]>();
    for (const cls of project.classes) {
      const key = `${cls.path}:${cls.line}`;
      byLine.set(key, [...(byLine.get(key) ?? []), cls]);
    }
    cache = { classes: project.classes, byLine };
  }
  return { index: project.index, byLine: cache.byLine, subclasses: project.subclasses };
}

/** The graph's class declared on `pos`'s line in `path` (the column picks between two on one line). */
export function classAt(hierarchy: PythonHierarchy, path: string, pos: Pos): ClassInheritance | null {
  const onLine = hierarchy.byLine.get(`${path}:${pos.line}`) ?? [];
  return onLine.find((c) => c.col === pos.col) ?? (onLine.length === 1 ? onLine[0]! : null);
}

/** A graph class as the type-hierarchy / supertype item a language server would return. */
export function classItem(cls: ClassInheritance): HierarchyItem {
  const range = { start: { line: cls.line, col: cls.col }, end: { line: cls.line, col: cls.col + cls.name.length } };
  return {
    name: cls.name,
    kind: "class",
    detail: null,
    path: cls.path,
    range,
    selectionRange: range,
    fromRanges: [],
  };
}

/** The declarations `cls` directly inherits from, in the order it writes them. */
export const pythonSupertypes = (hierarchy: PythonHierarchy, cls: ClassInheritance) =>
  baseDeclarations(hierarchy.index, cls);

/** The Python supertypes of the type at `pos` in `path`, as hierarchy items. */
export async function pythonSupertypeItems(
  hierarchy: PythonHierarchy,
  path: string,
  pos: Pos,
): Promise<HierarchyItem[]> {
  const cls = classAt(hierarchy, path, pos);
  return cls ? (await pythonSupertypes(hierarchy, cls)).map(classItem) : [];
}

const subclassMaps = new WeakMap<PythonHierarchy, Promise<Map<string, ClassInheritance[]>>>();

/** Direct subclasses: the shared index's map, or one derived for a hand-built hierarchy. */
function subclassesOf(hierarchy: PythonHierarchy): Promise<Map<string, ClassInheritance[]>> {
  if (hierarchy.subclasses) return Promise.resolve(new Map(hierarchy.subclasses));
  let map = subclassMaps.get(hierarchy);
  if (!map) subclassMaps.set(hierarchy, (map = subclassMap(hierarchy.index)));
  return map;
}

/** The declarations directly inheriting from `cls`. */
export async function pythonSubtypes(hierarchy: PythonHierarchy, cls: ClassInheritance): Promise<ClassInheritance[]> {
  return (await subclassesOf(hierarchy)).get(declarationKey(cls)) ?? [];
}

/** Every ancestor of `cls`, nearest first. */
export const pythonAncestors = (hierarchy: PythonHierarchy, cls: ClassInheritance) => ancestors(hierarchy.index, cls);

/** Every descendant of `cls`, nearest level first, each declaration once. */
export async function pythonDescendants(
  hierarchy: PythonHierarchy,
  cls: ClassInheritance,
  depth = 8,
): Promise<ClassInheritance[]> {
  const subclasses = await subclassesOf(hierarchy);
  const seen = new Set<string>([declarationKey(cls)]);
  const out: ClassInheritance[] = [];
  let level = [cls];
  for (let d = 0; d < depth && level.length; d++) {
    const next: ClassInheritance[] = [];
    for (const parent of level) {
      for (const sub of subclasses.get(declarationKey(parent)) ?? []) {
        if (!seen.add(declarationKey(sub))) continue;
        out.push(sub);
        next.push(sub);
      }
    }
    level = next;
  }
  return out;
}

/** Super Method (⌘U) deps backed by the graph, for a language server without a type hierarchy. */
export function pythonSuperDeps(
  hierarchy: PythonHierarchy,
  outline: (path: string) => Promise<OutlineItem[]>,
): SuperDeps {
  return {
    supertypes: (path, pos) => pythonSupertypeItems(hierarchy, path, pos),
    outline,
  };
}

/**
 * Go to Implementation targets of the Python class or method at `pos` in `path`: the classes
 * inheriting from it, or the methods overriding it, anywhere below it in the graph.
 */
export async function pythonImplementationTargets(
  hierarchy: PythonHierarchy,
  path: string,
  pos: Pos,
  outline: (path: string) => Promise<OutlineItem[]>,
  depth = 8,
): Promise<Location[]> {
  const outlines = new Map<string, Promise<OutlineItem[]>>();
  const outlineOf = (p: string) => {
    let o = outlines.get(p);
    if (!o) outlines.set(p, (o = outline(p).catch(() => [] as OutlineItem[])));
    return o;
  };
  const member = memberAt(await outlineOf(path), pos);
  if (!member.type) return [];
  const cls = classAt(hierarchy, path, member.type.selection_range.start);
  if (!cls) return [];
  const descendants = await pythonDescendants(hierarchy, cls, depth);
  if (!member.method) return descendants.map(classLocation);
  const name = baseName(member.method.name);
  const targets: Location[] = [];
  for (const sub of descendants) {
    const method = methodInOutline(await outlineOf(sub.path), sub, name);
    if (method) targets.push({ path: sub.path, range: method.selection_range });
  }
  return targets;
}
