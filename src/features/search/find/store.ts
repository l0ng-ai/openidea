import { create } from "zustand";
import type { ContextKeys } from "@/platform/context";
import type { ProjectFileSet, SearchContext, SearchQuery, SearchScope } from "@/platform/ipc";
import { SEARCH_CONTEXTS, customScopes, findCustomScope, rememberSearch, searchHistory } from "@/platform/search";
import { loadJson, saveJson } from "../common/open";

export { SEARCH_CONTEXTS };

export type ScopeTab = "project" | "module" | "directory" | "scope";
export type BuiltinScope = "projectFiles" | "productionFiles" | "testFiles" | "openFiles" | "recentFiles";
/** A built-in named scope or a user-defined one (`custom:<name>`, see `@/platform/search`). */
export type NamedScope = BuiltinScope | `custom:${string}`;

export const customScopeValue = (name: string): NamedScope => `custom:${name}`;
export const customScopeName = (v: NamedScope): string | null => (v.startsWith("custom:") ? v.slice(7) : null);

/** IDEA's root-based named scopes, searched by the backend over the project's source / test roots. */
export const FILE_SET_SCOPES: Partial<Record<BuiltinScope, ProjectFileSet>> = {
  projectFiles: "all",
  productionFiles: "production",
  testFiles: "test",
};

const FILE_SET_LABELS: Record<ProjectFileSet, string> = {
  all: "Project Files",
  production: "Project Production Files",
  test: "Project Test Files",
};

export interface FindOptions {
  pattern: string;
  replacement: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  isRegex: boolean;
  /** Replace: keep the case of each found occurrence (IDEA's "Preserve case"). */
  preserveCase: boolean;
  maskEnabled: boolean;
  mask: string;
  scopeTab: ScopeTab;
  /** Module tab: relative module folder or absolute workspace member (`""`: plain project root). */
  module: string;
  directory: string;
  namedScope: NamedScope;
  /** IDEA's search context filter (funnel menu): anywhere, only / except comments and string literals. */
  context: SearchContext;
}

interface FindPopupState extends FindOptions {
  open: boolean;
  replace: boolean;
  session: number;
  /** Title-bar pin: the popup stays open when a result is opened or the user clicks outside. */
  pinned: boolean;
}

const PINNED_KEY = "openidea.search.findPinned.v1";

export const useFindPopup = create<FindPopupState>(() => ({
  open: false,
  replace: false,
  session: 0,
  pattern: "",
  replacement: "",
  caseSensitive: false,
  wholeWord: false,
  isRegex: false,
  preserveCase: false,
  maskEnabled: false,
  mask: "",
  scopeTab: "project",
  module: "",
  directory: "",
  namedScope: "projectFiles",
  context: "any",
  pinned: loadJson<unknown>(PINNED_KEY, false) === true,
}));

export function setFindPopupPinned(pinned: boolean) {
  useFindPopup.setState({ pinned });
  saveJson(PINNED_KEY, pinned);
}

/**
 * Keys the popup handles that are also global shortcuts (⌘G / ⇧⌘G, F4 / ⌘↓, ⌥↓):
 * hidden actions bound later in the keymap win while the popup is open and
 * forward here.
 */
export type FindPopupCommand = "nextResult" | "previousResult" | "openResult" | "recentSearches";
let commandHandler: ((c: FindPopupCommand) => void) | null = null;

export function setFindPopupCommandHandler(handler: ((c: FindPopupCommand) => void) | null) {
  commandHandler = handler;
}

export function runFindPopupCommand(c: FindPopupCommand): boolean {
  if (!useFindPopup.getState().open || !commandHandler) return false;
  commandHandler(c);
  return true;
}

export interface FindArg {
  directory?: string;
  query?: string;
}

export function parseFindArg(arg: unknown, ctx: ContextKeys = {}): FindArg {
  const a = (arg && typeof arg === "object" ? arg : {}) as Record<string, unknown>;
  return {
    directory:
      typeof a.directory === "string"
        ? a.directory
        : typeof a.path === "string"
          ? a.path
          : typeof ctx.focusedDirectory === "string"
            ? ctx.focusedDirectory
            : undefined,
    query: typeof a.query === "string" ? a.query : undefined,
  };
}

export function showFindPopup(replace: boolean, arg: FindArg & { selection?: string | null } = {}) {
  const s = useFindPopup.getState();
  const patch: Partial<FindPopupState> = { open: true, replace, session: s.session + 1 };
  const prefill = arg.query ?? arg.selection;
  if (prefill) patch.pattern = prefill;
  if (arg.directory) {
    patch.scopeTab = "directory";
    patch.directory = arg.directory;
  } else if (!s.open && s.scopeTab === "directory" && !s.directory) {
    patch.scopeTab = "project";
  }
  useFindPopup.setState(patch);
}

export function hideFindPopup() {
  useFindPopup.setState({ open: false });
}

const MASKS_KEY = "openidea.search.fileMasks.v1";
const DEFAULT_MASKS = ["*.ts,*.tsx", "*.rs", "*.kt", "*.java", "*.py", "*.go", "*.md", "*.json", "!*.test.*"];

export function recentMasks(): string[] {
  const v = loadJson<unknown>(MASKS_KEY, []);
  const recent = Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  return [...recent, ...DEFAULT_MASKS.filter((m) => !recent.includes(m))];
}

export function rememberMask(mask: string) {
  const m = mask.trim();
  if (!m) return;
  const v = loadJson<unknown>(MASKS_KEY, []);
  const recent = Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  saveJson(MASKS_KEY, [m, ...recent.filter((x) => x !== m)].slice(0, 10));
}

/** Recent search (or replace) strings, newest first (⌥↓); shared with the editor's find bar. */
export const findHistory = searchHistory;
export const rememberFindString = rememberSearch;

export function buildQuery(o: FindOptions, scope: SearchScope, maxMatches: number): SearchQuery {
  const q: SearchQuery = {
    pattern: o.pattern,
    isRegex: o.isRegex,
    caseSensitive: o.caseSensitive,
    wholeWord: o.wholeWord,
    include: o.maskEnabled && o.mask.trim() ? [o.mask.trim()] : [],
    exclude: [],
    scope,
    maxMatches,
  };
  if (o.context !== "any") q.context = o.context;
  return q;
}

export interface ScopeInputs {
  root: string | null;
  /** Files of the open editors (Open Files). */
  openPaths: () => string[];
  /** Recently viewed files, once loaded. */
  recentPaths: string[] | null;
}

export function resolveDirectory(dir: string, root: string | null): string {
  const d = dir.trim().replace(/\/+$/, "");
  if (!d || d.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(d)) return d;
  return root ? `${root}/${d}` : d;
}

/** The backend scope of the popup's scope tabs. */
export function resolveFindScope(o: FindOptions, inputs: ScopeInputs): SearchScope {
  const { root } = inputs;
  if (o.scopeTab === "directory" && o.directory.trim())
    return { kind: "directory", path: resolveDirectory(o.directory, root) };
  if (o.scopeTab === "module")
    return o.module && root
      ? { kind: "directory", path: o.module.startsWith("/") ? o.module : `${root}/${o.module}` }
      : { kind: "project" };
  if (o.scopeTab !== "scope") return { kind: "project" };
  const custom = customScopeName(o.namedScope);
  if (custom !== null) {
    const scope = findCustomScope(custom);
    return scope ? { kind: "pattern", pattern: scope.pattern } : { kind: "project" };
  }
  const fileSet = FILE_SET_SCOPES[o.namedScope as BuiltinScope];
  if (fileSet) return { kind: "fileSet", set: fileSet };
  return { kind: "files", paths: o.namedScope === "openFiles" ? inputs.openPaths() : (inputs.recentPaths ?? []) };
}

export function describeQuery(q: SearchQuery, root: string | null): string {
  const rel = (p: string) => (root && p.startsWith(root + "/") ? p.slice(root.length + 1) : p);
  const where = (() => {
    switch (q.scope.kind) {
      case "project":
        return "Project";
      case "directory":
        return `Directory ${rel(q.scope.path)}`;
      case "fileSet":
        return FILE_SET_LABELS[q.scope.set];
      case "files":
        return `${q.scope.paths.length} files`;
      case "pattern": {
        const pattern = q.scope.pattern;
        const named = customScopes().find((s) => s.pattern === pattern);
        return named ? `Scope '${named.name}'` : `Scope ${pattern}`;
      }
    }
  })();
  const context = q.context && q.context !== "any" ? SEARCH_CONTEXTS.find((c) => c.value === q.context)?.label : null;
  return `'${q.pattern}' in ${where}${q.include.length ? ` (${q.include.join(", ")})` : ""}${context ? `, ${context.toLowerCase()}` : ""}`;
}
