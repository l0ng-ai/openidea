// The IDE's Jasmine hook (`--import`, passed as a data: URL through NODE_OPTIONS): once
// `jasmine-core` is booted, every spec a run reports also prints a record (`records.ts`) next to
// the run's own reporter, with the line the spec is declared on (Jasmine reports none). Runs in the
// user's Node (20+), so plain ESM without dependencies; reporting must never break a test run.
import Module from "node:module";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MARK = "@@openidea:test@@";
const FRAME = /(?:\(|\s)((?:file:\/\/\/?)?(?:[A-Za-z]:)?[^:()]+):(\d+):(\d+)\)?$/;

// Jasmine reports ES modules' files as URLs (`file:/...`).
const pathOf = (file) => resolve(file.startsWith("file:") ? fileURLToPath(file) : file);
const fileOf = (file) => relative(process.cwd(), pathOf(file)).split("\\").join("/");

/** The first frame of `stack` in the user's code: where a spec is declared while Jasmine loads its file. */
function declaration(stack) {
  for (const frame of stack.split("\n")) {
    const m = FRAME.exec(frame);
    if (!m || m[1].startsWith("node:") || /[\\/]node_modules[\\/]/.test(m[1])) continue;
    return { file: pathOf(m[1]), line: Number(m[2]), col: Number(m[3]) };
  }
  return null;
}

function watch(env) {
  /** Spec id to where it is declared. */
  const declared = new Map();
  // The globals are replaced, not wrapped: Jasmine finds a spec's file at a fixed depth in the stack
  // below `env.it`, which a wrapper would shift.
  for (const name of ["it", "fit", "xit"]) {
    if (typeof globalThis[name] !== "function" || typeof env[name] !== "function") continue;
    globalThis[name] = function () {
      const spec = env[name].apply(env, arguments);
      try {
        // Below the first two lines (the message, this function): the caller.
        const at = declaration((new Error().stack ?? "").split("\n").slice(2).join("\n"));
        if (spec && spec.id !== undefined && at) declared.set(spec.id, at);
      } catch {
        // No declaration line.
      }
      return spec;
    };
  }

  const suites = [];
  const report = (result, names, status) => {
    try {
      const at = declared.get(result.id);
      const file = result.filename ?? at?.file;
      if (!file) return;
      // An expectation's stack leaves out its message.
      const errors = (result.failedExpectations ?? []).map((e) =>
        e.stack?.includes(e.message) ? e.stack : [e.message, e.stack].filter(Boolean).join("\n"),
      );
      const record = {
        path: [fileOf(file), ...names],
        status,
        ms: result.duration ?? undefined,
        line: at?.line,
        col: at?.col,
        error: errors.length ? errors.join("\n") : undefined,
      };
      process.stdout.write(`${MARK}${JSON.stringify(record)}\n`);
    } catch {
      // A result without its usual shape: no record.
    }
  };
  env.addReporter({
    suiteStarted: (result) => suites.push(result.description),
    suiteDone: (result) => {
      // An error in `beforeAll` / `afterAll` (or the describe body) fails the suite itself.
      if (result.failedExpectations?.length) report(result, [...suites], "failed");
      suites.pop();
    },
    specDone: (result) => {
      // `excluded`: left out by `fit` / `fdescribe` or `--filter`; not part of this run.
      const status = { passed: "passed", failed: "failed", pending: "skipped" }[result.status];
      if (status) report(result, [...suites, result.description], status);
    },
  });
}

const load = Module._load;
const watched = new WeakSet();
let patched = false;
Module._load = function (...args) {
  const exports = load.apply(this, args);
  // `jasmine-core`, which the runner (and each `--parallel` worker) boots to get its environment.
  if (!patched && typeof exports?.boot === "function" && typeof exports.version === "function") {
    patched = true;
    const boot = exports.boot;
    exports.boot = function (...bootArgs) {
      const jasmine = boot.apply(this, bootArgs);
      try {
        // The runner creates the environment with its own options: watch it once it does.
        const getEnv = jasmine.getEnv;
        jasmine.getEnv = function (...envArgs) {
          const env = getEnv.apply(this, envArgs);
          try {
            if (!watched.has(env)) {
              watched.add(env);
              watch(env);
            }
          } catch {
            // Another Jasmine than expected: the run goes on without records.
          }
          return env;
        };
      } catch {
        // No environment to watch.
      }
      return jasmine;
    };
  }
  return exports;
};
