import { formatArgs } from "@/platform/commandLine";
/** Run configuration helpers: grouping, overriding, validation and argument parsing. */
import type { RunConfig } from "@/platform/ipc";
import { useRunConfigTypes } from "@/workbench/contributions";

const KIND_LABELS: Record<string, string> = {
  npm: "npm",
  vue: "Vue",
  deno: "Deno",
  bun: "Bun",
  cargo: "Cargo",
  gradle: "Gradle",
  maven: "Maven",
  go: "Go",
  python: "Python",
  pytest: "pytest",
  make: "Make",
  cmake: "CMake",
  just: "Just",
  shell: "Shell Script",
  program: "Program",
  compound: "Compound",
  application: "Application",
  "spring-boot": "Spring Boot",
  node: "Node.js",
  "java-file": "Java Single File",
  rustc: "Rust Single File",
  kotlinc: "Kotlin Single File",
  cc: "C/C++ Single File",
  native: "Native Executable",
  ruby: "Ruby",
  php: "PHP",
  perl: "Perl",
  lua: "Lua",
  r: "R",
  swift: "Swift",
  dart: "Dart",
  elixir: "Elixir",
  "scala-cli": "Scala CLI",
  kotlin: "Kotlin Script",
};

export const KIND_OPTIONS = Object.entries(KIND_LABELS).map(([value, label]) => ({ value, label }));

export function kindLabel(kind: string): string {
  const type = useRunConfigTypes.getState().types.get(kind);
  // A grouped type ("Tomcat Server › Local") is named by its group outside the Add menu.
  return type?.group ?? type?.label ?? KIND_LABELS[kind] ?? (kind ? kind[0]!.toUpperCase() + kind.slice(1) : "Other");
}

/**
 * The menu category of a run configuration kind, for the Services "Add Service"
 * menu (IDEA's template groups): a registered type's group (Docker, Servers),
 * else its language/tool category, else "Others".
 */
export const KIND_CATEGORIES: Record<string, string> = {
  "spring-boot": "Java",
  application: "Java",
  native: "Java",
  "java-file": "Java",
  kotlin: "Java",
  kotlinc: "Java",
  "scala-cli": "Java",
  "remote-jvm": "Java",
  maven: "Build Tools",
  gradle: "Build Tools",
  cmake: "Build Tools",
  make: "Build Tools",
  just: "Build Tools",
  npm: "JavaScript",
  vue: "JavaScript",
  node: "JavaScript",
  bun: "JavaScript",
  deno: "JavaScript",
  "node-remote": "JavaScript",
  python: "Python",
  pytest: "Python",
  "python-remote": "Python",
  cargo: "Rust",
  rustc: "Rust",
  go: "Go",
  "go-test": "Go",
  "go-remote": "Go",
  cc: "C/C++",
  shell: "Shell",
  program: "Shell",
};

/** Category order of the Add Service menu; unlisted categories (plugins) sort after, then "Others". */
export const CATEGORY_ORDER: readonly string[] = [
  "Java",
  "Build Tools",
  "JavaScript",
  "Python",
  "Rust",
  "Go",
  "C/C++",
  "Shell",
  "Servers",
  "Docker",
];

export function categoryOf(kind: string): string {
  return useRunConfigTypes.getState().types.get(kind)?.group ?? KIND_CATEGORIES[kind] ?? "Others";
}

/**
 * Whether the run kind executes on a JVM (its console can carry MyBatis logs).
 * `shortcut: tomcat is hardcoded — registered types don't declare a language.`
 */
export function isJvmKind(kind: string): boolean {
  return categoryOf(kind) === "Java" || kind === "maven" || kind === "gradle" || kind === "tomcat";
}

export function configIcon(config: Pick<RunConfig, "kind" | "isTest">): string {
  if (config.isTest) return "check";
  switch (config.kind) {
    case "compound":
      return "gutter-run-all";
    case "program":
      return "file-binary";
    case "spring-boot":
      return "spring-boot";
    case "npm":
    case "bun":
      return "file-npm";
    case "vue":
      return "file-vue";
    case "deno":
      return "file-ts";
    case "cargo":
      return "file-cargo";
    case "gradle":
      return "file-gradle";
    case "maven":
      return "file-maven";
    case "go":
      return "file-go";
    case "node":
      return "file-js";
    case "application":
      return "class";
    case "java-file":
      return "file-java";
    case "rustc":
      return "file-rust";
    case "cc":
      return "file-cpp";
    case "shell":
      return "file-shell";
    case "ruby":
      return "file-ruby";
    case "php":
      return "file-php";
    case "perl":
      return "file-perl";
    case "lua":
      return "file-lua";
    case "r":
      return "file-r";
    case "swift":
      return "file-swift";
    case "dart":
      return "file-dart";
    case "elixir":
      return "file-elixir";
    case "scala-cli":
      return "file-scala";
    case "kotlinc":
      return "file-kotlin";
    case "kotlin":
      return "file-kotlin-script";
    case "native":
      return "file-binary";
    case "python":
    case "pytest":
      return "file-python";
    default:
      return useRunConfigTypes.getState().types.get(config.kind)?.icon ?? "terminal";
  }
}

export interface ConfigGroup {
  kind: string;
  label: string;
  configs: RunConfig[];
}

/** Groups by kind, keeping the backend's order (detection order) within and across groups. */
export function groupConfigs(configs: readonly RunConfig[]): ConfigGroup[] {
  const groups = new Map<string, ConfigGroup>();
  for (const c of configs) {
    let g = groups.get(c.kind);
    if (!g) groups.set(c.kind, (g = { kind: c.kind, label: kindLabel(c.kind), configs: [] }));
    g.configs.push(c);
  }
  return [...groups.values()];
}

/** Configs persisted in `.openidea/run.toml` (everything not regenerated by detection). */
export function userConfigs(configs: readonly RunConfig[]): RunConfig[] {
  return configs.filter((c) => !c.detected);
}

/**
 * Applies an edit. Editing a detected config produces a user copy with the
 * same id, which then overrides the detected one (`run_configs` drops detected
 * entries whose id a user config shares).
 */
export function upsertConfig(configs: readonly RunConfig[], edited: RunConfig): RunConfig[] {
  const next: RunConfig = { ...edited, detected: false };
  const i = configs.findIndex((c) => c.id === edited.id);
  if (i < 0) return [...configs, next];
  const out = [...configs];
  out[i] = next;
  return out;
}

export function removeConfig(configs: readonly RunConfig[], id: string): RunConfig[] {
  return configs.filter((c) => c.id !== id);
}

/** Merges detected + user configs the way the backend does (user ids win, user configs last). */
export function mergeConfigs(detected: readonly RunConfig[], user: readonly RunConfig[]): RunConfig[] {
  const ids = new Set(user.map((u) => u.id));
  return [...detected.filter((d) => !ids.has(d.id)), ...user];
}

let counter = 0;
export function uid(): string {
  const rnd =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `user:${rnd}${++counter}`;
}

export function uniqueName(base: string, configs: readonly RunConfig[]): string {
  const names = new Set(configs.map((c) => c.name));
  if (!names.has(base)) return base;
  for (let i = 2; ; i++) {
    const n = `${base} (${i})`;
    if (!names.has(n)) return n;
  }
}

export function newConfig(configs: readonly RunConfig[]): RunConfig {
  return {
    id: uid(),
    name: uniqueName("Unnamed", configs),
    kind: "shell",
    command: "",
    args: [],
    cwd: null,
    env: {},
    detected: false,
    isTest: false,
    debugAdapter: null,
  };
}

export function duplicateConfig(config: RunConfig, configs: readonly RunConfig[]): RunConfig {
  return {
    ...structuredClone(config),
    id: uid(),
    name: uniqueName(`${config.name} (copy)`, configs),
    detected: false,
  };
}

/** Field errors: `name`, `command`, `env`, `cwd`, `compound`, `beforeLaunch` or a type param key. */
export type ConfigErrors = Partial<Record<string, string>>;

export function validateConfig(config: RunConfig, all: readonly RunConfig[] = []): ConfigErrors {
  const errors: ConfigErrors = {};
  if (!config.name.trim()) errors.name = "Name is required";
  else if (all.some((c) => c.id !== config.id && c.name.trim() === config.name.trim()))
    errors.name = "Another configuration has this name";
  if (config.kind === "compound") {
    const children = config.compound ?? [];
    if (!children.length) errors.compound = "Add at least one configuration";
    else if (compoundCycle(config, all)) errors.compound = "A compound configuration can't include itself";
    else if (children.some((id) => !all.some((c) => c.id === id)))
      errors.compound = "Some configurations no longer exist";
  } else if (!config.command.trim() && !useRunConfigTypes.getState().types.get(config.kind)?.debugOnly)
    errors.command = "Command is required";
  for (const t of config.beforeLaunch ?? []) {
    if (t.kind === "run" && (t.target === config.id || !all.some((c) => c.id === t.target)))
      errors.beforeLaunch = "A before launch task runs a missing configuration or this one";
    else if (t.kind !== "build" && t.kind !== "run" && !(t.target ?? "").trim())
      errors.beforeLaunch = "A before launch task is incomplete";
  }
  for (const key of Object.keys(config.env)) {
    if (!key.trim()) {
      errors.env = "Environment variable names can't be empty";
      break;
    }
    if (/[=\s\0]/.test(key)) {
      errors.env = `Invalid environment variable name: ${key}`;
      break;
    }
  }
  if (config.cwd && /\0/.test(config.cwd)) errors.cwd = "Invalid directory";
  return errors;
}

export const hasErrors = (e: ConfigErrors) => Object.keys(e).length > 0;

export { parseArgs, formatArgs } from "@/platform/commandLine";

/** Display command line, e.g. `pnpm run dev`. */
export function commandLine(config: Pick<RunConfig, "command" | "args">): string {
  return [config.command, formatArgs(config.args)].filter(Boolean).join(" ");
}

/** Whether compound `config` reaches itself through its children. */
export function compoundCycle(config: RunConfig, all: readonly RunConfig[]): boolean {
  const byId = new Map(all.map((c) => [c.id, c]));
  byId.set(config.id, config);
  const seen = new Set<string>();
  const visit = (id: string): boolean => {
    if (seen.has(id)) return false;
    seen.add(id);
    return (byId.get(id)?.compound ?? []).some((child) => child === config.id || visit(child));
  };
  return visit(config.id);
}

/** The configurations a compound starts (nested compounds flattened, each once). */
export function compoundChildren(config: RunConfig, all: readonly RunConfig[]): RunConfig[] {
  const out: RunConfig[] = [];
  const seen = new Set<string>([config.id]);
  const walk = (ids: readonly string[]) => {
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const c = all.find((x) => x.id === id);
      if (!c) continue;
      if (c.kind === "compound") walk(c.compound ?? []);
      else out.push(c);
    }
  };
  walk(config.compound ?? []);
  return out;
}

/** IDEA's one-line environment field: `A=1;B=2` (`;` and `\` in values escaped). */
export function formatEnv(env: RunConfig["env"]): string {
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v.replace(/[\\;]/g, (c) => `\\${c}`)}`)
    .join(";");
}

/**
 * Parses `A=1;B=2`, or one `NAME=value` per line as pasted from a shell or a
 * `.env` file (`export` prefixes, comments and surrounding quotes dropped).
 */
export function parseEnv(text: string): Array<{ key: string; value: string }> {
  const multiline = /\r?\n/.test(text.trim());
  const entries: string[] = [];
  if (multiline) entries.push(...text.split(/\r?\n/));
  else {
    let cur = "";
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]!;
      if (ch === "\\" && (text[i + 1] === ";" || text[i + 1] === "\\")) cur += text[++i];
      else if (ch === ";") {
        entries.push(cur);
        cur = "";
      } else cur += ch;
    }
    entries.push(cur);
  }
  const out: Array<{ key: string; value: string }> = [];
  for (const raw of entries) {
    let line = multiline ? raw.trim() : raw.trimStart();
    if (!line || (multiline && line.startsWith("#"))) continue;
    if (multiline) line = line.replace(/^export\s+/, "");
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1);
    if (multiline) {
      value = value.trim();
      const q = value[0];
      if ((q === '"' || q === "'") && value.length > 1 && value.endsWith(q)) value = value.slice(1, -1);
    }
    out.push({ key, value });
  }
  return out;
}
