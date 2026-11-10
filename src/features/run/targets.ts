/**
 * Run targets inside a file, for the gutter ▶ icons and "Run test" code lenses:
 * `fn main`, `#[test]` functions and `mod tests`, JS/TS `test`/`it`/`describe`,
 * pytest `def test_*` / `class Test*`, unittest `TestCase` subclasses, Go `func TestX(t *testing.T)`,
 * JUnit `@Test`, Minitest / Test::Unit classes, modules holding them and `def test_*`.
 * Line-based regex detection (cheap, no parser), plus the run configuration for
 * one target derived from the project's detected test configurations.
 */
import { goTargets } from "./goTargets";
import { csharpTargets } from "./csharpTargets";
import { formatArgs } from "./configs";
import type { RunConfig } from "@/platform/ipc";
import { applicationConfig, jvmTestConfig } from "./application";
import { goTestParts, withoutGoSelection } from "./goArguments";
import { contextConfig, relToCwd, testConfigFor } from "./context";
import { djangoLabel, djangoTestsOf } from "./djangoTypes";
import { scanJvmTargets, simpleClassName } from "./jvmTargets";
import { escapeRegExp } from "./testing/rerun";
import { pestFilter, phpunitArgs, phpunitFilter } from "./testing/phpunit";

export type TargetKind = "main" | "test" | "suite" | "generate";

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
  /** Python: a unittest `TestCase` subclass or one of its methods (what Django's runner can run). */
  unittest?: boolean;
  /** Ruby: a `module` suite, which runs the tests of every class declared inside it. */
  rubyModule?: boolean;
  pest?: boolean;
}

/** Above this size we skip detection (generated / minified files). */
export const MAX_SCAN = 400_000;

type Lang = "rust" | "js" | "python" | "php" | "go" | "jvm" | "ruby" | "csharp" | null;

export function targetLanguage(relPath: string): Lang {
  if (/\.cs$/i.test(relPath)) return "csharp";
  if (/\.rs$/.test(relPath)) return "rust";
  if (/\.[cm]?[jt]sx?$/.test(relPath)) return "js";
  if (/\.py$/.test(relPath)) return "python";
  if (/\.php$/.test(relPath)) return "php";
  if (/\.go$/.test(relPath)) return "go";
  if (/\.(java|kt|kts|scala|groovy)$/.test(relPath)) return "jvm";
  if (/\.rb$/.test(relPath)) return "ruby";
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

/** PHPUnit: classes named `*Test` / extending `TestCase`, and `test*` methods or `#[Test]` / `@test` ones. */
function phpTargets(lines: string[]): RunTarget[] {
  const out: RunTarget[] = [];
  let cls: string | null = null;
  let marked = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const c = /^\s*(?:final\s+|abstract\s+|readonly\s+)*class\s+(\w+)(?:\s+extends\s+([\w\\]+))?/.exec(line);
    if (c) {
      const test = /Test$|TestCase$/.test(c[1]!) || /TestCase$/.test(c[2] ?? "");
      cls = test && !/^\s*abstract\b/.test(line) ? c[1]! : null;
      if (cls) out.push({ line: i, kind: "suite", name: cls, path: [cls] });
      marked = false;
      continue;
    }
    if (!cls) continue;
    if (/#\[\s*(?:\\?PHPUnit\\Framework\\Attributes\\)?Test\s*[\],(]|@test\b/.test(line)) {
      marked = true;
      continue;
    }
    const m = /^\s*public\s+(?:static\s+)?function\s+(\w+)\s*\(/.exec(line);
    if (m && (marked || /^test/.test(m[1]!)))
      out.push({ line: i, kind: "test", name: `${cls}::${m[1]}`, path: [cls, m[1]!] });
    if (m || /^\s*(?:public|private|protected)\b/.test(line)) marked = false;
  }
  return out;
}

const PEST_RE = /^(\s*)(describe|test|it)\s*\(\s*(['"])((?:\\.|(?!\3).)*)\3/;

function pestTargets(lines: string[]): RunTarget[] {
  const out: RunTarget[] = [];
  const stack: Array<{ indent: number; name: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = PEST_RE.exec(lines[i]!);
    if (!m) continue;
    const indent = indentOf(m[1]!);
    while (stack.length && stack[stack.length - 1]!.indent >= indent) stack.pop();
    const text = m[4]!.replace(m[3] === "'" ? /\\(['\\])/g : /\\(["\\$])/g, "$1");
    const describes = stack.map((s) => s.name);
    if (m[2] === "describe") {
      const path = [...describes, text];
      out.push({ line: i, kind: "suite", name: path.join(" → "), path, pest: true });
      stack.push({ indent, name: text });
    } else {
      const path = [...describes, m[2] === "it" ? `it ${text}` : text];
      out.push({ line: i, kind: "test", name: path.join(" → "), path, pest: true });
    }
  }
  return out;
}

function pythonTargets(lines: string[]): RunTarget[] {
  const out: RunTarget[] = [];
  const classes: Array<{ indent: number; name: string; test: boolean; unittest: boolean }> = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const indent = indentOf(line);
    while (classes.length && classes[classes.length - 1]!.indent >= indent) classes.pop();
    const cls = /^\s*class\s+(\w+)\s*(?:\(([^)]*))?/.exec(line);
    if (cls) {
      // pytest collects `Test*` classes; unittest (and Django) any `TestCase` subclass.
      const unittest = /TestCase\b/.test(cls[2] ?? "");
      const test = (/^Test/.test(cls[1]!) || unittest) && classes.every((c) => c.test);
      classes.push({ indent, name: cls[1]!, test, unittest });
      if (test)
        out.push({
          line: i,
          kind: "suite",
          name: cls[1]!,
          path: classes.map((c) => c.name),
          ...(unittest ? { unittest } : {}),
        });
      continue;
    }
    const def = /^\s*(?:async\s+)?def\s+(test\w*)\s*\(/.exec(line);
    if (def && classes.every((c) => c.test)) {
      const path = [...classes.map((c) => c.name), def[1]!];
      const unittest = classes.length > 0 && classes[classes.length - 1]!.unittest;
      out.push({ line: i, kind: "test", name: path.join("."), path, ...(unittest ? { unittest } : {}) });
      continue;
    }
    if (indent === 0 && /^if\s+__name__\s*==\s*['"]__main__['"]\s*:/.test(line))
      out.push({ line: i, kind: "main", name: "main", path: [] });
  }
  return out;
}

/** A class that holds Minitest / Test::Unit tests: by its superclass or its name. */
const isRubyTestClass = (name: string, superclass: string | undefined) =>
  /(Test|TestCase|Spec)$/.test(superclass ?? "") || /Tests?(Case)?$/.test(name.split("::").pop()!);

/**
 * Minitest / Test::Unit: test classes, the modules that hold them (run together) and their
 * `def test_*` methods (ActiveSupport's `test "does x" do` is `test_does_x`). Frames are tracked
 * by indentation, as Python's are. Results name a class by its full name (`Outer::InnerTest`).
 */
function rubyTargets(lines: string[]): RunTarget[] {
  const frames: Array<{ indent: number; name: string; test: boolean; at: number; hasTests: boolean }> = [];
  const out: Array<RunTarget & { frame?: (typeof frames)[number] }> = [];
  const fullName = () => frames.map((f) => f.name).join("::");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const indent = indentOf(line);
    while (frames.length && frames[frames.length - 1]!.indent >= indent) frames.pop();
    const decl = /^\s*(class|module)\s+([A-Z]\w*(?:::[A-Z]\w*)*)(?:\s*<\s*([\w:]+))?/.exec(line);
    if (decl) {
      const test = decl[1] === "class" && isRubyTestClass(decl[2]!, decl[3]);
      const frame = { indent, name: decl[2]!, test, at: i, hasTests: false };
      frames.push(frame);
      out.push({
        line: i,
        kind: "suite",
        name: fullName(),
        path: [fullName()],
        ...(decl[1] === "module" ? { rubyModule: true } : {}),
        frame,
      });
      continue;
    }
    const owner = frames[frames.length - 1];
    if (!owner?.test) continue;
    const method =
      /^\s*def\s+(test_\w*[?!]?)/.exec(line)?.[1] ??
      (/^\s*test\s*\(?\s*(["'])(.+?)\1/.exec(line)?.[2] ?? "").replace(/\s+/g, "_").replace(/^(?=.)/, "test_");
    if (method && method !== "test_") {
      for (const f of frames) f.hasTests = true;
      out.push({ line: i, kind: "test", name: `${fullName()}#${method}`, path: [fullName(), method] });
    }
  }
  // A class or module that holds no tests is noise.
  return out.filter((t) => t.kind !== "suite" || t.frame?.hasTests).map(({ frame: _frame, ...t }) => t);
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

/**
 * Run targets of a file (relative path picks the language). `django`: a Django project, where
 * `tests.py` (Django's default test module) holds tests too.
 */
export function detectRunTargets(text: string, relPath: string, django = false): RunTarget[] {
  if (text.length > MAX_SCAN) return [];
  const lines = text.split("\n");
  switch (targetLanguage(relPath)) {
    case "csharp":
      return csharpTargets(text);
    case "rust":
      return rustTargets(lines, relPath);
    case "js":
      return /\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)__tests__\//.test(relPath) ? jsTargets(lines) : [];
    case "python":
      return pythonTargets(lines).filter(
        (t) =>
          t.kind === "main" ||
          /(^|\/)(test_[^/]*|[^/]*_test)\.py$|(^|\/)tests?\//.test(relPath) ||
          (django && /(^|\/)tests\.py$/.test(relPath)),
      );
    case "php":
      return /Test\.php$|(^|\/)tests?\//.test(relPath)
        ? [...phpTargets(lines), ...pestTargets(lines)].sort((a, b) => a.line - b.line)
        : [];
    case "go":
      return goTargets(text).filter((t) => t.kind === "main" || t.kind === "generate" || /_test\.go$/.test(relPath));
    case "jvm":
      return /\.(java|kts?)$/.test(relPath) ? javaKotlinTargets(text, relPath) : jvmTargets(lines, relPath);
    case "ruby":
      // RSpec files (`spec/`) are not Minitest.
      return /(^|\/)test_[^/]*\.rb$|_test\.rb$|(^|\/)tests?\//.test(relPath) ? rubyTargets(lines) : [];
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
  const file = testConfigFor(relPath, configs, base, content);
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
    case "dotnet-test": {
      const methods =
        target.kind === "suite" && content
          ? csharpTargets(content)
              .filter((t) => t.kind === "test" && t.path[0] === target.path[0])
              .map((t) => t.path.join("."))
          : [target.path.join(".")];
      return { ...named(file.args), params: { ...file.params, testMethods: JSON.stringify(methods) } };
    }
    case "npm":
    case "bun":
    case "deno":
      return named([...file.args, "-t", jsNamePattern(target)]);
    case "pytest":
    case "python":
      return named(withLast(file.args, (f) => `${f}::${target.path.join("::")}`));
    case "phpunit": {
      const [cls, method] = [target.path[0]!, target.path[1]];
      const filter = !target.pest
        ? phpunitFilter([method ? [cls, method] : [cls]])
        : target.kind === "suite"
          ? pestFilter(target.path)
          : pestFilter(target.path.slice(0, -1), target.path[target.path.length - 1]);
      return named(phpunitArgs(file.args, { target: relToCwd(relPath, file), filter }));
    }
    case "django-test": {
      // unittest's loader would call a module-level `test_*` function (or a plain class) to build the suite.
      if (!target.unittest) return null;
      const label = [djangoLabel(relToCwd(relPath, file)), ...target.path].join(".");
      const tests = djangoTestsOf(file, [label]);
      return tests ? { ...named(tests.args), ...(tests.params ? { params: tests.params } : {}) } : null;
    }
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
        ...withoutGoSelection(parts.program),
      ]);
      if (file.params?.goKind)
        result.params = {
          ...file.params,
          pattern: benchmark ? "^$" : pattern,
          toolArgs: formatArgs([...withoutGoSelection(parts.flags), ...(benchmark ? ["-bench", pattern] : [])]),
          programArgs: formatArgs(withoutGoSelection(parts.program).slice(1)),
        };
      return result;
    }
    case "rake":
    case "ruby": {
      // Minitest's `--name=`: `Class#test_x` names one test exactly, a regexp (no `$`, which a shell would
      // eat) the rest. The `=` form is one argument: rake's test loader would `require` the value of `-n x`.
      const full = target.path[0]!;
      const pattern =
        target.kind === "test" ? `${full}#${target.path[1]}` : target.rubyModule ? `/^${full}::/` : `/^${full}#/`;
      return file.kind === "rake"
        ? named([...file.args, `TESTOPTS=--name=${pattern}`])
        : named([...file.args, `--name=${pattern}`]);
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
