/**
 * Run targets inside a file, for the gutter ▶ icons and "Run test" code lenses:
 * `fn main`, `#[test]` functions and `mod tests`, JS/TS `test`/`it`/`describe`,
 * pytest `def test_*` / `class Test*`, Go `func TestX(t *testing.T)`, JUnit `@Test`.
 * Line-based regex detection (cheap, no parser), plus the run configuration for
 * one target derived from the project's detected test configurations.
 */
import { formatArgs } from "./configs";
import type { RunConfig } from "@/platform/ipc";
import { applicationConfig, jvmTestConfig } from "./application";
import { goTestParts, withoutGoSelection } from "./goArguments";
import { contextConfig, testConfigFor } from "./context";
import { scanJvmTargets, simpleClassName } from "./jvmTargets";
import { escapeRegExp } from "./testing/rerun";

export type TargetKind = "main" | "test" | "suite";

export interface RunTarget {
  /** 0-based line of the declaration. */
  line: number;
  kind: TargetKind;
  /** Display name (`adds_numbers`, `math > adds`). */
  name: string;
  /** Test path: Rust module path, describe chain, Python class chain… (framework specific). */
  path: string[];
  /** Name pattern contains printf placeholders / template parts (`test.each`). */
  parameterized?: boolean;
  /** JVM: binary name of the class (main class, test class). */
  className?: string;
  /** JVM: a `@SpringBootApplication` main class. */
  spring?: boolean;
}

/** Above this size we skip detection (generated / minified files). */
export const MAX_SCAN = 400_000;

type Lang = "rust" | "js" | "python" | "go" | "jvm" | null;

export function targetLanguage(relPath: string): Lang {
  if (/\.rs$/.test(relPath)) return "rust";
  if (/\.[cm]?[jt]sx?$/.test(relPath)) return "js";
  if (/\.py$/.test(relPath)) return "python";
  if (/\.go$/.test(relPath)) return "go";
  if (/\.(java|kt|kts|scala|groovy)$/.test(relPath)) return "jvm";
  return null;
}

const indentOf = (s: string) => /^\s*/.exec(s)![0].replace(/\t/g, "    ").length;

/** Strips string literals and line comments (rough) so braces inside them don't count. */
function codeOnly(line: string): string {
  return line
    .replace(/\/\/.*$/, "")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)'/g, "''");
}

function rustModulePrefix(relPath: string): string[] {
  const m = /(?:^|\/)src\/(.+)\.rs$/.exec(relPath);
  if (!m) return [];
  const parts = m[1]!.split("/");
  const last = parts[parts.length - 1];
  if (parts.length === 1 && (last === "lib" || last === "main")) return [];
  if (parts[0] === "bin") return [];
  if (last === "mod") parts.pop();
  return parts;
}

function rustTargets(lines: string[], relPath: string): RunTarget[] {
  const out: RunTarget[] = [];
  const prefix = rustModulePrefix(relPath);
  const mods: Array<{ name: string; depth: number }> = [];
  let depth = 0;
  let pendingTest = false;
  let pendingCfgTest = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = codeOnly(raw);
    const trimmed = line.trim();
    if (/^#\[(?:[\w:]+::)?test\b|^#\[(?:tokio|async_std|actix_rt|rstest|test_case)(?:::\w+)?\b/.test(trimmed))
      pendingTest = true;
    if (/^#\[cfg\(test\)\]/.test(trimmed)) pendingCfgTest = true;
    const fn = /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+(\w+)/.exec(trimmed);
    const mod = /^(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*\{/.exec(trimmed);
    if (fn) {
      const modPath = [...prefix, ...mods.map((m) => m.name)];
      if (pendingTest) out.push({ line: i, kind: "test", name: fn[1]!, path: [...modPath, fn[1]!] });
      else if (
        fn[1] === "main" &&
        depth === 0 &&
        /(?:^|\/)(?:src\/main|src\/bin\/[^/]+|examples\/[^/]+)\.rs$/.test(relPath)
      )
        out.push({ line: i, kind: "main", name: "main", path: [] });
      pendingTest = false;
      pendingCfgTest = false;
    } else if (mod) {
      const modPath = [...prefix, ...mods.map((m) => m.name), mod[1]!];
      if (pendingCfgTest || mod[1] === "tests") out.push({ line: i, kind: "suite", name: mod[1]!, path: modPath });
      mods.push({ name: mod[1]!, depth });
      pendingTest = false;
      pendingCfgTest = false;
    } else if (trimmed && !trimmed.startsWith("#[") && !trimmed.startsWith("//") && !trimmed.startsWith("///")) {
      pendingTest = false;
      if (!/^#/.test(trimmed)) pendingCfgTest = false;
    }
    for (const ch of line) {
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        while (mods.length && mods[mods.length - 1]!.depth >= depth) mods.pop();
      }
    }
  }
  // A suite that contains no tests is noise.
  return out.filter(
    (t) =>
      t.kind !== "suite" ||
      out.some((o) => o.kind === "test" && o.path.length > t.path.length && t.path.every((p, k) => o.path[k] === p)),
  );
}

const JS_RE =
  /^(\s*)(describe|suite|context|test|it)\b(?:\.(?:only|skip|todo|concurrent|failing|sequential))*(\.each\s*(?:\(.*?\)|`[^`]*`))?\s*\(\s*(['"`])((?:\\.|(?!\4).)*)\4/;

function jsTargets(lines: string[]): RunTarget[] {
  const out: RunTarget[] = [];
  const stack: Array<{ indent: number; name: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = JS_RE.exec(lines[i]!);
    if (!m) continue;
    const indent = indentOf(m[1]!);
    while (stack.length && stack[stack.length - 1]!.indent >= indent) stack.pop();
    const name = m[5]!.replace(/\\(.)/g, "$1");
    const parameterized = !!m[3] || (m[4] === "`" && name.includes("${")) || /%[sdifjo#%p]|\$\w+/.test(name);
    const path = [...stack.map((s) => s.name), name];
    const isSuite = m[2] === "describe" || m[2] === "suite" || m[2] === "context";
    out.push({ line: i, kind: isSuite ? "suite" : "test", name: path.join(" > "), path, parameterized });
    if (isSuite) stack.push({ indent, name });
  }
  return out;
}

function pythonTargets(lines: string[]): RunTarget[] {
  const out: RunTarget[] = [];
  const classes: Array<{ indent: number; name: string; test: boolean }> = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const indent = indentOf(line);
    while (classes.length && classes[classes.length - 1]!.indent >= indent) classes.pop();
    const cls = /^\s*class\s+(\w+)/.exec(line);
    if (cls) {
      const test = /^Test/.test(cls[1]!) && classes.every((c) => c.test);
      classes.push({ indent, name: cls[1]!, test });
      if (test) out.push({ line: i, kind: "suite", name: cls[1]!, path: classes.map((c) => c.name) });
      continue;
    }
    const def = /^\s*(?:async\s+)?def\s+(test\w*)\s*\(/.exec(line);
    if (def && classes.every((c) => c.test)) {
      const path = [...classes.map((c) => c.name), def[1]!];
      out.push({ line: i, kind: "test", name: path.join("."), path });
      continue;
    }
    if (indent === 0 && /^if\s+__name__\s*==\s*['"]__main__['"]\s*:/.test(line))
      out.push({ line: i, kind: "main", name: "main", path: [] });
  }
  return out;
}

/** `go test` reports subtest names with spaces as `_` (`t.Run("zero case")` → `TestX/zero_case`). */
export const goSubtestName = (name: string) => name.replace(/\s/g, "_");

function goTargets(lines: string[]): RunTarget[] {
  const out: RunTarget[] = [];
  const isMain = lines.some((l) => /^package\s+main\b/.test(l));
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const t = /^func\s+(Test\w*|Benchmark\w*|Example\w*|Fuzz\w*)\s*\(\s*(?:\w+\s+\*testing\.[TFB])?\s*\)?/.exec(line);
    if (t && (/^Example/.test(t[1]!) || /\*testing\.[TFB]/.test(line))) {
      out.push({ line: i, kind: "test", name: t[1]!, path: [t[1]!] });
      if (/\*testing\.[TB]\b/.test(line)) out.push(...goSubtests(lines, i, t[1]!));
      continue;
    }
    if (isMain && /^func\s+main\s*\(\s*\)/.test(line)) out.push({ line: i, kind: "main", name: "main", path: [] });
  }
  return out;
}

/**
 * Subtests of the test function at `start` (GoLand's gutter on subtests and
 * table-driven tests): `t.Run("name", …)`, and table entries run with
 * `t.Run(tt.name, …)` (`{name: "…", …}`) or keyed by name
 * (`for name, tc := range cases { t.Run(name, …) }` over `"…": {…}`).
 */
function goSubtests(lines: string[], start: number, test: string): RunTarget[] {
  if (/\}\s*(?:\/\/.*)?$/.test(lines[start]!)) return [];
  let end = start;
  while (end + 1 < lines.length && !/^}/.test(lines[end]!)) end++;
  const body = lines.slice(start + 1, end);
  const out: RunTarget[] = [];
  const add = (offset: number, name: string) => {
    const sub = goSubtestName(name.replace(/\\(.)/g, "$1"));
    if (!out.some((t) => t.path[1] === sub))
      out.push({ line: start + 1 + offset, kind: "test", name: `${test}/${sub}`, path: [test, sub] });
  };
  const fields = new Set<string>();
  const keys = new Set<string>();
  body.forEach((l, i) => {
    const lit = /\b\w+\.Run\(\s*"((?:[^"\\]|\\.)*)"\s*,/.exec(l);
    if (lit) add(i, lit[1]!);
    const field = /\b\w+\.Run\(\s*\w+\.(\w+)\s*,/.exec(l);
    if (field) fields.add(field[1]!);
    const key = /\b\w+\.Run\(\s*(\w+)\s*,/.exec(l);
    if (key && body.slice(0, i).some((b) => new RegExp(`\\bfor\\s+${key[1]}\\s*,\\s*\\w+\\s*:=\\s*range\\b`).test(b)))
      keys.add(key[1]!);
  });
  if (fields.size || keys.size) {
    body.forEach((l, i) => {
      for (const f of fields) {
        const m = new RegExp(`\\b${f}\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(l);
        if (m) add(i, m[1]!);
      }
      if (keys.size) {
        const m = /^\s*"((?:[^"\\]|\\.)*)"\s*:\s*\{/.exec(l);
        if (m) add(i, m[1]!);
      }
    });
  }
  return out.sort((a, b) => a.line - b.line);
}

/** Java / Kotlin: classes and methods with binary class names (see `jvmTargets.ts`). */
function javaKotlinTargets(text: string, relPath: string): RunTarget[] {
  return scanJvmTargets(text, relPath, /\.kts?$/.test(relPath)).map((t): RunTarget => {
    const simple = simpleClassName(t.className);
    switch (t.kind) {
      case "main":
        return {
          line: t.line,
          kind: "main",
          name: simple,
          path: [t.className],
          className: t.className,
          spring: t.spring,
        };
      case "suite":
        return { line: t.line, kind: "suite", name: simple, path: [t.className], className: t.className };
      default:
        return {
          line: t.line,
          kind: "test",
          name: `${simple}.${t.method}`,
          path: [t.className, t.method!],
          className: t.className,
        };
    }
  });
}

/** Scala / Groovy: line-based (JUnit-style annotations only). */
function jvmTargets(lines: string[], relPath: string): RunTarget[] {
  const out: RunTarget[] = [];
  const stem = (relPath.split("/").pop() ?? relPath).replace(/\.[^.]+$/, "");
  let pendingTest = false;
  let classLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (/^@(?:Test|ParameterizedTest|RepeatedTest|TestFactory)\b/.test(trimmed)) {
      pendingTest = true;
      if (/\bfun\b|\bvoid\b/.test(trimmed)) {
        /* annotation and declaration on one line: fall through */
      } else continue;
    }
    if (classLine < 0 && new RegExp(String.raw`\b(?:class|object)\s+${escapeRegExp(stem)}\b`).test(trimmed))
      classLine = i;
    const method = /\bfun\s+(?:`([^`]+)`|(\w+))\s*\(/.exec(trimmed) ?? /\bvoid\s+(\w+)\s*\(/.exec(trimmed) ?? null;
    if (method) {
      const name = method[1] ?? method[2]!;
      if (pendingTest) out.push({ line: i, kind: "test", name: `${stem}.${name}`, path: [stem, name] });
      else if (name === "main" && (/\bstatic\b/.test(trimmed) || /^fun\s+main\s*\(/.test(trimmed)))
        out.push({ line: i, kind: "main", name: "main", path: [] });
      pendingTest = false;
    } else if (trimmed && !trimmed.startsWith("@") && !trimmed.startsWith("//")) {
      pendingTest = false;
    }
  }
  if (classLine >= 0 && out.some((t) => t.kind === "test"))
    out.unshift({ line: classLine, kind: "suite", name: stem, path: [stem] });
  return out;
}

/** Run targets of a file (relative path picks the language). */
export function detectRunTargets(text: string, relPath: string): RunTarget[] {
  if (text.length > MAX_SCAN) return [];
  const lines = text.split("\n");
  switch (targetLanguage(relPath)) {
    case "rust":
      return rustTargets(lines, relPath);
    case "js":
      return /\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)__tests__\//.test(relPath) ? jsTargets(lines) : [];
    case "python":
      return pythonTargets(lines).filter(
        (t) => t.kind === "main" || /(^|\/)(test_[^/]*|[^/]*_test)\.py$|(^|\/)tests?\//.test(relPath),
      );
    case "go":
      return goTargets(lines).filter((t) => t.kind === "main" || /_test\.go$/.test(relPath));
    case "jvm":
      return /\.(java|kts?)$/.test(relPath) ? javaKotlinTargets(text, relPath) : jvmTargets(lines, relPath);
    default:
      return [];
  }
}

/** Jest / Vitest `-t` pattern for a test (full name = describe chain + name, space separated). */
export function jsNamePattern(target: RunTarget): string {
  const full = target.path.join(" ");
  let pattern = escapeRegExp(full);
  // `test.each` placeholders (%s, $name, ${…}) match anything.
  pattern = pattern.replace(/%[sdifjo#p]|\\\$\\\{[^}]*\\\}|\$\w+/g, ".*");
  return target.kind === "suite" ? `^${pattern}` : `^${pattern}$`;
}

function withLast(args: string[], f: (last: string) => string): string[] {
  return args.length ? [...args.slice(0, -1), f(args[args.length - 1]!)] : args;
}

/** Run configuration for one target, or null when the project has no matching runner. */
export function targetConfig(
  target: RunTarget,
  relPath: string,
  configs: RunConfig[],
  content?: string,
  /** The test configuration to narrow (one of `testBasesFor`); the closest by default. */
  base?: RunConfig,
): RunConfig | null {
  if (target.kind === "main") {
    if (target.className)
      return applicationConfig({ className: target.className, spring: target.spring }, relPath, configs);
    return contextConfig(relPath, configs, content);
  }
  const file = testConfigFor(relPath, configs, base);
  if (!file) return null;
  if (target.className && (file.kind === "maven" || file.kind === "gradle"))
    return jvmTestConfig(
      file,
      target.className,
      target.kind === "test" ? target.path[target.path.length - 1] : undefined,
    );
  const shortName = target.kind === "suite" ? target.path[target.path.length - 1]! : target.name;
  const named = (args: string[]): RunConfig => ({
    ...file,
    id: `context:target:${file.id}:${relPath}:${target.path.join("/")}`,
    name: shortName,
    args,
    env: { ...file.env },
    detected: true,
  });
  switch (file.kind) {
    case "npm":
    case "bun":
    case "deno":
      return named([...file.args, "-t", jsNamePattern(target)]);
    case "pytest":
    case "python":
      return named(withLast(file.args, (f) => `${f}::${target.path.join("::")}`));
    case "go": {
      const pattern = `^${target.path.map(escapeRegExp).join("$/^")}$`;
      const benchmark = target.path[0]?.startsWith("Benchmark");
      const parts = goTestParts(file.args);
      const selection = benchmark ? ["-run", "^$", "-bench", pattern] : ["-run", pattern];
      const result = named([
        "test",
        ...withoutGoSelection(parts.flags),
        ...parts.targets,
        ...selection,
        ...parts.program,
      ]);
      if (file.params?.goKind)
        result.params = {
          ...file.params,
          pattern: benchmark ? "^$" : pattern,
          toolArgs: formatArgs([...withoutGoSelection(parts.flags), ...(benchmark ? ["-bench", pattern] : [])]),
        };
      return result;
    }
    case "cargo": {
      const path = target.path.join("::");
      return named(target.kind === "suite" ? [...file.args, "--", `${path}::`] : [...file.args, "--", path, "--exact"]);
    }
    case "gradle":
      return named(
        withLast(file.args, (f) => (target.kind === "suite" ? f : `${f}.${target.path[target.path.length - 1]}`)),
      );
    case "maven":
      return named(
        withLast(file.args, (f) => (target.kind === "suite" ? f : `${f}#${target.path[target.path.length - 1]}`)),
      );
  }
  return null;
}
