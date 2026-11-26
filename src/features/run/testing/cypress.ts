/**
 * Cypress through its built-in `teamcity` reporter (the run adds `--reporter teamcity`): service
 * messages for each suite and test, with durations and failure details. They name no file: Cypress
 * prints `Running:  cart.cy.ts  (1 of 2)` before each spec, relative to the specs' common folder,
 * which the `--spec` paths of the run, when it names them, turn back into the path they were given as.
 *
 * `cypress run` has no option selecting tests by name: a test or suite runs its spec with its full
 * title in `CYPRESS_grep` (`Cypress.env("grep")`), which the official `@cypress/grep` plugin reads; its
 * version 7 reads `--expose grep=…` instead, added at launch for Cypress 15.10+ (`cypressType.ts`).
 */
import type { RunConfig } from "@/platform/ipc";
import { stripAnsi } from "@/ui/ansi";
import { cypressType } from "../cypressType";
import { appendScriptArgs } from "../scriptArgs";
import { serviceMessage } from "./teamcity";
import type { TestEvent, TestOutputParser } from "./types";

const RUNNING_RE = /^\s*Running:\s+(.+?)\s+\(\d+ of \d+\)$/;
/** Mocha's title of a failing hook: `"before each" hook for "test"`, `"after all" hook: name for "test"`. */
const HOOK_RE = /^"(?:before|after) (each|all)" hook(?:: .*?)?(?: for "(.*)")?$/;
/** A long spec path wraps onto lines of its own, under where it starts. */
const WRAPPED_RE = /^ {12}(\S.*?)\s*$/;

/** Values of `--spec` / `-s`: comma-separated paths or globs. */
export function cypressSpecs(args: readonly string[]): string[] {
  const out: string[] = [];
  args.forEach((a, i) => {
    const value = a === "--spec" || a === "-s" ? args[i + 1] : a.startsWith("--spec=") ? a.slice(7) : undefined;
    if (value) out.push(...value.split(",").map((s) => s.trim().replace(/\\/g, "/").replace(/^\.\//, "")));
  });
  return out.filter(Boolean);
}

/** The file a `Running:` name stands for: the `--spec` path it ends with, else the name itself. */
function specFile(name: string, specs: readonly string[]): string {
  const clean = name.replace(/\\/g, "/");
  const given = specs.map((s) => s.replace(/^\*\*\//, "")).find((s) => s === clean || s.endsWith(`/${clean}`));
  return given ?? clean;
}

export function cypressParser(specs: readonly string[] = []): TestOutputParser {
  let file = "";
  /** The `Running:` name while it may continue on the next line. */
  let wrapping: string | null = null;
  const suites: string[] = [];
  const open = new Map<string, { path: string[]; failed: boolean }>();
  /** `it.skip`: reported ignored, then started and never finished. */
  const ignored = new Set<string>();
  const pathOf = (name: string) => [file, ...suites, name];
  return {
    feed(raw) {
      const line = stripAnsi(raw);
      const wrapped = WRAPPED_RE.exec(line);
      if (wrapping !== null && wrapped && !line.includes("##teamcity[")) {
        wrapping += wrapped[1]!;
        file = specFile(wrapping, specs);
        return [];
      }
      wrapping = null;
      const running = RUNNING_RE.exec(line);
      if (running) {
        wrapping = running[1]!;
        file = specFile(running[1]!, specs);
        suites.length = 0;
        open.clear();
        ignored.clear();
        return [];
      }
      const message = serviceMessage(line);
      if (!message || !file) return [];
      const { kind, attrs: a } = message;
      const name = a.name ?? "";
      const events: TestEvent[] = [];
      const path = pathOf(name);
      const key = path.join("\u0000");
      switch (kind) {
        case "testSuiteStarted":
          suites.push(name);
          break;
        case "testSuiteFinished":
          if (suites[suites.length - 1] === name) suites.pop();
          break;
        case "testStarted":
          if (ignored.has(key)) break;
          open.set(key, { path, failed: false });
          events.push({ type: "start", path });
          events.push({ type: "location", path, location: { path: file, resolve: "path", test: path.slice(1) } });
          break;
        case "testIgnored":
          ignored.add(key);
          events.push({ type: "location", path, location: { path: file, resolve: "path", test: path.slice(1) } });
          events.push({ type: "result", path, status: "skipped" });
          break;
        case "testFailed": {
          // A failing hook is reported under its own title (`"before each" hook for "adds"`): an `each` hook
          // fails the test it ran for, an `all` hook its suite (whose remaining tests Cypress skips).
          const hook = HOOK_RE.exec(name);
          const failed = !hook ? path : hook[1] === "each" ? pathOf(hook[2] ?? name) : [file, ...suites];
          const test = open.get(failed.join("\u0000"));
          if (test) test.failed = true;
          const text = a.details || a.message || "";
          for (const l of text.replace(/\n$/, "").split("\n")) events.push({ type: "output", path: failed, line: l });
          events.push({ type: "result", path: failed, status: "failed" });
          break;
        }
        case "testFinished": {
          const test = open.get(key);
          if (!test) break;
          open.delete(key);
          const durationMs = a.duration ? Number(a.duration) : undefined;
          events.push({ type: "result", path, status: test.failed ? "failed" : "passed", durationMs });
          break;
        }
      }
      return events;
    },
  };
}

/** A component spec: it mounts components, or sits in `cypress/component/` (others are end-to-end specs). */
export function isCypressComponentSpec(relPath: string, content?: string): boolean {
  return /(^|\/)cypress\/component\//.test(relPath) || /\bcy\.mount\s*\(/.test(content ?? "");
}

/** The environment variable carrying the titles to run: `@cypress/grep` before version 7 reads it as `Cypress.env("grep")`. */
export const CYPRESS_GREP = "CYPRESS_grep";
const CYPRESS_GREP_OMIT = "CYPRESS_grepOmitFiltered";

/**
 * Arguments, environment (and a Cypress configuration's form) running `specs` (paths or globs relative to
 * the project) on `config`, in place of its own `--spec`. `grep`: full titles (describe chain and name) for
 * `@cypress/grep`, `; ` separated; none runs the specs whole. `component`: the testing type the specs need,
 * switched on a Cypress configuration's own arguments.
 */
export function cypressSelection(
  config: RunConfig,
  specs: string[],
  { grep = [], component }: { grep?: string[]; component?: boolean } = {},
): Pick<RunConfig, "args" | "params" | "env"> {
  const args: string[] = [];
  for (let i = 0; i < config.args.length; i++) {
    const a = config.args[i]!;
    if (a === "--spec" || a === "-s") i++;
    else if (!a.startsWith("--spec=")) args.push(a);
  }
  const own =
    config.kind === "cypress" && component !== undefined
      ? args.filter((a) => a !== "--component" && a !== "--e2e")
      : args;
  const mode = component && !own.includes("--component") ? ["--component"] : [];
  const selected = appendScriptArgs(config.command, own, [...mode, "--spec", specs.join(",")]);
  const { [CYPRESS_GREP]: _grep, [CYPRESS_GREP_OMIT]: _omit, ...env } = config.env;
  // Tests left out are not reported at all (else as skipped).
  if (grep.length) Object.assign(env, { [CYPRESS_GREP]: grep.join("; "), [CYPRESS_GREP_OMIT]: "true" });
  // A Cypress configuration's form shows what runs: the specs, the testing type.
  const params =
    config.kind === "cypress" ? (cypressType.paramsFrom!({ ...config, args: selected }) ?? undefined) : config.params;
  return { args: selected, params, env };
}
