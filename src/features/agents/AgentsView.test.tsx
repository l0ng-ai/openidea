import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { AgentTask } from "@/bindings";
import * as actions from "@/platform/actions";
import { registerActions } from "@/platform/actions";
import { EDITOR_TAB_MIME, type EditorInput } from "@/workbench/contributions";
import { confirmChecked, showError } from "@/workbench/messages";
import { ContextMenuHost, dragSession, hideContextMenu } from "@/ui";
import { AgentsView } from "./AgentsView";
import { SESSION_KIND } from "./model";
import { archiveTask, unarchiveTask, deleteTask, dockTask, openTask, undockTask, useAgents } from "./store";
import { taskActions, taskMenu } from "./taskActions";
import styles from "./Agents.module.css";

const editor = vi.hoisted(() => ({
  active: undefined as EditorInput | undefined,
  listener: undefined as ((input: EditorInput) => void) | undefined,
  tabInput: undefined as ((paneId: string, tabId: string) => EditorInput | null) | undefined,
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
    tabInput: editor.tabInput,
  }),
}));

vi.mock("./store", async (original) => ({
  ...(await original<typeof import("./store")>()),
  openTask: vi.fn((id: string) => editor.listener?.({ kind: "agent-session", key: id, data: { task: id } })),
  archiveTask: vi.fn(async () => {}),
  unarchiveTask: vi.fn(async () => {}),
  deleteTask: vi.fn(async () => {}),
  dockTask: vi.fn(),
  undockTask: vi.fn(),
}));

vi.mock("./SessionEditor", () => ({ SessionEditor: () => <div data-testid="docked-session" /> }));

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

const row = (id: string) =>
  within(screen.getByRole("tree", { name: "Agent tasks" }))
    .getByText(id)
    .closest('[role="treeitem"]')!;
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
  vi.spyOn(actions, "executeAction");
  editor.active = undefined;
  editor.tabInput = undefined;
  vi.mocked(confirmChecked).mockResolvedValue({ checked: false });
  useAgents.setState({
    loaded: true,
    error: null,
    tasks: new Map([task("one"), task("two"), task("three"), task("four")].map((t) => [t.id, t])),
    docked: null,
  });
  dispose = registerActions(taskActions);
});
afterEach(() => {
  dispose();
  hideContextMenu();
  vi.restoreAllMocks();
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

describe("Agents docked view", () => {
  it("shows the docked conversation above the list and switches it by selecting a task", () => {
    useAgents.setState({ docked: "one" });
    setup();
    expect(screen.getByTestId("docked-session")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open in Editor" })).toBeTruthy();
    expect(openTask).not.toHaveBeenCalled();
    select("two");
    expect(actions.executeAction).toHaveBeenCalledWith("agents.dockTask", "two");
    expect(dockTask).toHaveBeenCalledWith("two");
    expect(openTask).not.toHaveBeenCalled();
  });

  it("hides the docked task from the list below", () => {
    useAgents.setState({ docked: "one" });
    setup();
    const tree = within(screen.getByRole("tree", { name: "Agent tasks" }));
    expect(tree.queryByText("one")).toBeNull();
    expect(tree.getByText("two")).toBeTruthy();
  });

  it("gives the whole tool window to the conversation when the docked task is the only one", () => {
    useAgents.setState({ tasks: new Map([task("one")].map((t) => [t.id, t])), docked: "one" });
    setup();
    expect(screen.queryByRole("tree", { name: "Agent tasks" })).toBeNull();
    expect(screen.getByTestId("docked-session")).toBeTruthy();
  });

  it("undocks from the docked conversation's bar", () => {
    useAgents.setState({ docked: "one" });
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Open in Editor" }));
    expect(undockTask).toHaveBeenCalledTimes(1);
  });

  it("opens tabs as usual without a docked conversation", () => {
    setup();
    expect(screen.queryByRole("button", { name: "Open in Editor" })).toBeNull();
    select("two");
    expect(openTask).toHaveBeenCalledWith("two");
    expect(dockTask).not.toHaveBeenCalled();
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

  it("unarchives only archived tasks in a mixed selection", async () => {
    const tasks = [task("one"), task("two", "archived"), task("three", "archived")];
    useAgents.setState({ tasks: new Map(tasks.map((t) => [t.id, t])) });
    setup();
    fireEvent.doubleClick(screen.getByText("Archived"));
    select("one");
    select("three", { shiftKey: true });
    context("two");
    fireEvent.click(screen.getByRole("menuitem", { name: "Unarchive (2)" }));
    await waitFor(() => expect(unarchiveTask).toHaveBeenCalledTimes(2));
    expect(vi.mocked(unarchiveTask).mock.calls).toEqual([["two"], ["three"]]);
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

describe("Agents task menu", () => {
  it("offers to dock a task into the tool window", async () => {
    setup();
    context("one");
    fireEvent.click(screen.getByRole("menuitem", { name: "Open in Tool Window" }));
    await waitFor(() => expect(dockTask).toHaveBeenCalledWith("one"));
  });

  it("offers to move the docked task back to an editor", async () => {
    useAgents.setState({ docked: "one" });
    setup();
    // The docked task is not listed; its menu lives on the docked conversation's header.
    const menu = taskMenu([useAgents.getState().tasks.get("one")!]);
    expect(menu).toContainEqual(expect.objectContaining({ action: "agents.undockTask", label: "Open in Editor" }));
    await taskActions.find((action) => action.id === "agents.undockTask")!.run({ ctx: {}, arg: "one" });
    await waitFor(() => expect(undockTask).toHaveBeenCalledTimes(1));
  });
});

describe("Agents drag & drop", () => {
  // jsdom has no elementFromPoint; the drop target is found through it.
  const pointAt = (el: Element) => {
    const original = document.elementFromPoint;
    document.elementFromPoint = () => el;
    return () => {
      document.elementFromPoint = original;
    };
  };

  it("docks a session editor tab dropped on the tool window and highlights while it hovers", () => {
    editor.tabInput = (paneId, tabId) =>
      paneId === "p" && tabId === "t" ? { kind: SESSION_KIND, key: "agent:one", data: { task: "one" } } : null;
    setup();
    const view = document.querySelector(`.${styles.view}`)!;
    const restore = pointAt(view);
    try {
      const session = dragSession({ type: EDITOR_TAB_MIME, payload: JSON.stringify({ paneId: "p", tabId: "t" }) });
      act(() => session.move(10, 10));
      expect(view.className).toContain(styles.dropTarget);
      act(() => session.drop(10, 10));
      expect(actions.executeAction).toHaveBeenCalledWith("agents.dockTask", "one");
      expect(dockTask).toHaveBeenCalledWith("one");
      expect(view.className).not.toContain(styles.dropTarget);
    } finally {
      restore();
    }
  });

  it("ignores editor tab drags that are not agent sessions", () => {
    editor.tabInput = () => null;
    setup();
    const view = document.querySelector(`.${styles.view}`)!;
    const restore = pointAt(view);
    try {
      const session = dragSession({ type: EDITOR_TAB_MIME, payload: JSON.stringify({ paneId: "p", tabId: "t" }) });
      act(() => session.move(10, 10));
      expect(view.className).not.toContain(styles.dropTarget);
      act(() => session.drop(10, 10));
      expect(dockTask).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });
});
