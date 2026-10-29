/**
 * `languages.*` (interpreters / toolchains) and `projectStructure.*` settings:
 * shape, defaults and normalisation (mirrors `ide-core::settings`).
 */
import { useMemo } from "react";
import { useProject } from "./project";

export interface LanguagesValid {
  python: { interpreter: string; activateVirtualenv: boolean };
  node: { interpreter: string; packageManager: "" | "npm" | "pnpm" | "yarn" | "bun" };
  rust: {
    toolchain: string;
    stdlib: string;
    checkOnSave: boolean;
    checkCommand: "check" | "clippy";
    rustfmtArgs: string;
  };
  go: { goroot: string; gopath: string };
  typescript: { version: string };
  java: {
    jdk: string;
    jdtlsJdk: string;
    jdtlsVmArgs: string;
    maven: { home: string; userSettings: string; localRepository: string };
  };
}

export interface ProjectStructureValid {
  sourceRoots: string[];
  testRoots: string[];
  resourceRoots: string[];
  testResourceRoots: string[];
  excluded: string[];
  /** Auto-detected roots the user unmarked. */
  unmarked: string[];
  /** Content roots besides the project folder (absolute paths). */
  contentRoots: string[];
  /** "Exclude files": `;`-separated name patterns. */
  excludeFiles: string;
}

/** The folder lists of `ProjectStructureValid` (marks). */
export type FolderListKey =
  | "sourceRoots"
  | "testRoots"
  | "resourceRoots"
  | "testResourceRoots"
  | "excluded"
  | "unmarked";

export const DEFAULT_LANGUAGES: LanguagesValid = {
  python: { interpreter: "", activateVirtualenv: true },
  node: { interpreter: "", packageManager: "" },
  rust: { toolchain: "", stdlib: "", checkOnSave: true, checkCommand: "check", rustfmtArgs: "" },
  go: { goroot: "", gopath: "" },
  typescript: { version: "bundled" },
  java: { jdk: "", jdtlsJdk: "", jdtlsVmArgs: "", maven: { home: "", userSettings: "", localRepository: "" } },
};

export const DEFAULT_PROJECT_STRUCTURE: ProjectStructureValid = {
  sourceRoots: [],
  testRoots: [],
  resourceRoots: [],
  testResourceRoots: [],
  excluded: [],
  unmarked: [],
  contentRoots: [],
  excludeFiles: "",
};

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const text = (v: unknown, d: string) => (typeof v === "string" ? v.trim() : d);
const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], d: T): T =>
  typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : d;

/** Project-relative folder: `/`-separated, no leading `./` or `/`, no trailing `/`. */
export function normalizeFolder(path: string): string {
  return path
    .replace(/\\/g, "/")
    .trim()
    .replace(/^(\.\/)+/, "")
    .replace(/^\/+|\/+$/g, "");
}

const folders = (v: unknown): string[] =>
  Array.isArray(v)
    ? [
        ...new Set(
          v
            .filter((x): x is string => typeof x === "string")
            .map(normalizeFolder)
            .filter((x) => x),
        ),
      ]
    : [];

/** Settings store the content root itself as `.`; roots use `""`. */
const folderKey = (stored: string) => (stored === "." ? "" : stored);
const storedFolder = (rel: string) => normalizeFolder(rel) || ".";

export function validateLanguages(raw: unknown): LanguagesValid {
  const d = DEFAULT_LANGUAGES;
  const l = obj(raw);
  const py = obj(l.python);
  const node = obj(l.node);
  const rust = obj(l.rust);
  const go = obj(l.go);
  const ts = obj(l.typescript);
  const java = obj(l.java);
  const maven = obj(java.maven);
  return {
    python: {
      interpreter: text(py.interpreter, d.python.interpreter),
      activateVirtualenv: bool(py.activateVirtualenv, d.python.activateVirtualenv),
    },
    node: {
      interpreter: text(node.interpreter, d.node.interpreter),
      packageManager: oneOf(node.packageManager, ["", "npm", "pnpm", "yarn", "bun"] as const, d.node.packageManager),
    },
    rust: {
      toolchain: text(rust.toolchain, d.rust.toolchain),
      stdlib: text(rust.stdlib, d.rust.stdlib),
      checkOnSave: bool(rust.checkOnSave, d.rust.checkOnSave),
      checkCommand: oneOf(rust.checkCommand, ["check", "clippy"] as const, d.rust.checkCommand),
      rustfmtArgs: typeof rust.rustfmtArgs === "string" ? rust.rustfmtArgs : d.rust.rustfmtArgs,
    },
    go: { goroot: text(go.goroot, d.go.goroot), gopath: text(go.gopath, d.go.gopath) },
    typescript: { version: text(ts.version, d.typescript.version) || d.typescript.version },
    java: {
      jdk: text(java.jdk, d.java.jdk),
      jdtlsJdk: text(java.jdtlsJdk, d.java.jdtlsJdk),
      jdtlsVmArgs: text(java.jdtlsVmArgs, d.java.jdtlsVmArgs),
      maven: {
        home: text(maven.home, d.java.maven.home),
        userSettings: text(maven.userSettings, d.java.maven.userSettings),
        localRepository: text(maven.localRepository, d.java.maven.localRepository),
      },
    },
  };
}

export function validateProjectStructure(raw: unknown): ProjectStructureValid {
  const p = obj(raw);
  return {
    sourceRoots: folders(p.sourceRoots),
    testRoots: folders(p.testRoots),
    resourceRoots: folders(p.resourceRoots),
    testResourceRoots: folders(p.testResourceRoots),
    excluded: folders(p.excluded),
    unmarked: folders(p.unmarked),
    contentRoots: Array.isArray(p.contentRoots)
      ? [...new Set(p.contentRoots.filter((x): x is string => typeof x === "string" && !!x.trim()))]
      : [],
    excludeFiles: typeof p.excludeFiles === "string" ? p.excludeFiles : "",
  };
}

/** Root kinds, as in IDEA's Project Structure (`ide-workspace::roots::RootKind`). */
export type FolderRole = "source" | "test" | "resources" | "testResources" | "excluded";

export const FOLDER_ROLES: readonly FolderRole[] = ["source", "test", "resources", "testResources", "excluded"];

const ROLE_KEYS: Record<FolderRole, Exclude<FolderListKey, "unmarked">> = {
  source: "sourceRoots",
  test: "testRoots",
  resources: "resourceRoots",
  testResources: "testResourceRoots",
  excluded: "excluded",
};

/** A root of the project: user-marked (`detectedFrom` null) or detected from a build file. */
export interface RootFolder {
  /** Project-relative, `/`-separated; `""` is the project root. */
  path: string;
  kind: FolderRole;
  detectedFrom: string | null;
}

/** User-marked role of a project-relative folder (exact match), or null. */
export function folderRole(ps: ProjectStructureValid, rel: string): FolderRole | null {
  const r = storedFolder(rel);
  for (const role of FOLDER_ROLES) {
    if (ps[ROLE_KEYS[role]].includes(r)) return role;
  }
  return null;
}

/**
 * Effective roots: user marks win, `unmarked` hides detected roots
 * (mirrors `ProjectRoots::compute`), sorted by path.
 */
export function effectiveRoots(detected: readonly RootFolder[], ps: ProjectStructureValid): RootFolder[] {
  const out: RootFolder[] = [];
  for (const role of FOLDER_ROLES)
    for (const path of ps[ROLE_KEYS[role]].map(folderKey))
      if (!out.some((r) => r.path === path)) out.push({ path, kind: role, detectedFrom: null });
  const unmarked = ps.unmarked.map(folderKey);
  for (const d of detected) if (!unmarked.includes(d.path) && !out.some((r) => r.path === d.path)) out.push({ ...d });
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Effective role of a folder (exact match): what its icon shows. */
export function rootRole(roots: readonly RootFolder[], rel: string): FolderRole | null {
  const r = normalizeFolder(rel);
  return roots.find((x) => x.path === r)?.kind ?? null;
}

const inside = (rel: string, root: string) => !root || rel === root || rel.startsWith(`${root}/`);

/** The innermost root containing the project-relative path `rel`. */
export function rootFor(roots: readonly RootFolder[], rel: string): RootFolder | null {
  const r = normalizeFolder(rel);
  let best: RootFolder | null = null;
  for (const root of roots) if (inside(r, root.path) && (!best || root.path.length > best.path.length)) best = root;
  return best;
}

/** Test files recognised by name (mirrors `ide-workspace::roots::is_test_file_name`). */
export function isTestFileName(name: string): boolean {
  if (name.endsWith("_test.go")) return true;
  if (name.endsWith(".py")) {
    const stem = name.slice(0, -3);
    return stem.startsWith("test_") || stem.endsWith("_test") || stem === "conftest";
  }
  return /^.+\.(test|spec)\.(js|jsx|ts|tsx|mjs|cjs|mts|cts)$/.test(name);
}

/** IDEA's "Project Test Files": under a test (resource) root, or a test file by name. */
export function isTestPath(roots: readonly RootFolder[], rel: string): boolean {
  const root = rootFor(roots, rel);
  if (root?.kind === "test" || root?.kind === "testResources") return true;
  if (root?.kind === "excluded") return false;
  return isTestFileName(normalizeFolder(rel).split("/").pop() ?? "");
}

/**
 * Gives `rel` the `role` (null = Unmark). Marking a detected root with its
 * detected role needs no override; unmarking a detected root records it in `unmarked`.
 */
export function markFolder(
  ps: ProjectStructureValid,
  rel: string,
  role: FolderRole | null,
  detected: readonly RootFolder[] = [],
): ProjectStructureValid {
  const r = storedFolder(rel);
  const next: ProjectStructureValid = {
    ...ps,
    sourceRoots: ps.sourceRoots.filter((x) => x !== r),
    testRoots: ps.testRoots.filter((x) => x !== r),
    resourceRoots: ps.resourceRoots.filter((x) => x !== r),
    testResourceRoots: ps.testResourceRoots.filter((x) => x !== r),
    excluded: ps.excluded.filter((x) => x !== r),
    unmarked: ps.unmarked.filter((x) => x !== r),
  };
  const auto = detected.find((d) => d.path === folderKey(r))?.kind ?? null;
  if (role === null) {
    if (auto) next.unmarked = [...next.unmarked, r].sort();
  } else if (role !== auto) {
    next[ROLE_KEYS[role]] = [...next[ROLE_KEYS[role]], r].sort();
  }
  return next;
}

/** Detected roots the user unmarked. */
export function unmarkedRoots(detected: readonly RootFolder[], ps: ProjectStructureValid): RootFolder[] {
  const unmarked = ps.unmarked.map(folderKey);
  return detected.filter((d) => unmarked.includes(d.path));
}

/** Brings back every unmarked detected root. */
export function restoreDetected(ps: ProjectStructureValid, detected: readonly RootFolder[]): ProjectStructureValid {
  return { ...ps, unmarked: ps.unmarked.filter((p) => !detected.some((d) => d.path === folderKey(p))) };
}

/** Settings keys of `ProjectStructureValid`, in a stable order. */
export const PROJECT_STRUCTURE_KEYS = [
  "sourceRoots",
  "testRoots",
  "resourceRoots",
  "testResourceRoots",
  "excluded",
  "unmarked",
] as const satisfies ReadonlyArray<FolderListKey>;

/** Effective Project Structure of the open project (reactive). */
export function useProjectStructure(): ProjectStructureValid {
  const raw = useProject((s) => (s.settings as { projectStructure?: unknown } | null)?.projectStructure);
  return useMemo(() => validateProjectStructure(raw), [raw]);
}
