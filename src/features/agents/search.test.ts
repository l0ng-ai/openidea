import { describe, expect, it } from "vitest";
import type { AgentTask, ExternalSession } from "@/bindings";
import { searching, sessionHits, taskHits } from "./search";

function task(id: string, title = id, prompt: string | null = null): AgentTask {
  return {
    id,
    title,
    prompt,
    status: "ready",
    isolation: "local",
    provider: "claude",
    model: null,
    cwd: "/p",
    branch: null,
    base: null,
    baseCommit: null,
    error: null,
    createdMs: 0,
    updatedMs: 0,
    config: [],
    commands: [],
    usage: null,
    queue: [],
  };
}

const session = (provider: string, sessionId: string, title: string): ExternalSession => ({
  provider,
  sessionId,
  title,
  cwd: null,
  updatedMs: 0,
});

const noProject = () => null;

describe("task search", () => {
  it("matches the title's substring case-insensitively, with its characters for highlighting", () => {
    const hits = taskHits([task("one", "Fix the login redirect")], "LOGIN", noProject);
    expect(hits.get("one")).toEqual([8, 9, 10, 11, 12]);
  });

  it("matches non-contiguous characters, as the command palette does", () => {
    const hits = taskHits([task("one", "Fix the login redirect")], "flr", noProject);
    expect(hits.get("one")).toEqual([0, 8, 14]);
  });

  it("matches word starts of a camel-hump title", () => {
    const hits = taskHits([task("one", "Fix LoginBug")], "lb", noProject);
    expect(hits.get("one")).toEqual([4, 9]);
  });

  it("matches the first user message of sessions whose title says nothing about it", () => {
    const hits = taskHits([task("one", "Explore the repo", "Please make the parser thread-safe")], "THREAD", noProject);
    expect(hits.get("one")).toBeNull();
  });

  it("prefers the title's hit characters over the prompt's", () => {
    const hits = taskHits([task("one", "Fix the login redirect", "the login is broken")], "LOGIN", noProject);
    expect(hits.get("one")).toEqual([8, 9, 10, 11, 12]);
  });

  it("matches the project name", () => {
    const hits = taskHits([task("one", "Fix the bug")], "openidea", () => "openidea");
    expect(hits.get("one")).toBeNull();
  });

  it("leaves out tasks that match nothing", () => {
    const hits = taskHits([task("one", "Fix the login"), task("two", "Write the docs")], "login", noProject);
    expect([...hits.keys()]).toEqual(["one"]);
  });

  it("searches over every task whatever the section would show it in", () => {
    // The helper sees all tasks; keeping groups out of the scope is the view's job.
    const tasks = [task("pinned", "Pin me"), task("grouped", "Group me"), task("ungrouped", "Find me")];
    const hits = taskHits(tasks, "me", noProject);
    expect([...hits.keys()].sort()).toEqual(["grouped", "pinned", "ungrouped"]);
  });

  it("ignores surrounding whitespace and matches a trimmed query", () => {
    const hits = taskHits([task("one", "Fix the login")], "  login  ", noProject);
    expect(hits.get("one")).toEqual([8, 9, 10, 11, 12]);
  });

  it("is not searching on an empty or blank query, and matches nothing then", () => {
    expect(searching("")).toBe(false);
    expect(searching("   ")).toBe(false);
    expect(searching("login")).toBe(true);
    expect(taskHits([task("one", "Fix the login")], "", noProject).size).toBe(0);
    expect(taskHits([task("one", "Fix the login")], "   ", noProject).size).toBe(0);
  });

  it("tolerates tasks without a first message", () => {
    const hits = taskHits([task("one", "Fix the login", null)], "LOGIN", noProject);
    expect(hits.get("one")).toEqual([8, 9, 10, 11, 12]);
  });
});

describe("session search", () => {
  it("matches imported sessions by title, keyed by provider and session", () => {
    const sessions = [session("claude", "a1", "Refactor the parser"), session("codex", "b2", "Write tests")];
    const hits = sessionHits(sessions, "refactor");
    expect(hits.get("claude:a1")).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(hits.has("codex:b2")).toBe(false);
  });

  it("matches nothing without a query", () => {
    expect(sessionHits([session("claude", "a1", "Refactor")], "").size).toBe(0);
  });
});
