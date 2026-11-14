import { beforeEach, expect, it, vi } from "vitest";
import type { AgentEntry, AgentTask } from "@/bindings";
import { discardEphemeral, sendMessage, startSideConversation, useAgents } from "./store";

const ipc = vi.hoisted(() => ({ create: vi.fn(), prompt: vi.fn(), delete: vi.fn(), cancel: vi.fn() }));
vi.mock("@/platform/ipc", async (original) => ({
  ...(await original<typeof import("@/platform/ipc")>()),
  commands: {
    ...(await original<typeof import("@/platform/ipc")>()).commands,
    agentCreateEphemeral: (...args: unknown[]) => ipc.create(...args),
    agentPrompt: (...args: unknown[]) => ipc.prompt(...args),
    agentDelete: (...args: unknown[]) => ipc.delete(...args),
    agentCancel: (...args: unknown[]) => ipc.cancel(...args),
  },
}));

const editor = vi.hoisted(() => ({
  open: vi.fn(),
  close: vi.fn(),
  /** Pane id reported for a session-key lookup; set per test ("null" when nothing is found). */
  paneOf: vi.fn<(key: string) => string | null>(() => null),
}));
vi.mock("@/workbench/contributions", async (original) => ({
  ...(await original<typeof import("@/workbench/contributions")>()),
  editorService: () => ({ openInput: editor.open, closeInput: editor.close, paneOf: editor.paneOf }),
  maybeEditorService: () => ({ activePath: () => null }),
  toolWindowService: () => ({ show: vi.fn() }),
}));

const source: AgentTask = {
  id: "t1",
  title: "Task",
  provider: "codex",
  status: "ready",
  isolation: "local",
  model: null,
  cwd: "/repo",
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
  capabilities: { fork: true, rollback: true, steer: true, images: true },
};

const side = (id: string): AgentTask => ({ ...source, id, title: `Side of ${id}`, isolation: "local" });

const user = (text: string): AgentEntry => ({
  type: "user",
  text,
  attachments: [],
  sentMs: 0,
  doneMs: 1,
  steered: false,
});
const agentReply = (text: string): AgentEntry => ({ type: "agent", text });

beforeEach(() => {
  ipc.create.mockReset().mockResolvedValue({ status: "ok", data: side("t2") });
  ipc.prompt.mockReset().mockResolvedValue({ status: "ok", data: null });
  ipc.delete.mockReset().mockResolvedValue({ status: "ok", data: null });
  ipc.cancel.mockReset().mockResolvedValue({ status: "ok", data: null });
  editor.open.mockReset().mockResolvedValue(undefined);
  editor.close.mockReset().mockResolvedValue(true);
  editor.paneOf.mockReset().mockReturnValue(null);
  useAgents.setState({
    tasks: new Map([["t1", source]]),
    entries: new Map([["t1", [user("Fix the login bug"), agentReply("Fixed it in `auth.ts`.")]]]),
    ephemeral: new Set<string>(),
    composers: new Map(),
  });
});

it("opens a side conversation of the task: ephemeral, local, split and quoted", async () => {
  const id = await startSideConversation("t1", "the selected text");
  expect(id).toBe("t2");
  // The host builds the context from its own copy of the conversation.
  expect(ipc.create).toHaveBeenCalledWith(
    expect.objectContaining({
      provider: "codex",
      isolation: "local",
      prompt: { text: "the selected text", files: [], images: [] },
    }),
    "t1",
  );
  const s = useAgents.getState();
  expect(s.ephemeral.has("t2")).toBe(true);
  expect(s.composers.get("t2")?.text).toContain("> the selected text");
  expect(editor.open).toHaveBeenCalledWith(expect.objectContaining({ kind: "agent-session", key: "agent:t2" }), {
    focus: true,
    side: true,
  });
});

it("keeps the marks across a page reload and drops them with the app", async () => {
  const { watchEphemeralTasks } = await import("./store");
  const stop = watchEphemeralTasks();
  sessionStorage.setItem("openidea.agents.sideMarks", JSON.stringify(["t2"]));

  // The store refills after the reload: the mark comes back with the task…
  useAgents.setState({
    loaded: true,
    tasks: new Map([
      ["t1", source],
      ["t2", side("t2")],
    ]),
    ephemeral: new Set(),
  });
  expect(useAgents.getState().ephemeral.has("t2")).toBe(true);

  // …and when the host's copy is gone (app restart, or the task was discarded), so is the mark.
  useAgents.setState((s) => {
    const tasks = new Map(s.tasks);
    tasks.delete("t2");
    return { tasks };
  });
  expect(useAgents.getState().ephemeral.has("t2")).toBe(false);
  expect(sessionStorage.getItem("openidea.agents.sideMarks")).toBe("[]");
  stop();
});

it("sends follow-up messages as typed: the host owns the context", async () => {
  await startSideConversation("t1", "the selected text");
  useAgents.setState((s) => {
    const composers = new Map(s.composers);
    composers.set("t2", { text: "Why did you touch auth.ts?", files: [], images: [] });
    return { composers };
  });
  await sendMessage("t2", false);
  expect(ipc.prompt).toHaveBeenCalledTimes(1);
  const [task, prompt] = ipc.prompt.mock.calls[0]!;
  expect(task).toBe("t2");
  expect(prompt.text).toBe("Why did you touch auth.ts?");
});

it("opens a nested side conversation in its parent's pane", async () => {
  await startSideConversation("t1", "first");
  editor.open.mockClear();
  // The parent side conversation shows in a split pane: the nested one joins it there.
  editor.paneOf.mockReturnValue("pane-right");
  useAgents.setState((s) => {
    const entries = new Map(s.entries);
    entries.set(
      "t2",
      entries.get("t1")!.map((e) => ({ ...e })),
    );
    return { entries };
  });
  await startSideConversation("t2", "deeper question");
  expect(ipc.create).toHaveBeenLastCalledWith(expect.objectContaining({ provider: "codex" }), "t2");
  // No second split: it stacks in the same pane.
  expect(editor.open).toHaveBeenLastCalledWith(expect.anything(), { focus: true, pane: "pane-right" });
});

it("discards a side conversation: stops it, deletes it, clears its state", async () => {
  const busy = { ...side("t2"), status: "running" as const };
  useAgents.setState({
    tasks: new Map([
      ["t1", source],
      ["t2", busy],
    ]),
    ephemeral: new Set(["t2"]),
    entries: new Map([
      ["t2", []],
      ["t2/sub", []],
      ["t1", []],
    ]),
    composers: new Map([["t2", { text: "", files: [], images: [] }]]),
    unread: new Set(["t2"]),
    docked: null,
  });
  ipc.cancel.mockImplementation(async () => {
    useAgents.setState((s) => {
      const tasks = new Map(s.tasks);
      tasks.set("t2", { ...busy, status: "ready" });
      return { tasks };
    });
    return { status: "ok", data: null };
  });
  await discardEphemeral("t2");
  expect(ipc.cancel).toHaveBeenCalledWith("t2", null);
  expect(ipc.delete).toHaveBeenCalledWith("t2", false);
  const s = useAgents.getState();
  expect(s.ephemeral.has("t2")).toBe(false);
  expect(s.tasks.has("t2")).toBe(false);
  expect(s.tasks.has("t1")).toBe(true);
  expect(s.entries.has("t2")).toBe(false);
  expect(s.entries.has("t2/sub")).toBe(false);
  expect(s.composers.has("t2")).toBe(false);
  expect(s.unread.has("t2")).toBe(false);
});

it("ignores discard requests for tasks that are not side conversations", async () => {
  useAgents.setState({ tasks: new Map([["t1", source]]), ephemeral: new Set() });
  await discardEphemeral("t1");
  expect(ipc.delete).not.toHaveBeenCalled();
});
