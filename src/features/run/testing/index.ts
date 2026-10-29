/** Picks the test output parser for a run configuration. */
import type { RunConfig } from "@/platform/ipc";
import { cargoParser } from "./cargo";
import { goParser } from "./go";
import { jsParser } from "./js";
import { jvmParser } from "./jvm";
import { pytestParser } from "./pytest";
import type { TestEvent, TestOutputParser } from "./types";

export type { TestEvent, TestOutputParser, TestStatus } from "./types";
export { parseDuration } from "./types";
export { TestResults, nodeStatus, type TestNode } from "./results";
export { cargoParser, goParser, jsParser, jvmParser, pytestParser };

/** Runs several parsers side by side (unknown tool: e.g. `make test`). */
export function combinedParser(parsers: TestOutputParser[]): TestOutputParser {
  return {
    feed: (line) => parsers.flatMap((p) => p.feed(line)),
    end: () => parsers.flatMap((p) => p.end?.() ?? []),
  };
}

export type Framework = "cargo" | "js" | "pytest" | "go" | "jvm" | "auto";

export function frameworkFor(config: Pick<RunConfig, "kind" | "command" | "args">): Framework {
  const cmd = [config.command, ...config.args].join(" ");
  switch (config.kind) {
    case "cargo":
      return "cargo";
    case "npm":
    case "deno":
    case "bun":
      return "js";
    case "pytest":
    case "python":
      return "pytest";
    case "go":
      return "go";
    case "gradle":
    case "maven":
      return "jvm";
  }
  if (/\bcargo\b/.test(cmd)) return "cargo";
  if (/\b(jest|vitest|npm|pnpm|yarn|bun|npx|deno)\b/.test(cmd)) return "js";
  if (/\bpytest\b/.test(cmd)) return "pytest";
  if (/\bgo\s+test\b/.test(cmd)) return "go";
  if (/\b(gradlew?|mvnw?)\b/.test(cmd)) return "jvm";
  return "auto";
}

/**
 * Launch arguments that make a test run reportable per test: pytest prints
 * only progress dots by default, so passed tests would never reach the tree.
 * `-v` adds one line per test (live, like IDEA's runner) unless the user
 * chose a verbosity already.
 */
export function withTestReporting<T extends Pick<RunConfig, "kind" | "command" | "args">>(config: T): T {
  if (frameworkFor(config) !== "pytest") return config;
  const cmd = [config.command, ...config.args];
  const pytestAt = cmd.findIndex((a) => /(^|[/\\])pytest(\.exe)?$/.test(a));
  if (pytestAt < 0) return config;
  const chosen = cmd.slice(pytestAt + 1).some((a) => /^-[vq]+$|^--(verbose|quiet)$|^--verbosity/.test(a));
  return chosen ? config : { ...config, args: [...config.args, "-v"] };
}

export function createTestParser(config: Pick<RunConfig, "kind" | "command" | "args">): TestOutputParser {
  switch (frameworkFor(config)) {
    case "cargo":
      return cargoParser();
    case "js":
      return jsParser();
    case "pytest":
      return pytestParser();
    case "go":
      return goParser();
    case "jvm":
      return jvmParser();
    default:
      return combinedParser([cargoParser(), jsParser(), pytestParser(), goParser(), jvmParser()]);
  }
}

/** Convenience for tests and batch parsing. */
export function parseAll(parser: TestOutputParser, text: string): TestEvent[] {
  const events = text.split("\n").flatMap((l) => parser.feed(l.replace(/\r$/, "")));
  return [...events, ...(parser.end?.() ?? [])];
}
