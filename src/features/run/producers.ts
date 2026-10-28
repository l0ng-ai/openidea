/**
 * Run-context producers (IDEA's `RunConfigurationProducer`s): the temporary
 * configuration that runs the element at the caret (a test, a test class, a
 * main function), the file (`node hi.js`, `python3 hi.py`, `go run hi.go`,
 * `rustc` + run …) or a test directory. Pure: runtimes come in through a
 * `ToolEnv`; menus produce with `OPTIMISTIC` (names only), launches with the
 * located tools (`runtimes.ts`).
 *
 * Files outside the project (scratches) run from their own directory with
 * globally installed tools.
 */
import type { RunConfig } from "@/platform/ipc";
import { isTestPath } from "@/platform/languageSettings";
import { currentRoots } from "@/platform/projectRoots";
import { applicationConfig, jvmModuleDir } from "./application";
import { formatArgs } from "./configs";
import { contextConfig, fileRole, projectPython, testBasesFor, testConfigFor } from "./context";
import { detectRunTargets, targetConfig, targetLanguage, type RunTarget } from "./targets";
import { tx } from "@/platform/i18n";

export interface LocatedTool {
  path: string | null;
  version: string | null;
}

export interface ToolEnv {
  /** `undefined`: unknown (no lookup) → the bare name, resolved at launch; `null`: not installed. */
  tool(name: string): LocatedTool | null | undefined;
  /** Where single source files are compiled to. */
  compileDir: string;
  /** Windows: compile-and-run lines are for `cmd /c` (quoting, `.exe`, `mkdir`). */
  windows?: boolean;
  /** The project interpreter from settings (Python). */
  python?: string | null;
  /** The project root has `deno.json(c)` / `bun.lock(b)`. */
  deno?: boolean;
  bun?: boolean;
}

/** Names only: every tool unknown. */
export const OPTIMISTIC: ToolEnv = { tool: () => undefined, compileDir: "/tmp/openidea-run" };

export interface ContextInput {
  /** Absolute path of the file or directory. */
  path: string;
  /** Project root (null without a project). */
  root: string | null;
  configs: readonly RunConfig[];
  /** File text (at least the first 20 000 characters) when known. */
  content?: string;
  /** Go: the module path of a module directory (`go.mod`), when known. */
  goModule?: (dir: string) => string | null | undefined;
  /** 0-based caret line: the element at the caret wins over the file. */
  line?: number;
}

export interface Missing {
  title: string;
  body: string;
}

export interface Produced {
  /** Configuration name, as in "Run '<name>'". */
  name: string;
  scope: "element" | "file" | "directory";
  config?: RunConfig;
  /** The runtime is not installed: what to install. */
  missing?: Missing;
  /** Compiled single files: build `build`, then debug `config` (the binary). */
  debug?: { build: RunConfig; config: RunConfig };
  /** Among several choices: the configuration it derives from (`npm run test:unit`). */
  detail?: string;
}

// ---------------------------------------------------------------------------
// Paths

const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const dirName = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) || "/" : "");
const stemOf = (p: string) => baseName(p).replace(/\.[^.]+$/, "");

function inProject(path: string, root: string | null): boolean {
  return !!root && (path === root || path.startsWith(root + "/"));
}

function relTo(path: string, root: string | null): string {
  return root && path.startsWith(root + "/") ? path.slice(root.length + 1) : path;
}

/** Short stable hash, so compiled binaries of same-named files don't collide. */
function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** One word for the platform shell: POSIX `sh` quoting, or `cmd`'s double quotes. */
export function shellWord(s: string, windows = false): string {
  if (!windows) return formatArgs([s]);
  if (s === "") return '""';
  return /[\s"&|<>^(),;=%!']/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** A command for the platform shell; `cmd` runs a batch file (`kotlinc.bat`) with `call` so `&&` sees its exit code. */
function shellLine(words: readonly string[], windows = false): string {
  const line = words.map((w) => shellWord(w, windows)).join(" ");
  return windows && /\.(bat|cmd)$/i.test(words[0] ?? "") ? `call ${line}` : line;
}

/** A path for the platform shell (backslashes for `cmd`). */
const nativePath = (p: string, windows = false) => (windows ? p.replace(/\//g, "\\") : p);

/** Creates `dir` (with parents) if missing, as a shell command. */
function mkdirLine(dir: string, windows = false): string {
  if (!windows) return `mkdir -p ${shellWord(dir)}`;
  const d = shellWord(nativePath(dir, true), true);
  return `(if not exist ${d} mkdir ${d})`;
}

/** Absolute directory of a configuration's working directory (a Go module). */
export function goModuleDir(root: string, cwd: string | null): string {
  const rel = (cwd ?? "").replace(/^\.(?:\/|$)/, "").replace(/\/+$/, "");
  if (rel.startsWith("/")) return rel;
  return rel ? `${root}/${rel}` : root;
}

/**
 * GoLand's names for `go test` configurations: `go test <package>` and
 * `TestFoo in <package>`, the package being its import path (module path from
 * `go.mod`), else the `package` clause or directory.
 */
export function goTestNamed(
  config: RunConfig,
  input: Pick<ContextInput, "root" | "content" | "goModule">,
  test?: string,
): RunConfig {
  if (config.kind !== "go" || config.args[0] !== "test") return config;
  const pkgArg =
    config.args.find((a, i) => i > 0 && !a.startsWith("-") && !/^-(run|skip|bench)$/.test(config.args[i - 1]!)) ?? ".";
  const recursive = /(^|\/)\.\.\.$/.test(pkgArg);
  const dir = pkgArg.replace(/\/?\.\.\.$/, "").replace(/^\.(?:\/|$)/, "");
  const module = input.root ? input.goModule?.(goModuleDir(input.root, config.cwd)) : undefined;
  const clause = /^\s*package\s+(\w+)/m.exec(input.content ?? "")?.[1];
  const base = module ? (dir ? `${module}/${dir}` : module) : (clause ?? (dir || "."));
  const pkg = recursive ? `${base}/...` : base;
  return { ...config, name: test ? `${test} in ${pkg}` : `go test ${pkg}` };
}

// ---------------------------------------------------------------------------
// Languages

export type ScriptLanguage =
  | "js"
  | "ts"
  | "python"
  | "shell"
  | "ruby"
  | "php"
  | "perl"
  | "lua"
  | "r"
  | "go"
  | "rust"
  | "java"
  | "kotlin"
  | "kotlin-script"
  | "swift"
  | "c"
  | "cpp"
  | "dart"
  | "elixir"
  | "scala"
  | "shebang";

/** `#!/usr/bin/env -S deno run` → `["deno", "run"]`; `#!/bin/zsh -f` → `["/bin/zsh", "-f"]`. */
export function shebang(content: string | undefined): string[] | null {
  const m = /^#!\s*(\S+)(.*)$/m.exec(content?.split("\n", 1)[0] ?? "");
  if (!m) return null;
  const rest = m[2]!.trim().split(/\s+/).filter(Boolean);
  if (/(^|\/)env$/.test(m[1]!)) {
    const args = rest[0] === "-S" ? rest.slice(1) : rest.filter((a) => !a.startsWith("-"));
    return args.length ? args : null;
  }
  return [m[1]!, ...rest];
}

const interpreterName = (cmd: string) => baseName(cmd).replace(/\.exe$/, "");

export function scriptLanguage(path: string, content?: string): ScriptLanguage | null {
  const name = baseName(path);
  if (/\.[cm]?js$/.test(name)) return "js";
  if (/\.[cm]?ts$/.test(name) && !/\.d\.[cm]?ts$/.test(name)) return "ts";
  if (/\.pyw?$/.test(name)) return "python";
  if (/\.(sh|bash|zsh)$/.test(name)) return "shell";
  if (/\.rb$/.test(name)) return "ruby";
  if (/\.php$/.test(name)) return "php";
  if (/\.pl$/.test(name)) return "perl";
  if (/\.lua$/.test(name)) return "lua";
  if (/\.[rR]$/.test(name)) return "r";
  if (/\.go$/.test(name)) return "go";
  if (/\.rs$/.test(name)) return "rust";
  if (/\.java$/.test(name)) return "java";
  if (/\.kt$/.test(name)) return "kotlin";
  if (/\.kts$/.test(name) && !/\.gradle\.kts$/.test(name)) return "kotlin-script";
  if (/\.swift$/.test(name)) return "swift";
  if (/\.c$/.test(name)) return "c";
  if (/\.(cpp|cc|cxx|c\+\+)$/.test(name)) return "cpp";
  if (/\.dart$/.test(name)) return "dart";
  if (/\.exs$/.test(name)) return "elixir";
  if (/\.(scala|sc)$/.test(name)) return "scala";
  if (!name.includes(".") && shebang(content)) return "shebang";
  return null;
}

/** Tools a file of `lang` may run with, in preference order. */
export function toolsFor(lang: ScriptLanguage, content?: string): string[] {
  switch (lang) {
    case "js":
      return ["node", "deno", "bun"];
    case "ts":
      return ["node", "tsx", "ts-node", "deno", "bun"];
    case "python":
      return ["python3", "python"];
    case "shell":
    case "shebang": {
      const sb = shebang(content);
      const fromShebang = sb ? [interpreterName(sb[0]!)] : [];
      return [...fromShebang, ...(lang === "shell" ? ["bash", "zsh", "sh"] : [])].filter(
        (n, i, all) => all.indexOf(n) === i,
      );
    }
    case "ruby":
      return ["ruby"];
    case "php":
      return ["php"];
    case "perl":
      return ["perl"];
    case "lua":
      return ["lua"];
    case "r":
      return ["Rscript"];
    case "go":
      return ["go"];
    case "rust":
      return ["rustc"];
    case "java":
      return ["java"];
    case "kotlin":
      return ["kotlinc"];
    case "kotlin-script":
      return ["kotlin", "kotlinc"];
    case "swift":
      return ["swift"];
    case "c":
      return ["clang", "gcc", "cc"];
    case "cpp":
      return ["clang++", "g++", "c++"];
    case "dart":
      return ["dart"];
    case "elixir":
      return ["elixir"];
    case "scala":
      return ["scala-cli"];
  }
}

/** Install suggestions for a missing runtime. */
const INSTALL: Record<string, string> = {
  js: "Install Node.js from https://nodejs.org (or `brew install node`).",
  python: "Install Python (`brew install python`) or choose an interpreter in Settings › Python Interpreter.",
  ruby: "Install Ruby (`brew install ruby`).",
  php: "Install PHP (`brew install php`).",
  perl: "Install Perl (`brew install perl`).",
  lua: "Install Lua (`brew install lua`).",
  r: "Install R (`brew install r`) so that `Rscript` is on the PATH.",
  go: "Install Go from https://go.dev/dl (or `brew install go`).",
  rust: "Install Rust with rustup: https://rustup.rs",
  java: "Install a JDK 11+ (`brew install openjdk`), or download one in Settings › Languages & Frameworks › Java (Project JDK › Download JDK…).",
  kotlin:
    "Install the Kotlin compiler (`brew install kotlin`, or https://kotlinlang.org/docs/command-line.html) so that `kotlinc` is on the PATH.",
  "kotlin-script": "Install Kotlin (`brew install kotlin`).",
  swift: "Install the Xcode command line tools (`xcode-select --install`).",
  c: "Install a C compiler: `xcode-select --install` (clang) or `brew install gcc`.",
  cpp: "Install a C++ compiler: `xcode-select --install` (clang++) or `brew install gcc`.",
  dart: "Install the Dart SDK (`brew install dart-sdk`).",
  elixir: "Install Elixir (`brew install elixir`).",
  scala: "Install Scala CLI (`brew install Virtuslab/scala-cli/scala-cli`).",
  shell: "Install the shell named in the script's #! line.",
  shebang: "Install the interpreter named in the script's #! line.",
};

const LANGUAGE_NAMES: Partial<Record<ScriptLanguage, string>> = {
  js: "Node.js",
  ts: "TypeScript",
  python: "Python",
  r: "R",
  go: "Go",
  rust: "rustc",
  java: "Java",
  kotlin: "The Kotlin compiler",
  "kotlin-script": "Kotlin",
  c: "A C compiler",
  cpp: "A C++ compiler",
  scala: "Scala CLI",
};

function missing(lang: ScriptLanguage, file: string, tools: string[]): Missing {
  const what = LANGUAGE_NAMES[lang] ?? tools[0] ?? lang;
  return {
    title: tx`Cannot run '${file}'`,
    body: `${what} was not found (looked for ${tools.map((t) => `\`${t}\``).join(", ")}). ${INSTALL[lang] ?? ""}`.trim(),
  };
}

/** First available tool: its path (bare name when unknown), or null when none is installed. */
function pick(env: ToolEnv, names: readonly string[]): { name: string; command: string; tool?: LocatedTool } | null {
  for (const name of names) {
    const t = env.tool(name);
    if (t === undefined) return { name, command: name };
    if (t?.path) return { name, command: t.path, tool: t };
  }
  return null;
}

/** `major.minor` of a version string, or null. */
function semver(v: string | null | undefined): [number, number] | null {
  const m = /^(\d+)\.(\d+)/.exec(v ?? "");
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/**
 * Node's built-in TypeScript support: unflagged on 23.6+ and 22.18+, behind
 * `--experimental-strip-types` on 22.6–22.17 and 23.0–23.5, none before.
 */
export function nodeTypeStripping(version: string | null | undefined): "native" | "flag" | null {
  const v = semver(version);
  if (!v) return null;
  const [major, minor] = v;
  if (major > 23 || (major === 23 && minor >= 6) || (major === 22 && minor >= 18)) return "native";
  if ((major === 22 && minor >= 6) || major === 23) return "flag";
  return null;
}

// ---------------------------------------------------------------------------
// File-level producers

interface FileSite {
  /** Id path (project-relative inside the project). */
  idPath: string;
  /** File argument and working directory: project-relative from the root, or the file name from its directory. */
  arg: string;
  cwd: string | null;
  file: string;
  inProject: boolean;
}

function site(input: ContextInput): FileSite {
  const inside = inProject(input.path, input.root);
  const rel = relTo(input.path, input.root);
  return {
    idPath: rel,
    arg: inside ? rel : baseName(input.path),
    cwd: inside ? null : dirName(input.path),
    file: baseName(input.path),
    inProject: inside,
  };
}

function fileConfig(
  s: FileSite,
  kind: string,
  command: string,
  args: string[],
  debugAdapter: string | null = null,
): RunConfig {
  return {
    id: `context:file:${s.idPath}`,
    name: s.file,
    kind,
    command,
    args,
    cwd: s.cwd,
    env: {},
    detected: true,
    isTest: false,
    debugAdapter,
  };
}

/** Python: the interpreter from settings, the detected project interpreter, then `python3` on the PATH. */
function pythonCommand(input: ContextInput, env: ToolEnv, s: FileSite): { command: string; prefix: string[] } | null {
  if (env.python) return { command: env.python, prefix: [] };
  const py = projectPython([...input.configs]);
  if (py) {
    // A venv-relative interpreter is relative to the project root.
    const command =
      !s.inProject && input.root && py.command.includes("/") && !py.command.startsWith("/")
        ? `${input.root}/${py.command.replace(/^\.\//, "")}`
        : py.command;
    return { command, prefix: py.prefix };
  }
  const t = pick(env, ["python3", "python"]);
  return t ? { command: t.command, prefix: [] } : null;
}

function jsRuntime(lang: "js" | "ts", env: ToolEnv, s: FileSite): Produced {
  const name = s.file;
  const ok = (config: RunConfig): Produced => ({ name, scope: "file", config });
  if (s.inProject && env.deno) {
    const deno = pick(env, ["deno"]);
    if (deno) return ok(fileConfig(s, "deno", deno.command, ["run", s.arg], "js-debug"));
  }
  if (s.inProject && env.bun) {
    const bun = pick(env, ["bun"]);
    if (bun) return ok(fileConfig(s, "bun", bun.command, ["run", s.arg]));
  }
  const node = env.tool("node");
  const nodeCmd = node === undefined ? "node" : (node?.path ?? null);
  if (lang === "js") {
    if (!nodeCmd) return { name, scope: "file", missing: missing("js", name, ["node"]) };
    return ok(fileConfig(s, "node", nodeCmd, [s.arg], "js-debug"));
  }
  const strip = nodeCmd ? nodeTypeStripping(node?.version) : null;
  if (nodeCmd && strip === "native") return ok(fileConfig(s, "node", nodeCmd, [s.arg], "js-debug"));
  if (nodeCmd && strip === "flag")
    return ok(fileConfig(s, "node", nodeCmd, ["--experimental-strip-types", s.arg], "js-debug"));
  for (const runner of ["tsx", "ts-node"]) {
    const t = env.tool(runner);
    if (t?.path) return ok(fileConfig(s, "node", t.path, [s.arg], "js-debug"));
  }
  // Nothing known (no lookup available): let npx find or fetch tsx.
  if (node === undefined) return ok(fileConfig(s, "node", "npx", ["tsx", s.arg], "js-debug"));
  const found = node?.version ? `Found Node.js ${node.version}. ` : nodeCmd ? "" : "Node.js was not found. ";
  return {
    name,
    scope: "file",
    missing: {
      title: tx`Cannot run '${name}'`,
      body:
        `Running TypeScript needs Node.js 22.6+ (type stripping), tsx or ts-node. ${found}` +
        "Upgrade Node.js (https://nodejs.org), or install tsx: `npm install -D tsx` (or `npm install -g tsx`).",
    },
  };
}

/** Compile command of a single C / C++ / Rust / Kotlin file, as a shell line that builds and then runs. */
function compiled(
  input: ContextInput,
  env: ToolEnv,
  s: FileSite,
  lang: "rust" | "c" | "cpp" | "kotlin",
  test?: { filter?: string[]; name: string },
): Produced {
  const win = !!env.windows;
  const tools = toolsFor(lang);
  const compiler = pick(env, tools);
  const name = test?.name ?? s.file;
  const scope = test ? "element" : "file";
  if (!compiler) return { name, scope, missing: missing(lang, s.file, tools) };
  const java = lang === "kotlin" ? pick(env, ["java"]) : null;
  if (lang === "kotlin" && !java) return { name, scope, missing: missing("java", s.file, ["java"]) };
  const dir = env.compileDir.replace(/\\/g, "/").replace(/(.)\/+$/, "$1");
  const ext = lang === "kotlin" ? ".jar" : win ? ".exe" : "";
  const out = nativePath(`${dir}/${stemOf(s.file)}-${hash(input.path)}${test ? "-test" : ""}${ext}`, win);
  const flags =
    lang === "rust"
      ? ["-g", "--edition", "2021", ...(test ? ["--test"] : []), "-o", out, s.arg]
      : lang === "kotlin"
        ? // The jar's manifest names the file's main class (`HiKt`, `pkg.HiKt`).
          ["-include-runtime", "-d", out, s.arg]
        : ["-g", ...(lang === "cpp" ? ["-std=c++17"] : []), "-o", out, s.arg];
  const build = `${mkdirLine(dir, win)} && ${shellLine([compiler.command, ...flags], win)}`;
  const runArgs = test?.filter ?? [];
  const run = lang === "kotlin" ? [java!.command, "-jar", out] : [out, ...runArgs];
  const kind = lang === "rust" ? "rustc" : lang === "kotlin" ? "kotlinc" : "cc";
  const idPath = test ? `${s.idPath}#${test.name}` : s.idPath;
  const debugAdapter = lang === "kotlin" ? null : "codelldb";
  const config: RunConfig = {
    ...fileConfig(s, kind, `${build} && ${shellLine(run, win)}`, [], debugAdapter),
    id: `context:file:${idPath}`,
    name,
    isTest: !!test,
  };
  if (!debugAdapter) return { name, scope, config };
  const buildConfig: RunConfig = {
    ...config,
    id: `context:build:${idPath}`,
    name: `Build ${s.file}`,
    command: build,
    isTest: false,
    debugAdapter: null,
  };
  const binary: RunConfig = { ...config, kind: "native", command: out, args: runArgs, isTest: false };
  return { name, scope, config, debug: { build: buildConfig, config: binary } };
}

function simple(
  lang: ScriptLanguage,
  s: FileSite,
  env: ToolEnv,
  kind: string,
  args: (command: string, tool: string) => string[],
  debugAdapter: string | null = null,
): Produced {
  const tools = toolsFor(lang);
  const t = pick(env, tools);
  if (!t) return { name: s.file, scope: "file", missing: missing(lang, s.file, tools) };
  return { name: s.file, scope: "file", config: fileConfig(s, kind, t.command, args(t.command, t.name), debugAdapter) };
}

const hasGoMain = (content?: string) => content === undefined || /^\s*package\s+main\b/m.test(content);
const hasRustMain = (content?: string) =>
  content === undefined || /^(?:pub\s+)?(?:async\s+)?fn\s+main\s*\(/m.test(content);
const hasCMain = (content?: string) => content === undefined || /^\s*(?:int|void)\s+main\s*\(/m.test(content);
/** A top-level `fun main` (with or without `args`, `suspend` allowed). */
const hasKotlinMain = (content?: string) => content === undefined || /^(?:suspend\s+)?fun\s+main\s*\(/m.test(content);

/**
 * The configs of the given build tools whose build contains the file (working
 * directory at or above it): a build nested in a folder of repositories owns only its files.
 */
function buildOwners(rel: string, configs: readonly RunConfig[], kinds: readonly string[]): RunConfig[] {
  return configs.filter((c) => {
    if (!kinds.includes(c.kind)) return false;
    const cwd = (c.cwd ?? "").replace(/^\.\/?/, "").replace(/\/+$/, "");
    return !cwd || rel.startsWith(cwd + "/");
  });
}

const cargoOwner = (rel: string, configs: readonly RunConfig[]) => buildOwners(rel, configs, ["cargo"]);
const hasBuildTool = (rel: string, configs: readonly RunConfig[], kinds: readonly string[]) =>
  buildOwners(rel, configs, kinds).length > 0;
const JVM_BUILDS = ["maven", "gradle"];

/**
 * A Godot scene: `godot --path <project> res://<scene>` in the Godot project holding it
 * (a detected "Godot Project" configuration), debuggable through the editor's adapter.
 */
function godotScene(rel: string, configs: readonly RunConfig[]): Produced | null {
  const dirs = configs
    .filter((c) => c.kind === "godot" && c.detected && c.id.startsWith("godot:project"))
    .map((c) => (c.cwd ?? "").replace(/^\.\/?/, "").replace(/\/+$/, ""));
  const dir = dirs.filter((d) => !d || rel.startsWith(d + "/")).sort((a, b) => b.length - a.length)[0];
  if (dir === undefined) return null;
  const name = baseName(rel);
  const scene = `res://${dir ? rel.slice(dir.length + 1) : rel}`;
  const config: RunConfig = {
    id: `context:file:${rel}`,
    name,
    kind: "godot",
    command: "godot",
    args: ["--path", ".", scene],
    cwd: dir || null,
    env: {},
    detected: true,
    isTest: false,
    debugAdapter: "godot",
  };
  return { name, scope: "file", config };
}

/** The file as a whole: tests of a test file, the project's run target, or the runtime for its language. */
export function produceFile(input: ContextInput, env: ToolEnv): Produced | null {
  const s = site(input);
  const lang = scriptLanguage(input.path, input.content);
  const configs = [...input.configs];
  const rel = s.idPath;

  if (s.inProject) {
    if (/\.t?scn$/i.test(rel)) return godotScene(rel, configs);
    // Project-aware: test files through the project's test runner, Cargo / Go / Gradle / Maven mains.
    const role = fileRole(rel, input.content);
    if (role === "test") {
      const found = testConfigFor(rel, configs);
      const test = found && goTestNamed(found, input);
      if (test) return { name: test.name, scope: "file", config: test };
    }
    if (lang === "rust" && cargoOwner(rel, configs).length) {
      const example = /(?:^|\/)examples\/([^/]+)\.rs$/.exec(rel)?.[1];
      if (example && hasRustMain(input.content)) {
        const base = cargoOwner(rel, configs).find((c) => c.id.startsWith("cargo:run")) ?? cargoOwner(rel, configs)[0]!;
        const config: RunConfig = {
          ...base,
          id: `context:file:${rel}`,
          name: `Run ${example}`,
          args: ["run", "--example", example],
          env: { ...base.env },
          isTest: false,
          detected: true,
          debugAdapter: "codelldb",
        };
        return { name: config.name, scope: "file", config };
      }
      if (role !== "main") return null;
      const main = contextConfig(rel, configs, input.content);
      return main ? { name: main.name, scope: "file", config: main } : null;
    }
    if (lang === "go" && hasBuildTool(rel, configs, ["go"])) {
      if (!hasGoMain(input.content)) return null;
      const main = contextConfig(rel, configs, input.content ?? "package main");
      if (main) return { name: main.name, scope: "file", config: main };
    }
    if (/\.(java|kt)$/.test(rel) && hasBuildTool(rel, configs, JVM_BUILDS)) {
      if (input.content === undefined) return null;
      const targets = detectRunTargets(input.content, rel).filter((t) => t.className);
      const target = targets.find((t) => t.kind === "main") ?? targets.find((t) => t.kind === "suite");
      const config = target ? targetConfig(target, rel, configs, input.content) : null;
      return config ? { name: config.name, scope: "file", config } : null;
    }
  }
  if (!lang) return null;

  switch (lang) {
    case "js":
    case "ts":
      return jsRuntime(lang, env, s);
    case "python": {
      const py = pythonCommand(input, env, s);
      if (!py) return { name: s.file, scope: "file", missing: missing("python", s.file, ["python3", "python"]) };
      return {
        name: s.file,
        scope: "file",
        config: fileConfig(s, "python", py.command, [...py.prefix, s.arg], "debugpy"),
      };
    }
    case "shell":
    case "shebang": {
      const sb = shebang(input.content);
      const tools = toolsFor(lang, input.content);
      if (lang === "shebang" && sb) {
        const interp = interpreterName(sb[0]!);
        if (/^python[\d.]*$/.test(interp)) {
          const py = pythonCommand(input, env, s);
          if (py)
            return {
              name: s.file,
              scope: "file",
              config: fileConfig(s, "python", py.command, [...py.prefix, s.arg], "debugpy"),
            };
        }
        const t = sb[0]!.startsWith("/") ? { command: sb[0]!, name: interp } : pick(env, [interp]);
        if (!t) return { name: s.file, scope: "file", missing: missing(lang, s.file, [interp]) };
        const kind = /^(ba|z|k|da|fi)?sh$/.test(interp) ? "shell" : interp === "node" ? "node" : interp;
        return {
          name: s.file,
          scope: "file",
          config: fileConfig(
            s,
            kind,
            t.command,
            [...sb.slice(1), s.arg],
            interp === "node" || interp === "deno" ? "js-debug" : null,
          ),
        };
      }
      // A shell script: the shell of its #! line, else by extension.
      const preferred = sb
        ? interpreterName(sb[0]!)
        : /\.bash$/.test(s.file)
          ? "bash"
          : /\.zsh$/.test(s.file)
            ? "zsh"
            : "sh";
      const t = pick(env, [preferred]);
      if (!t) return { name: s.file, scope: "file", missing: missing("shell", s.file, tools) };
      return {
        name: s.file,
        scope: "file",
        config: fileConfig(s, "shell", t.command, [...(sb?.slice(1) ?? []), s.arg]),
      };
    }
    case "ruby":
    case "php":
    case "perl":
    case "lua":
    case "swift":
    case "elixir":
      return simple(lang, s, env, lang, () => [s.arg]);
    case "r":
      return simple(lang, s, env, "r", () => [s.arg]);
    case "dart":
      return simple(lang, s, env, "dart", () => ["run", s.arg]);
    case "scala":
      return simple(lang, s, env, "scala-cli", () => ["run", s.arg]);
    case "kotlin":
      // `kotlinc` into a runnable jar, then `java -jar`.
      return hasKotlinMain(input.content) ? compiled(input, env, s, "kotlin") : null;
    case "kotlin-script":
      return simple(lang, s, env, "kotlin", (_, tool) => (tool === "kotlinc" ? ["-script", s.arg] : [s.arg]));
    case "go":
      if (!hasGoMain(input.content) || /_test\.go$/.test(s.file)) return null;
      return simple(lang, s, env, "go", () => ["run", s.arg], "delve");
    case "java":
      if (input.content !== undefined && !/\bvoid\s+main\s*\(/.test(input.content)) return null;
      // JEP 330: `java Hi.java` compiles and runs a single source file.
      return simple(lang, s, env, "java-file", () => [s.arg], "java-debug");
    case "rust":
      if (!hasRustMain(input.content)) {
        // A standalone file with tests only: run them all.
        return input.content !== undefined && /#\[test\]/.test(input.content)
          ? compiled(input, env, s, "rust", { name: s.file })
          : null;
      }
      return compiled(input, env, s, "rust");
    case "c":
    case "cpp":
      return hasCMain(input.content) ? compiled(input, env, s, lang) : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Element at the caret

/** Last line (0-based, inclusive) of the declaration starting at `target.line`. */
export function targetEnd(lines: readonly string[], target: RunTarget, python: boolean): number {
  const start = target.line;
  if (python) {
    const indent = /^\s*/.exec(lines[start] ?? "")![0].length;
    let end = start;
    for (let i = start + 1; i < lines.length; i++) {
      const l = lines[i]!;
      if (!l.trim() || /^\s*#/.test(l)) continue;
      if (/^\s*/.exec(l)![0].length <= indent) break;
      end = i;
    }
    return end;
  }
  let depth = 0;
  let opened = false;
  for (let i = start; i < lines.length; i++) {
    const code = lines[i]!.replace(/\/\/.*$/, "")
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
      .replace(/'(?:[^'\\]|\\.)*'/g, "''")
      .replace(/`(?:[^`\\]|\\.)*`/g, "``");
    for (const ch of code) {
      if (ch === "{") {
        depth++;
        opened = true;
      } else if (ch === "}") depth--;
    }
    if (opened && depth <= 0) return i;
    if (!opened && i - start > 5) return start;
  }
  return opened ? lines.length - 1 : start;
}

/** The innermost run target whose declaration contains `line`. */
export function innermostTarget(
  content: string,
  targets: readonly RunTarget[],
  line: number,
  python = false,
): RunTarget | null {
  const lines = content.split("\n");
  let best: RunTarget | null = null;
  for (const t of targets) {
    if (t.line > line) continue;
    if (line > targetEnd(lines, t, python)) continue;
    if (!best || t.line >= best.line) best = t;
  }
  return best;
}

/** Standalone (outside a build project) files: Rust `fn main` / tests anywhere, C / C++ `main`. */
export function standaloneTargets(content: string, path: string): RunTarget[] {
  const lines = content.split("\n");
  const out: RunTarget[] = [];
  if (/\.rs$/.test(path)) {
    // Detect as if it were a crate root (`src/main.rs`): main and test paths without a module prefix.
    return detectRunTargets(content, "src/main.rs");
  }
  if (/\.(c|cpp|cc|cxx)$/.test(path)) {
    lines.forEach((l, i) => {
      if (/^\s*(?:int|void)\s+main\s*\(/.test(l)) out.push({ line: i, kind: "main", name: "main", path: [] });
    });
  }
  return out;
}

/** Run targets of a file for the caret / gutter: project-aware inside the project, standalone outside. */
export function fileTargets(input: Pick<ContextInput, "path" | "root" | "configs">, content: string): RunTarget[] {
  const s = { inProject: inProject(input.path, input.root), rel: relTo(input.path, input.root) };
  const rust = /\.rs$/.test(input.path);
  if (/\.(c|cpp|cc|cxx)$/.test(input.path)) return standaloneTargets(content, input.path);
  const cargo =
    s.inProject && (cargoOwner(s.rel, input.configs).length > 0 || /(^|\/)(src|tests|examples|benches)\//.test(s.rel));
  if (rust && !cargo) return standaloneTargets(content, input.path);
  if (!targetLanguage(input.path)) return [];
  if (!s.inProject) {
    // Scratches: mains only (tests need the project's runner).
    const isGo = /\.go$/.test(input.path);
    return detectRunTargets(content, isGo || /\.py$/.test(input.path) ? input.path : s.rel).filter(
      (t) => t.kind === "main" && (!t.className || /\.(java|kt)$/.test(input.path)),
    );
  }
  return detectRunTargets(content, s.rel);
}

function elementProduction(input: ContextInput, env: ToolEnv, target: RunTarget): Produced | null {
  const s = site(input);
  const rel = s.idPath;
  if (target.kind === "main") {
    // Java / Kotlin main classes in a Maven / Gradle project: an Application configuration.
    if (target.className && s.inProject && hasBuildTool(rel, input.configs, JVM_BUILDS)) {
      const config = applicationConfig({ className: target.className, spring: target.spring }, rel, input.configs);
      return { name: config.name, scope: "element", config };
    }
    const file = produceFile(input, env);
    return file ? { ...file, scope: "element" } : null;
  }
  const rust = /\.rs$/.test(input.path);
  if (rust && !(s.inProject && cargoOwner(rel, input.configs).length)) {
    const path = target.path.join("::");
    const filter = target.kind === "suite" ? [`${path}::`] : [path, "--exact"];
    const name = target.kind === "suite" ? target.path[target.path.length - 1]! : path;
    return compiled(input, env, s, "rust", { name, filter });
  }
  if (!s.inProject) return null;
  const found = targetConfig(target, rel, [...input.configs], input.content);
  const config = found && goTestNamed(found, input, target.name);
  return config ? { name: config.name, scope: "element", config } : null;
}

/**
 * IDEA's ⌃⇧R: the innermost context at the caret — a test or test class, a
 * main function — else the file.
 */
export function produceContext(input: ContextInput, env: ToolEnv): Produced | null {
  if (input.content !== undefined && input.line !== undefined) {
    const targets = fileTargets(input, input.content.slice(0, 400_000));
    const inner = innermostTarget(input.content, targets, input.line, /\.py$/.test(input.path));
    if (inner) {
      const p = elementProduction(input, env, inner);
      if (p) return p;
    }
  }
  return produceFile(input, env);
}

/**
 * Every configuration that can run the context, when several test
 * configurations match it equally well (`npm run test` and `npm run test:unit`):
 * like IDEA, the user then chooses one. A single production otherwise.
 */
export function produceContextChoices(input: ContextInput, env: ToolEnv): Produced[] {
  const produced = produceContext(input, env);
  if (!produced?.config || produced.scope === "directory" || !inProject(input.path, input.root))
    return produced ? [produced] : [];
  const rel = relTo(input.path, input.root);
  const bases = testBasesFor(rel, [...input.configs]);
  if (bases.length < 2) return [produced];
  let element: RunTarget | null = null;
  if (produced.scope === "element") {
    const targets = fileTargets(input, (input.content ?? "").slice(0, 400_000));
    element = innermostTarget(input.content ?? "", targets, input.line ?? 0, /\.py$/.test(input.path));
    if (!element || element.kind === "main") return [produced];
  } else if (!produced.config.isTest) {
    return [produced];
  }
  const out: Produced[] = [];
  for (const base of bases) {
    const found = element
      ? targetConfig(element, rel, [...input.configs], input.content, base)
      : testConfigFor(rel, [...input.configs], base);
    const config = found && goTestNamed(found, input, element?.name);
    if (!config || out.some((o) => o.config?.id === config.id)) continue;
    out.push({ name: config.name, scope: produced.scope, config, detail: base.name });
  }
  return out.length > 1 ? out : [produced];
}

// ---------------------------------------------------------------------------
// Directories (project view): "Run 'Tests in 'dir''", "Run 'All Tests'"

const TEST_DIR = /(^|\/)(tests?|__tests__|specs?|test_?\w*)$/;

export function produceDirectory(input: ContextInput): Produced | null {
  const { root } = input;
  if (!root || !inProject(input.path, root) || input.path === root) return null;
  const rel = relTo(input.path, root);
  const name = baseName(rel);
  const jvmRoot = /^(?:(.*)\/)?src\/test(?:\/(java|kotlin|scala|groovy))?$/.exec(rel);
  const jvmPackage = /^(?:(.*)\/)?src\/test\/(?:java|kotlin|scala|groovy)\/(.+)$/.exec(rel);
  const marked = isTestPath(currentRoots(), rel);
  if (!TEST_DIR.test(rel) && !jvmRoot && !jvmPackage && !marked && !/(^|\/)src\/test(\/|$)/.test(rel)) return null;
  const tests = input.configs.filter((c) => c.isTest);
  const closest = (kinds: string[]) => {
    const cands = tests.filter((c) => kinds.includes(c.kind));
    const score = (c: RunConfig) => {
      const cwd = (c.cwd ?? "").replace(/^\.\/?/, "").replace(/\/+$/, "");
      if (!cwd) return 0;
      return rel === cwd || rel.startsWith(cwd + "/") ? cwd.length : -1;
    };
    return cands
      .map((c) => [c, score(c)] as const)
      .filter(([, n]) => n >= 0)
      .sort((a, b) => b[1] - a[1])[0]?.[0];
  };
  const relToCwd = (c: RunConfig) => {
    const cwd = (c.cwd ?? "").replace(/^\.\/?/, "").replace(/\/+$/, "");
    return cwd && rel.startsWith(cwd + "/") ? rel.slice(cwd.length + 1) : rel === cwd ? "" : rel;
  };
  const make = (base: RunConfig, label: string, args: string[]): Produced => ({
    name: label,
    scope: "directory",
    config: { ...base, id: `context:dir:${base.id}:${rel}`, name: label, args, env: { ...base.env }, detected: true },
  });
  const testsIn = `Tests in '${name}'`;

  if (jvmRoot || jvmPackage || /(^|\/)src\/test(\/|$)/.test(rel)) {
    const base = closest(["gradle", "maven"]);
    if (base) {
      const module = jvmModuleDir(rel + "/x.java", input.configs);
      const moduleBase = { ...base, cwd: module || base.cwd };
      if (!jvmPackage) return make(moduleBase, "All Tests", [...base.args]);
      const pkg = jvmPackage[2]!.replace(/\//g, ".");
      return base.kind === "gradle"
        ? make(moduleBase, `Tests in '${pkg}'`, [...base.args, "--tests", `${pkg}.*`])
        : make(moduleBase, `Tests in '${pkg}'`, [
            ...base.args,
            `-Dtest=${pkg}.**.*`,
            "-Dsurefire.failIfNoSpecifiedTests=false",
          ]);
    }
  }
  const js = closest(["npm", "bun", "deno"]);
  const py = closest(["pytest"]);
  const go = closest(["go"]);
  const cargo = closest(["cargo"]);
  if (cargo && /(^|\/)tests$/.test(rel) && !js && !py) return make(cargo, "All Tests", [...cargo.args, "--tests"]);
  if (py && (!js || /(^|\/)tests?$/.test(rel))) return make(py, testsIn, [...py.args, relToCwd(py)]);
  if (js) {
    const dir = relToCwd(js);
    if (js.kind === "deno") return make(js, testsIn, [...js.args, dir]);
    return make(js, testsIn, js.args.includes("--") ? [...js.args, dir] : [...js.args, "--", dir]);
  }
  if (go) {
    const dir = relToCwd(go);
    const p = make(
      go,
      testsIn,
      go.args.map((a) => (a === "./..." ? `./${dir}/...` : a)),
    );
    const config = goTestNamed(p.config!, input);
    return { ...p, name: config.name, config };
  }
  return null;
}

/** All tools a production for this input may ask about (looked up before launching). */
export function neededTools(input: ContextInput): string[] {
  const lang = scriptLanguage(input.path, input.content);
  if (!lang) return [];
  return lang === "kotlin" ? ["kotlinc", "java"] : toolsFor(lang, input.content);
}
