/**
 * `languages.*` (interpreters / toolchains) and `projectStructure.*` settings:
 * shape, defaults and normalisation (mirrors `ide-core::settings`).
 */
import { useMemo } from "react";
import { useProject } from "./project";

export interface GoBuildTags {
  os: string;
  arch: string;
  version: string;
  compiler: string;
  cgo: string;
  custom: string;
  experiments: string;
}

const DEFAULT_GO_BUILD_TAGS: GoBuildTags = {
  os: "",
  arch: "",
  version: "",
  compiler: "",
  cgo: "",
  custom: "",
  experiments: "",
};

/** An external formatter (Prettier, oxfmt, Ruff) and the languages it formats. */
interface ExternalFormatterValid {
  path: string;
  configurationDirectory: string;
  languages: string[];
  prefer: boolean;
  runOnSave: boolean;
}

const DEFAULT_FORMATTER: ExternalFormatterValid = {
  path: "",
  configurationDirectory: "",
  languages: [
    "markdown",
    "yaml",
    "css",
    "scss",
    "less",
    "html",
    "graphql",
    "javascript",
    "javascriptreact",
    "typescript",
    "typescriptreact",
    "json",
    "jsonc",
    "vue",
  ],
  prefer: false,
  runOnSave: false,
};

const DEFAULT_RUFF_FORMATTER: ExternalFormatterValid = {
  ...DEFAULT_FORMATTER,
  languages: ["python"],
};

/** `languages.php.languageLevel` values, newest first; `""` = Auto (from `composer.json`). */
export const PHP_LANGUAGE_LEVELS = [
  "",
  "8.5",
  "8.4",
  "8.3",
  "8.2",
  "8.1",
  "8.0",
  "7.4",
  "7.3",
  "7.2",
  "7.1",
  "7.0",
  "5.6",
] as const;

/** `languages.java.languageLevel` values; `""` = SDK default (Auto). */
export const JAVA_LANGUAGE_LEVELS = ["", "8", "11", "17", "21", "25"] as const;

export type DependencyScopeValid = "compile" | "test" | "runtime" | "provided";

export const DEPENDENCY_SCOPES = ["compile", "test", "runtime", "provided"] as const;

export interface ProjectLibraryValid {
  name: string;
  classes: string[];
  sources: string[];
  javadocs: string[];
  scope: DependencyScopeValid;
}

export interface ModuleDependencyValid {
  kind: "library" | "module";
  target: string;
  scope: DependencyScopeValid;
  exported: boolean;
}

export interface ModuleStructureValid {
  jdk: string;
  languageLevel: (typeof JAVA_LANGUAGE_LEVELS)[number];
  compilerOutput: string;
  testCompilerOutput: string;
  dependencies: ModuleDependencyValid[];
}

export interface FacetConfigValid {
  kind: "web" | "spring" | "jpa";
  module: string;
  descriptor: string;
  webRoot: string;
}

export type ArtifactKindValid = "jar" | "war" | "warExploded";

export const ARTIFACT_KINDS = ["jar", "war", "warExploded"] as const;

export interface ArtifactConfigValid {
  name: string;
  kind: ArtifactKindValid;
  module: string;
  outputDirectory: string;
  mainClass: string;
  includeLibraries: string[];
}

export interface LanguagesValid {
  python: { interpreter: string; activateVirtualenv: boolean };
  ruby: { interpreter: string };
  node: { interpreter: string; packageManager: "" | "npm" | "pnpm" | "yarn" | "bun" };
  php: {
    interpreter: string;
    languageLevel: (typeof PHP_LANGUAGE_LEVELS)[number];
    includePaths: string[];
    stubs: string[];
    phpstanConfig: string;
  };
  rust: {
    toolchain: string;
    stdlib: string;
    checkOnSave: boolean;
    checkCommand: "check" | "clippy";
    rustfmtArgs: string;
  };
  go: {
    goroot: string;
    gopath: string;
    buildTags: GoBuildTags;
    modules: { env: Record<string, string>; autoVendor: boolean };
  };
  typescript: { version: string };
  prettier: ExternalFormatterValid;
  oxfmt: ExternalFormatterValid;
  ruff: ExternalFormatterValid;
  java: {
    jdk: string;
    languageLevel: (typeof JAVA_LANGUAGE_LEVELS)[number];
    jdtlsJdk: string;
    jdtlsVmArgs: string;
    gradle: {
      linkedProjects: string[] | null;
      jvm: string;
      distribution: "wrapper" | "local";
      home: string;
      userHome: string;
      /** IDEA's "Build and run using": Gradle (`JavaExec`) or the IDE (the language server's classpath). */
      runUsing: "gradle" | "ide";
    };
    maven: {
      home: string;
      userSettings: string;
      toolchains: string;
      localRepository: string;
      jdk: string;
      unlinkedProjects: string[];
      linkedProjects: string[];
      daemon: boolean;
      mvndHome: string;
      /** `-T`: a thread count (4) or a core multiplier (2C, 2.5C); empty = Maven's default. */
      threads: string;
    };
  };
  /** Preview font size in px; `null` follows the editor font size. */
  markdown: { previewFontSize: number | null };
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
  /** Project compiler output directory; empty = default. */
  compilerOutput: string;
  /** Per-module overrides keyed by module relative path (`"."` for root). */
  modules: Record<string, ModuleStructureValid>;
  /** Project-level libraries. */
  libraries: ProjectLibraryValid[];
  /** Module framework facets (`web`, `spring`, `jpa`). */
  facets: FacetConfigValid[];
  /** Packaging artifacts (`jar`, `war`, `warExploded`). */
  artifacts: ArtifactConfigValid[];
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
  ruby: { interpreter: "" },
  node: { interpreter: "", packageManager: "" },
  php: { interpreter: "", languageLevel: "", includePaths: [], stubs: [], phpstanConfig: "" },
  rust: { toolchain: "", stdlib: "", checkOnSave: true, checkCommand: "check", rustfmtArgs: "" },
  go: { goroot: "", gopath: "", buildTags: DEFAULT_GO_BUILD_TAGS, modules: { env: {}, autoVendor: true } },
  typescript: { version: "bundled" },
  prettier: DEFAULT_FORMATTER,
  oxfmt: DEFAULT_FORMATTER,
  ruff: DEFAULT_RUFF_FORMATTER,
  java: {
    jdk: "",
    languageLevel: "",
    jdtlsJdk: "",
    jdtlsVmArgs: "",
    gradle: { linkedProjects: null, jvm: "", distribution: "wrapper", home: "", userHome: "", runUsing: "gradle" },
    maven: {
      home: "",
      userSettings: "",
      toolchains: "",
      localRepository: "",
      jdk: "",
      unlinkedProjects: [],
      linkedProjects: [],
      daemon: false,
      mvndHome: "",
      threads: "",
    },
  },
  markdown: { previewFontSize: null },
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
  compilerOutput: "",
  modules: {},
  libraries: [],
  facets: [],
  artifacts: [],
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

/** A stored preview font size within IDEA's 8..72, or `null` (follow the editor font). */
const previewSize = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(72, Math.max(8, Math.round(v))) : null;
/** Non-empty trimmed strings, without duplicates. */
const strings = (v: unknown): string[] =>
  Array.isArray(v)
    ? [...new Set(v.filter((x): x is string => typeof x === "string").map((x) => x.trim()))].filter((x) => x)
    : [];
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

function validateFormatter(raw: unknown, d = DEFAULT_FORMATTER): ExternalFormatterValid {
  const f = obj(raw);
  return {
    path: text(f.path, d.path),
    configurationDirectory: text(f.configurationDirectory, d.configurationDirectory),
    languages: Array.isArray(f.languages)
      ? [...new Set(f.languages.filter((v): v is string => typeof v === "string"))]
      : d.languages,
    prefer: bool(f.prefer, d.prefer),
    runOnSave: bool(f.runOnSave, d.runOnSave),
  };
}

export function validateLanguages(raw: unknown): LanguagesValid {
  const d = DEFAULT_LANGUAGES;
  const l = obj(raw);
  const py = obj(l.python);
  const ruby = obj(l.ruby);
  const node = obj(l.node);
  const php = obj(l.php);
  const rust = obj(l.rust);
  const go = obj(l.go);
  const tags = obj(go.buildTags);
  const modules = obj(go.modules);
  const ts = obj(l.typescript);
  const java = obj(l.java);
  const maven = obj(java.maven);
  const gradle = obj(java.gradle);
  const markdown = obj(l.markdown);
  return {
    python: {
      interpreter: text(py.interpreter, d.python.interpreter),
      activateVirtualenv: bool(py.activateVirtualenv, d.python.activateVirtualenv),
    },
    ruby: { interpreter: text(ruby.interpreter, d.ruby.interpreter) },
    node: {
      interpreter: text(node.interpreter, d.node.interpreter),
      packageManager: oneOf(node.packageManager, ["", "npm", "pnpm", "yarn", "bun"] as const, d.node.packageManager),
    },
    php: {
      interpreter: text(php.interpreter, d.php.interpreter),
      languageLevel: oneOf(php.languageLevel, PHP_LANGUAGE_LEVELS, d.php.languageLevel),
      includePaths: strings(php.includePaths),
      stubs: strings(php.stubs),
      phpstanConfig: text(php.phpstanConfig, d.php.phpstanConfig),
    },
    rust: {
      toolchain: text(rust.toolchain, d.rust.toolchain),
      stdlib: text(rust.stdlib, d.rust.stdlib),
      checkOnSave: bool(rust.checkOnSave, d.rust.checkOnSave),
      checkCommand: oneOf(rust.checkCommand, ["check", "clippy"] as const, d.rust.checkCommand),
      rustfmtArgs: typeof rust.rustfmtArgs === "string" ? rust.rustfmtArgs : d.rust.rustfmtArgs,
    },
    go: {
      goroot: text(go.goroot, d.go.goroot),
      gopath: text(go.gopath, d.go.gopath),
      buildTags: Object.fromEntries(
        Object.entries(DEFAULT_GO_BUILD_TAGS).map(([key, value]) => [key, text(tags[key], value)]),
      ) as unknown as GoBuildTags,
      modules: {
        autoVendor: bool(modules.autoVendor, true),
        env: Object.fromEntries(
          Object.entries(obj(modules.env)).filter(
            ([key, value]) => !!key && !/[=\s\0]/.test(key) && typeof value === "string" && !value.includes("\0"),
          ),
        ) as Record<string, string>,
      },
    },
    typescript: { version: text(ts.version, d.typescript.version) || d.typescript.version },
    prettier: validateFormatter(l.prettier),
    oxfmt: validateFormatter(l.oxfmt),
    ruff: validateFormatter(l.ruff, DEFAULT_RUFF_FORMATTER),
    java: {
      jdk: text(java.jdk, d.java.jdk),
      languageLevel: oneOf(java.languageLevel, JAVA_LANGUAGE_LEVELS, d.java.languageLevel),
      jdtlsJdk: text(java.jdtlsJdk, d.java.jdtlsJdk),
      jdtlsVmArgs: text(java.jdtlsVmArgs, d.java.jdtlsVmArgs),
      gradle: {
        linkedProjects: Array.isArray(gradle.linkedProjects)
          ? gradle.linkedProjects.filter((p): p is string => typeof p === "string")
          : null,
        jvm: text(gradle.jvm, d.java.gradle.jvm),
        distribution: oneOf(gradle.distribution, ["wrapper", "local"] as const, d.java.gradle.distribution),
        home: text(gradle.home, d.java.gradle.home),
        userHome: text(gradle.userHome, d.java.gradle.userHome),
        runUsing: oneOf(gradle.runUsing, ["gradle", "ide"] as const, d.java.gradle.runUsing),
      },
      maven: {
        home: text(maven.home, d.java.maven.home),
        userSettings: text(maven.userSettings, d.java.maven.userSettings),
        toolchains: text(maven.toolchains, d.java.maven.toolchains),
        localRepository: text(maven.localRepository, d.java.maven.localRepository),
        jdk: text(maven.jdk, d.java.maven.jdk),
        unlinkedProjects: folders(maven.unlinkedProjects),
        linkedProjects: folders(maven.linkedProjects),
        daemon: bool(maven.daemon, d.java.maven.daemon),
        mvndHome: text(maven.mvndHome, d.java.maven.mvndHome),
        threads: text(maven.threads, d.java.maven.threads),
      },
    },
    markdown: { previewFontSize: previewSize(markdown.previewFontSize) },
  };
}

/**
 * Markdown preview (and notebook Markdown cell) font size in px: Languages &
 * Frameworks › Markdown, else the editor font size, as IDEA defaults it.
 */
export function markdownPreviewFontSize(settings: unknown): number {
  const s = obj(settings);
  const editorSize = obj(s.editor).fontSize;
  return (
    previewSize(obj(obj(s.languages).markdown).previewFontSize) ??
    // 13: the editor's default font size.
    (typeof editorSize === "number" && editorSize > 0 ? editorSize : 13)
  );
}

/** Reactive `markdownPreviewFontSize` of the open project. */
export function useMarkdownPreviewFontSize(): number {
  return useProject((s) => markdownPreviewFontSize(s.settings));
}

function validateModuleDependencies(raw: unknown): ModuleDependencyValid[] {
  if (!Array.isArray(raw)) return [];
  const out: ModuleDependencyValid[] = [];
  for (const item of raw) {
    const m = obj(item);
    const target = text(m.target, "");
    if (!target) continue;
    out.push({
      kind: oneOf(m.kind, ["library", "module"] as const, "library"),
      target,
      scope: oneOf(m.scope, DEPENDENCY_SCOPES, "compile"),
      exported: bool(m.exported, false),
    });
  }
  return out;
}

function validateModulesMap(raw: unknown): Record<string, ModuleStructureValid> {
  const m = obj(raw);
  const out: Record<string, ModuleStructureValid> = {};
  for (const [k, v] of Object.entries(m)) {
    const key = normalizeFolder(k) || ".";
    const mod = obj(v);
    out[key] = {
      jdk: text(mod.jdk, ""),
      languageLevel: oneOf(mod.languageLevel, JAVA_LANGUAGE_LEVELS, ""),
      compilerOutput: text(mod.compilerOutput, ""),
      testCompilerOutput: text(mod.testCompilerOutput, ""),
      dependencies: validateModuleDependencies(mod.dependencies),
    };
  }
  return out;
}

function validateLibrariesList(raw: unknown): ProjectLibraryValid[] {
  if (!Array.isArray(raw)) return [];
  const out: ProjectLibraryValid[] = [];
  for (const item of raw) {
    const l = obj(item);
    const name = text(l.name, "");
    const classes = strings(l.classes);
    const sources = strings(l.sources);
    const javadocs = strings(l.javadocs);
    if (!name && classes.length === 0 && sources.length === 0) continue;
    out.push({
      name: name || (classes[0]?.split(/[\\/]/).pop() ?? "Library"),
      classes,
      sources,
      javadocs,
      scope: oneOf(l.scope, DEPENDENCY_SCOPES, "compile"),
    });
  }
  return out;
}

function validateFacetsList(raw: unknown): FacetConfigValid[] {
  if (!Array.isArray(raw)) return [];
  const out: FacetConfigValid[] = [];
  for (const item of raw) {
    const f = obj(item);
    const kind = oneOf(f.kind, ["web", "spring", "jpa"] as const, "web");
    const module = normalizeFolder(text(f.module, ".")) || ".";
    out.push({
      kind,
      module,
      descriptor: text(f.descriptor, ""),
      webRoot: text(f.webRoot, ""),
    });
  }
  return out;
}

function validateArtifactsList(raw: unknown): ArtifactConfigValid[] {
  if (!Array.isArray(raw)) return [];
  const out: ArtifactConfigValid[] = [];
  for (const item of raw) {
    const a = obj(item);
    const name = text(a.name, "");
    if (!name) continue;
    out.push({
      name,
      kind: oneOf(a.kind, ARTIFACT_KINDS, "jar"),
      module: normalizeFolder(text(a.module, ".")) || ".",
      outputDirectory: text(a.outputDirectory, ""),
      mainClass: text(a.mainClass, ""),
      includeLibraries: strings(a.includeLibraries),
    });
  }
  return out;
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
    compilerOutput: text(p.compilerOutput, ""),
    modules: validateModulesMap(p.modules),
    libraries: validateLibrariesList(p.libraries),
    facets: validateFacetsList(p.facets),
    artifacts: validateArtifactsList(p.artifacts),
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
