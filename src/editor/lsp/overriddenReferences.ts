/**
 * Usages of a Python method through its bases. basedpyright and pyrefly bind a call to the
 * declaration on the receiver's static type: `repo.save()` with `repo: Repository` is a reference
 * of `Repository.save` only, never of the override the caret is on. Find Usages and the usage
 * counts add the references of the methods it overrides, as JDT's search does for Java.
 */
import type { References } from "@/bindings";
import { isPythonPath, projectPythonHierarchy, pythonOverriddenMethods } from "@/editor/navigation/pythonHierarchy";
import { commands, isCancelled, type Location, type OutlineItem, type Pos } from "@/platform/ipc";
import { readManyFileLines, withDocument } from "./files";
import { lspRequest } from "./lsp";

/** Outlines by path, shared by the lookups of one pass so a base file is read once. */
export type OutlineCache = Map<string, Promise<OutlineItem[]>>;

/** The methods the Python method named at `pos` in `path` (open as `doc`) overrides; none for another language. */
export async function overriddenMethods(
  path: string,
  doc: number,
  pos: Pos,
  outlines: OutlineCache = new Map(),
): Promise<Location[]> {
  if (!isPythonPath(path)) return [];
  const hierarchy = await projectPythonHierarchy().catch(() => null);
  if (!hierarchy) return [];
  const outline = (p: string) => {
    let o = outlines.get(p);
    if (!o) {
      o =
        p === path
          ? lspRequest(() => commands.docOutline(doc))
          : withDocument(p, (d) => lspRequest(() => commands.docOutline(d)));
      outlines.set(p, o);
    }
    return o;
  };
  return pythonOverriddenMethods(hierarchy, path, pos, outline).catch(() => []);
}

/** `super().save(` and `super(Impl, self).save(`, up to the method name. */
const SUPER_CALL = /\bsuper\s*\([^()]*\)\s*\.\s*$/;

/**
 * `references` of each of `methods`. A `super()` call among them runs the overridden method
 * from an override and never the one searched, so it is left out. The searches run one after
 * another: a caller can reuse its request id, and cancelling it stops whichever runs. One that
 * fails counts as incomplete.
 */
export async function overriddenReferences(
  methods: readonly Location[],
  references: (doc: number, pos: Pos) => Promise<References>,
): Promise<References[]> {
  const found: References[] = [];
  for (const m of methods) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- sequential: the caller's request id is reused
      found.push(await withDocument(m.path, (d) => references(d, m.range.start)));
    } catch (e) {
      if (isCancelled(e)) throw e;
      found.push({ locations: [], incomplete: "serverFailed" });
    }
  }
  const files = await readManyFileLines(found.flatMap((r) => r.locations.filter((l) => !l.uri).map((l) => l.path)));
  const viaSuper = (l: Location) =>
    !l.uri && SUPER_CALL.test(files.get(l.path)?.[l.range.start.line]?.slice(0, l.range.start.col) ?? "");
  return found.map((r) => ({ ...r, locations: r.locations.filter((l) => !viaSuper(l)) }));
}
