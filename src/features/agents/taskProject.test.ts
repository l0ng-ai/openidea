import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTask, ProjectInfo } from "@/bindings";
import { useProject } from "@/platform/project";
import { HOME_KEY, SESSION_KIND, TOOL_WINDOW, sessionKey } from "./model";
import {
  HOME,
  composerDraft,
  connect,
  disconnect,
  forkTask,
  startTask,
  updateComposer,
  updateDraft,
  useAgents,
} from "./store";

const backend = vi.hoisted(() => ({
  create: vi.fn(),
  fork: vi.fn(),
  subscribe: vi.fn(),
  open: vi.fn(),
  close: vi.fn(),
  show: vi.fn(),
  closeAvailable: true,
  tasks: [] as AgentTask[],
}));
vi.mock("@tauri-apps/api/core", async (original) => ({
  ...(await original<typeof import("@tauri-apps/api/core")>()),
  Channel: class {
    onmessage = () => {};
  },
}));
vi.mock("@/platform/ipc", async (original) => ({
  ...(await original<typeof import("@/platform/ipc")>()),
  isTauri: () => true,
  commands: {
    agentCreate: backend.create,
    agentFork: backend.fork,
    agentSubscribe: backend.subscribe,
    agentProviders: async () => ({ status: "ok", data: [] }),
  },
}));
vi.mock("@/workbench/contributions", async (original) => ({
  ...(await original<typeof import("@/workbench/contributions")>()),
  editorService: () => ({
    openInput: backend.open,
    closeInput: backend.closeAvailable ? backend.close : undefined,
    openTabs: () => [],
  }),
  toolWindowService: () => ({ show: backend.show }),
}));

const ok = <T>(data: T) => ({ status: "ok" as const, data });
function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const task = (id: string, cwd = "/project-a"): AgentTask => ({
  id,
  cwd,
  title: id,
  provider: "codex",
  status: "ready",
  isolation: "local",
  model: null,
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
});
const setProject = (root: string | null) =>
  useProject.setState({
    project: root === null ? null : ({ root, trusted: true } as ProjectInfo),
  });

beforeEach(() => {
  disconnect();
  vi.resetAllMocks();
  backend.closeAvailable = true;
  backend.close.mockResolvedValue(true);
  backend.tasks = [task("source")];
  backend.subscribe.mockImplementation(async () => ok(backend.tasks));
  setProject("/project-a");
  useProject.setState({ settings: null });
  useAgents.setState({
    loaded: true,
    tasks: new Map([["source", task("source")]]),
    entries: new Map(),
    providers: [],
    draft: { provider: "codex", config: {}, isolation: "local", base: "main" },
    history: [],
    composers: new Map(),
    lastComposer: HOME,
    focus: null,
    sessionLocation: "editor",
    docked: null,
    lastTask: null,
    homeOpen: true,
  });
  updateComposer(HOME, { text: "submitted in A" });
});
afterEach(() => disconnect());

const transitions = [
  "disconnect",
  "reconnect",
  "replace connection",
  "trust change",
  "A to B",
  "A to B to A",
  "A to B to C",
  "close project",
] as const;
async function transition(change: (typeof transitions)[number]) {
  if (change !== "replace connection") disconnect();
  if (change.startsWith("A to B")) setProject("/project-b");
  if (change === "trust change")
    useProject.setState({ project: { root: "/project-a", trusted: false } as ProjectInfo });
  if (change === "close project") setProject(null);
  backend.tasks = [task("current", useProject.getState().project?.root ?? "")];
  if (change !== "disconnect" && change !== "close project") await connect();
  if (change === "A to B to A" || change === "A to B to C") {
    disconnect();
    setProject(change === "A to B to A" ? "/project-a" : "/project-c");
    backend.tasks = [task("current", useProject.getState().project!.root)];
    await connect();
  }
  updateDraft({ projectRoot: "/current/member", provider: "current-agent", config: { model: "current-model" } });
  updateComposer(HOME, {
    text: "current project draft",
    files: [{ path: "/current/next.ts", rel: "next.ts", attached: true }],
    images: [{ mimeType: "image/png", data: "next", name: "next.png" }],
  });
  useAgents.setState({ history: ["current history"], docked: "current", homeOpen: true, lastTask: "current" });
}

const paths = [
  { name: "create local task", create: true, run: () => startTask("local"), mock: backend.create, turns: null },
  { name: "create worktree task", create: true, run: () => startTask("worktree"), mock: backend.create, turns: null },
  { name: "fork entire task", create: false, run: () => forkTask("source", null), mock: backend.fork, turns: null },
  { name: "fork selected turns", create: false, run: () => forkTask("source", 2), mock: backend.fork, turns: 2 },
];

describe.each(paths)("$name project ownership", (path) => {
  function begin() {
    const response = deferred();
    path.mock.mockReturnValueOnce(response.promise);
    return { ...response, pending: path.run() };
  }

  it.each(["editor", "toolWindow"] as const)("opens a successful task in the current %s", async (location) => {
    useAgents.setState({ sessionLocation: location });
    const response = begin();
    expect(path.mock).toHaveBeenCalledTimes(1);
    if (path.create)
      expect(backend.create).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: { text: "submitted in A", files: [], images: [] },
        }),
      );
    else expect(backend.fork).toHaveBeenCalledWith("source", path.turns);
    response.resolve(ok(task("completed")));
    await response.pending;
    expect(useAgents.getState().tasks.get("completed")).toEqual(task("completed"));
    if (location === "editor") {
      expect(backend.open).toHaveBeenCalledWith(
        { kind: SESSION_KIND, key: sessionKey("completed"), data: { task: "completed", title: "completed" } },
        { focus: true },
      );
    } else {
      expect(useAgents.getState().docked).toBe("completed");
      expect(backend.show).toHaveBeenCalledWith(TOOL_WINDOW, true);
      expect(backend.open).not.toHaveBeenCalled();
    }
    expect(composerDraft(HOME).text).toBe(path.create ? "" : "submitted in A");
    expect(useAgents.getState().history).toEqual(path.create ? ["submitted in A"] : []);
  });

  it.each(transitions)("ignores a successful reply after %s", async (change) => {
    const response = begin();
    await transition(change);
    const current = useAgents.getState();
    response.resolve(ok(task("old-task")));
    await response.pending;
    expect(useAgents.getState()).toBe(current);
    expect(backend.open).not.toHaveBeenCalled();
    expect(backend.close).not.toHaveBeenCalled();
    expect(backend.show).not.toHaveBeenCalled();
  });

  it("leaves a current task with a colliding id and its conversation untouched", async () => {
    const response = begin();
    await transition("A to B");
    const currentTask = { ...task("completed", "/project-b"), title: "B's task" };
    useAgents.setState({
      tasks: new Map([[currentTask.id, currentTask]]),
      entries: new Map([[currentTask.id, [{ type: "agent", text: "B's conversation" }]]]),
    });
    const current = useAgents.getState();
    response.resolve(ok(task("completed")));
    await response.pending;
    expect(useAgents.getState()).toBe(current);
    expect(backend.open).not.toHaveBeenCalled();
  });

  it.each([false, true])("preserves state on command failure (switched project=%s)", async (switched) => {
    const response = begin();
    if (switched) await transition("A to B");
    const current = useAgents.getState();
    const failure = switched
      ? expect(response.pending).resolves.toBeUndefined()
      : expect(response.pending).rejects.toThrow("operation failed");
    response.resolve({ status: "error", error: { kind: "internal", message: "operation failed" } });
    await failure;
    expect(useAgents.getState()).toBe(current);
    expect(backend.open).not.toHaveBeenCalled();
    expect(backend.close).not.toHaveBeenCalled();
  });

  it.each([false, true])("preserves state on transport failure (switched project=%s)", async (switched) => {
    const response = begin();
    if (switched) await transition("A to B");
    const current = useAgents.getState();
    const failure = switched
      ? expect(response.pending).resolves.toBeUndefined()
      : expect(response.pending).rejects.toThrow("connection lost");
    response.reject(new Error("connection lost"));
    await failure;
    expect(useAgents.getState()).toBe(current);
    expect(backend.open).not.toHaveBeenCalled();
    expect(backend.close).not.toHaveBeenCalled();
  });

  it("keeps task and conversation events that arrived before the same-project reply", async () => {
    const response = begin();
    const newer = { ...task("completed"), title: "Newer title", status: "running" as const };
    useAgents.setState({
      tasks: new Map([[newer.id, newer]]),
      entries: new Map([[newer.id, [{ type: "agent", text: "new entry" }]]]),
    });
    response.resolve(ok(task("completed")));
    await response.pending;
    expect(useAgents.getState().tasks.get(newer.id)).toBe(newer);
    expect(useAgents.getState().entries.get(newer.id)).toEqual([{ type: "agent", text: "new entry" }]);
  });

  it.each(["old first", "new first"])(
    "accepts only the new project's request when acknowledgements arrive %s",
    async (order) => {
      const old = begin();
      await transition("A to B");
      const current = begin();
      const finishOld = async () => {
        old.resolve(ok(task("old-task")));
        await old.pending;
      };
      const finishCurrent = async () => {
        current.resolve(ok(task("new-task", "/project-b")));
        await current.pending;
      };
      if (order === "old first") {
        await finishOld();
        await finishCurrent();
      } else {
        await finishCurrent();
        await finishOld();
      }
      expect([...useAgents.getState().tasks.keys()]).toEqual(["current", "new-task"]);
      expect(useAgents.getState().lastTask).toBe("new-task");
      expect(backend.open).toHaveBeenCalledTimes(1);
      expect(backend.open).toHaveBeenCalledWith(expect.objectContaining({ key: sessionKey("new-task") }), {
        focus: true,
      });
      expect(useAgents.getState().history).toEqual(
        path.create ? ["current project draft", "current history"] : ["current history"],
      );
    },
  );

  it.each(["first then second", "second then first"])(
    "keeps both legitimate same-project requests (%s)",
    async (order) => {
      const first = begin();
      const second = begin();
      const finishFirst = async () => {
        first.resolve(ok(task("first")));
        await first.pending;
      };
      const finishSecond = async () => {
        second.resolve(ok(task("second")));
        await second.pending;
      };
      if (order === "first then second") {
        await finishFirst();
        await finishSecond();
      } else {
        await finishSecond();
        await finishFirst();
      }
      expect(useAgents.getState().tasks.has("first")).toBe(true);
      expect(useAgents.getState().tasks.has("second")).toBe(true);
      expect(backend.open).toHaveBeenCalledTimes(2);
    },
  );
});

describe.each(paths.filter((path) => path.create))("$name after closing Home", (path) => {
  async function waitingForClose() {
    const closing = deferred();
    backend.close.mockReturnValueOnce(closing.promise);
    backend.create.mockResolvedValueOnce(ok(task("completed")));
    const pending = path.run();
    await vi.waitFor(() => expect(backend.close).toHaveBeenCalledWith(HOME_KEY));
    return { ...closing, pending };
  }

  it.each(transitions)("does not navigate after %s while the page is closing", async (change) => {
    const closing = await waitingForClose();
    await transition(change);
    const current = useAgents.getState();
    closing.resolve(true);
    await closing.pending;
    expect(useAgents.getState()).toBe(current);
    expect(backend.open).not.toHaveBeenCalled();
    expect(backend.show).not.toHaveBeenCalled();
    expect(backend.close).toHaveBeenCalledTimes(1);
  });

  it.each(transitions)("does not surface an old close failure after %s", async (change) => {
    const closing = await waitingForClose();
    await transition(change);
    const current = useAgents.getState();
    const done = expect(closing.pending).resolves.toBeUndefined();
    closing.reject(new Error("old close failed"));
    await done;
    expect(useAgents.getState()).toBe(current);
    expect(backend.open).not.toHaveBeenCalled();
    expect(backend.show).not.toHaveBeenCalled();
  });

  it("still navigates after closing when only settings or another composer changed", async () => {
    const closing = await waitingForClose();
    updateDraft({ config: { model: "different" } });
    updateComposer("other", { text: "another conversation" });
    closing.resolve(true);
    await closing.pending;
    expect(backend.open).toHaveBeenCalledWith(expect.objectContaining({ key: sessionKey("completed") }), {
      focus: true,
    });
    expect(composerDraft("other").text).toBe("another conversation");
  });

  it("respects a cancelled close", async () => {
    const closing = await waitingForClose();
    closing.resolve(false);
    await closing.pending;
    expect(backend.open).not.toHaveBeenCalled();
    expect(useAgents.getState().tasks.has("completed")).toBe(true);
  });

  it("does not navigate when closing fails", async () => {
    const closing = await waitingForClose();
    const failure = expect(closing.pending).rejects.toThrow("could not close");
    closing.reject(new Error("could not close"));
    await failure;
    expect(backend.open).not.toHaveBeenCalled();
    expect(useAgents.getState().tasks.has("completed")).toBe(true);
  });

  it("opens the task when the editor service has no close operation", async () => {
    backend.closeAvailable = false;
    backend.create.mockResolvedValueOnce(ok(task("completed")));
    await path.run();
    expect(backend.open).toHaveBeenCalledWith(expect.objectContaining({ key: sessionKey("completed") }), {
      focus: true,
    });
  });

  it("keeps the workspace member selected for the request", async () => {
    const root = "/workspace/member-a";
    const result = task("completed", root);
    backend.create.mockResolvedValueOnce(ok(result));
    await startTask(path.name === "create worktree task" ? "worktree" : "local", root);
    expect(backend.create).toHaveBeenCalledWith(expect.objectContaining({ projectRoot: root }));
    expect(useAgents.getState().tasks.get(result.id)).toEqual(result);
    expect(backend.open).toHaveBeenCalledWith(expect.objectContaining({ key: sessionKey(result.id) }), { focus: true });
  });
});
