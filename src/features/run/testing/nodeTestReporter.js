// The IDE's node:test reporter (`--test-reporter`, passed as a data: URL through NODE_OPTIONS
// next to `spec`): one record per finished test, which the IDE turns into the test tree and
// hides from the console (`records.ts`). Runs in the user's Node (20+), so plain ESM without dependencies.
import { relative, resolve } from "node:path";

const MARK = "@@openidea:test@@";

const fileOf = (path) => (path ? relative(process.cwd(), path).split("\\").join("/") : "");

function message(error) {
  // node:test wraps what the test threw in an ERR_TEST_FAILURE whose `cause` it is.
  const cause = error && error.code === "ERR_TEST_FAILURE" && error.cause !== undefined ? error.cause : error;
  if (cause instanceof Error) return cause.stack || `${cause.name}: ${cause.message}`;
  return String(cause);
}

export default async function* reporter(source) {
  /** Per file, the names of the tests being reported, by nesting level. */
  const open = new Map();
  for await (const { type, data } of source) {
    if (type !== "test:start" && type !== "test:pass" && type !== "test:fail") continue;
    const file = fileOf(data.file);
    // A file without reported tests (none matched, or it failed to load) reports as a test named after it.
    const self = data.nesting === 0 && data.file && resolve(data.name) === resolve(data.file);
    const names = open.get(file) ?? [];
    open.set(file, names);
    if (type === "test:start") {
      names.length = data.nesting;
      names.push(data.name);
      continue;
    }
    const path = [...(file ? [file] : []), ...(self ? [] : [...names.slice(0, data.nesting), data.name])];
    const details = data.details ?? {};
    const record = {
      path,
      status:
        type === "test:fail" ? "failed" : data.skip !== undefined || data.todo !== undefined ? "skipped" : "passed",
      ms: details.duration_ms,
      line: self ? undefined : data.line,
      col: self ? undefined : data.column,
      error:
        type === "test:fail" && details.error && details.error.failureType !== "subtestsFailed"
          ? message(details.error)
          : undefined,
    };
    yield `${MARK}${JSON.stringify(record)}\n`;
  }
}
