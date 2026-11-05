/**
 * `main` inherited from a superclass (in the project or a library JAR): the JVM
 * launches `java -cp … Sub` fine when `Base` declares `static main`, but the
 * synchronous scanner only sees the file's own text. This asks the language
 * server for the superclass chain once, and remembers the answer for
 * `fileTargets` to read synchronously.
 */
import { lspRequest } from "@/editor/lsp/lsp";
import { readFileLines, withDocument } from "@/editor/lsp/files";
import { commands, type HierarchyItem, type Pos } from "@/platform/ipc";
import type { RunTarget } from "./targets";
import { jvmMainCandidates, scanJvmTargets, simpleClassName, type JvmMainCandidate } from "./jvmTargets";

export interface InheritedMainDeps {
  supertypes: (path: string, pos: Pos) => Promise<HierarchyItem[]>;
  /** Source text of a supertype (file, or decompiled / source-jar document). */
  text: (item: HierarchyItem) => Promise<string>;
}

export const inheritedMainDeps: InheritedMainDeps = {
  supertypes: (path, pos) =>
    withDocument(path, (doc) => lspRequest(() => commands.lspTypeHierarchy(doc, pos, "incoming"))),
  text: async (item) => {
    const lines = await readFileLines(item.uri ?? item.path);
    if (!lines) throw new Error("unreadable");
    return lines.join("\n");
  },
};

/** Whether the type declares a static `main` itself, by `uri ?? path` and name. */
const declares = new Map<string, Promise<boolean>>();
/** file → `class extends base` → inherits a static `main`. */
const resolved = new Map<string, Map<string, boolean>>();
const keyOf = (c: Pick<JvmMainCandidate, "className" | "base">) => `${c.className} extends ${c.base}`;

/** After the server settles: ask again where it said "no" (it may have been indexing); keep the "yes" answers. */
export function retryNegativeInheritedMain() {
  declares.clear();
  for (const m of resolved.values()) for (const [k, v] of m) if (!v) m.delete(k);
}

export function clearInheritedMain() {
  declares.clear();
  resolved.clear();
}

export const hasInheritedMain = (path: string, c: Pick<JvmMainCandidate, "className" | "base">) =>
  resolved.get(path)?.get(keyOf(c)) === true;

/** Candidates of `path` not answered yet. */
export function unresolvedCandidates(path: string, text: string): JvmMainCandidate[] {
  const done = resolved.get(path);
  return jvmMainCandidates(text, path).filter((c) => !done?.has(keyOf(c)));
}

function declaresMain(s: HierarchyItem, deps: InheritedMainDeps): Promise<boolean> {
  const key = `${s.uri ?? s.path}#${s.name}`;
  let p = declares.get(key);
  if (!p) {
    const name = s.name.replace(/<.*$/, "");
    p = deps
      .text(s)
      .then((text) =>
        scanJvmTargets(text, "", false).some(
          (t) => t.kind === "main" && !t.instance && simpleClassName(t.className) === name,
        ),
      );
    // Not remembered on failure: the document may become readable later.
    p.catch(() => declares.delete(key));
    declares.set(key, p);
  }
  return p.catch(() => false);
}

/**
 * Whether a superclass of the type at `pos` declares a static `main`.
 * `undefined` when the server could not say (not ready), so the caller retries later.
 * Interfaces are skipped: a static interface `main` is not inherited.
 */
export async function resolveInheritedMain(
  path: string,
  pos: Pos,
  deps: InheritedMainDeps,
  depth = 6,
): Promise<boolean | undefined> {
  const seen = new Set<string>();
  let level = [{ path, pos }];
  for (let d = 0; d < depth && level.length; d++) {
    const next: typeof level = [];
    for (const t of level) {
      let supers: HierarchyItem[];
      try {
        supers = await deps.supertypes(t.path, t.pos);
      } catch {
        if (d === 0) return undefined;
        continue;
      }
      for (const s of supers) {
        if (s.kind !== "class") continue;
        const key = `${s.uri ?? s.path}:${s.selectionRange.start.line}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (await declaresMain(s, deps)) return true;
        next.push({ path: s.path, pos: s.selectionRange.start });
      }
    }
    level = next;
  }
  return false;
}

/** Resolves the file's pending candidates; true when a new inherited `main` was found. */
export async function resolveCandidates(
  path: string,
  candidates: readonly JvmMainCandidate[],
  deps: InheritedMainDeps = inheritedMainDeps,
): Promise<boolean> {
  let found = false;
  for (const c of candidates) {
    const has = await resolveInheritedMain(path, { line: c.line, col: c.col }, deps);
    if (has === undefined) continue;
    if (!resolved.has(path)) resolved.set(path, new Map());
    resolved.get(path)!.set(keyOf(c), has);
    found ||= has;
  }
  return found;
}

/** `main` targets for the file's classes whose superclass declares one (answers resolved earlier). */
export function inheritedRunTargets(path: string, text: string): RunTarget[] {
  if (!resolved.get(path)?.size) return [];
  return jvmMainCandidates(text, path)
    .filter((c) => hasInheritedMain(path, c))
    .map((c) => ({
      line: c.line,
      kind: "main",
      name: simpleClassName(c.className),
      path: [c.className],
      className: c.className,
      spring: c.spring,
    }));
}
