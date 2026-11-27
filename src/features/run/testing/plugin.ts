import { tx } from "@/platform/i18n";
import type { PluginTestEvent } from "@/bindings";
import { parsePluginTests } from "@/workbench/contributions";
import type { TestEvent, TestOutputParser } from "./types";

/** IDs stay private to a run; the existing tree uses display-name paths. */
export class PluginTestEvents {
  private paths = new Map<string, string[]>();
  private names = new Map<string, string>();
  map(events: readonly PluginTestEvent[]): TestEvent[] {
    const paths = new Map(this.paths);
    const names = new Map(this.names);
    const out: TestEvent[] = [];
    for (const event of events) {
      if (event.type === "other") continue;
      if (event.type === "suiteStarted" || event.type === "testStarted") {
        if (!event.id || !event.name || (event.parent && !paths.has(event.parent)))
          throw new Error("Invalid test parent");
        const path = [...(event.parent ? paths.get(event.parent)! : []), event.name];
        if (path.length > 128 || paths.size > 100000) throw new Error("Test tree too large");
        let key = JSON.stringify(path);
        if (names.has(key) && names.get(key) !== event.id) {
          path[path.length - 1] += ` [${event.id}]`;
          key = JSON.stringify(path);
        }
        names.set(key, event.id);
        paths.set(event.id, path);
        out.push({ type: "start", path });
        if (event.location)
          out.push({
            type: "location",
            path,
            location: {
              path: event.location.path,
              line: event.location.range.start.line + 1,
              col: event.location.range.start.col + 1,
              resolve: "path",
            },
          });
        continue;
      }
      const path = paths.get(event.id);
      if (!path) throw new Error("Unknown test id");
      if (event.type === "output") out.push({ type: "output", path, line: event.text });
      else if (event.type === "skipped") {
        out.push({ type: "result", path, status: "skipped" });
        if (event.reason) out.push({ type: "output", path, line: event.reason });
      } else {
        out.push({
          type: "result",
          path,
          status: event.type === "failed" ? "failed" : "passed",
          durationMs: event.durationMs ?? undefined,
        });
        if (event.type === "failed") {
          out.push({ type: "output", path, line: event.message });
          if (event.expected !== null) out.push({ type: "output", path, line: tx`Expected: ${event.expected}` });
          if (event.actual !== null) out.push({ type: "output", path, line: tx`Actual: ${event.actual}` });
          if (event.location)
            out.push({
              type: "location",
              path,
              location: {
                path: event.location.path,
                line: event.location.range.start.line + 1,
                col: event.location.range.start.col + 1,
                resolve: "path",
              },
            });
        }
      }
    }
    this.paths = paths;
    this.names = names;
    return out;
  }
}

/** Sequential, bounded batches; a parser failure switches this run to built-in parsing. */
export class PluginTestOutput {
  private readonly events = new PluginTestEvents();
  private pending = Promise.resolve();
  private pendingChars = 0;
  private buffer = "";
  private scheduled = false;
  private failed = false;
  private fallbackEvents: TestEvent[] = [];
  constructor(
    private readonly config: string,
    private readonly fallback: TestOutputParser,
    private readonly apply: (events: TestEvent[]) => void,
  ) {}
  feed(line: string) {
    const fallback = this.fallback.feed(line);
    if (this.failed) {
      this.apply(fallback);
      return;
    }
    this.fallbackEvents.push(...fallback);
    if (this.fallbackEvents.length > 10000) this.fallbackEvents.splice(0, this.fallbackEvents.length - 10000);
    this.buffer += `${line}\n`;
    if (!this.scheduled) {
      this.scheduled = true;
      queueMicrotask(() => {
        this.scheduled = false;
        this.flush();
      });
    }
  }
  private flush() {
    while (this.buffer.length) {
      let end = Math.min(this.buffer.length, 16000);
      const last = this.buffer.charCodeAt(end - 1);
      if (last >= 0xd800 && last <= 0xdbff) end--;
      const chunk = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(chunk.length);
      this.pendingChars += chunk.length;
      if (this.pendingChars > 1 << 20) {
        this.failed = true;
        this.buffer = "";
        this.apply(this.fallbackEvents);
        this.fallbackEvents = [];
        break;
      }
      this.pending = this.pending.then(async () => {
        this.pendingChars -= chunk.length;
        if (this.failed) return;
        try {
          const events = await parsePluginTests(this.config, chunk);
          if (events === null) throw new Error("Parser unavailable");
          this.apply(this.events.map(events));
        } catch {
          this.failed = true;
          this.apply(this.fallbackEvents);
          this.fallbackEvents = [];
        }
      });
    }
  }
  async end() {
    this.flush();
    await this.pending;
    if (this.failed) this.apply(this.fallback.end?.() ?? []);
    this.fallbackEvents = [];
  }
}
