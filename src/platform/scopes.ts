/**
 * Scopes (Settings › Appearance & Behavior › Scopes): named sets of files that other
 * settings refer to, e.g. File Colors. A scope's pattern is an expression over file
 * patterns: `file:src//*.ts && !file:*.test.ts`, `file[web]:*.ts` or `(a || b) && !c`.
 *
 * A file pattern matches the project-relative path (folders end in `/`): `*` stands for
 * any characters, `**` and a trailing `*` for characters within one name, and `//` for
 * any folders in between. `file[module]:` also requires the file to be in a module of that name.
 */
import { useMemo } from "react";
import type { RootFolder } from "./languageSettings";
import { useProject } from "./project";
import {
  inFileSet,
  projectModules,
  projectRelative,
  useDetectedRoots,
  useEffectiveRoots,
  type ProjectModule,
} from "./projectRoots";

export interface NamedScope {
  name: string;
  pattern: string;
}

/** Scopes every project has, by name. */
export const BUILTIN_SCOPES = ["Project Files", "Production", "Tests", "Non-Project Files"] as const;

type Node =
  | { kind: "file"; module: RegExp | null; path: RegExp }
  | { kind: "not"; of: Node }
  | { kind: "and" | "or"; left: Node; right: Node };

export class ScopeSyntaxError extends Error {
  constructor(
    message: string,
    readonly at: number,
  ) {
    super(message);
  }
}

/** The regular expression of a file pattern, read the way the pattern syntax defines it. */
export function filePatternRegExp(pattern: string): RegExp {
  let out = "";
  let afterSlash = false;
  let afterStar = false;
  for (const c of pattern) {
    if (c !== "/" && afterSlash) {
      out += "\\/";
      afterSlash = false;
    }
    if (c !== "*" && afterStar) {
      out += ".*";
      afterStar = false;
    }
    if (c === "*") {
      if (afterStar) out += "[^/]*";
      afterStar = !afterStar;
    } else if (c === "/") {
      if (afterSlash) out += "\\/(.*\\/)?";
      afterSlash = !afterSlash;
    } else {
      out += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  if (afterStar) out += "[^/]*";
  return new RegExp(`^${out}$`);
}

/** A module name pattern: `*` stands for any characters. */
const moduleRegExp = (pattern: string) =>
  new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);

/** Parses a scope pattern; throws `ScopeSyntaxError` with the offset of the problem. */
export function parseScope(text: string): Node {
  let i = 0;
  const ws = () => {
    while (i < text.length && /\s/.test(text[i]!)) i++;
  };
  const eat = (token: string) => {
    ws();
    if (!text.startsWith(token, i)) return false;
    i += token.length;
    return true;
  };
  const or = (): Node => {
    let left = and();
    while (eat("||")) left = { kind: "or", left, right: and() };
    return left;
  };
  const and = (): Node => {
    let left = unary();
    while (eat("&&")) left = { kind: "and", left, right: unary() };
    return left;
  };
  const unary = (): Node => {
    if (eat("!")) return { kind: "not", of: unary() };
    if (eat("(")) {
      const inner = or();
      if (!eat(")")) throw new ScopeSyntaxError("')' expected", i);
      return inner;
    }
    return atom();
  };
  const atom = (): Node => {
    ws();
    const start = i;
    if (!text.startsWith("file", i)) throw new ScopeSyntaxError("'file:' expected", start);
    i += 4;
    let module: RegExp | null = null;
    if (text[i] === "[") {
      const close = text.indexOf("]", i);
      if (close < 0) throw new ScopeSyntaxError("']' expected", i);
      module = moduleRegExp(text.slice(i + 1, close).trim());
      i = close + 1;
    }
    if (text[i] !== ":") throw new ScopeSyntaxError("':' expected", i);
    i++;
    const from = i;
    // A pattern runs to whitespace or an operator.
    while (i < text.length && !/[\s()|&!]/.test(text[i]!)) i++;
    if (i === from) throw new ScopeSyntaxError("Pattern expected", i);
    return { kind: "file", module, path: filePatternRegExp(text.slice(from, i)) };
  };
  const node = or();
  ws();
  if (i < text.length) throw new ScopeSyntaxError("Unexpected text", i);
  return node;
}

/** The problem with a scope pattern and its offset, or null when it parses. */
export function scopeError(pattern: string): { message: string; at: number } | null {
  try {
    parseScope(pattern);
    return null;
  } catch (e) {
    return e instanceof ScopeSyntaxError ? { message: e.message, at: e.at } : { message: String(e), at: 0 };
  }
}

/** What a scope is matched against. */
export interface ScopeContext {
  roots: readonly RootFolder[];
  modules: readonly ProjectModule[];
  scopes: readonly NamedScope[];
  /** Folders outside the project that are not Non-Project Files either (scratches). */
  ownFolders?: readonly string[];
}

/** The innermost module holding the file (`rel` in the project, `path` absolute). */
function moduleOf(rel: string, path: string, modules: readonly ProjectModule[]): ProjectModule | undefined {
  let best: ProjectModule | undefined;
  for (const m of modules) {
    // Workspace members have absolute paths.
    const at = m.path.startsWith("/") ? path : rel;
    const holds = m.path === "" || at === m.path || at.startsWith(`${m.path}/`);
    if (holds && (!best || m.path.length > best.path.length)) best = m;
  }
  return best;
}

function matches(node: Node, rel: string, path: string, dir: boolean, ctx: ScopeContext): boolean {
  switch (node.kind) {
    case "not":
      return !matches(node.of, rel, path, dir, ctx);
    case "and":
      return matches(node.left, rel, path, dir, ctx) && matches(node.right, rel, path, dir, ctx);
    case "or":
      return matches(node.left, rel, path, dir, ctx) || matches(node.right, rel, path, dir, ctx);
    case "file": {
      if (node.module) {
        const m = moduleOf(rel, path, ctx.modules);
        if (!m || !node.module.test(m.name)) return false;
      }
      return node.path.test(dir ? `${rel}/` : rel);
    }
  }
}

const parsed = new Map<string, Node | null>();
function compiled(pattern: string): Node | null {
  let node = parsed.get(pattern);
  if (node === undefined) {
    try {
      node = parseScope(pattern);
    } catch {
      node = null;
    }
    if (parsed.size > 200) parsed.clear();
    parsed.set(pattern, node);
  }
  return node;
}

/** Whether the absolute `path` is in the scope called `name` (built-in or user-defined). */
export function inScope(name: string, path: string, ctx: ScopeContext, dir = false): boolean {
  switch (name) {
    case "Project Files":
      return inFileSet("all", path, ctx.roots);
    case "Production":
      return inFileSet("production", path, ctx.roots);
    case "Tests":
      return inFileSet("test", path, ctx.roots);
    case "Non-Project Files":
      return projectRelative(path) === null && !ctx.ownFolders?.some((d) => path === d || path.startsWith(`${d}/`));
  }
  const scope = ctx.scopes.find((s) => s.name === name);
  const node = scope ? compiled(scope.pattern) : null;
  const rel = projectRelative(path);
  return !!node && rel !== null && rel !== "" && matches(node, rel, path, dir, ctx);
}

/** User scopes from settings. */
export function validateScopes(raw: unknown): NamedScope[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((s) =>
    s && typeof s === "object" && typeof s.name === "string" && s.name.trim()
      ? [{ name: s.name, pattern: typeof s.pattern === "string" ? s.pattern : "" }]
      : [],
  );
}

let cachedRaw: unknown = Symbol("unset");
let cachedScopes: NamedScope[] = [];
/** The project's user scopes (cached per settings object). */
export function userScopes(raw: unknown = (useProject.getState().settings as { scopes?: unknown } | null)?.scopes) {
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedScopes = validateScopes(raw);
  }
  return cachedScopes;
}

function modulesOf(detected: readonly RootFolder[]): ProjectModule[] {
  const project = useProject.getState().project;
  return project?.workspace
    ? project.workspace.projects.map((path) => ({ path, name: path.slice(path.lastIndexOf("/") + 1) }))
    : projectModules(detected, project?.name ?? "");
}

/** The scope context, following roots and settings. */
export function useScopeContext(): ScopeContext {
  const roots = useEffectiveRoots();
  const detected = useDetectedRoots();
  const raw = useProject((s) => (s.settings as { scopes?: unknown } | null)?.scopes);
  const project = useProject((s) => s.project);
  return useMemo(
    () => ({ roots, modules: modulesOf(detected), scopes: userScopes(raw) }),
    // `project` changes the module names.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [roots, detected, raw, project],
  );
}
