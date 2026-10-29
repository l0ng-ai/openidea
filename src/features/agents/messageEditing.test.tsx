import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AgentEntry, AgentTask } from "@/bindings";

const ipc = vi.hoisted(() => ({ rollback: vi.fn(), prompt: vi.fn(), cancel: vi.fn() }));
const entries: AgentEntry[] = [
  { type: "user", text: "Original message", attachments: [], sentMs: 1, doneMs: 2, steered: false },
  { type: "agent", text: "Original answer" },
];

vi.mock("@/platform/ipc", async (original) => ({
  ...(await original<typeof import("@/platform/ipc")>()),
  commands: {
    agentEntries: async () => ({ status: "ok", data: entries }),
    agentChanges: async () => ({ status: "ok", data: [] }),
    vcsBranchInfo: async () => ({ status: "ok", data: { head: "main" } }),
    agentRollback: ipc.rollback,
    agentPrompt: ipc.prompt,
    agentCancel: ipc.cancel,
  },
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));

import { SessionEditor } from "./SessionEditor";
import { updateComposer, useAgents } from "./store";

const task: AgentTask = {
  id: "editing",
  title: "Test task",
  provider: "codex",
  status: "ready",
  isolation: "local",
  model: null,
  cwd: "/project",
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

beforeEach(() => {
  ipc.rollback.mockReset().mockResolvedValue({ status: "ok", data: null });
  ipc.prompt.mockReset().mockResolvedValue({ status: "ok", data: null });
  ipc.cancel.mockReset().mockResolvedValue({ status: "ok", data: null });
  useAgents.setState({ tasks: new Map([[task.id, task]]), entries: new Map(), composers: new Map(), focus: null });
});

async function edit() {
  render(<SessionEditor input={{ kind: "agent-session", key: task.id, data: { task: task.id } }} />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Edit" }));
  const box = screen.getAllByRole("textbox", { name: "Message" })[0]!;
  fireEvent.change(box, { target: { value: "Edited message" } });
  return { user, box, send: screen.getAllByRole("button", { name: "Send" })[0]! };
}

describe("editing a sent agent message", () => {
  it("keeps Enter, Shift+Enter and IME confirmation for editing", async () => {
    const { box } = await edit();
    fireEvent.keyDown(box, { key: "Enter" });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    fireEvent.keyDown(box, { key: "Enter", metaKey: true, isComposing: true });
    fireEvent.keyDown(box, { key: "Enter", metaKey: true, keyCode: 229 });
    expect(ipc.rollback).not.toHaveBeenCalled();
    expect(box).toHaveValue("Edited message");
  });

  it("keeps the draft and shows a rollback failure beside it", async () => {
    ipc.rollback.mockResolvedValue({ status: "error", error: { kind: "internal", message: "Rollback failed" } });
    const { user, box, send } = await edit();
    await user.click(send);
    expect(await screen.findByRole("alert")).toHaveTextContent("Rollback failed");
    expect(box).toHaveValue("Edited message");
    expect(box).toBeInTheDocument();
    expect(send).toBeEnabled();
    expect(ipc.prompt).not.toHaveBeenCalled();
    ipc.rollback.mockResolvedValue({ status: "ok", data: null });
    await user.click(send);
    await waitFor(() => expect(ipc.prompt).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("rolls back before sending the edited text when Send is clicked", async () => {
    let finish!: (value: unknown) => void;
    ipc.rollback.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const { user, box, send } = await edit();
    await user.click(send);
    expect(ipc.rollback).toHaveBeenCalledWith(task.id, 0);
    expect(ipc.prompt).not.toHaveBeenCalled();
    expect(send).toBeDisabled();
    fireEvent.keyDown(box, { key: "Enter", metaKey: true });
    expect(ipc.rollback).toHaveBeenCalledTimes(1);
    await act(async () => finish({ status: "ok", data: null }));
    await waitFor(() =>
      expect(ipc.prompt).toHaveBeenCalledWith(task.id, { text: "Edited message", files: [], images: [] }, false),
    );
  });

  it.each(["", "Another draft"])("recovers the edit after rollback if sending fails (draft: %j)", async (draft) => {
    ipc.rollback.mockImplementation(async () => {
      // The backend emits Truncated before replying, removing the inline editor.
      useAgents.setState({ entries: new Map([[task.id, []]]) });
      return { status: "ok", data: null };
    });
    let finish!: (value: unknown) => void;
    ipc.prompt.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const { user, box, send } = await edit();
    act(() => updateComposer(task.id, { text: draft }));
    await user.click(send);
    expect(box).not.toBeInTheDocument();
    await act(async () => finish({ status: "error", error: { kind: "internal", message: "Send failed" } }));
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue(
      draft ? `Edited message\n${draft}` : "Edited message",
    );
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveFocus();
    ipc.prompt.mockResolvedValue({ status: "ok", data: null });
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(ipc.prompt).toHaveBeenCalledTimes(2);
    expect(ipc.rollback).toHaveBeenCalledTimes(1);
  });

  it.each([{ metaKey: true }, { ctrlKey: true }])("still sends with modified Enter (%j)", async (modifier) => {
    const { box } = await edit();
    fireEvent.keyDown(box, { key: "Enter", ...modifier });
    await waitFor(() => expect(ipc.prompt).toHaveBeenCalledTimes(1));
  });

  it("waits for a running turn to stop before rolling it back", async () => {
    useAgents.setState({ tasks: new Map([[task.id, { ...task, status: "running" }]]) });
    const { user, send } = await edit();
    await user.click(send);
    expect(ipc.cancel).toHaveBeenCalledWith(task.id, null);
    expect(ipc.rollback).not.toHaveBeenCalled();
    act(() => useAgents.setState({ tasks: new Map([[task.id, task]]) }));
    await waitFor(() => expect(ipc.prompt).toHaveBeenCalledTimes(1));
  });

  it.each(["Cancel", "Escape"])(
    "%s restores the message and discards edits without touching the conversation",
    async (method) => {
      const { user, box } = await edit();
      if (method === "Cancel") await user.click(screen.getByRole("button", { name: "Cancel" }));
      else fireEvent.keyDown(box, { key: "Escape" });
      expect(box).not.toBeInTheDocument();
      expect(screen.getByText("Original message")).toBeInTheDocument();
      expect(screen.getByText("Original answer")).toBeInTheDocument();
      expect(ipc.rollback).not.toHaveBeenCalled();
      expect(ipc.prompt).not.toHaveBeenCalled();
      await user.click(screen.getByRole("button", { name: "Edit" }));
      expect(screen.getAllByRole("textbox", { name: "Message" })[0]).toHaveValue("Original message");
    },
  );
});
