/**
 * `node --test`: the IDE's reporter (`nodeTestReporter.js`) runs next to `spec` and prints a
 * record per finished test (`records.ts`). It reaches Node through `NODE_OPTIONS`, as does the
 * name filter: a `package.json` script's own arguments can't take them (`node --test` reads
 * options only before its file patterns).
 */
import REPORTER_SOURCE from "./nodeTestReporter.js?raw";

const REPORTER = `--test-reporter=data:text/javascript;base64,${btoa(REPORTER_SOURCE)}`;
const PATTERN_RE = /(^|\s)--test-name-pattern=(?:"(?:[^"\\]|\\.)*"|\S+)/g;

/** `NODE_OPTIONS` with the IDE's reporter added (once), `spec` keeping the console readable. */
export function withNodeTestReporter(env: Record<string, string>): Record<string, string> {
  const options = env.NODE_OPTIONS ?? "";
  if (options.includes(REPORTER) || /(^|\s)--test-reporter[=\s]/.test(options)) return env;
  const reporters = [
    "--test-reporter=spec",
    "--test-reporter-destination=stdout",
    REPORTER,
    "--test-reporter-destination=stdout",
  ];
  return { ...env, NODE_OPTIONS: [options, ...reporters].filter(Boolean).join(" ") };
}

/** `NODE_OPTIONS` selecting the tests whose full name (describe chain and name, space separated) matches `pattern`. */
export function withNodeTestNamePattern(env: Record<string, string>, pattern: string): Record<string, string> {
  const options = (env.NODE_OPTIONS ?? "").replace(PATTERN_RE, "").trim();
  // NODE_OPTIONS splits at spaces outside double quotes, where a backslash escapes the next character.
  const quoted = `"${pattern.replace(/[\\"]/g, "\\$&")}"`;
  return { ...env, NODE_OPTIONS: [options, `--test-name-pattern=${quoted}`].filter(Boolean).join(" ") };
}
