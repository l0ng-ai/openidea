import { fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentTask } from "@/bindings";

const actions = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("@/platform/actions", () => ({ executeAction: actions.execute }));

import { SelectionToolbar } from "./SelectionToolbar";

const task: AgentTask = {
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

interface SetupOptions {
  subagent?: boolean;
  task?: AgentTask;
}

/** Mounts the toolbar over a stream holding one row of selectable text. */
function setup({ subagent = false, task: agent = task }: SetupOptions) {
  const stream = document.createElement("div");
  stream.setAttribute("data-selection-stream", "");
  const row = document.createElement("div");
  const text = document.createTextNode("Selected text");
  row.appendChild(text);
  stream.appendChild(row);
  document.body.appendChild(stream);
  const view = render(<SelectionToolbar streamRef={{ current: stream }} task={agent} subagent={subagent} />);
  return { row, text, view };
}

/** Selects `node`'s text as the user would, then releases the mouse over the conversation. */
function selectThenRelease(node: Node) {
  const range = document.createRange();
  range.selectNodeContents(node);
  const selection = document.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  fireEvent.mouseUp(document, { button: 0 });
}

const sideButton = (view: ReturnType<typeof render>) => view.queryByRole("button", { name: "Start Side Conversation" });

afterEach(() => document.querySelectorAll("[data-selection-stream]").forEach((n) => n.remove()));
beforeEach(() => actions.execute.mockClear());

it("offers Reply and a side conversation on a selection", () => {
  const { view, row } = setup({});
  selectThenRelease(row);
  expect(view.getByRole("button", { name: "Reply" })).toBeInTheDocument();
  expect(sideButton(view)).toBeInTheDocument();
});

it("quotes the selection into the composer on Reply", () => {
  const { view, row } = setup({});
  selectThenRelease(row);
  fireEvent.click(view.getByRole("button", { name: "Reply" }));
  expect(actions.execute).toHaveBeenCalledWith("agents.quoteReply", { task: task.id, text: "Selected text" });
  expect(view.queryByRole("button", { name: "Reply" })).toBeNull();
});

it("starts the side conversation with the selection", () => {
  const { view, row } = setup({});
  selectThenRelease(row);
  fireEvent.click(sideButton(view)!);
  expect(actions.execute).toHaveBeenCalledWith("agents.startSideConversation", {
    task: task.id,
    text: "Selected text",
  });
});

it("hides when the selection collapses", () => {
  const { view, text } = setup({});
  selectThenRelease(text);
  expect(view.getByRole("button", { name: "Reply" })).toBeInTheDocument();
  document.getSelection()?.removeAllRanges();
  fireEvent(document, new Event("selectionchange"));
  expect(view.queryByRole("button", { name: "Reply" })).toBeNull();
});

it("offers no side conversation in a subagent's view", () => {
  const { view, row } = setup({ subagent: true });
  selectThenRelease(row);
  expect(view.getByRole("button", { name: "Reply" })).toBeInTheDocument();
  expect(sideButton(view)).toBeNull();
});

it("offers no side conversation while the agent runs", () => {
  const { view, row } = setup({ task: { ...task, status: "running" } });
  selectThenRelease(row);
  expect(sideButton(view)).toBeNull();
  expect(view.getByRole("button", { name: "Reply" })).toBeInTheDocument();
});

it("shows nothing in an archived task", () => {
  const { view, row } = setup({ task: { ...task, status: "archived" } });
  selectThenRelease(row);
  expect(view.queryByRole("button", { name: "Reply" })).toBeNull();
});

it("ignores a selection in an editable field", () => {
  const { view, text, row } = setup({});
  const field = document.createElement("div");
  field.setAttribute("contenteditable", "true");
  field.textContent = "typing here";
  row.parentElement!.appendChild(field);
  text.remove();
  selectThenRelease(field);
  expect(view.queryByRole("button", { name: "Reply" })).toBeNull();
});
