/**
 * "Run Context Configuration" (⌃⇧R): derives a run configuration from the
 * active file — the file's tests for test files, the matching run target or a
 * direct interpreter invocation for main files. Best effort, IDEA-style.
 */
import type { RunConfig } from "@/platform/ipc";
import { djangoLabel, djangoTestsOf, hasDjangoTests } from "./djangoTypes";
import { phpunitArgs } from "./testing/phpunit";
import { goTestParts } from "./goArguments";
import { isWindows } from "./jvmTypes";

export type FileRole = "test" | "main" | "script" | null;

/** `django`: a Django project, whose default test module is `tests.py` (elsewhere a script). */
export function fileRole(relPath: string, content?: string, windows = isWindows(), django = false): FileRole {
  const name = relPath.split("/").pop() ?? relPath;
  if (
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(name) ||
    /(^|\/)__tests__\//.test(relPath) ||
    /^test_.*\.py$|_test\.py$/.test(name) ||
    (django && name === "tests.py") ||
    /_test\.go$/.test(name) ||
    /Test\.php$/.test(name) ||
    /_(spec|test)\.rb$/.test(name) ||
    /(Test|Tests|Spec|IT)\.(kt|java|scala|groovy)$/.test(name) ||
    (/(^|\/)tests\/[^/]+\.rs$/.test(relPath) && name !== "mod.rs")
  )
    return "test";
  if (/(^|\/)src\/main\.rs$|(^|\/)src\/bin\/[^/]+\.rs$/.test(relPath)) return "main";
  if (/\.go$/.test(name) && content !== undefined && /^\s*package\s+main\b/m.test(content)) return "main";
  if (/\.(kt|java)$/.test(name) && content !== undefined && /\bfun\s+main\s*\(|static\s+void\s+main\s*\(/.test(content))
    return "main";
  if (/\.(py|rb|sh|bash|zsh|[cm]?js|ts)$/.test(name)) return "script";
  if (windows && /\.(bat|cmd)$/i.test(name)) return "script";
  return null;
}

const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const stem = (p: string) => (p.split("/").pop() ?? p).replace(/\.[^.]+$/, "");

/** Kinds whose test configs can run a file of this extension. */
function testKinds(relPath: string): string[] {
  if (/\.[cm]?[jt]sx?$/.test(relPath)) return ["npm", "deno", "bun"];
  if (/\.py$/.test(relPath)) return ["pytest", "python", "django-test"];
  if (/\.php$/.test(relPath)) return ["phpunit"];
  if (/_spec\.rb$/.test(relPath)) return ["rspec", "rake"];
  if (/_test\.rb$/.test(relPath)) return ["rake", "rspec"];
  if (/\.go$/.test(relPath)) return ["go"];
  if (/\.rs$/.test(relPath)) return ["cargo"];
  if (/\.(kt|java|scala|groovy)$/.test(relPath)) return ["gradle", "maven"];
  return [];
}

/** Configs whose working directory most specifically contains `relPath` (ties in their original order). */
function allClosest(configs: RunConfig[], relPath: string): RunConfig[] {
  const score = (c: RunConfig) => {
    const cwd = (c.kind === "go" ? (c.params?.module ?? c.cwd ?? "") : (c.cwd ?? ""))
      .replace(/^\.\/?/, "")
      .replace(/\/+$/, "");
    if (!cwd) return 0;
    return relPath === cwd || relPath.startsWith(cwd + "/") ? cwd.length : -1;
  };
  const scored = configs.map((c) => [c, score(c)] as const).filter(([, s]) => s >= 0);
  const best = Math.max(...scored.map(([, s]) => s));
  return scored.filter(([, s]) => s === best).map(([c]) => c);
}

/** Config whose working directory most specifically contains `relPath`. */
function closest(configs: RunConfig[], relPath: string): RunConfig | undefined {
  return allClosest(configs, relPath)[0];
}

/** `relPath` relative to the working directory of `config`. */
export function relToCwd(relPath: string, config: RunConfig): string {
  const cwd = (config.kind === "go" ? (config.params?.module ?? config.cwd ?? "") : (config.cwd ?? ""))
    .replace(/^\.\/?/, "")
    .replace(/\/+$/, "");
  return cwd && relPath.startsWith(cwd + "/") ? relPath.slice(cwd.length + 1) : relPath;
}

function derived(base: RunConfig, relPath: string, patch: Partial<RunConfig>): RunConfig {
  const name = relPath.split("/").pop() ?? relPath;
  return {
    ...base,
    id: `context:${base.id}:${relPath}`,
    name,
    detected: true,
    env: { ...base.env },
    ...patch,
  };
}

/**
 * The project's Python interpreter as `(command, leading args)`, derived from
 * detected configs (venv / uv / poetry), or null when none says.
 */
export function projectPython(configs: RunConfig[]): { command: string; prefix: string[] } | null {
  const py = configs.find((c) => c.kind === "python");
  if (py) {
    // The interpreter part ends where the program starts: `-m`, or the script (`manage.py`). What follows
    // (`runserver`, `test`…) belongs to that program, never to the interpreter.
    const end = py.args.findIndex((a) => a === "-m" || a.endsWith(".py"));
    const python = py.args.findIndex((a) => /^python[\d.]*$/.test(a));
    return { command: py.command, prefix: py.args.slice(0, end >= 0 ? end : python + 1) };
  }
  const pytest = configs.find((c) => c.kind === "pytest");
  if (!pytest) return null;
  const venvTool = /^(.*[/\\](?:bin|Scripts)[/\\])pytest(\.exe)?$/.exec(pytest.command);
  if (venvTool) return { command: `${venvTool[1]}python${venvTool[2] ?? ""}`, prefix: [] };
  const m = pytest.args.indexOf("-m");
  if (m >= 0 && pytest.args[m + 1] === "pytest") return { command: pytest.command, prefix: pytest.args.slice(0, m) };
  if (pytest.args[0] === "run" && pytest.args[1] === "pytest")
    return { command: pytest.command, prefix: ["run", "python"] };
  return null;
}

/**
 * PyCharm runs pytest for a `test_*.py` file even when the project declares no
 * test setup: `python -m pytest`, with the project's interpreter when detected.
 */
function implicitPytest(relPath: string, configs: RunConfig[]): RunConfig | null {
  if (!relPath.endsWith(".py")) return null;
  const py = projectPython(configs);
  return {
    id: "pytest:implicit",
    name: "pytest",
    kind: "pytest",
    command: py?.command ?? "python3",
    args: [...(py?.prefix ?? []), "-m", "pytest"],
    cwd: null,
    env: {},
    detected: true,
    isTest: true,
    debugAdapter: "debugpy",
  };
}

/**
 * Test configurations that can run `relPath` equally well (same, closest working
 * directory: `npm run test` and `npm run test:unit`…); the default one first.
 */
export function testBasesFor(relPath: string, configs: RunConfig[]): RunConfig[] {
  const kinds = testKinds(relPath);
  // Configurations produced from a test or file are results of narrowing, never bases for it.
  const candidates = configs
    .filter((c) => c.isTest && kinds.includes(c.kind) && !c.id.startsWith("context:"))
    .sort((a, b) => kinds.indexOf(a.kind) - kinds.indexOf(b.kind));
  const best = allClosest(candidates, relPath);
  if (best.length) return best;
  const fallback = candidates[0] ?? implicitPytest(relPath, configs);
  return fallback ? [fallback] : [];
}

/**
 * File-level test configuration for `relPath` (the closest matching test config,
 * or `base`, narrowed to the file).
 */
export function testConfigFor(relPath: string, configs: RunConfig[], base?: RunConfig): RunConfig | null {
  base ??= testBasesFor(relPath, configs)[0];
  if (!base) return null;
  const file = relToCwd(relPath, base);
  switch (base.kind) {
    case "npm":
    case "bun": {
      // `npm run test -- file` works for npm, pnpm, yarn and bun.
      const args = base.args.includes("--") ? [...base.args, file] : [...base.args, "--", file];
      return derived(base, relPath, { args });
    }
    case "deno":
      return derived(base, relPath, { args: [...base.args, file] });
    case "pytest":
    case "python":
    case "rspec":
      return derived(base, relPath, { args: [...base.args, file] });
    case "phpunit":
      return derived(base, relPath, { args: phpunitArgs(base.args, { target: file }) });
    case "rake": {
      // `rake test` (minitest) takes the file as TEST=; `rake spec` as SPEC=.
      const task = base.args.at(-1) ?? "";
      const key = /(^|:)spec$/.test(task) ? "SPEC" : /(^|:)test$/.test(task) ? "TEST" : null;
      return key ? derived(base, relPath, { args: [...base.args, `${key}=${file}`] }) : base;
    }
    case "django-test": {
      const tests = djangoTestsOf(base, [djangoLabel(file)]);
      return tests ? derived(base, relPath, tests) : null;
    }
    case "go": {
      const dir = dirOf(file);
      const target = dir ? `./${dir}` : ".";
      const parts = goTestParts(base.args);
      const args = ["test", ...parts.flags, target, ...parts.program];
      return derived(base, relPath, {
        args,
        name: `go test ${target}`,
        ...(base.params?.goKind ? { params: { ...base.params, scope: "directory", target } } : {}),
      });
    }
    case "cargo": {
      const m = /(?:^|\/)tests\/([^/]+)\.rs$/.exec(relPath);
      return m ? derived(base, relPath, { args: [...base.args, "--test", m[1]!] }) : base;
    }
    case "gradle":
      return derived(base, relPath, { args: [...base.args, "--tests", `*${stem(relPath)}`] });
    case "maven":
      return derived(base, relPath, { args: [...base.args, `-Dtest=${stem(relPath)}`] });
  }
  return base;
}

function mainConfigFor(relPath: string, configs: RunConfig[]): RunConfig | null {
  if (relPath.endsWith(".rs")) {
    const bin = /src\/bin\/([^/]+)\.rs$/.exec(relPath)?.[1];
    const runs = configs.filter((c) => c.kind === "cargo" && c.id.startsWith("cargo:run"));
    const byBin = bin ? runs.find((c) => c.id === `cargo:run:${bin}` || c.args.includes(bin)) : undefined;
    return byBin ?? closest(runs, relPath) ?? runs[0] ?? null;
  }
  if (relPath.endsWith(".go")) {
    const gos = configs.filter((c) => c.kind === "go");
    const runs = gos.filter((c) => c.args[0] === "run");
    // The module containing the file (nested modules run from their own directory).
    const base = closest(runs, relPath) ?? closest(gos, relPath) ?? runs[0] ?? gos[0];
    if (!base) return null;
    const dir = dirOf(relToCwd(relPath, base));
    const target = dir ? `./${dir}` : ".";
    const hit = runs.find((c) => (c.cwd ?? "") === (base.cwd ?? "") && c.args[1] === target);
    if (hit) return hit;
    return derived(base, relPath, { args: ["run", target], name: `go run ${target}`, isTest: false });
  }
  if (/\.(kt|java)$/.test(relPath)) {
    // The build containing the file (builds nested in a folder of repositories carry a `:<dir>` suffix).
    const runs = configs.filter((c) =>
      ["gradle:bootRun", "gradle:run", "maven:spring-boot:run"].some((id) => c.id === id || c.id.startsWith(`${id}:`)),
    );
    return closest(runs, relPath) ?? null;
  }
  return null;
}

/** `from .models import …`, `from . import x`: the file is a module of a package. */
const RELATIVE_IMPORT = /^[ \t]*from[ \t]+\.+[\w.]*[ \t]+import\b/m;
const IDENTIFIER = /^[A-Za-z_]\w*$/;

/**
 * A module that imports relatively runs as `python -m <package>.<module>` from the folder its top
 * package sits in (the last `src` of its path, else the Python project's folder): run as a script,
 * its relative imports fail. `null` for other files.
 */
export function pythonModuleRun(
  relPath: string,
  content: string | undefined,
  configs: RunConfig[],
): { cwd: string; module: string } | null {
  if (!content || !RELATIVE_IMPORT.test(content)) return null;
  const project = closest(
    configs.filter((c) => c.kind === "python" || c.kind === "pytest"),
    relPath,
  )?.cwd?.replace(/^\.\/?|\/+$/g, "");
  const segs = relPath.replace(/\.py$/, "").split("/");
  const first = project && relPath.startsWith(`${project}/`) ? project.split("/").length : 0;
  const src = segs.lastIndexOf("src", segs.length - 2);
  const start = src >= first ? src + 1 : first;
  const parts = segs.slice(start);
  // Only a module inside a package can import relatively.
  if (parts.length < 2 || !parts.every((p) => IDENTIFIER.test(p))) return null;
  if (parts.at(-1) === "__main__" || parts.at(-1) === "__init__") parts.pop();
  return { cwd: segs.slice(0, start).join("/"), module: parts.join(".") };
}

/** A command relative to the project root (`.venv/bin/python`), from `cwd` inside it. */
function fromSubfolder(command: string, cwd: string): string {
  if (!cwd || !command.includes("/") || command.startsWith("/") || /^[A-Za-z]:/.test(command)) return command;
  return "../".repeat(cwd.split("/").length) + command;
}

function scriptConfigFor(
  relPath: string,
  configs: RunConfig[],
  windows = isWindows(),
  content?: string,
): RunConfig | null {
  const base: RunConfig = {
    id: `context:file:${relPath}`,
    name: relPath.split("/").pop() ?? relPath,
    kind: "shell",
    command: "",
    args: [],
    cwd: null,
    env: {},
    detected: true,
    isTest: false,
    debugAdapter: null,
  };
  if (relPath.endsWith(".py")) {
    // Reuse the project's interpreter (venv / uv / poetry) when detected.
    const py = projectPython(configs) ?? { command: "python3", prefix: [] };
    const module = pythonModuleRun(relPath, content, configs);
    if (module)
      return {
        ...base,
        kind: "python",
        command: fromSubfolder(py.command, module.cwd),
        args: [...py.prefix, "-m", module.module],
        cwd: module.cwd || null,
        debugAdapter: "debugpy",
      };
    return { ...base, kind: "python", command: py.command, args: [...py.prefix, relPath], debugAdapter: "debugpy" };
  }
  if (/\.[cm]?js$/.test(relPath)) return { ...base, command: "node", args: [relPath], debugAdapter: "js-debug" };
  if (/\.ts$/.test(relPath)) return { ...base, command: "npx", args: ["tsx", relPath], debugAdapter: "js-debug" };
  if (/\.(sh|bash|zsh)$/.test(relPath)) {
    const shell = relPath.endsWith(".zsh") ? "zsh" : relPath.endsWith(".bash") ? "bash" : "sh";
    return { ...base, command: shell, args: [relPath] };
  }
  if (windows && /\.(bat|cmd)$/i.test(relPath)) {
    const file = relPath.split("/").pop() ?? relPath;
    return { ...base, command: "cmd.exe", args: ["/c", file], cwd: dirOf(relPath) || null };
  }
  return null;
}

/** Config to run for the file at `relPath` (relative to the project root), if any. */
export function contextConfig(
  relPath: string,
  configs: RunConfig[],
  content?: string,
  windows = isWindows(),
): RunConfig | null {
  const role = fileRole(relPath, content, windows, hasDjangoTests(configs));
  if (role === "test") return testConfigFor(relPath, configs);
  if (role === "main") return mainConfigFor(relPath, configs) ?? scriptConfigFor(relPath, configs, windows, content);
  if (role === "script") return scriptConfigFor(relPath, configs, windows, content);
  return null;
}
