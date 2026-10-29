import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AgentTask } from "@/bindings";
import { registerActions } from "@/platform/actions";
import type { EditorInput } from "@/workbench/contributions";
import { confirmChecked, showError } from "@/workbench/messages";
import { ContextMenuHost, hideContextMenu } from "@/ui";
import { AgentsView } from "./AgentsView";
import { SESSION_KIND } from "./model";
import { archiveTask, deleteTask, openTask, useAgents } from "./store";
import { taskActions } from "./taskActions";

const editor = vi.hoisted(() => ({
  active: undefined as EditorInput | undefined,
  listener: undefined as ((input: EditorInput) => void) | undefined,
}));

vi.mock("@/workbench/contributions", async (original) => ({
  ...(await original<typeof import("@/workbench/contributions")>()),
  maybeEditorService: () => ({
    activeInput: () => editor.active,
    onActiveInputChange: (listener: typeof editor.listener) => {
      editor.listener = listener;
      return () => {
        editor.listener = undefined;
      };
    },
  }),
}));

vi.mock("./store", async (original) => ({
  ...(await original<typeof import("./store")>()),
  openTask: vi.fn((id: string) => editor.listener?.({ kind: "agent-session", key: id, data: { task: id } })),
  archiveTask: vi.fn(async () => {}),
  deleteTask: vi.fn(async () => {}),
}));

vi.mock("@/workbench/messages", () => ({
  confirmChecked: vi.fn(async () => ({ checked: false })),
  showError: vi.fn(async () => {}),
}));

function task(
  id: string,
  status: AgentTask["status"] = "ready",
  isolation: AgentTask["isolation"] = "local",
): AgentTask {
  return {
    id,
    title: id,
    status,
    isolation,
    provider: "codex",
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
  };
}

const row = (id: string) => screen.getByText(id).closest('[role="treeitem"]')!;
const select = (id: string, modifiers: MouseEventInit = {}) =>
  fireEvent.mouseDown(row(id), { button: 0, ...modifiers });
const selectedTasks = () =>
  screen
    .queryAllByRole("treeitem", { selected: true })
    .filter((item) => item.getAttribute("aria-level") === "2")
    .map((item) => item.querySelector("[title]")?.getAttribute("title"));
const context = (id: string) => {
  fireEvent.mouseDown(row(id), { button: 2 });
  fireEvent.contextMenu(row(id));
};

let dispose: () => void;
beforeEach(() => {
  vi.clearAllMocks();
  editor.active = undefined;
  vi.mocked(confirmChecked).mockResolvedValue({ checked: false });
  useAgents.setState({
    loaded: true,
    error: null,
    tasks: new Map([task("one"), task("two"), task("three"), task("four")].map((t) => [t.id, t])),
  });
  dispose = registerActions(taskActions);
});
afterEach(() => {
  dispose();
  hideContextMenu();
});

function setup() {
  render(
    <>
      <AgentsView />
      <ContextMenuHost />
    </>,
  );
}

describe("Agents selection", () => {
  it("extends and shrinks a range without opening its lead or losing selection to an editor echo", () => {
    setup();
    select("one");
    select("three", { shiftKey: true });
    expect(selectedTasks()).toEqual(["one", "two", "three"]);
    expect(openTask).toHaveBeenCalledTimes(1);
    act(() => editor.listener?.({ kind: SESSION_KIND, key: "one", data: { task: "one" } }));
    expect(selectedTasks()).toEqual(["one", "two", "three"]);
    select("two", { shiftKey: true });
    expect(selectedTasks()).toEqual(["one", "two"]);
    select("four");
    expect(selectedTasks()).toEqual(["four"]);
  });

  it("keeps the initial active task as the anchor for repeated keyboard extension", () => {
    editor.active = { kind: SESSION_KIND, key: "one", data: { task: "one" } };
    setup();
    const tree = screen.getByRole("tree");
    fireEvent.keyDown(tree, { key: "ArrowDown", shiftKey: true });
    fireEvent.keyDown(tree, { key: "ArrowDown", shiftKey: true });
    expect(selectedTasks()).toEqual(["one", "two", "three"]);
    expect(openTask).not.toHaveBeenCalled();
  });

  it.each(["metaKey", "ctrlKey"])("toggles individual tasks with %s", (modifier) => {
    setup();
    select("one");
    select("three", { [modifier]: true });
    expect(selectedTasks()).toEqual(["one", "three"]);
    select("three", { [modifier]: true });
    expect(selectedTasks()).toEqual(["one"]);
    expect(openTask).toHaveBeenCalledTimes(1);
  });
});

describe("Agents bulk actions", () => {
  it("deletes the right-clicked selection after one confirmation, excluding group headers", async () => {
    const tasks = [task("one", "running"), task("two"), task("three")];
    useAgents.setState({ tasks: new Map(tasks.map((t) => [t.id, t])) });
    setup();
    select("one");
    select("three", { shiftKey: true });
    context("two");
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete (3)…" }));
    await waitFor(() => expect(deleteTask).toHaveBeenCalledTimes(3));
    expect(confirmChecked).toHaveBeenCalledTimes(1);
    expect(confirmChecked).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("3 agent tasks") }),
    );
    expect(vi.mocked(deleteTask).mock.calls).toEqual([
      ["one", false],
      ["two", false],
      ["three", false],
    ]);
  });

  it("right-clicking outside the selection targets only that task", async () => {
    setup();
    select("one");
    select("two", { shiftKey: true });
    context("four");
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete…" }));
    await waitFor(() => expect(deleteTask).toHaveBeenCalledExactlyOnceWith("four", false));
  });

  it("archives only eligible tasks in a mixed selection", async () => {
    const tasks = [task("one", "running"), task("two"), task("three", "archived")];
    useAgents.setState({ tasks: new Map(tasks.map((t) => [t.id, t])) });
    setup();
    fireEvent.doubleClick(screen.getByText("Archived"));
    select("one");
    select("three", { shiftKey: true });
    context("two");
    fireEvent.click(screen.getByRole("menuitem", { name: "Archive (1)" }));
    await waitFor(() => expect(archiveTask).toHaveBeenCalledExactlyOnceWith("two"));
  });

  it("cancels the whole batch", async () => {
    vi.mocked(confirmChecked).mockResolvedValue(null);
    await taskActions.find((action) => action.id === "agents.deleteTasks")!.run({ ctx: {}, arg: ["one", "two"] });
    expect(deleteTask).not.toHaveBeenCalled();
  });

  it.each([false, true])("applies worktree cleanup (%s) only to worktree tasks", async (checked) => {
    const tasks = [task("one"), task("two", "ready", "worktree")];
    useAgents.setState({ tasks: new Map(tasks.map((t) => [t.id, t])) });
    vi.mocked(confirmChecked).mockResolvedValue({ checked });
    await taskActions.find((action) => action.id === "agents.deleteTasks")!.run({ ctx: {}, arg: ["one", "two"] });
    expect(vi.mocked(deleteTask).mock.calls).toEqual([
      ["one", false],
      ["two", checked],
    ]);
  });

  it("continues after an error and reports the failed task", async () => {
    vi.mocked(deleteTask).mockRejectedValueOnce(new Error("Cannot remove worktree"));
    await taskActions.find((action) => action.id === "agents.deleteTasks")!.run({ ctx: {}, arg: ["one", "two"] });
    expect(deleteTask).toHaveBeenCalledTimes(2);
    expect(showError).toHaveBeenCalledWith("Cannot delete agent tasks", "one: Cannot remove worktree");
  });
});
