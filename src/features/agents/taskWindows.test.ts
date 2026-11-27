import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { editorService, type EditorInput, type EditorService } from "@/workbench/contributions";
import { executeAction } from "@/platform/actions";
import {
  activateTaskWindows,
  moveTaskToWindow,
  prepareTaskWindowInput,
  TASK_WINDOW,
  type TaskWindowMessage,
} from "./taskWindows";
import { routeToWindow, taskWindowDraft, taskWindowFocused, updateTaskWindowDraft } from "./taskWindowRouting";

const CHILD = "editor-main-3";
const backend = vi.hoisted(() => ({
  label: "main",
  serviceOverride: undefined as EditorService | undefined,
  subscribers: new Set<() => void>(),
  receive: undefined as ((event: { payload: unknown }) => void) | undefined,
  destroyed: undefined as (() => void) | undefined,
  focusChanged: undefined as ((event: { payload: boolean }) => void) | undefined,
  activeInput: undefined as ((input: EditorInput) => void) | undefined,
  draft: { text: "Unsent draft", files: [{ path: "/project/a.ts", rel: "a.ts" }], images: [] },
  state: {
    loaded: true,
    error: null as string | null,
    entries: new Map<string, unknown[]>([["running-task", []]]),
    entryLoads: new Map<string, { error: string | null }>(),
    composers: new Map(),
    tasks: new Map([["running-task", { status: "running", title: "Fix the build" }]]),
    docked: null as string | null,
    unread: new Set<string>(),
  },
  emit: vi.fn(async () => {}),
  openInWindow: vi.fn(async (_input: EditorInput) => "editor-main-3"),
  openInput: vi.fn(async (_input: EditorInput, _options?: unknown) => {}),
  openFile: vi.fn(async (_path: string, _options?: unknown) => {}),
  unsubscribe: vi.fn(async () => ({ status: "ok", data: null })),
  focus: vi.fn(async () => {}),
  closeInput: vi.fn(async () => true),
  openTask: vi.fn(),
  openHome: vi.fn(),
  updateComposer: vi.fn(),
  notify: vi.fn(),
  loadEntries: vi.fn(async () => {}),
}));

vi.mock("@tauri-apps/api/event", () => ({
  TauriEvent: { WINDOW_DESTROYED: "destroyed" },
  emitTo: backend.emit,
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    label: backend.label,
    listen: async (_event: string, receive: typeof backend.receive) => {
      backend.receive = receive;
      return () => {
        backend.receive = undefined;
      };
    },
  }),
  getAllWindows: async () => [{ label: "main" }, { label: "settings-main" }, { label: "editor-main-3" }],
  Window: {
    getByLabel: async () => ({
      unminimize: async () => {},
      show: async () => {},
      setFocus: backend.focus,
      isFocused: async () => false,
      once: async (_event: string, destroyed: () => void) => {
        backend.destroyed = destroyed;
      },
      onFocusChanged: async (changed: typeof backend.focusChanged) => {
        backend.focusChanged = changed;
        return async () => {};
      },
    }),
  },
}));
vi.mock("@/platform/ipc", () => ({
  isTauri: () => true,
  call: async (result: Promise<{ data: unknown }>) => (await result).data,
  commands: { agentUnsubscribe: backend.unsubscribe },
}));
vi.mock("@/workbench/contributions", () => ({
  editorService: () =>
    backend.serviceOverride ?? {
      openFile: backend.openFile,
      openInput: backend.openInput,
      closeInput: backend.closeInput,
      openInWindow: backend.openInWindow,
      onActiveInputChange: (listener: typeof backend.activeInput) => {
        backend.activeInput = listener;
        return () => {
          backend.activeInput = undefined;
        };
      },
    },
  provideEditorService: (service: EditorService) => {
    backend.serviceOverride = service;
  },
  provideToolWindowService: vi.fn(),
  notifications: () => ({ notify: backend.notify }),
}));
vi.mock("./store", () => ({
  composerDraft: () => backend.draft,
  updateComposer: backend.updateComposer,
  loadEntries: backend.loadEntries,
  openTask: backend.openTask,
  openHome: backend.openHome,
  useAgents: {
    subscribe: (fn: () => void) => {
      backend.subscribers.add(fn);
      return () => backend.subscribers.delete(fn);
    },
    getState: () => backend.state,
    setState: (patch: Partial<typeof backend.state>) => Object.assign(backend.state, patch),
  },
}));

let stop: () => void;
beforeEach(async () => {
  vi.clearAllMocks();
  backend.label = "main";
  backend.serviceOverride = undefined;
  backend.subscribers.clear();
  backend.state.loaded = true;
  backend.state.error = null;
  backend.state.entries = new Map([["running-task", []]]);
  backend.state.entryLoads = new Map();
  backend.state.docked = null;
  backend.state.unread = new Set();
  backend.destroyed = undefined;
  backend.focusChanged = undefined;
  stop = activateTaskWindows();
  await vi.waitFor(() => expect(backend.receive).toBeDefined());
});
afterEach(() => {
  stop();
  vi.useRealTimers();
});

const receive = (message: TaskWindowMessage) => backend.receive?.({ payload: message });

async function detach() {
  expect(await moveTaskToWindow("running-task")).toBe(true);
  await vi.waitFor(() => expect(backend.focusChanged).toBeDefined());
}

describe("moving a conversation to a lightweight editor window", () => {
  it("opens the tab there with the unsent draft, then closes it here", async () => {
    backend.state.docked = "running-task";
    await detach();
    expect(backend.openInWindow).toHaveBeenCalledWith({
      kind: "agent-session",
      key: "agent:running-task",
      data: { task: "running-task", title: "Fix the build" },
    });
    expect(backend.closeInput).toHaveBeenCalledWith("agent:running-task");
    expect(backend.state.docked).toBeNull();
    expect(backend.state.tasks.has("running-task")).toBe(true);
  });

  it("keeps the conversation here when the window cannot open", async () => {
    backend.openInWindow.mockRejectedValueOnce(new Error("Timed out opening the editor window"));
    expect(await moveTaskToWindow("running-task")).toBe(false);
    expect(backend.closeInput).not.toHaveBeenCalled();
    expect(routeToWindow("running-task")).toBe(false);
    expect(backend.notify).toHaveBeenCalledWith(
      expect.objectContaining({ body: "Timed out opening the editor window" }),
    );
  });

  it("focuses the window instead of opening a second view", async () => {
    await detach();
    expect(routeToWindow("running-task")).toBe(true);
    await vi.waitFor(() => expect(backend.focus).toHaveBeenCalled());
    expect(await moveTaskToWindow("running-task")).toBe(true);
    expect(backend.openInWindow).toHaveBeenCalledOnce();
    expect(routeToWindow("another-task")).toBe(false);
    expect(routeToWindow(null)).toBe(false);
  });

  it("closes a tab of the conversation that Back/Forward reopened here", async () => {
    await detach();
    backend.closeInput.mockClear();
    backend.activeInput?.({ kind: "agent-session", key: "agent:running-task", data: { task: "running-task" } });
    expect(backend.closeInput).toHaveBeenCalledWith("agent:running-task");
  });

  it("brings the conversation back with what was typed there when the window closes", async () => {
    await detach();
    receive({ type: "draft", task: "running-task", label: CHILD, draft: { text: "Typed over there" } });
    backend.destroyed?.();
    expect(backend.updateComposer).toHaveBeenCalledWith("running-task", { ...backend.draft, text: "Typed over there" });
    expect(backend.openTask).toHaveBeenCalledWith("running-task");
    expect(backend.unsubscribe).toHaveBeenCalledWith(CHILD);
    expect(routeToWindow("running-task")).toBe(false);
  });

  it("brings the conversation back when only its tab closes there", async () => {
    await detach();
    receive({ type: "closed", task: "running-task", label: "editor-main-9" });
    expect(backend.openTask).not.toHaveBeenCalled();
    receive({ type: "closed", task: "running-task", label: CHILD });
    expect(backend.openTask).toHaveBeenCalledWith("running-task");
    expect(backend.unsubscribe).not.toHaveBeenCalled();
  });

  it("counts a conversation in a focused window as read", async () => {
    await detach();
    backend.state.unread.add("running-task");
    backend.focusChanged?.({ payload: true });
    expect(taskWindowFocused("running-task")).toBe(true);
    expect(backend.state.unread.has("running-task")).toBe(false);
    backend.focusChanged?.({ payload: false });
    expect(taskWindowFocused("running-task")).toBe(false);
  });

  it("finds its windows again after a reload", async () => {
    expect(backend.emit).toHaveBeenCalledWith(CHILD, TASK_WINDOW, { type: "sync" });
    expect(backend.emit).toHaveBeenCalledOnce();
    receive({ type: "draft", task: "running-task", label: "editor-project-2-1", draft: backend.draft });
    expect(routeToWindow("running-task")).toBe(false);
    receive({ type: "draft", task: "running-task", label: CHILD, draft: backend.draft });
    expect(routeToWindow("running-task")).toBe(true);
    expect(backend.closeInput).toHaveBeenCalledWith("agent:running-task");
    expect(backend.openInWindow).not.toHaveBeenCalled();
  });

  it("shows what a lightweight window asks for", () => {
    receive({ type: "open", task: "another-task" });
    expect(backend.openTask).toHaveBeenCalledWith("another-task");
    receive({ type: "open", task: null, prompt: "Review this" });
    expect(backend.openHome).toHaveBeenCalledWith("Review this");
  });

  it("returns the latest mirrored draft to a reloading child", async () => {
    await detach();
    receive({ type: "draft", task: "running-task", label: CHILD, draft: { text: "Latest draft" } });
    receive({ type: "requestDraft", task: "running-task", label: CHILD });
    expect(backend.emit).toHaveBeenLastCalledWith(CHILD, TASK_WINDOW, {
      type: "draftSnapshot",
      task: "running-task",
      draft: { ...backend.draft, text: "Latest draft" },
    });
  });

  it("routes edits made in the project to the latest draft in its child", async () => {
    await detach();
    receive({ type: "draft", task: "running-task", label: CHILD, draft: { text: "Typed there" } });
    expect(taskWindowDraft("running-task")?.text).toBe("Typed there");
    expect(updateTaskWindowDraft("running-task", { text: "Typed there @a.ts" })).toBe(true);
    expect(backend.emit).toHaveBeenLastCalledWith(CHILD, TASK_WINDOW, {
      type: "draftSnapshot",
      task: "running-task",
      draft: { ...backend.draft, text: "Typed there @a.ts" },
    });
    expect(updateTaskWindowDraft("another-task", { text: "Local draft" })).toBe(false);
  });

  it("does not hide the original view before the child reports success", async () => {
    let finish!: (label: string) => void;
    backend.openInWindow.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const moving = moveTaskToWindow("running-task");
    receive({ type: "draft", task: "running-task", label: CHILD, draft: { text: "Already typed there" } });
    expect(backend.closeInput).not.toHaveBeenCalled();
    finish(CHILD);
    expect(await moving).toBe(true);
    await vi.waitFor(() => expect(backend.destroyed).toBeDefined());
    backend.destroyed?.();
    expect(backend.updateComposer).toHaveBeenCalledWith("running-task", {
      ...backend.draft,
      text: "Already typed there",
    });
  });

  it("ignores late draft events from a window that failed to open", async () => {
    backend.openInWindow.mockRejectedValueOnce(new Error("Cannot load task"));
    expect(await moveTaskToWindow("running-task")).toBe(false);
    receive({ type: "draft", task: "running-task", label: "editor-main-99", draft: backend.draft });
    expect(backend.closeInput).not.toHaveBeenCalled();
    expect(routeToWindow("running-task")).toBe(false);
  });
});

describe("preparing the child's conversation", () => {
  const input: EditorInput = {
    kind: "agent-session",
    key: "agent:running-task",
    data: { task: "running-task", draft: { text: "Old launch draft" } },
  };
  async function child() {
    stop();
    await Promise.resolve();
    backend.label = CHILD;
  }
  async function reply() {
    await vi.waitFor(() =>
      expect(backend.emit).toHaveBeenCalledWith("main", TASK_WINDOW, {
        type: "requestDraft",
        task: "running-task",
        label: CHILD,
      }),
    );
    receive({ type: "draftSnapshot", task: "running-task", draft: { ...backend.draft, text: "Latest draft" } });
  }

  it("waits for the task and uses the current draft instead of launch data", async () => {
    await child();
    backend.state.loaded = false;
    backend.emit.mockClear();
    const pending = prepareTaskWindowInput(input);
    expect(backend.emit).not.toHaveBeenCalled();
    backend.state.loaded = true;
    backend.subscribers.forEach((fn) => fn());
    await reply();
    expect(await pending).toEqual({
      ...input,
      data: { task: "running-task", draft: { ...backend.draft, text: "Latest draft" } },
    });
    expect(backend.subscribers.size).toBe(0);
  });

  it("routes files, diffs and workbench actions to the project while keeping its conversation here", async () => {
    await child();
    stop = activateTaskWindows();
    backend.activeInput?.(input);
    backend.emit.mockClear();
    await editorService().openFile("/project/a.ts", { focus: true });
    expect(backend.emit).toHaveBeenLastCalledWith("main", TASK_WINDOW, {
      type: "openFile",
      path: "/project/a.ts",
      options: { focus: true },
    });
    const diff = { kind: "diff", key: "diff:one" };
    await editorService().openInput(diff);
    expect(backend.emit).toHaveBeenLastCalledWith("main", TASK_WINDOW, {
      type: "openInput",
      input: diff,
      options: undefined,
    });
    await editorService().openInput(input);
    expect(backend.openInput).toHaveBeenCalledWith(input, undefined);
    await executeAction("file.settings", "agents");
    expect(backend.emit).toHaveBeenLastCalledWith("main", TASK_WINDOW, {
      type: "action",
      action: "file.settings",
      arg: "agents",
    });
  });

  it("applies context appended in the project to the child composer", async () => {
    await child();
    stop = activateTaskWindows();
    backend.activeInput?.(input);
    backend.emit.mockClear();
    const draft = { ...backend.draft, text: "Typed in the child @a.ts" };
    receive({ type: "draftSnapshot", task: "running-task", draft });
    expect(backend.updateComposer).toHaveBeenCalledWith("running-task", draft);
    expect(backend.emit).not.toHaveBeenCalled();
  });

  it("does not complete the handoff when connecting fails", async () => {
    await child();
    backend.state.error = "Connection failed";
    backend.emit.mockClear();
    await expect(prepareTaskWindowInput(input)).rejects.toThrow("Connection failed");
    expect(backend.emit).not.toHaveBeenCalled();
  });

  it("waits for conversation entries and rejects their loading error", async () => {
    await child();
    backend.state.entries.clear();
    const pending = prepareTaskWindowInput(input);
    const rejected = expect(pending).rejects.toThrow("Cannot read conversation");
    expect(backend.loadEntries).toHaveBeenCalledWith("running-task");
    backend.state.entryLoads.set("running-task", { error: "Cannot read conversation" });
    backend.subscribers.forEach((fn) => fn());
    await rejected;
  });

  it("times out without hiding the parent or retaining its store listener", async () => {
    await child();
    vi.useFakeTimers();
    backend.state.loaded = false;
    const rejected = expect(prepareTaskWindowInput(input)).rejects.toThrow("Loading the conversation timed out");
    await vi.advanceTimersByTimeAsync(20_000);
    await rejected;
    expect(backend.subscribers.size).toBe(0);
    expect(backend.closeInput).not.toHaveBeenCalled();
  });
});
