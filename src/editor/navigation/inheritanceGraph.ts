/**
 * The Python inheritance graph of the project, shared by every feature that needs it
 * (gutter markers, type hierarchy, structure view, inspections).
 *
 * A language server's `typeHierarchy` is not used: basedpyright and pyrefly declare no
 * `typeHierarchyProvider`, and a server analyses a single root, so an attached
 * dependency project's classes would be invisible anyway. The IDE index knows every
 * `class X(Base)` of every content root, which is the whole answer this needs.
 */
import { commands, type ClassInheritance, type Location, type OutlineItem } from "@/platform/ipc";
import { lspRequest } from "@/editor/lsp/lsp";
import { useProject } from "@/platform/project";
import { readManyFileLines } from "@/editor/lsp/files";
import { baseName } from "./structureNav";

/**
 * The graph of the open project, shared across documents and kept across edits: it is a
 * whole-project index answer, not a per-document one. Dropped when other files change or
 * a server settles (the index may have moved on).
 */
let cache: { root: string; promise: Promise<ClassInheritance[]> } | null = null;

/** Forgets the cached graph and everything derived from it (files changed, a server settled, or tests). */
export function forgetInheritanceGraph() {
  cache = null;
  indexCache = null;
}

/** The project's classes and their base names, fetched once per project and invalidation. */
export function pythonInheritanceGraph(): Promise<ClassInheritance[]> {
  const root = useProject.getState().project?.root ?? "";
  if (!cache || cache.root !== root) {
    cache = { root, promise: lspRequest(() => commands.navInheritance()) };
    // A failed request must not stick: the next caller retries it.
    cache.promise.catch(() => {
      if (cache?.root === root) cache = null;
    });
  }
  return cache.promise;
}

/** Where a name written in a file comes from: the module of a `from` import and the name it is declared under there. */
export interface ImportBinding {
  module: string;
  name: string;
}

/**
 * The local name -> declaration bindings of a file's `from` imports:
 * `from a.b import X as Y` binds `Y` to (`a.b`, `X`). Plain `import a.b` statements are
 * skipped: a base written through them keeps its qualifier, which the graph does not store.
 */
export function importBindings(lines: readonly string[]): Map<string, ImportBinding> {
  const out = new Map<string, ImportBinding>();
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").replace(/#.*$/, "");
    const from = /^\s*from\s+(\.*[\w.]*)\s+import\s+(.*)$/.exec(line);
    if (!from) continue;
    let body = from[2]!.trim();
    if (body.startsWith("(")) {
      // The names may span lines inside the parentheses.
      let text = body.slice(1);
      while (!text.includes(")") && i + 1 < lines.length) text += ` ${(lines[++i] ?? "").replace(/#.*$/, "")}`;
      body = text.slice(0, text.indexOf(")") < 0 ? undefined : text.indexOf(")"));
    }
    for (const part of body.split(",")) {
      const [name, alias] = part.trim().split(/\s+as\s+/);
      const declared = (name ?? "").trim();
      if (!declared || declared === "*" || !/^\w+$/.test(declared)) continue;
      const local = (alias ?? declared).trim();
      if (!/^\w+$/.test(local)) continue;
      out.set(local, { module: from[1]!, name: declared });
    }
  }
  return out;
}

/** What an index needs from the editor: a file's lines, and a module's file. */
export interface InheritanceDeps {
  readFiles: (paths: readonly string[]) => Promise<Map<string, string[] | null>>;
  /** `from a.b import X`: the file `a.b` names, `.x` resolved relative to `from`. */
  moduleFile?: (module: string, from: string) => Promise<string | null>;
}

/** Resolves the base names the graph stores to class declarations. */
export interface InheritanceIndex {
  /** The graph's classes by name. */
  byName: ReadonlyMap<string, ClassInheritance[]>;
  /** A base that names one class, or a class of the subclass's own file. */
  exact(name: string, from: string): ClassInheritance[];
  /** `exact`, else the declaration the file's imports point at (empty when unknown). */
  resolve(name: string, from: string): Promise<ClassInheritance[]>;
  /** Reads the imports of `paths` in one batch, ahead of the `resolve` calls that need them. */
  readImports(paths: readonly string[]): Promise<void>;
}

/**
 * Index a graph for lookups. A base name is only trusted when it names one class in the
 * project or a class of the subclass's own file: a `Config` declared in hundreds of
 * modules must not make every one of them a subclass of every other. When several files
 * declare it, the subclass file's own imports decide (`from x.y import Config`).
 */
export function inheritanceIndex(graph: readonly ClassInheritance[], deps: InheritanceDeps): InheritanceIndex {
  const byName = new Map<string, ClassInheritance[]>();
  for (const cls of graph) byName.set(cls.name, [...(byName.get(cls.name) ?? []), cls]);
  const imports = new Map<string, Promise<Map<string, ImportBinding> | null>>();
  const answers = new Map<string, Promise<ClassInheritance[]>>();
  const exact = (name: string, from: string): ClassInheritance[] => {
    const found = byName.get(name) ?? [];
    return found.length <= 1 ? found : found.filter((c) => c.path === from);
  };
  const bindingsOf = (from: string): Promise<Map<string, ImportBinding> | null> => {
    let pending = imports.get(from);
    if (!pending) {
      pending = deps
        .readFiles([from])
        .then((files) => {
          const lines = files.get(from);
          return lines ? importBindings(lines) : null;
        })
        .catch(() => null);
      imports.set(from, pending);
    }
    return pending;
  };
  return {
    byName,
    exact,
    readImports: async (paths) => {
      // Without a module lookup an import never resolves a base: nothing to read for it.
      const unread = deps.moduleFile ? [...new Set(paths)].filter((p) => !imports.has(p)) : [];
      if (!unread.length) return;
      const files = deps.readFiles(unread).catch(() => new Map<string, string[] | null>());
      for (const p of unread) {
        imports.set(
          p,
          files.then((f) => {
            const lines = f.get(p);
            return lines ? importBindings(lines) : null;
          }),
        );
      }
      await files;
    },
    resolve: (name, from) => {
      const found = exact(name, from);
      if (found.length || !deps.moduleFile) return Promise.resolve(found);
      const moduleFile = deps.moduleFile;
      // No class of that name at all: it may be an import alias (`import X as Y`).
      const key = `${from}\u0000${name}`;
      let pending = answers.get(key);
      if (!pending) {
        pending = (async () => {
          const binding = (await bindingsOf(from))?.get(name);
          // The graph has no class under the imported name: no module lookup can find one.
          if (!binding || !byName.get(binding.name)?.length) return [];
          // `from . import X` names the package itself: resolve its `__init__`.
          const module = binding.module;
          const named = /^\.+$/.test(module) ? `${module.endsWith(".") ? module : `${module}.`}__init__` : module;
          const file = await moduleFile(named, from).catch(() => null);
          // The declaration carries the imported (pre-alias) name.
          return file ? (byName.get(binding.name) ?? []).filter((c) => c.path === file) : [];
        })();
        answers.set(key, pending);
      }
      return pending;
    },
  };
}

/** The graph indexed once per project, with what every consumer derives from it. */
export interface PythonIndex {
  classes: readonly ClassInheritance[];
  index: InheritanceIndex;
  /**
   * Direct subclasses, keyed by [`declarationKey`] of the base they write. Built on first use:
   * it resolves every base of the project, which supertype lookups never need.
   */
  subclasses: () => Promise<Map<string, ClassInheritance[]>>;
}

let indexCache: { source: Promise<ClassInheritance[]>; pending: Promise<PythonIndex> } | null = null;

/**
 * The project's graph indexed once, shared by every consumer: the gutter, the type
 * hierarchy and the inspections all need the same name map, resolver and subclass map,
 * and rebuilding them per call (or per feature) would walk the graph again.
 */
/** What the project index reads: file lines and the file a module names. */
const PROJECT_DEPS: InheritanceDeps = {
  readFiles: readManyFileLines,
  moduleFile: (module, from) => lspRequest(() => commands.navResolveModule(module, from)),
};

export function projectPythonIndex(): Promise<PythonIndex> {
  const source = pythonInheritanceGraph();
  if (!indexCache || indexCache.source !== source) {
    const pending = source.then(async (graph) => {
      const index = inheritanceIndex(graph, PROJECT_DEPS);
      let subclasses: Promise<Map<string, ClassInheritance[]>> | null = null;
      return { classes: graph, index, subclasses: () => (subclasses ??= subclassMap(index)) };
    });
    indexCache = { source, pending };
    pending.catch(() => {
      if (indexCache?.pending === pending) indexCache = null;
    });
  }
  return indexCache.pending;
}

/** Identifies one class declaration in the graph. */
export function declarationKey(cls: ClassInheritance): string {
  return `${cls.path}:${cls.line}:${cls.col}`;
}

/** The class declaration itself as a navigation target (its name identifier). */
export function classLocation(cls: ClassInheritance): Location {
  const start = { line: cls.line, col: cls.col };
  return { path: cls.path, range: { start, end: start } };
}

/** The method `method` (bare name) directly inside the class at `cls`'s position. */
export function methodInOutline(
  outline: readonly OutlineItem[],
  cls: ClassInheritance,
  method: string,
): OutlineItem | null {
  const find = (items: readonly OutlineItem[]): OutlineItem | null => {
    for (const it of items) {
      if (
        it.kind === "class" &&
        it.selection_range.start.line === cls.line &&
        it.selection_range.start.col === cls.col
      ) {
        return it.children.find((ch) => ch.kind === "method" && baseName(ch.name) === method) ?? null;
      }
      const deeper = find(it.children);
      if (deeper) return deeper;
    }
    return null;
  };
  return find(outline);
}

/** Direct subclasses, keyed by [`declarationKey`] of the base they write. */
export async function subclassMap(index: InheritanceIndex): Promise<Map<string, ClassInheritance[]>> {
  const pairs: Array<[ClassInheritance, string]> = [];
  for (const sameNamed of index.byName.values()) {
    for (const cls of sameNamed) for (const base of new Set(cls.bases)) pairs.push([cls, base]);
  }
  // The files whose imports decide a base: read together, not one request per class.
  await index.readImports(pairs.filter(([cls, base]) => !index.exact(base, cls.path).length).map(([cls]) => cls.path));
  const resolved = await Promise.all(pairs.map(([cls, base]) => index.resolve(base, cls.path)));
  const out = new Map<string, ClassInheritance[]>();
  pairs.forEach(([cls], i) => {
    for (const decl of resolved[i]!) {
      const key = declarationKey(decl);
      out.set(key, [...(out.get(key) ?? []), cls]);
    }
  });
  return out;
}

/** The declarations `cls` directly inherits from, in the order it writes them. */
export async function baseDeclarations(index: InheritanceIndex, cls: ClassInheritance): Promise<ClassInheritance[]> {
  const out: ClassInheritance[] = [];
  for (const base of cls.bases) out.push(...(await index.resolve(base, cls.path)));
  return out;
}

/**
 * Standard bases that declare no method a project class could override or implement (only
 * dunders), so a chain ending in them is still fully known: `class Shape(ABC)`.
 */
const EMPTY_BASES: ReadonlySet<string> = new Set(["object", "ABC", "Generic", "Protocol"]);

/** One class `cls` inherits from, and how far up it sits (its direct bases are depth 1). */
export interface AncestorNode {
  decl: ClassInheritance;
  depth: number;
}

/** Ancestors of `cls`, and how deep the first base the project does not declare sits. */
export interface AncestryResolution {
  /** The declarations `cls` inherits from, nearest first. */
  ancestors: AncestorNode[];
  /**
   * Depth of the shallowest base name that names no class of the project (`dict`, a library
   * class), or `Infinity` when the chain resolved completely. A rule may trust the chain up
   * to that depth only: a foreign base can declare or implement anything.
   */
  firstUnresolvedDepth: number;
}

/**
 * Walks `cls`'s ancestry nearest first (breadth-first, each declaration once) and reports
 * at which depth the chain leaves the project. A rule that reasons about an ancestor at
 * depth `d` is sound exactly while `firstUnresolvedDepth > d`.
 */
export async function ancestryResolution(
  index: InheritanceIndex,
  cls: ClassInheritance,
  depth = 8,
): Promise<AncestryResolution> {
  const seen = new Set<string>([declarationKey(cls)]);
  const out: AncestorNode[] = [];
  let firstUnresolvedDepth = Infinity;
  let level: ClassInheritance[] = [cls];
  for (let d = 1; d <= depth && level.length; d++) {
    const next: ClassInheritance[] = [];
    for (const current of level) {
      for (const base of current.bases) {
        const found = await index.resolve(base, current.path);
        if (!found.length) {
          if (!EMPTY_BASES.has(base)) firstUnresolvedDepth = Math.min(firstUnresolvedDepth, d);
          continue;
        }
        for (const parent of found) {
          if (!seen.add(declarationKey(parent))) continue;
          out.push({ decl: parent, depth: d });
          next.push(parent);
        }
      }
    }
    level = next;
  }
  return { ancestors: out, firstUnresolvedDepth };
}

/** Every ancestor of `cls`, nearest first, up to `depth` levels. */
export async function ancestors(
  index: InheritanceIndex,
  cls: ClassInheritance,
  depth = 8,
): Promise<ClassInheritance[]> {
  return (await ancestryResolution(index, cls, depth)).ancestors.map((node) => node.decl);
}
