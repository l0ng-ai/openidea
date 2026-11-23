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

  it("ranks a conversation the same when it reads it from what it kept", () => {
    const tool = (extra: Partial<Extract<AgentEntry, { type: "tool" }>>): AgentEntry => ({
      type: "tool",
      id: "t",
      title: "tool",
      kind: "other",
      status: "completed",
      locations: [],
      output: null,
      diffs: [],
      ...extra,
    });
    const entries: AgentEntry[] = [
      {
        type: "user",
        text: "See [the spec](https://github.com/acme/app/issues/5) and @docs/spec.md",
        attachments: ["/repo/notes.md"],
        steered: false,
      },
      tool({ kind: "edit", diffs: [{ path: "/repo/docs/report.md", added: 3, removed: 0 }] }),
      tool({
        kind: "execute",
        title: 'gh pr create --title "Add the thing"',
        output: "https://github.com/acme/app/pull/40\n",
      }),
      tool({
        kind: "execute",
        title: "gh issue create",
        output:
          'https://github.com/acme/app/issues/41 {"url":"https://github.com/acme/app/issues/41","title":"Bug","state":"OPEN"}',
      }),
      tool({ kind: "fetch", title: "Fetch https://docs.example.com/guide" }),
      agent(
        "Done: https://github.com/acme/app/pull/40 and `/tmp/summary.md`, again [spec](https://github.com/acme/app/issues/5)",
      ),
    ];
    const read = () => extractSessionAssets({ task, entries, remoteUrl: "git@github.com:acme/app.git" });

    const first = read();
    expect(first.pullRequests.length + first.createdIssues.length + first.references.length).toBeGreaterThan(2);
    expect(first.artifacts.length).toBeGreaterThan(1);
    expect(read()).toEqual(first);
    expect(
      extractSessionAssets({ task, entries: structuredClone(entries), remoteUrl: "git@github.com:acme/app.git" }),
    ).toEqual(first);
  });

  it("reads an entry again where the task runs elsewhere", () => {
    const entries: AgentEntry[] = [{ ...agent("Wrote `docs/out.md`") }];
    const rel = (cwd: string) =>
      extractSessionAssets({ task: { cwd, projectRoot: cwd }, entries }).artifacts.map((a) =>
        a.kind === "file" ? a.path : a.url,
      );
    expect(rel("/one")).toEqual(["/one/docs/out.md"]);
    expect(rel("/two")).toEqual(["/two/docs/out.md"]);
  });

  it("shows what a replaced entry says now", () => {
    const running: AgentEntry = {
      type: "tool",
      id: "gh",
      title: "gh pr create",
      kind: "execute",
      status: "running",
      locations: [],
      output: null,
      diffs: [],
    };
    expect(pullRequests([running])).toEqual([]);
    expect(pullRequests([{ ...running, status: "completed", output: "https://github.com/acme/app/pull/9" }])).toEqual([
      "#9",
    ]);
  });
});
