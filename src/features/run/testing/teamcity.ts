/**
 * TeamCity service messages (`##teamcity[testStarted name='…' …]`): PHPUnit's `--teamcity` output and
 * the Gradle test init script (`gradleTests.gradle`) report each test with them.
 */
import { TestStdout } from "./types";

const MESSAGE_RE = /^\s*##teamcity\[(\w+)((?:\s+[\w.-]+='(?:[^|']|\|.)*')*)\s*\]\s*$/;
const ATTR_RE = /([\w.-]+)='((?:[^|']|\|.)*)'/g;

/** TeamCity escapes: `|n` `|r` `|'` `|[` `|]` `||` and `|0xNNNN`. */
function unescape(value: string): string {
  return value.replace(/\|(0x[0-9a-fA-F]{4}|.)/g, (_, c: string) => {
    if (c.startsWith("0x")) return String.fromCharCode(Number.parseInt(c, 16));
    return c === "n" ? "\n" : c === "r" ? "\r" : c;
  });
}

export interface ServiceMessage {
  kind: string;
  attrs: Record<string, string>;
}

/** The service message on `line`, or null for any other output. */
export function serviceMessage(line: string): ServiceMessage | null {
  const m = MESSAGE_RE.exec(line);
  if (!m) return null;
  const attrs: Record<string, string> = {};
  for (const a of (m[2] ?? "").matchAll(ATTR_RE)) attrs[a[1]!] = unescape(a[2]!);
  return { kind: m[1]!, attrs };
}

/**
 * Console text of a run reporting through service messages: the messages feed the test tree. With
 * `testOutput`, a test's own stdout / stderr (`testStdOut`, `testStdErr`) and its failure are shown in
 * the console too, so the run reads like the program's output with no test selected (OpenIDEA's JUnit
 * runner and the Gradle init script report them only through these messages).
 */
export class TeamcityOutput extends TestStdout {
  constructor(feedLine: (line: string) => void, testOutput = false) {
    super(feedLine, (line) => {
      if (!MESSAGE_RE.test(line)) return line + "\n";
      if (!testOutput) return "";
      const message = serviceMessage(line);
      if (message?.kind === "testStdOut" || message?.kind === "testStdErr") return message.attrs.out ?? "";
      if (message?.kind !== "testFailed") return "";
      const failure = (message.attrs.details || message.attrs.message || "").replace(/\n$/, "");
      return failure ? failure + "\n" : "";
    });
  }
}
