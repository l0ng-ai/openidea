// The IDE's Mocha hook (`--import`, passed as a data: URL through NODE_OPTIONS): once Mocha is
// loaded, every test a run reports also prints a record (`records.ts`) next to the run's own
// reporter, with the line the test is declared on (Mocha reports none). Runs in the user's
// Node (20+), so plain ESM without dependencies; reporting must never break a test run.
import Module from "node:module";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MARK = "@@openidea:test@@";
const DECLARED = Symbol("openidea.declared");
const FRAME = /(?:\(|\s)((?:file:\/\/\/?)?(?:[A-Za-z]:)?[^:()]+):(\d+):(\d+)\)?$/;

const fileOf = (path) => relative(process.cwd(), path).split("\\").join("/");

/** Where in `file` the code running now was called from: a test's declaration while Mocha loads the file. */
function declaredIn(file) {
  for (const frame of (new Error().stack ?? "").split("\n").slice(1)) {
    const m = FRAME.exec(frame);
    if (!m) continue;
    const path = m[1].startsWith("file:") ? fileURLToPath(m[1]) : m[1];
    if (resolve(path) === file) return { line: Number(m[2]), col: Number(m[3]) };
  }
  return null;
}

function report(test, status, error) {
  try {
    if (!test.file) return;
    const at = test[DECLARED];
    const record = {
      path: [fileOf(test.file), ...test.titlePath()],
      status,
      ms: test.duration,
      line: at?.line,
      col: at?.col,
      error: error === undefined ? undefined : String((error && error.stack) || error),
    };
    process.stdout.write(`${MARK}${JSON.stringify(record)}\n`);
  } catch {
    // A test object without its usual shape (a plugin's): no record.
  }
}

function watch(Mocha) {
  const addTest = Mocha.Suite.prototype.addTest;
  Mocha.Suite.prototype.addTest = function (test) {
    try {
      if (test && test.file) test[DECLARED] = declaredIn(resolve(test.file));
    } catch {
      // No declaration line.
    }
    return addTest.call(this, test);
  };
  const run = Mocha.Runner.prototype.run;
  Mocha.Runner.prototype.run = function (...args) {
    this.on("pass", (test) => report(test, "passed"));
    this.on("pending", (test) => report(test, "skipped"));
    // A failing hook fails the test it ran for, or reports as itself.
    this.on("fail", (runnable, error) =>
      report(runnable.type === "hook" ? (runnable.ctx?.currentTest ?? runnable) : runnable, "failed", error),
    );
    return run.apply(this, args);
  };
}

const load = Module._load;
let watching = false;
Module._load = function (...args) {
  const exports = load.apply(this, args);
  if (!watching && typeof exports === "function" && exports.Runner && exports.Suite && exports.reporters) {
    watching = true;
    try {
      watch(exports);
    } catch {
      // Another Mocha than expected: the run goes on without records.
    }
  }
  return exports;
};
