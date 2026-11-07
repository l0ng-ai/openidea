/** Picks the test output parser for a run configuration. */
import type { RunConfig } from "@/platform/ipc";
import { cargoParser } from "./cargo";
import { goParser } from "./go";
import { jsParser } from "./js";
import { jvmParser } from "./jvm";
import { phpunitParser, withTeamcity } from "./phpunit";
import { pytestParser } from "./pytest";
import { rubyParser } from "./ruby";
import { unittestParser } from "./unittest";
import type { TestEvent, TestOutputParser } from "./types";

export type { TestEvent, TestOutputParser, TestStatus } from "./types";
export { parseDuration } from "./types";
export { TestResults, nodeStatus, type TestNode } from "./results";
export { cargoParser, goParser, jsParser, jvmParser, phpunitParser, pytestParser, rubyParser, unittestParser };

/** Runs several parsers side by side (unknown tool: e.g. `make test`). */
export function combinedParser(parsers: TestOutputParser[]): TestOutputParser {
  return {
    feed: (line) => parsers.flatMap((p) => p.feed(line)),
    end: () => parsers.flatMap((p) => p.end?.() ?? []),
  };
}

export type Framework = "cargo" | "js" | "pytest" | "unittest" | "phpunit" | "go" | "jvm" | "ruby" | "auto";

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
      return "pytest";
    case "python":
      // `manage.py test` made as a Python configuration before the Django tests type existed.
      return /\bmanage\.py test\b/.test(cmd) ? "unittest" : "pytest";
    case "django-test":
      return "unittest";
    case "phpunit":
      return "phpunit";
    case "go":
      return "go";
    case "gradle":
    case "maven":
      return "jvm";
    case "ruby":
    case "rake":
    case "rspec":
      return "ruby";
  }
  if (/\bcargo\b/.test(cmd)) return "cargo";
  if (/\b(jest|vitest|npm|pnpm|yarn|bun|npx|deno)\b/.test(cmd)) return "js";
  if (/\bpytest\b/.test(cmd)) return "pytest";
  if (/\bmanage\.py test\b/.test(cmd)) return "unittest";
  if (/(^|[/\\\s])phpunit(\.phar|\.bat)?(\s|$)/.test(cmd)) return "phpunit";
  if (/\bgo\s+test\b/.test(cmd)) return "go";
  if (/\b(gradlew?|mvnw?)\b/.test(cmd)) return "jvm";
  return "auto";
}

/** `TESTOPTS=-v` / a trailing `-v`: Minitest prints a line per test only when verbose. */
function rubyVerbose<T extends Pick<RunConfig, "kind" | "command" | "args">>(config: T): T {
  if (config.kind === "rspec") return config;
  if (config.kind === "rake") {
    const at = config.args.findIndex((a) => a.startsWith("TESTOPTS="));
    if (at < 0) return { ...config, args: [...config.args, "TESTOPTS=-v"] };
    // Options already given (`--name=Class#test_x`): add ours unless verbosity was chosen.
    return /(^|\s)(-v|--verbose)(\s|$)/.test(config.args[at]!)
      ? config
      : { ...config, args: config.args.map((a, i) => (i === at ? `${a} -v` : a)) };
  }
  const chosen = config.args.some((a) => a === "-v" || a === "--verbose");
  return chosen ? config : { ...config, args: [...config.args, "-v"] };
}

/**
 * Launch arguments that make a test run reportable per test: pytest and
 * Django print only progress dots by default, so passed tests would never
 * reach the tree. `-v` (Django: `-v 2`) adds one line per test (live, like
 * IDEA's runner) unless the user chose a verbosity already.
 */
export function withTestReporting<T extends Pick<RunConfig, "kind" | "command" | "args">>(config: T): T {
  if (frameworkFor(config) === "go" && config.args[0] === "test") {
    const boundary = config.args.findIndex((a) => a === "-args" || a === "--");
    const tool = boundary < 0 ? config.args : config.args.slice(0, boundary);
    const args = tool.filter((a) => a !== "-json" && !a.startsWith("-json="));
    return {
      ...config,
      args: ["test", "-json", ...args.slice(1), ...(boundary < 0 ? [] : config.args.slice(boundary))],
    };
  }
  if (frameworkFor(config) === "phpunit") return { ...config, args: withTeamcity(config.args) };
  if (frameworkFor(config) === "unittest") {
    const chosen = config.args.some((a) => /^(-v|--verbosity)(=?\d)?$/.test(a));
    return chosen ? config : { ...config, args: [...config.args, "-v", "2"] };
  }
  if (frameworkFor(config) === "ruby") return rubyVerbose(config);
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
    case "unittest":
      return unittestParser();
    case "phpunit":
      return phpunitParser();
    case "go":
      return goParser();
    case "jvm":
      return jvmParser();
    case "ruby":
      return rubyParser();
    default:
      return combinedParser([
        cargoParser(),
        jsParser(),
        pytestParser(),
        unittestParser(),
        phpunitParser(),
        goParser(),
        jvmParser(),
        rubyParser(),
      ]);
  }
}

/** Convenience for tests and batch parsing. */
export function parseAll(parser: TestOutputParser, text: string): TestEvent[] {
  const events = text.split("\n").flatMap((l) => parser.feed(l.replace(/\r$/, "")));
  return [...events, ...(parser.end?.() ?? [])];
}
