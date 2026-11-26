import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunAnythingItem } from "@/bindings";
import { runAnythingProviderList } from "@/workbench/contributions";
import { createMemoryPluginsBackend, setPluginsBackend, type PluginsBackend } from "../backend";
import { claimsLine, projectRunAnything, wantsPrefix } from "../runAnything";

afterEach(() => setPluginsBackend(null));

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function withBackend(over: Partial<PluginsBackend>) {
  setPluginsBackend({ ...createMemoryPluginsBackend([]), ...over });
}

const provider = () => runAnythingProviderList().find((p) => p.id === "plugin.go.task")!;

describe("Run Anything prefixes", () => {
  it("asks for the prefix's entries while the word is typed and after it", () => {
    expect(["t", "ta", "task", "task ", "task build", "task  ns:build"].map((t) => wantsPrefix("task", t))).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(["", "tasks", "taskx build", "make task", "x"].map((t) => wantsPrefix("task", t))).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it("claims only lines whose first word is the prefix", () => {
    expect(claimsLine("task", "task build")).toBe(true);
    expect(claimsLine("task", "  task")).toBe(true);
    expect(claimsLine("task", "tasks build")).toBe(false);
    expect(claimsLine("task", "echo task")).toBe(false);
  });
});

describe("a plugin's Run Anything provider", () => {
  it("shows the plugin's answer for the latest text and drops one for older text", async () => {
    const answers = new Map<string, ReturnType<typeof deferred<RunAnythingItem[]>>>();
    const suggest = vi.fn((_p: string, _prefix: string, text: string) => {
      const d = deferred<RunAnythingItem[]>();
      answers.set(text, d);
      return d.promise;
    });
    withBackend({ runAnythingSuggest: suggest });
    const off = projectRunAnything("go", { prefix: "task", title: "Go Task" });
    const p = provider();
    const changed = vi.fn();
    const unsubscribe = p.subscribe!(changed);
    expect(p.group).toBe("Go Task");
    expect(p.items("make")).toEqual([]);
    expect(p.items("task b")).toEqual([]);
    expect(p.items("task bu")).toEqual([]);
    expect(suggest.mock.calls.map((c) => c[2])).toEqual(["task b", "task bu"]);
    // The answer for the older text arrives last-but-one: ignored.
    answers.get("task b")!.resolve([{ label: "task old", detail: null, line: null }]);
    answers.get("task bu")!.resolve([{ label: "task build", detail: "Taskfile.yml", line: "task ns:build" }]);
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    const [item] = p.items("task bu");
    expect(item).toMatchObject({ label: "task build", detail: "Taskfile.yml", completion: "task ns:build" });
    expect(suggest).toHaveBeenCalledTimes(2);
    unsubscribe();
    off();
    expect(runAnythingProviderList().some((q) => q.id === "plugin.go.task")).toBe(false);
  });

  it("runs only its lines, and keeps a line it claimed out of the shell when it fails", async () => {
    const run = vi.fn(async (_p: string, _prefix: string, line: string) => {
      if (line === "task broken") throw new Error("trap");
      return line !== "task unknown";
    });
    withBackend({ runAnythingRun: run });
    const off = projectRunAnything("go", { prefix: "task" });
    const p = provider();
    expect(p.accepts!("task build")).toBe(true);
    expect(p.accepts!("make build")).toBe(false);
    expect(await p.execute!("make build")).toBe(false);
    expect(await p.execute!("  task build ")).toBe(true);
    expect(run).toHaveBeenLastCalledWith("go", "task", "task build");
    // Left by the plugin: the next provider, and finally the shell, get it.
    expect(await p.execute!("task unknown")).toBe(false);
    expect(await p.execute!("task broken")).toBe(true);
    off();
  });
});
