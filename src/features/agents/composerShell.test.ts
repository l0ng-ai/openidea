import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTask } from "@/bindings";
import { emptyDraft, shellCommand } from "./composerModel";
import { composerDraft, sendMessage, stopTask, updateComposer, useAgents } from "./store";

const backend = vi.hoisted(() => ({
  shell: vi.fn(),
  prompt: vi.fn(),
  cancelRequest: vi.fn(),
  cancel: vi.fn(),
}));
vi.mock("@/platform/ipc", async (original) => ({
  ...(await original<typeof import("@/platform/ipc")>()),
  commands: {
    agentShell: backend.shell,
    agentPrompt: backend.prompt,
    agentCancel: backend.cancel,
    cancelRequest: backend.cancelRequest,
  },
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
