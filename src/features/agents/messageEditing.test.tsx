import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AgentEntry, AgentTask } from "@/bindings";

const ipc = vi.hoisted(() => ({ rollback: vi.fn(), prompt: vi.fn(), cancel: vi.fn(), confirm: vi.fn() }));
vi.mock("@/workbench/messages", () => ({ confirm: ipc.confirm }));
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
import { registerActions } from "@/platform/actions";
import { composerDraft, retractFrom, rerunFrom, sendMessage, updateComposer, useAgents } from "./store";
import { replyActions } from "./replyActions";

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

let returnDispose: () => void;
afterEach(() => returnDispose());

beforeEach(() => {
  const dispose = registerActions(replyActions);
  returnDispose = dispose;
  ipc.confirm.mockReset().mockResolvedValue(true);
  ipc.rollback.mockReset().mockResolvedValue({ status: "ok", data: null });
  ipc.prompt.mockReset().mockResolvedValue({ status: "ok", data: null });
  ipc.cancel.mockReset().mockResolvedValue({ status: "ok", data: null });
  useAgents.setState({
    loaded: true,
    tasks: new Map([[task.id, task]]),
    entries: new Map(),
    composers: new Map(),
    focus: null,
  });
});

it("keeps the transcript and running session when a fresh-session rerun is cancelled", async () => {
  ipc.confirm.mockResolvedValue(false);
  useAgents.setState({
    tasks: new Map([[task.id, { ...task, status: "running" }]]),
    entries: new Map([[task.id, entries]]),
  });
  await rerunFrom(task.id, 0, "Replacement");
  expect(ipc.confirm).toHaveBeenCalledWith(
    expect.objectContaining({
      message: expect.stringContaining("clears the entire conversation"),
    }),
  );
  expect(ipc.cancel).not.toHaveBeenCalled();
  expect(ipc.rollback).not.toHaveBeenCalled();
  expect(ipc.prompt).not.toHaveBeenCalled();
  expect(useAgents.getState().entries.get(task.id)).toEqual(entries);
});

describe("retracting a turn", () => {
  it.each([0, 1])("stops before rollback and restores text/images without sending (turn %s)", async (turn) => {
    const image = { mimeType: "image/png", data: "AAA", name: "shot.png" };
    useAgents.setState({ tasks: new Map([[task.id, { ...task, status: "running" }]]) });
    updateComposer(task.id, { text: "Draft" });
    const running = retractFrom(task.id, turn, "Original", [image]);
    await waitFor(() => expect(ipc.cancel).toHaveBeenCalledTimes(1));
    expect(ipc.rollback).not.toHaveBeenCalled();
    useAgents.setState({ tasks: new Map([[task.id, task]]) });
    await running;
    expect(ipc.rollback).toHaveBeenCalledExactlyOnceWith(task.id, turn);
    expect(ipc.prompt).not.toHaveBeenCalled();
    expect(composerDraft(task.id)).toEqual({ text: "Original\nDraft", images: [image], files: [] });
    expect(useAgents.getState().focus?.key).toBe(task.id);
  });

  it("keeps the draft and avoids rollback when the agent does not stop in time", async () => {
    vi.useFakeTimers();
    try {
      useAgents.setState({ tasks: new Map([[task.id, { ...task, status: "running" }]]) });
      const result = expect(retractFrom(task.id, 1, "Original")).rejects.toThrow("The agent is still stopping");
      await vi.advanceTimersByTimeAsync(15_000);
      await result;
      expect(ipc.rollback).not.toHaveBeenCalled();
      expect(composerDraft(task.id).text).toBe("Original");
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovers the original prompt when rollback fails", async () => {
    ipc.rollback.mockResolvedValue({ status: "error", error: { kind: "internal", message: "Rollback failed" } });
    await expect(retractFrom(task.id, 1, "Original")).rejects.toThrow("Rollback failed");
    expect(composerDraft(task.id).text).toBe("Original");
    expect(ipc.prompt).not.toHaveBeenCalled();
  });

  it("confirms before retracting a turn with later messages and guards repeated clicks", async () => {
    const transcript = [...entries, { ...entries[0]!, text: "Follow up" } as AgentEntry, entries[1]!];
    useAgents.setState({ entries: new Map([[task.id, transcript]]) });
    let answer!: (ok: boolean) => void;
    ipc.confirm.mockReturnValue(
      new Promise<boolean>((resolve) => {
        answer = resolve;
      }),
    );
    render(<SessionEditor input={{ kind: "agent-session", key: task.id, data: { task: task.id } }} />);
    const user = userEvent.setup();
    const retract = screen.getAllByRole("button", { name: "Retract Message" })[0]!;
    await user.click(retract);
    await user.click(retract);
    expect(ipc.confirm).toHaveBeenCalledTimes(1);
    expect(ipc.rollback).not.toHaveBeenCalled();
    await act(async () => answer(false));
    expect(useAgents.getState().entries.get(task.id)).toEqual(transcript);
    ipc.confirm.mockResolvedValue(true);
    await user.click(retract);
    await waitFor(() => expect(ipc.rollback).toHaveBeenCalledExactlyOnceWith(task.id, 0));
    expect(composerDraft(task.id).text).toBe("Original message");
  });
});

async function edit() {
  render(<SessionEditor input={{ kind: "agent-session", key: task.id, data: { task: task.id } }} />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Edit" }));
  const box = screen.getAllByRole("textbox", { name: "Message" })[0]!;
  fireEvent.change(box, { target: { value: "Edited message" } });
  return { user, box, send: screen.getAllByRole("button", { name: "Send" })[0]! };
}

it.each([false, true])("recovers images after failed regeneration (new draft: %s)", async (draft) => {
  const image = { mimeType: "image/png", data: "AAA", name: "shot.png" };
  const added = { mimeType: "image/png", data: "BBB", name: "added.png" };
  useAgents.setState({
    entries: new Map([
      [
        task.id,
        [
          { type: "user", text: "Original message", attachments: [image.name], images: [image], steered: false },
          entries[1]!,
        ],
      ],
    ]),
  });
  ipc.rollback.mockImplementation(async () => {
    useAgents.setState({ entries: new Map([[task.id, []]]) });
    return { status: "ok", data: null };
  });
  let finish!: (value: unknown) => void;
  ipc.prompt.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
  const running = replyActions
    .find((a) => a.id === "agents.regenerateReply")!
    .run({ ctx: {}, arg: { task: task.id, turn: 0 } });
  await waitFor(() => expect(ipc.prompt).toHaveBeenCalledTimes(1));
  const files = draft ? [{ path: "/project/a.ts", rel: "a.ts" }] : [];
  if (draft) updateComposer(task.id, { text: "Another draft @a.ts", files, images: [added] });
  finish({ status: "error", error: { kind: "internal", message: "Send failed" } });
  await running;
  const expected = {
    text: draft ? "Original message\nAnother draft @a.ts" : "Original message",
    files,
    images: draft ? [image, added] : [image],
  };
  expect(composerDraft(task.id)).toEqual(expected);
  expect(useAgents.getState().focus?.key).toBe(task.id);
  await sendMessage(task.id, false);
  expect(ipc.prompt).toHaveBeenLastCalledWith(task.id, { ...expected, files: files.map((f) => f.path) }, false);
  expect(ipc.rollback).toHaveBeenCalledTimes(1);
});

describe("a sent message with images", () => {
  afterEach(() => {
    entries[0] = { type: "user", text: "Original message", attachments: [], sentMs: 1, doneMs: 2, steered: false };
  });

  it("shows the images and lists only the files as chips", async () => {
    entries[0] = {
      type: "user",
      text: "Look",
      attachments: ["a.ts", "shot.png"],
      images: [{ mimeType: "image/png", data: "AAA", name: "shot.png" }],
      sentMs: 1,
      doneMs: 2,
      steered: false,
    };
    render(<SessionEditor input={{ kind: "agent-session", key: task.id, data: { task: task.id } }} />);
    const img = await screen.findByRole("img", { name: "shot.png" });
    expect(img).toHaveAttribute("src", "data:image/png;base64,AAA");
    expect(screen.getByText("a.ts")).toBeInTheDocument();
    expect(screen.queryByText("shot.png")).not.toBeInTheDocument();
    entries[0] = { type: "user", text: "Original message", attachments: [], sentMs: 1, doneMs: 2, steered: false };
  });

  it("opens an image in a dialog and keeps the images when editing, minus the removed ones", async () => {
    entries[0] = {
      type: "user",
      text: "Look",
      attachments: ["a.png", "b.png"],
      images: [
        { mimeType: "image/png", data: "AAA", name: "a.png" },
        { mimeType: "image/png", data: "BBB", name: "b.png" },
      ],
      sentMs: 1,
      doneMs: 2,
      steered: false,
    };
    render(<SessionEditor input={{ kind: "agent-session", key: task.id, data: { task: task.id } }} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "a.png" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getAllByRole("img", { name: "a.png" })).toHaveLength(2);
    await user.click(screen.getAllByRole("button", { name: "Close" })[0]!);
    await user.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getAllByRole("button", { name: "Remove Image" })).toHaveLength(2);
    await user.click(screen.getAllByRole("button", { name: "Remove Image" })[0]!);
    expect(screen.getAllByRole("button", { name: "Remove Image" })).toHaveLength(1);
    expect(screen.queryByRole("img", { name: "a.png" })).not.toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: "Send" })[0]!);
    await waitFor(() => expect(ipc.prompt).toHaveBeenCalledTimes(1));
    expect(ipc.prompt.mock.calls[0]![1].images).toEqual([{ mimeType: "image/png", data: "BBB", name: "b.png" }]);
    entries[0] = { type: "user", text: "Original message", attachments: [], sentMs: 1, doneMs: 2, steered: false };
  });
});

describe("editing a sent agent message", () => {
  it("names the icon-only edit-and-resend action and disables empty edits", async () => {
    const { box, send } = await edit();
    expect(send.textContent).toBe("");
    expect(send).toHaveAttribute("data-tooltip", "Send");
    expect(send).toBeEnabled();
    fireEvent.change(box, { target: { value: "" } });
    expect(send).toBeDisabled();
  });

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
    expect(send).toHaveAccessibleName("Send");
    expect(send.textContent).toBe("");
    expect(send.querySelector('[role="status"]')).toBeInTheDocument();
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

describe("session composer submission", () => {
  it.each(["click", "Enter"])("keeps an accessible icon-only Send action with %s submission", async (method) => {
    let finish!: (value: unknown) => void;
    ipc.prompt.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    render(<SessionEditor input={{ kind: "agent-session", key: task.id, data: { task: task.id } }} />);
    const send = screen.getByRole("button", { name: "Send" });
    expect(send.textContent).toBe("");
    expect(send).toHaveAttribute("data-tooltip", "Send");
    expect(send).toBeDisabled();
    const box = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(box, { target: { value: "Follow up" } });
    expect(send).toBeEnabled();
    if (method === "click") fireEvent.click(send);
    else fireEvent.keyDown(box, { key: "Enter" });
    expect(ipc.prompt).toHaveBeenCalledExactlyOnceWith(task.id, { text: "Follow up", files: [], images: [] }, false);
    expect(send).toBeDisabled();
    await act(async () => finish({ status: "ok", data: null }));
    expect(box).toHaveValue("");
  });

  it("keeps Queue named and shows icon-only Stop actions while the agent works", async () => {
    useAgents.setState({ tasks: new Map([[task.id, { ...task, status: "running" }]]) });
    render(<SessionEditor input={{ kind: "agent-session", key: task.id, data: { task: task.id } }} />);
    const queue = screen.getByRole("button", { name: "Queue" });
    expect(queue.textContent).toBe("");
    expect(queue).toHaveAttribute("data-tooltip", "Queue");
    expect(queue).toBeDisabled();
    expect(screen.getAllByRole("button", { name: "Stop" }).every((button) => button.textContent === "")).toBe(true);
    await screen.findByText("Original message");
  });
});
