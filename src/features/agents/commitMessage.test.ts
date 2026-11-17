import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfigOption, AgentEntry, AgentProvider, AgentTask } from "@/bindings";
import {
  askingChoices,
  commitMessageOf,
  commitMessagePrompt,
  fitPatch,
  generateCommitMessage,
  pickAgent,
  replyOf,
} from "./commitMessage";
import { useAgents, type Draft } from "./store";

const backend = vi.hoisted(() => ({
  create: vi.fn(),
  entries: vi.fn(),
  cancel: vi.fn(),
  remove: vi.fn(),
  log: vi.fn(),
  notify: vi.fn(),
  changes: vi.fn(),
  setMessage: vi.fn(),
  revision: vi.fn(),
}));

vi.mock("@/platform/ipc", async (original) => ({
  ...(await original<typeof import("@/platform/ipc")>()),
  commands: {
    agentCreate: backend.create,
    agentEntries: backend.entries,
    agentCancel: backend.cancel,
    agentDelete: backend.remove,
    vcsLog: backend.log,
  },
}));
vi.mock("@/workbench/contributions", async (original) => ({
  ...(await original<typeof import("@/workbench/contributions")>()),
  notifications: () => ({ notify: backend.notify }),
  maybeCommitService: () => ({
    changes: backend.changes,
    setMessage: backend.setMessage,
    revision: backend.revision,
    selection: vi.fn(),
  }),
}));

const ok = (data: unknown) => Promise.resolve({ status: "ok" as const, data });

const task = (id: string, provider: string, patch: Partial<AgentTask> = {}): AgentTask => ({
  id,
  title: id,
  provider,
  model: null,
  status: "ready",
  isolation: "local",
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
  ...patch,
});

const modelOption = (current: string | null): AgentConfigOption => ({
  id: "model",
  name: "Model",
  description: null,
  category: "model",
  current,
  values: ["fast", "smart"].map((value) => ({ value, name: value, description: null })),
  via: "option",
});

const provider = (id: string, installed = true, config: AgentConfigOption[] = []) =>
  ({ id, name: id, installed, config }) as AgentProvider;

const draft = (id: string): Draft => ({ provider: id, config: {}, isolation: "local", base: null });

const PATCH = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n";

describe("fitPatch", () => {
  it("keeps a patch that fits", () => {
    expect(fitPatch(PATCH, 1_000)).toBe(PATCH);
  });

  it("cuts a long file short and names the files that no longer fit", () => {
    const file = (name: string, lines: number) =>
      `diff --git a/${name} b/${name}\n@@ -1 +1 @@\n${"+line\n".repeat(lines)}`;
    const fitted = fitPatch([file("big.ts", 600), file("later.ts", 600), file("last.ts", 600)].join(""), 3_000, 2_000);
    expect(fitted).toContain("diff --git a/big.ts b/big.ts");
    expect(fitted).toContain("rest of this file's diff omitted");
    expect(fitted).toContain("Diff omitted for: last.ts");
    expect(fitted.length).toBeLessThan(3_200);
  });
});

describe("commitMessagePrompt", () => {
  it("titles the task, states the limit and the style, and carries the changes", () => {
    const prompt = commitMessagePrompt(PATCH, 50, ["feat: add x", "fix: y"]);
    expect(prompt.split("\n")[0]).toBe("Write a commit message");
    expect(prompt).toContain("at most 50 characters");
    expect(prompt).toContain("- feat: add x\n- fix: y");
    expect(prompt).toContain(`<changes>\n${PATCH.trimEnd()}\n</changes>`);
  });

  it("leaves out the style hint without earlier commits", () => {
    expect(commitMessagePrompt(PATCH, 72, [])).not.toContain("latest commits");
  });

  it("adds the project's commit conventions before the recent subjects", () => {
    const prompt = commitMessagePrompt(PATCH, 72, ["fix: y"], "  Use Conventional Commits.\nPrefix the issue key.  ");
    const conventions = prompt.indexOf("Follow these conventions for commit messages here:\nUse Conventional Commits.");
    expect(conventions).toBeGreaterThan(0);
    expect(prompt).toContain("Prefix the issue key.\n");
    expect(conventions).toBeLessThan(prompt.indexOf("latest commits"));
    expect(commitMessagePrompt(PATCH, 72, [], " \n ")).not.toContain("conventions");
  });
});

describe("commitMessageOf", () => {
  it("keeps a plain message, subject and body", () => {
    expect(commitMessageOf("Fix crash on save\n\nThe buffer was freed twice.\n")).toBe(
      "Fix crash on save\n\nThe buffer was freed twice.",
    );
  });

  it("takes the text out of a code fence", () => {
    expect(commitMessageOf("```\nAdd a button\n```")).toBe("Add a button");
    expect(commitMessageOf("Here it is:\n\n```text\nAdd a button\n\nBody.\n```\n\nAnything else?")).toBe(
      "Add a button\n\nBody.",
    );
  });

  it("drops a label and wrapping quotes", () => {
    expect(commitMessageOf("Commit message: Add a button")).toBe("Add a button");
    expect(commitMessageOf('"Add a button"')).toBe("Add a button");
    expect(commitMessageOf("`Add a button`")).toBe("Add a button");
  });

  it("keeps a subject that merely starts with a word like a label", () => {
    expect(commitMessageOf("Message: show the error text")).toBe("Message: show the error text");
  });

  it("normalises line endings and blank lines", () => {
    expect(commitMessageOf("Add a button  \r\n\r\n\r\n\r\nBody.")).toBe("Add a button\n\nBody.");
  });

  it("is empty for a reply without text", () => {
    expect(commitMessageOf("  \n")).toBe("");
  });
});

describe("replyOf", () => {
  const user: AgentEntry = { type: "user", text: "q", attachments: [] };
  const agent = (text: string): AgentEntry => ({ type: "agent", text });

  it("is the last message the agent wrote after the last question", () => {
    const entries = [
      user,
      agent("old"),
      user,
      agent("Looking…"),
      { type: "thought", text: "hm" } as AgentEntry,
      agent("Fix it"),
    ];
    expect(replyOf(entries)).toBe("Fix it");
  });

  it("is empty when the agent wrote nothing yet", () => {
    expect(replyOf([agent("old"), user])).toBe("");
  });
});

describe("askingChoices", () => {
  const option = (category: string, id: string, values: string[], current: string): AgentConfigOption => ({
    id,
    name: id,
    description: null,
    category,
    current,
    values: values.map((value) => ({ value, name: value, description: null })),
    via: "option",
  });

  it("moves a mode that approves everything to the one that asks", () => {
    const claude = option("mode", "mode", ["acceptEdits", "plan", "bypassPermissions", "default"], "bypassPermissions");
    expect(askingChoices([claude])).toEqual([{ id: "mode", value: "default" }]);
  });

  it("takes the read-only mode of an agent that has no default one", () => {
    const codex = option("mode", "mode", ["auto", "full-access", "read-only"], "full-access");
    expect(askingChoices([codex])).toEqual([{ id: "mode", value: "read-only" }]);
  });

  it("prefers read-only over a mode that asks before it writes", () => {
    const codex = option("mode", "mode", ["read-only", "ask", "auto", "full-access"], "auto");
    expect(askingChoices([codex])).toEqual([{ id: "mode", value: "read-only" }]);
  });

  it("turns allow-all permissions and bypassed approvals off", () => {
    const options = [
      option("permissions", "perm", ["on", "off"], "on"),
      option("approval", "openidea.cursor.approval", ["ask", "bypass"], "bypass"),
    ];
    expect(askingChoices(options)).toEqual([
      { id: "perm", value: "off" },
      { id: "openidea.cursor.approval", value: "ask" },
    ]);
  });

  it("leaves an agent without such settings alone", () => {
    expect(askingChoices([modelOption("fast")])).toEqual([]);
    expect(askingChoices([option("mode", "mode", ["bypassPermissions", "acceptEdits"], "acceptEdits")])).toEqual([]);
  });
});

describe("pickAgent", () => {
  it("is the agent of the latest task, on its model", () => {
    const tasks = [
      task("a", "codex", { updatedMs: 1 }),
      task("b", "claude", { updatedMs: 5, config: [modelOption("smart")] }),
      task("c", "gemini", { updatedMs: 9, status: "archived" }),
    ];
    const providers = ["codex", "claude", "gemini"].map((id) => provider(id));
    expect(pickAgent(tasks, providers, draft("codex"))).toEqual({
      provider: "claude",
      config: [{ id: "model", value: "smart" }],
    });
  });

  it("asks for approvals even when the latest task approves everything", () => {
    const mode: AgentConfigOption = {
      id: "mode",
      name: "Mode",
      description: null,
      category: "mode",
      current: "bypassPermissions",
      values: ["default", "bypassPermissions"].map((value) => ({ value, name: value, description: null })),
      via: "mode",
    };
    const tasks = [task("b", "claude", { updatedMs: 5, config: [modelOption("smart"), mode] })];
    expect(pickAgent(tasks, [provider("claude")], draft("claude"))?.config).toEqual([
      { id: "model", value: "smart" },
      { id: "mode", value: "default" },
    ]);
  });

  it("passes over a task whose agent is not installed", () => {
    const tasks = [task("a", "codex", { updatedMs: 1 }), task("b", "claude", { updatedMs: 5 })];
    const providers = [provider("codex"), provider("claude", false)];
    expect(pickAgent(tasks, providers, draft("claude"))?.provider).toBe("codex");
  });

  it("falls back to the New Task page's agent and its model", () => {
    const providers = [provider("codex"), provider("claude", true, [modelOption("fast")])];
    expect(pickAgent([], providers, draft("claude"))).toEqual({
      provider: "claude",
      config: [{ id: "model", value: "fast" }],
    });
  });

  it("takes any installed agent when the selected one is missing, and none without one", () => {
    expect(pickAgent([], [provider("claude", false), provider("codex")], draft("claude"))).toEqual({
      provider: "codex",
      config: [],
    });
    expect(pickAgent([], [provider("claude", false)], draft("claude"))).toBeNull();
  });
});

describe("generateCommitMessage", () => {
  const changes = { revision: 3, roots: ["/p"], patch: PATCH };
  const notified = () => backend.notify.mock.calls.map(([n]) => n as { level: string; title: string; body?: string });

  /** The created task ends its turn with `status` right after it is created. */
  function createdTask(status: AgentTask["status"], reply = "Fix the thing\n\nBecause.") {
    backend.create.mockImplementation((request: { provider: string }) => {
      setTimeout(() => {
        useAgents.setState((s) => ({ tasks: new Map(s.tasks).set("new", task("new", request.provider, { status })) }));
      }, 0);
      return ok(task("new", request.provider, { status: "starting" }));
    });
    backend.entries.mockImplementation(() =>
      ok([
        { type: "user", text: "q", attachments: [] },
        { type: "agent", text: reply },
      ]),
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    backend.changes.mockResolvedValue(changes);
    backend.setMessage.mockReturnValue(true);
    backend.revision.mockReturnValue(changes.revision);
    backend.log.mockImplementation(() => ok([{ summary: "feat: earlier" }]));
    backend.cancel.mockImplementation(() => ok(null));
    backend.remove.mockImplementation(() => ok(null));
    useAgents.setState({
      providers: [provider("claude")],
      tasks: new Map([["t1", task("t1", "claude", { updatedMs: 4, config: [modelOption("smart")] })]]),
      unread: new Set(),
      draft: draft("claude"),
    });
  });

  it("asks the agent of the latest task, fills the commit field and removes the task", async () => {
    createdTask("ready", "```\nFix the thing\n\nBecause.\n```");
    await generateCommitMessage();

    expect(backend.create).toHaveBeenCalledOnce();
    const request = backend.create.mock.calls[0]![0] as {
      provider: string;
      config: unknown;
      isolation: string;
      prompt: { text: string };
    };
    expect(request).toMatchObject({
      provider: "claude",
      config: [{ id: "model", value: "smart" }],
      isolation: "local",
    });
    expect(request.prompt.text).toContain(PATCH.trimEnd());
    expect(request.prompt.text).toContain("- feat: earlier");
    expect(backend.setMessage).toHaveBeenCalledWith(3, "Fix the thing\n\nBecause.");
    expect(backend.remove).toHaveBeenCalledWith("new", false);
    expect(backend.cancel).not.toHaveBeenCalled();
    expect(notified()).toEqual([]);
    expect(useAgents.getState().unread.has("new")).toBe(false);
  });

  it("does not bother the agent when nothing is included", async () => {
    backend.changes.mockResolvedValue({ ...changes, patch: " \n" });
    await generateCommitMessage();
    expect(backend.create).not.toHaveBeenCalled();
    expect(notified()).toEqual([expect.objectContaining({ level: "info", title: "No changes to describe" })]);
  });

  it("points to the settings when no agent is installed", async () => {
    useAgents.setState({ providers: [], tasks: new Map() });
    await generateCommitMessage();
    expect(backend.create).not.toHaveBeenCalled();
    expect(notified()).toEqual([expect.objectContaining({ level: "warning", title: "No coding agent available" })]);
  });

  it("stops and removes a task that asks for permission", async () => {
    createdTask("needsInput");
    await generateCommitMessage();
    expect(backend.setMessage).not.toHaveBeenCalled();
    expect(backend.cancel).toHaveBeenCalledWith("new", null);
    expect(backend.remove).toHaveBeenCalledWith("new", false);
    expect(notified()).toEqual([
      expect.objectContaining({
        level: "error",
        title: "Couldn't generate the commit message",
        body: "The agent asked for permission to continue",
      }),
    ]);
  });

  it("reports a failed task with the reason it gave", async () => {
    backend.create.mockImplementation((request: { provider: string }) => {
      setTimeout(() => {
        useAgents.setState((s) => ({
          tasks: new Map(s.tasks).set(
            "new",
            task("new", request.provider, { status: "failed", error: "not signed in" }),
          ),
        }));
      }, 0);
      return ok(task("new", request.provider, { status: "starting" }));
    });
    await generateCommitMessage();
    expect(notified()).toEqual([expect.objectContaining({ level: "error", body: "not signed in" })]);
    expect(backend.remove).toHaveBeenCalledWith("new", false);
  });

  it("reports a reply without a commit message", async () => {
    createdTask("ready", "   ");
    await generateCommitMessage();
    expect(backend.setMessage).not.toHaveBeenCalled();
    expect(notified()).toEqual([
      expect.objectContaining({ level: "error", body: "The agent did not reply with a commit message" }),
    ]);
  });

  it("does not overwrite a message or inclusion edited while the agent worked", async () => {
    createdTask("ready");
    backend.setMessage.mockReturnValue(false);
    await generateCommitMessage();
    expect(notified()).toEqual([expect.objectContaining({ level: "info", title: "Commit message not replaced" })]);
    expect(backend.remove).toHaveBeenCalledWith("new", false);
  });

  it("does not fill in a message for changes edited in the files while the agent worked", async () => {
    createdTask("ready");
    backend.changes.mockResolvedValueOnce(changes).mockResolvedValue({ ...changes, patch: changes.patch + "+more\n" });
    await generateCommitMessage();
    expect(backend.setMessage).not.toHaveBeenCalled();
    expect(notified()).toEqual([expect.objectContaining({ level: "info", title: "Commit message not replaced" })]);
  });

  it("runs once at a time", async () => {
    createdTask("ready");
    await Promise.all([generateCommitMessage(), generateCommitMessage()]);
    expect(backend.create).toHaveBeenCalledOnce();
    expect(backend.setMessage).toHaveBeenCalledOnce();
  });
});
