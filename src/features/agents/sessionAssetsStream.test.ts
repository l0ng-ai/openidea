/**
 * Assets are read from the conversation after every streamed chunk: the entries a chunk
 * leaves alone must not be scanned again, however long the conversation is.
 */
import { describe, expect, it } from "vitest";
import type { AgentEntry, AgentTask } from "@/bindings";
import { extractSessionAssets } from "./sessionAssetsModel";

const task = { cwd: "/repo", projectRoot: "/repo" } satisfies Pick<AgentTask, "cwd" | "projectRoot">;

/** A finished `gh` call whose output names a pull request; `reads.count` counts how often the output is read. */
function ghCall(i: number, reads: { count: number }): AgentEntry {
  const entry: AgentEntry = {
    type: "tool",
    id: `gh-${i}`,
    title: `gh pr view ${1000 + i}`,
    kind: "execute",
    status: "completed",
    locations: [],
    output: null,
    diffs: [],
  };
  Object.defineProperty(entry, "output", {
    get() {
      reads.count++;
      return `https://github.com/acme/app/pull/${1000 + i}`;
    },
  });
  return entry;
}

const agent = (text: string): AgentEntry => ({ type: "agent", text });
const pullRequests = (entries: AgentEntry[]) =>
  extractSessionAssets({ task, entries }).pullRequests.map((pr) => pr.idLabel);

describe("assets while a reply streams", () => {
  it("does not read the output of earlier tool calls again for each chunk", () => {
    const reads = { count: 0 };
    const earlier = Array.from({ length: 200 }, (_, i) => ghCall(i, reads));
    pullRequests([...earlier, agent("")]);
    expect(reads.count).toBeGreaterThan(0);

    reads.count = 0;
    for (let chunk = 1; chunk <= 20; chunk++) pullRequests([...earlier, agent("word ".repeat(chunk))]);
    expect(reads.count).toBe(0);
  });

  it("shows a reference the streamed message names as soon as its text has it", () => {
    const reads = { count: 0 };
    const earlier = [ghCall(0, reads), ghCall(1, reads)];
    expect(pullRequests([...earlier, agent("Opened it: https://github.com/acme/app/pu")])).toEqual(["#1001", "#1000"]);
    expect(pullRequests([...earlier, agent("Opened it: https://github.com/acme/app/pull/77 for review")])).toEqual([
      "#77",
      "#1001",
      "#1000",
    ]);
  });
});
