import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTask } from "@/bindings";
import { completionAt, emptyDraft, shellCommand, shellHistoryMatches } from "./composerModel";
import { HOME, composerDraft, sendMessage, startTask, stopTask, updateComposer, useAgents } from "./store";

const backend = vi.hoisted(() => ({
  shell: vi.fn(),
  prompt: vi.fn(),
  cancelRequest: vi.fn(),
  cancel: vi.fn(),
  create: vi.fn(),
}));
vi.mock("@/platform/ipc", async (original) => ({
  ...(await original<typeof import("@/platform/ipc")>()),
  commands: {
    agentShell: backend.shell,
    agentPrompt: backend.prompt,
    agentCreate: backend.create,
    agentCancel: backend.cancel,
    cancelRequest: backend.cancelRequest,
  },
}));

vi.mock("@/workbench/contributions", async (original) => ({
  ...(await original<typeof import("@/workbench/contributions")>()),
  editorService: () => ({ openInput: vi.fn(), closeInput: async () => true, openTabs: () => [] }),
}));

const ok = { status: "ok" as const, data: null };

beforeEach(() => {
  for (const f of Object.values(backend)) f.mockReset();
  backend.prompt.mockResolvedValue(ok);
  backend.cancel.mockResolvedValue(ok);
  useAgents.setState({
    tasks: new Map([["t", { id: "t", status: "ready" } as AgentTask]]),
    shellRunning: new Set(),
  });
  updateComposer("t", emptyDraft());
});

describe("`!` commands in the composer", () => {
  it("are told apart from messages", () => {
    const draft = (text: string) => ({ ...emptyDraft(), text });
    expect(shellCommand(draft("! git status "))).toBe("git status");
    expect(shellCommand(draft("!ls"))).toBe("ls");
    expect(shellCommand(draft("!"))).toBeNull();
    expect(shellCommand(draft("fix this!"))).toBeNull();
    expect(shellCommand(draft(" !ls"))).toBeNull();
    const image = { name: "a.png", data: "", mimeType: "image/png" };
    expect(shellCommand({ ...draft("!ls"), images: [image] })).toBeNull();
  });

  it("run in the task instead of going to the agent, and Stop ends them", async () => {
    let finish!: () => void;
    backend.shell.mockReturnValue(new Promise((done) => (finish = () => done(ok))));
    updateComposer("t", { text: "! git status" });
    const sent = sendMessage("t", false);
    await vi.waitFor(() => expect(backend.shell).toHaveBeenCalled());
    const [task, command, request] = backend.shell.mock.calls[0]!;
    expect([task, command]).toEqual(["t", "git status"]);
    expect(composerDraft("t").text).toBe("");
    // Offered again in every composer's `!` completion.
    expect(useAgents.getState().history[0]).toBe("!git status");
    expect(useAgents.getState().shellRunning.has("t")).toBe(true);

    await stopTask("t");
    expect(backend.cancelRequest).toHaveBeenCalledWith(request);
    // The agent isn't working: nothing else to stop.
    expect(backend.cancel).not.toHaveBeenCalled();
    finish();
    await sent;
    expect(useAgents.getState().shellRunning.has("t")).toBe(false);
    expect(backend.prompt).not.toHaveBeenCalled();
  });

  it("leave other messages to the agent", async () => {
    updateComposer("t", { text: "fix this!" });
    await sendMessage("t", false);
    expect(backend.prompt).toHaveBeenCalledOnce();
    expect(backend.shell).not.toHaveBeenCalled();
  });
});

describe("a `!` command from the new task composer", () => {
  it("creates the task without a turn and runs the command in it", async () => {
    backend.create.mockResolvedValue({ status: "ok", data: { id: "n", status: "ready" } as AgentTask });
    backend.shell.mockResolvedValue(ok);
    useAgents.setState({ providers: [], draft: { provider: "codex", config: {}, isolation: "local", base: null } });
    updateComposer(HOME, { text: "!ls -la" });
    await startTask("local");
    expect(backend.create.mock.calls[0]![0]).toMatchObject({ idle: true, prompt: { text: "!ls -la" } });
    await vi.waitFor(() => expect(backend.shell).toHaveBeenCalled());
    expect(backend.shell.mock.calls[0]!.slice(0, 2)).toEqual(["n", "ls -la"]);
    expect(composerDraft(HOME).text).toBe("");
  });

  it("leaves a message to start a turn", async () => {
    backend.create.mockResolvedValue({ status: "ok", data: { id: "m", status: "starting" } as AgentTask });
    useAgents.setState({ providers: [], draft: { provider: "codex", config: {}, isolation: "local", base: null } });
    updateComposer(HOME, { text: "list the files" });
    await startTask("local");
    expect(backend.create.mock.calls[0]![0]).toMatchObject({ idle: false });
    expect(backend.shell).not.toHaveBeenCalled();
  });
});

describe("`!` completion", () => {
  it("completes the word at the caret, the first one as a command", () => {
    expect(completionAt("!", 1)).toEqual({ kind: "shell", query: "", from: 1, to: 1, command: true });
    expect(completionAt("!gi", 3)).toEqual({ kind: "shell", query: "gi", from: 1, to: 3, command: true });
    expect(completionAt("!cat src/ma", 11)).toEqual({
      kind: "shell",
      query: "src/ma",
      from: 5,
      to: 11,
      command: false,
    });
    // `/` and `@` are path characters here, not commands or references.
    expect(completionAt("!ls /us", 7)).toMatchObject({ kind: "shell", query: "/us" });
    expect(completionAt("!echo @a", 8)).toMatchObject({ kind: "shell", query: "@a" });
    expect(completionAt("/re", 3)).toMatchObject({ kind: "command" });
  });

  it("offers earlier commands, newest first and each once", () => {
    const history = ["!git status", "fix it", "!git log -3", "!git status", "!ls"];
    expect(shellHistoryMatches(history, "git", 10)).toEqual(["git status", "git log -3"]);
    expect(shellHistoryMatches(history, "", 2)).toEqual(["git status", "git log -3"]);
    // The command typed out in full has nothing to add.
    expect(shellHistoryMatches(history, "ls", 10)).toEqual([]);
  });
});
