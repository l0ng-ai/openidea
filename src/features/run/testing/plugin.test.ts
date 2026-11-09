import { describe, expect, it, vi } from "vitest";
import { providePluginTestParser } from "@/workbench/contributions";
import { PluginTestEvents, PluginTestOutput } from "./plugin";
import { TestResults } from "./results";

describe("plugin test events", () => {
  it("maps stable ids, nested paths, failures, output and UTF-16 locations to the existing tree", () => {
    const mapping = new PluginTestEvents();
    const location = { path: "/project/test.php", range: { start: { line: 2, col: 4 }, end: { line: 2, col: 6 } } };
    const events = mapping.map([
      { type: "suiteStarted", id: "suite", parent: null, name: "Suite", location: null },
      { type: "testStarted", id: "t", parent: "suite", name: "case", location },
      { type: "failed", id: "t", durationMs: 7, message: "mismatch", expected: "one", actual: "two", location: null },
    ]);
    expect(events).toContainEqual({
      type: "location",
      path: ["Suite", "case"],
      location: { path: location.path, line: 3, col: 5, resolve: "path" },
    });
    const tree = new TestResults();
    tree.apply(events);
    expect(tree.counts().failed).toBe(1);
    expect(mapping.map([{ type: "output", id: "t", text: "later" }])).toEqual([
      { type: "output", path: ["Suite", "case"], line: "later" },
    ]);
  });
  it("rejects an invalid parent without corrupting the last valid mapping", () => {
    const mapping = new PluginTestEvents();
    expect(() =>
      mapping.map([{ type: "testStarted", id: "x", parent: "missing", name: "bad", location: null }]),
    ).toThrow();
    expect(() => mapping.map([{ type: "passed", id: "x", durationMs: null }])).toThrow();
  });
  it("serializes bounded batches and falls back when a parser fails", async () => {
    const chunks: string[] = [];
    const dispose = providePluginTestParser(async (_id, chunk) => {
      chunks.push(chunk);
      return null;
    });
    const feed = vi.fn(() => [{ type: "start" as const, path: ["fallback"] }]);
    const apply = vi.fn();
    const parser = new PluginTestOutput("plugin:fixture:tests", { feed }, apply);
    parser.feed("x".repeat(40000));
    await parser.end();
    expect(chunks[0]!.length).toBeLessThanOrEqual(16000);
    expect(apply).toHaveBeenCalledWith([{ type: "start", path: ["fallback"] }]);
    dispose();
  });
});
