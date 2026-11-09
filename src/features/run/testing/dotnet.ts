import type { RunConfig } from "@/platform/ipc";
import type { TestEvent } from "./types";

/** Only this invocation's reports are read, including each target framework's report. */
export class DotnetReports {
  readonly prefix = `openidea-${crypto.randomUUID()}`;
  private readonly paths = new Set<string>();
  private mtp = false;

  launch(config: RunConfig): RunConfig {
    this.mtp = config.params?.runner === "mtp" || config.params?.runner === "mtp-legacy";
    if (this.mtp) {
      if (config.params?.trx === "false") return config;
      const args = [...config.args];
      if (config.params?.runner === "mtp-legacy" && !args.includes("--")) args.push("--");
      if (!args.includes("--report-trx")) args.push("--report-trx");
      return { ...config, args };
    }
    const boundary = config.args.indexOf("--");
    const at = boundary < 0 ? config.args.length : boundary;
    return {
      ...config,
      args: [...config.args.slice(0, at), "--logger", `trx;LogFilePrefix=${this.prefix}`, ...config.args.slice(at)],
    };
  }

  feed(line: string) {
    // Match the absolute report path, independently of VSTest's UI language.
    const path = /(?:[A-Za-z]:[\\/]|\/).*\.trx\s*$/i.exec(line)?.[0].trim();
    if (path && (this.mtp || path.replace(/\\/g, "/").split("/").at(-1)?.startsWith(this.prefix))) this.paths.add(path);
  }

  async read(readText: (path: string) => Promise<string>): Promise<TestEvent[]> {
    const events: TestEvent[] = [];
    for (const path of this.paths) events.push(...trxEvents(await readText(path)));
    return events;
  }
}

const elements = (node: Document | Element, name: string) => Array.from(node.getElementsByTagNameNS("*", name));
const attr = (node: Element, name: string) => node.getAttribute(name) ?? "";

export function trxEvents(xml: string): TestEvent[] {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (elements(doc, "parsererror").length || doc.documentElement.localName !== "TestRun")
    throw new Error("Invalid TRX report");
  const definitions = new Map(
    elements(doc, "UnitTest").map((test) => [attr(test, "id"), elements(test, "TestMethod")[0]]),
  );
  const events: TestEvent[] = [];
  for (const result of elements(doc, "UnitTestResult")) {
    const method = definitions.get(attr(result, "testId"));
    if (!method) continue;
    const className = attr(method, "className").split(",")[0]!;
    const name = attr(method, "name").replace(/\(.*$/s, "").trim();
    const source = attr(method, "codeBase").replace(/\\/g, "/");
    if (!className || !name || !source) continue;
    const display = (attr(result, "testName") || name).replace(
      new RegExp(`^${className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.`),
      "",
    );
    const path = [source, className, name, ...(display === name ? [] : [display])];
    const outcome = attr(result, "outcome");
    const status =
      outcome === "Passed" ? "passed" : /^(NotExecuted|Inconclusive|Pending)$/.test(outcome) ? "skipped" : "failed";
    const duration = /^(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(attr(result, "duration"));
    const durationMs = duration
      ? (Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3])) * 1000
      : undefined;
    events.push({ type: "result", path, status, durationMs });
    for (const tag of ["Message", "StackTrace", "StdOut", "StdErr"]) {
      for (const node of elements(result, tag)) {
        for (const line of (node.textContent ?? "").split(/\r?\n/).slice(0, 200)) {
          events.push({ type: "output", path, line });
          const location = /\bin (.+\.(?:cs|fs|vb)):(?:line )?(\d+)/.exec(line);
          if (location)
            events.push({
              type: "location",
              path,
              location: { path: location[1]!, line: Number(location[2]), resolve: "path" },
            });
        }
      }
    }
  }
  return events;
}

/** A parameterized case reruns its method, using adapter-independent TRX method identities. */
export function dotnetFilter(paths: string[][]): string | null {
  if (paths.some((path) => path.length < 3)) return null;
  const names = [...new Set(paths.map((path) => `${path[1]}.${path[2]}`))];
  if (!names.length) return null;
  return names.map((name) => `FullyQualifiedName=${name.replace(/[\\()&|=!~]/g, "\\$&")}`).join("|");
}
