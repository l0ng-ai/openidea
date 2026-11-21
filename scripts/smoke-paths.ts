/**
 * What the Language smoke workflow must run for, so that its path selection can be checked
 * against it (scripts/smoke-paths.test.ts):
 * - the files `pnpm smoke` loads: the import closure of the test files the workflow runs, of the
 *   Vitest config and of its setup files, resolved as Vite does (its aliases, then TypeScript's
 *   resolver); the tsconfig files Vite reads to compile them; the dependency manifests;
 * - the crates the smoke runs: the workspace dependencies (cargo metadata) of `rustSmoke`.
 *
 * `node scripts/smoke-paths.ts` lists the inputs a pull request could change without running
 * every language; `node scripts/smoke-paths.ts <path>…` the languages a change to each path runs.
 */
import { execFile, execFileSync } from "node:child_process";
import {
  existsSync,
  globSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { builtinModules } from "node:module";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import ts from "typescript";
import type { ViteUserConfigExport } from "vitest/config";
import { parse } from "yaml";

const execFileAsync = promisify(execFile);

export const WORKFLOW = ".github/workflows/language-smoke.yml";

/** Inputs that no import reaches: what installs the packages the smoke imports. */
const MANIFESTS = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"];

/**
 * Crates the smoke runs, and why; their workspace dependencies run with them. ide-host is the
 * exception: it links every crate, and the smoke drives only part of it.
 */
export const rustSmoke: Record<string, string> = {
  "ide-host": "openidea-server and the smoke tests (crates/ide-host/tests/language_smoke.rs, project_smoke.rs)",
  "ide-lsp": "every code intelligence check of language_smoke.rs",
  "ide-dap": "debugging in smoke/debug.test.ts",
  "ide-run": "runs and test runs in smoke/run.test.ts",
  "ide-sdk": "the SDKs project_smoke.rs detects (jdk, python_venv)",
  "ide-tools": "the language servers and debuggers the IDE installs",
  "ide-search": "Find Usages candidates (Project::reference_candidates), language_smoke.rs references",
  "ide-streams": "debugStreamTrace in smoke/debug.test.ts",
};

export interface Alias {
  find: string | RegExp;
  replacement: string;
}

export interface Closure {
  /** Repository-relative `/`-separated path → what makes it an input (who imports it). */
  files: Map<string, string>;
  /** Imports that may load repository files but can't be followed. */
  problems: string[];
}

const isFile = (path: string) => existsSync(path) && statSync(path).isFile();
const packageName = (spec: string) =>
  spec
    .split("/")
    .slice(0, spec.startsWith("@") ? 2 : 1)
    .join("/");

/** Vite's alias rule (@rollup/plugin-alias): the first entry that matches rewrites the specifier. */
function applyAlias(spec: string, alias: Alias[]): string {
  const hit = alias.find(({ find }) =>
    typeof find === "string" ? spec === find || spec.startsWith(`${find}/`) : find.test(spec),
  );
  return hit ? spec.replace(hit.find, hit.replacement) : spec;
}

const isImportMeta = (node: ts.Node | undefined, name: string) =>
  !!node &&
  ts.isPropertyAccessExpression(node) &&
  node.name.text === name &&
  ts.isMetaProperty(node.expression) &&
  node.expression.keywordToken === ts.SyntaxKind.ImportKeyword;

/**
 * The repository files `entries` load, transitively: static, type-only and literal dynamic
 * imports, re-exports, `import.meta.glob`, `new URL(…, import.meta.url)`, `/// <reference path>`
 * and CSS `@import`. Packages and Vite's virtual modules are not repository files; an import that
 * might be one but can't be resolved, or is computed at run time, is a problem.
 */
export function importClosure(root: string, entries: string[], alias: Alias[], options: ts.CompilerOptions): Closure {
  root = realpathSync(root);
  const rel = (file: string) => relative(root, file).split(sep).join("/");
  const cache = ts.createModuleResolutionCache(root, (name) => name, options);
  const files = new Map<string, string>();
  const problems: string[] = [];
  const queue: string[] = [];

  const add = (file: string, why: string) => {
    // Alias targets may name the repository through a symlink (macOS /var → /private/var).
    const path = rel(realpathSync(file));
    if (path.startsWith("../") || isAbsolute(path)) return problems.push(`${why}: ${file} is outside the repository`);
    if (path.split("/").includes("node_modules") || files.has(path)) return;
    files.set(path, why);
    queue.push(resolve(root, path));
  };

  const follow = (spec: string, importer: string) => {
    const from = `imported by ${rel(importer)}`;
    if (/^(virtual:|\0|\/@)/.test(spec) || spec.startsWith("node:") || builtinModules.includes(spec)) return;
    const query = spec.indexOf("?");
    const path = applyAlias(query < 0 ? spec : spec.slice(0, query), alias);
    if (query < 0) {
      const hit = ts.resolveModuleName(path, importer, options, ts.sys, cache).resolvedModule;
      if (hit) {
        add(hit.resolvedFileName, from);
        // A declaration file beside the module Vite loads.
        if (hit.extension === ts.Extension.Dts) {
          const base = hit.resolvedFileName.slice(0, -".d.ts".length);
          for (const ext of [".js", ".mjs", ".cjs"]) if (isFile(base + ext)) add(base + ext, from);
        }
        return;
      }
    }
    // Assets (`./x.css`, `?raw`) and other files TypeScript doesn't resolve as modules.
    if (path.startsWith(".") || isAbsolute(path)) {
      const file = path.startsWith(".") ? resolve(dirname(importer), path) : isFile(path) ? path : join(root, path);
      if (isFile(file)) add(file, from);
      else problems.push(`${rel(importer)}: cannot resolve "${spec}"`);
    } else if (!existsSync(join(root, "node_modules", packageName(path)))) {
      problems.push(`${rel(importer)}: cannot resolve "${spec}" (not a local file, not an installed package)`);
    }
  };

  const globImport = (arg: ts.Expression | undefined, importer: string) => {
    const patterns = arg && ts.isArrayLiteralExpression(arg) ? [...arg.elements] : arg ? [arg] : [];
    if (!patterns.length || !patterns.every(ts.isStringLiteralLike)) {
      return problems.push(`${rel(importer)}: import.meta.glob with computed patterns`);
    }
    for (const { text } of patterns) {
      // Negated patterns only narrow the match.
      if (text.startsWith("!")) continue;
      const pattern = applyAlias(text, alias);
      const cwd = pattern.startsWith("/") && !pattern.startsWith(root) ? root : dirname(importer);
      for (const hit of globSync(pattern.startsWith(root) ? pattern : pattern.replace(/^\//, ""), { cwd })) {
        const file = resolve(cwd, hit);
        if (isFile(file)) add(file, `globbed by ${rel(importer)}`);
      }
    }
  };

  const scan = (file: string) => {
    const text = readFileSync(file, "utf8");
    if (file.endsWith(".css")) {
      for (const [, spec] of text.matchAll(/@import\s+(?:url\(\s*)?["']([^"']+)["']/g)) {
        if (spec && !/^[a-z]+:\/\//.test(spec)) follow(spec, file);
      }
      return;
    }
    if (!/\.[cm]?[jt]sx?$/.test(file)) return;
    const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false);
    for (const ref of tree.referencedFiles) {
      const target = resolve(dirname(file), ref.fileName);
      if (isFile(target)) add(target, `referenced by ${rel(file)}`);
      else problems.push(`${rel(file)}: cannot resolve reference "${ref.fileName}"`);
    }
    const visit = (node: ts.Node): void => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        follow(node.moduleSpecifier.text, file);
      } else if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference) &&
        ts.isStringLiteral(node.moduleReference.expression)
      ) {
        follow(node.moduleReference.expression.text, file);
      } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
        if (ts.isStringLiteral(node.argument.literal)) follow(node.argument.literal.text, file);
      } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const [arg] = node.arguments;
        if (arg && ts.isStringLiteralLike(arg)) follow(arg.text, file);
        else problems.push(`${rel(file)}: import() of a computed specifier`);
      } else if (ts.isCallExpression(node) && isImportMeta(node.expression, "glob")) {
        globImport(node.arguments[0], file);
      } else if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "URL" &&
        isImportMeta(node.arguments?.[1], "url")
      ) {
        // URL resolution: relative to the module even without "./".
        const arg = node.arguments?.[0];
        const spec = arg && ts.isStringLiteralLike(arg) ? arg.text.replace(/^(?![./])/, "./") : undefined;
        if (!spec) problems.push(`${rel(file)}: new URL(…, import.meta.url) of a computed path`);
        // A directory (an alias's target, say) is no module: what loads from it is imported on its own.
        else if (!existsSync(resolve(dirname(file), spec)) || isFile(resolve(dirname(file), spec))) follow(spec, file);
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
  };

  for (const entry of entries) {
    const file = resolve(root, entry);
    if (isFile(file)) add(file, "entry point");
    else problems.push(`${entry}: entry point not found`);
  }
  for (let file = queue.pop(); file; file = queue.pop()) scan(file);
  return { files: new Map([...files].sort(([a], [b]) => (a < b ? -1 : 1))), problems };
}

// ---- The workflow ----

interface Step {
  id?: string;
  run?: string;
}
export interface Workflow {
  on: Record<string, { paths?: string[] } | null>;
  jobs: Record<string, { steps?: Step[] }>;
}

export function readWorkflow(root: string): Workflow {
  return parse(readFileSync(join(root, WORKFLOW), "utf8")) as Workflow;
}

/** A GitHub path filter as a RegExp: `*` is any run of characters but `/`, `**` any run at all. */
export function filterPattern(glob: string): RegExp {
  if (/[?+[\]]|^!/.test(glob)) throw new Error(`path filter "${glob}": only * and ** are modelled here`);
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `^${glob
      .split("**")
      .map((part) => part.split("*").map(escape).join("[^/]*"))
      .join(".*")}$`,
  );
}

/** The test files the workflow's `pnpm smoke` steps run. */
export function smokeTestFiles(workflow: Workflow): string[] {
  const files = new Set<string>();
  for (const job of Object.values(workflow.jobs)) {
    for (const { run } of job.steps ?? []) {
      for (const [, args = ""] of (run ?? "").matchAll(/\bpnpm smoke\b(.*)/g)) {
        const named = args.trim().split(/\s+/);
        const end = named.findIndex((arg) => arg.startsWith("-"));
        const paths = named.slice(0, end < 0 ? undefined : end).filter(Boolean);
        if (!paths.length) throw new Error(`${WORKFLOW}: "pnpm smoke${args}" names no test file`);
        paths.forEach((path) => files.add(path));
      }
    }
  }
  return [...files];
}

function classifyScript(workflow: Workflow): string {
  const script = workflow.jobs.changes?.steps?.find((step) => step.id === "classify")?.run;
  if (!script) throw new Error(`${WORKFLOW}: no "classify" step in the "changes" job`);
  return script;
}

/**
 * Runs bash `driver` beside the Changes step (`classify.sh`) and `paths.txt`, as for a pull
 * request, then `collect`s from the scratch directory. The driver defines `gh`, which lists the
 * pull request's files.
 */
async function runChangesStep<T>(workflow: Workflow, paths: string[], driver: string, collect: (dir: string) => T) {
  const dir = mkdtempSync(join(tmpdir(), "smoke-paths-"));
  try {
    writeFileSync(join(dir, "classify.sh"), classifyScript(workflow));
    writeFileSync(join(dir, "paths.txt"), paths.map((path) => `${path}\n`).join(""));
    const { stdout } = await execFileAsync("bash", ["--noprofile", "--norc", "-c", driver], {
      cwd: dir,
      encoding: "utf8",
      maxBuffer: 64 << 20,
      env: { ...process.env, GITHUB_EVENT_NAME: "pull_request", GITHUB_REPOSITORY: "openidea/openidea", PR: "1" },
    });
    return { stdout, collected: collect(dir) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The Changes step's run, once per path: path → the languages a pull request changing only that path runs. */
export async function selectedLanguages(workflow: Workflow, paths: string[]): Promise<Map<string, string[]>> {
  const workers = Math.max(1, Math.min(availableParallelism(), paths.length));
  const chunks = Array.from({ length: workers }, (_, i) => paths.filter((_, j) => j % workers === i));
  const driver = `
    gh() { printf '%s\\n' "$CHANGED"; }
    export GITHUB_OUTPUT="$PWD/output"
    while IFS= read -r CHANGED; do
      : > "$GITHUB_OUTPUT"
      ( set -eo pipefail; . ./classify.sh ) > /dev/null 2> error
      status=$?
      printf '%s\\t%s\\t%s\\n' "$CHANGED" "$status" "$(grep '^languages=' "$GITHUB_OUTPUT" | cut -d= -f2-)$(tr '\\n' ' ' < error)"
    done < paths.txt`;
  const runs = await Promise.all(chunks.map((chunk) => runChangesStep(workflow, chunk, driver, () => undefined)));
  const result = new Map<string, string[]>();
  for (const line of runs.flatMap(({ stdout }) => stdout.split("\n")).filter(Boolean)) {
    const [path = "", status, output = ""] = line.split("\t");
    if (status !== "0") throw new Error(`${WORKFLOW}: the Changes step failed for ${path} (exit ${status}): ${output}`);
    result.set(path, JSON.parse(output) as string[]);
  }
  return result;
}

/**
 * The Changes step's own `all`, `smoke` and `unused` (set by its bash, never copied here) and the
 * paths its `grep -E` matches with each, for every path at once.
 */
async function changesPatterns(workflow: Workflow, paths: string[]) {
  const driver = `
    gh() { :; }
    report() {
      printf '%s\\n' "$all" > all
      grep -E -- "$smoke" paths.txt > smoke || [ $? -eq 1 ]
      grep -E -- "$unused" paths.txt > unused || [ $? -eq 1 ]
    }
    trap report EXIT
    export GITHUB_OUTPUT="$PWD/output"
    set -eo pipefail
    . ./classify.sh > /dev/null`;
  const { collected } = await runChangesStep(workflow, paths, driver, (dir) => {
    const lines = (name: string) => readFileSync(join(dir, name), "utf8").split(/\s+/).filter(Boolean);
    return { all: lines("all"), smoke: new Set(lines("smoke")), unused: new Set(lines("unused")) };
  });
  if (!collected.all.length) throw new Error(`${WORKFLOW}: the Changes step's "all" lists no language`);
  return collected;
}

/**
 * Paths a pull request or push could change without running every language, with why: outside an
 * `on.<event>.paths` filter, or not selected for every language by the Changes step.
 *
 * The step sends a path matching its `smoke` pattern and not its `unused` one, in its last case
 * arm, to every language; that decides every path. The step itself also runs for one path per
 * directory and outcome, so an earlier arm that takes a directory elsewhere breaks the check.
 */
export async function unselected(workflow: Workflow, paths: string[]): Promise<Map<string, string[]>> {
  const reasons = new Map<string, string[]>();
  const flag = (path: string, reason: string) => reasons.set(path, [...(reasons.get(path) ?? []), reason]);
  for (const event of ["pull_request", "push"]) {
    const filters = workflow.on[event]?.paths?.map(filterPattern);
    if (!filters) continue;
    for (const path of paths) if (!filters.some((filter) => filter.test(path))) flag(path, `not in on.${event}.paths`);
  }

  const { all, smoke, unused } = await changesPatterns(workflow, paths);
  const selects = (path: string) => smoke.has(path) && !unused.has(path);
  for (const path of paths) {
    if (!smoke.has(path)) flag(path, 'not matched by "smoke" in the Changes step');
    else if (unused.has(path)) flag(path, 'matched by "unused" in the Changes step');
  }
  const sample = new Map<string, string>();
  for (const path of paths) {
    const key = `${path.slice(0, path.lastIndexOf("/") + 1)}\t${selects(path)}`;
    if (!sample.has(key)) sample.set(key, path);
  }
  for (const [path, languages] of await selectedLanguages(workflow, [...sample.values()])) {
    if (all.every((language) => languages.includes(language)) !== selects(path)) {
      throw new Error(
        `${WORKFLOW}: for ${path} the Changes step runs ${languages.join(" ") || "no language"}, ` +
          `not what its "smoke" and "unused" patterns give; update unselected() in scripts/smoke-paths.ts`,
      );
    }
  }
  return reasons;
}

// ---- What the smoke depends on ----

/** Every repository file `pnpm smoke` loads or is built from, with why. */
export async function smokeInputs(root: string, workflow: Workflow): Promise<Closure> {
  root = realpathSync(root);
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts?: Record<string, string> };
  const configFile = /--config\s+(\S+)/.exec(pkg.scripts?.smoke ?? "")?.[1];
  if (!configFile) throw new Error('package.json: the "smoke" script names no --config file');
  // Named by the "smoke" script, so only known at run time.
  const loaded: { default: ViteUserConfigExport } = await import(pathToFileURL(join(root, configFile)).href);
  const config =
    typeof loaded.default === "function"
      ? await loaded.default({ command: "serve", mode: "test" })
      : await loaded.default;
  const rawAlias = config.resolve?.alias ?? [];
  const alias: Alias[] = Array.isArray(rawAlias)
    ? rawAlias.map(({ find, replacement }) => ({ find, replacement }))
    : Object.entries(rawAlias).map(([find, replacement]) => ({ find, replacement }));

  const tests = smokeTestFiles(workflow);
  const tsconfig = ts.findConfigFile(join(root, dirname(tests[0] ?? ".")), ts.sys.fileExists);
  if (!tsconfig) throw new Error(`no tsconfig.json for ${tests[0]}`);
  const parsed = ts.getParsedCommandLineOfConfigFile(
    tsconfig,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (d) => {
        throw new Error(ts.flattenDiagnosticMessageText(d.messageText, "\n"));
      },
    },
  );
  const setup = [config.test?.setupFiles ?? []].flat();
  const closure = importClosure(root, [...tests, configFile, ...setup], alias, parsed?.options ?? {});
  const files = new Map(closure.files);

  // Vite compiles each module with the options of its nearest tsconfig.json (and what it extends).
  const seen = new Set<string>();
  const addConfig = (file: string, why: string) => {
    const path = relative(root, file).split(sep).join("/");
    if (path.startsWith("../") || seen.has(path)) return;
    seen.add(path);
    files.set(path, why);
    const raw: { extends?: string | string[] } | undefined = ts.readConfigFile(file, ts.sys.readFile).config;
    const extended = raw?.extends;
    for (const base of [extended ?? []].flat()) {
      if (base.startsWith(".")) addConfig(resolve(dirname(file), base), `extended by ${path}`);
    }
  };
  for (const path of closure.files.keys()) {
    const config = ts.findConfigFile(join(root, dirname(path)), ts.sys.fileExists);
    if (config) addConfig(config, `compiles ${path}`);
  }

  for (const manifest of MANIFESTS) files.set(manifest, "installs the packages the smoke imports");
  const workspace = parse(readFileSync(join(root, "pnpm-workspace.yaml"), "utf8")) as {
    patchedDependencies?: Record<string, string>;
  };
  for (const patch of Object.values(workspace.patchedDependencies ?? {}))
    files.set(patch, "patches an installed package");
  return { files: new Map([...files].sort(([a], [b]) => (a < b ? -1 : 1))), problems: closure.problems };
}

/** The crates the smoke runs (path of their library root → why), from cargo metadata. */
export function rustSmokeInputs(root: string): Map<string, string> {
  const metadata = JSON.parse(
    execFileSync("cargo", ["metadata", "--no-deps", "--format-version", "1", "--offline"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 << 20,
    }),
  ) as {
    packages: {
      name: string;
      manifest_path: string;
      dependencies: { name: string; kind: string | null; path?: string }[];
      targets: { kind: string[]; src_path: string }[];
    }[];
  };
  const packages = new Map(metadata.packages.map((pkg) => [pkg.name, pkg]));
  const why = new Map<string, string>(Object.entries(rustSmoke));
  const queue = Object.keys(rustSmoke).filter((name) => name !== "ide-host");
  for (let name = queue.pop(); name; name = queue.pop()) {
    const pkg = packages.get(name);
    if (!pkg) throw new Error(`cargo metadata: no workspace crate ${name}`);
    for (const dep of pkg.dependencies) {
      if (!dep.path || dep.kind === "dev" || why.has(dep.name)) continue;
      why.set(dep.name, `dependency of ${name}`);
      queue.push(dep.name);
    }
  }
  const real = realpathSync(root);
  const inputs = new Map<string, string>();
  for (const [name, reason] of why) {
    const pkg = packages.get(name);
    if (!pkg) throw new Error(`cargo metadata: no workspace crate ${name}`);
    const target = pkg.targets.find((t) => t.kind.includes("lib")) ?? pkg.targets[0];
    const path = relative(real, realpathSync(target?.src_path ?? pkg.manifest_path))
      .split(sep)
      .join("/");
    inputs.set(path, `${name}: ${reason}`);
  }
  return inputs;
}

export function describeUnselected(reasons: Map<string, string[]>, inputs: Map<string, string>): string {
  if (!reasons.size) return "";
  const lines = [...reasons].map(([path, why]) => `  ${path} (${inputs.get(path)}): ${why.join("; ")}`);
  return [
    `Language smoke would not run every language for a change to:`,
    ...lines,
    ``,
    `Add these paths to both on.*.paths and the "smoke" pattern in ${WORKFLOW},`,
    `or change the dependency that brings them in.`,
  ].join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const workflow = readWorkflow(root);
  const asked = process.argv.slice(2);
  if (asked.length) {
    const filters = workflow.on.pull_request?.paths?.map(filterPattern);
    for (const [path, languages] of await selectedLanguages(workflow, asked)) {
      const triggered = !filters || filters.some((filter) => filter.test(path));
      console.log(`${path}: ${triggered ? languages.join(" ") || "no language" : "not in on.pull_request.paths"}`);
    }
  } else {
    const { files, problems } = await smokeInputs(root, workflow);
    const inputs = new Map([...files, ...rustSmokeInputs(root)]);
    const report = [...problems, describeUnselected(await unselected(workflow, [...inputs.keys()]), inputs)].filter(
      Boolean,
    );
    console.log(report.join("\n") || `All ${inputs.size} Language smoke inputs run every language.`);
    if (report.length) process.exitCode = 1;
  }
}
