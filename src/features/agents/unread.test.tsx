import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { AgentEntry, AgentEvent, AgentTask } from "@/bindings";
import {
  dropOnEditor,
  useContributions,
  useEditorTabTitles,
  type EditorInput,
  type OpenEditorTab,
} from "@/workbench/contributions";
import { AgentsView } from "./AgentsView";
import { AgentsStatus } from "./AgentsStatus";
import { activate } from "./index";
import { openChangeDiff } from "./SessionEditor";
import * as actions from "@/platform/actions";
import { TASK_DRAG } from "./model";
import {
  connect,
  disconnect,
  loadEntries,
  dockTask,
  markVisible,
  openHome,
  openTask,
  setSessionLocation,
  undockTask,
  useAgents,
} from "./store";

const backend = vi.hoisted(() => ({
  active: null as EditorInput | null,
  tabs: [] as OpenEditorTab[],
  channel: null as { onmessage: (event: AgentEvent) => void } | null,
  tasks: [] as AgentTask[],
  entries: null as Promise<AgentEntry[]> | null,
  notify: vi.fn(),
  openInput: vi.fn(),
  closeInput: vi.fn(),
  showToolWindow: vi.fn(),
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
    agentSubscribe: async (channel: typeof backend.channel) => {
      backend.channel = channel;
      return { status: "ok", data: backend.tasks };
    },
    agentProviders: async () => ({ status: "ok", data: [] }),
    agentChanges: async () => ({ status: "ok", data: [] }),
    agentGroupedChanges: async () => ({ status: "ok", data: { uncommitted: [], commits: [] } }),
    agentBaseText: async (_task: string, path: string) => ({ status: "ok", data: `base of ${path}` }),
    agentEntries: async () => ({ status: "ok", data: await backend.entries }),
  },
}));
vi.mock("@/workbench/contributions", async (original) => ({
  ...(await original<typeof import("@/workbench/contributions")>()),
  editorService: () => ({
    openInput: backend.openInput,
    closeInput: backend.closeInput,
    activeInput: () => backend.active,
    openTabs: () => backend.tabs,
  }),
  toolWindowService: () => ({ show: backend.showToolWindow }),
  notifications: () => ({ notify: backend.notify }),
}));

const task = (id: string, status: AgentTask["status"] = "running"): AgentTask => ({
  id,
  title: id,
  status,
  provider: "codex",
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
});

const emit = (event: AgentEvent) => act(() => backend.channel!.onmessage(event));
const reply = (id = "one", text = "New reply") =>
  emit({ type: "entry", task: id, subagent: null, index: 0, entry: { type: "agent", text } });
const visible: Array<() => void> = [];
const show = (id = "one") => {
  let hide!: () => void;
  act(() => {
    hide = markVisible(id);
  });
  visible.push(hide);
  return () => visible.splice(visible.indexOf(hide), 1)[0]!();
};

beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  disconnect();
  backend.active = null;
  backend.tabs = [];
  useAgents.setState({ sessionLocation: "editor" });
  localStorage.clear();
  backend.tasks = [task("one"), task("two", "ready")];
  await connect();
});
afterEach(() => {
  visible.splice(0).forEach((hide) => hide());
  disconnect();
  vi.restoreAllMocks();
});

describe("agent tab titles", () => {
  it("refreshes restored tab titles when tasks finish loading", async () => {
    disconnect();
    const revision = useEditorTabTitles.getState().revision;
    backend.tasks = [{ ...task("one"), title: "Saved rename" }];
    await connect();
    expect(useAgents.getState().tasks.get("one")?.title).toBe("Saved rename");
    expect(useEditorTabTitles.getState().revision).toBe(revision + 1);
  });

  it("refreshes titles for user and provider renames, but not unchanged task updates", () => {
    const revision = useEditorTabTitles.getState().revision;
    emit({ type: "task", task: { ...task("one"), title: "User rename" } });
    expect(useEditorTabTitles.getState().revision).toBe(revision + 1);
    emit({ type: "task", task: { ...task("one"), title: "User rename", updatedMs: 1 } });
    expect(useEditorTabTitles.getState().revision).toBe(revision + 1);
    emit({ type: "task", task: { ...task("two", "ready"), title: "Provider title" } });
    expect(useEditorTabTitles.getState().revision).toBe(revision + 2);
  });
});

describe("agent unread activity", () => {
  it("does not mark historical tasks unread, but tracks replies even without loaded entries", () => {
    expect(useAgents.getState().unread.size).toBe(0);
    reply();
    reply("one", "New reply, streamed further");
    reply("two");
    expect([...useAgents.getState().unread]).toEqual(["one", "two"]);
    expect(useAgents.getState().entries.size).toBe(0);
    expect(backend.notify).not.toHaveBeenCalled();
  });

  it("tracks a reply that streams on as appends, but not a thought", () => {
    reply("one", "");
    emit({ type: "append", task: "one", subagent: null, index: 0, from: 0, text: "Done" });
    emit({ type: "entry", task: "two", subagent: null, index: 0, entry: { type: "thought", text: "" } });
    emit({ type: "append", task: "two", subagent: null, index: 0, from: 0, text: "Hmm" });
    expect([...useAgents.getState().unread]).toEqual(["one"]);
  });

  it.each(["ready", "needsInput", "failed", "limited"] as const)("marks background %s transitions unread", (status) => {
    emit({ type: "task", task: task("one", status) });
    expect(useAgents.getState().unread.has("one")).toBe(true);
    expect(backend.notify).toHaveBeenCalledTimes(1);
    show();
    emit({ type: "task", task: task("one", status) });
    expect(useAgents.getState().unread.size).toBe(0);
    expect(backend.notify).toHaveBeenCalledTimes(1);
  });

  it("keeps the latest usage limits per provider without marking anything unread", () => {
    const fiveHour = (usedPercent: number) => [{ window: "five_hour", usedPercent, resetsMs: null }];
    emit({ type: "limits", provider: "claude", limits: fiveHour(10) });
    emit({ type: "limits", provider: "codex", limits: fiveHour(50) });
    emit({ type: "limits", provider: "claude", limits: fiveHour(12) });
    expect(useAgents.getState().limits.get("claude")).toEqual(fiveHour(12));
    expect(useAgents.getState().limits.get("codex")).toEqual(fiveHour(50));
    expect(useAgents.getState().unread.size).toBe(0);
  });

  it("ignores user messages, thoughts, empty replies and subagent streaming", () => {
    const entries: AgentEntry[] = [
      { type: "user", text: "Do this", attachments: [] },
      { type: "thought", text: "Thinking" },
      { type: "agent", text: " " },
    ];
    for (const entry of entries) emit({ type: "entry", task: "one", subagent: null, index: 0, entry });
    emit({ type: "entry", task: "one", subagent: "child", index: 0, entry: { type: "agent", text: "Working" } });
    emit({ type: "task", task: { ...task("one"), title: "Renamed" } });
    expect(useAgents.getState().unread.size).toBe(0);
  });

  it("clears only the viewed task and keeps reading while either split shows it", () => {
    reply();
    reply("two");
    const hide = show();
    show();
    hide();
    reply();
    emit({ type: "task", task: task("one", "ready") });
    expect([...useAgents.getState().unread]).toEqual(["two"]);
    expect(backend.notify).not.toHaveBeenCalled();
  });

  it("keeps a visible session unread while the window is unfocused, then clears on focus", () => {
    vi.mocked(document.hasFocus).mockReturnValue(false);
    reply();
    show();
    expect(useAgents.getState().unread.has("one")).toBe(true);
    vi.mocked(document.hasFocus).mockReturnValue(true);
    fireEvent(window, new Event("focus"));
    expect(useAgents.getState().unread.size).toBe(0);
    reply();
    expect(useAgents.getState().unread.size).toBe(0);
  });

  it("does not read hidden windows and removes focus listeners when the session closes", () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const hide = show();
    reply();
    fireEvent(window, new Event("focus"));
    expect(useAgents.getState().unread.has("one")).toBe(true);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    fireEvent(document, new Event("visibilitychange"));
    expect(useAgents.getState().unread.size).toBe(0);
    hide();
    reply();
    fireEvent(window, new Event("focus"));
    expect(useAgents.getState().unread.has("one")).toBe(true);
  });

  it("cleans up archived and deleted tasks, ignores late replies, and resets on project switch", async () => {
    reply();
    reply("two");
    emit({ type: "task", task: task("one", "archived") });
    reply();
    expect([...useAgents.getState().unread]).toEqual(["two"]);
    emit({ type: "removed", id: "two" });
    reply("two");
    expect(useAgents.getState().unread.size).toBe(0);
    emit({ type: "task", task: task("one") });
    reply();
    const oldChannel = backend.channel!;
    disconnect();
    backend.tasks = [task("other")];
    await connect();
    oldChannel.onmessage({ type: "task", task: task("one", "ready") });
    expect(useAgents.getState().unread.size).toBe(0);
    expect([...useAgents.getState().tasks.keys()]).toEqual(["other"]);
  });
});

describe("agent unread indicators", () => {
  it("shows a dot on the task and a clickable status count even when all tasks are idle", () => {
    emit({ type: "task", task: task("one", "ready") });
    render(
      <>
        <AgentsView />
        <AgentsStatus />
      </>,
    );
    expect(screen.getByRole("img", { name: "Unread" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "1 unread" }));
    expect(backend.openInput).toHaveBeenCalledWith(expect.objectContaining({ data: { task: "one", title: "one" } }), {
      focus: true,
    });
    show();
    expect(screen.queryByRole("img", { name: "Unread" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /unread/ })).not.toBeInTheDocument();
  });

  it("counts unread and needs-input tasks once each in the sidebar badge", () => {
    const dispose = activate();
    try {
      const useBadge = useContributions.getState().toolWindows.get("agents")!.useBadge!;
      function Badge() {
        return <span data-testid="badge">{useBadge()}</span>;
      }
      act(() =>
        useAgents.setState({
          tasks: new Map([task("one", "needsInput"), task("two", "ready")].map((t) => [t.id, t])),
          unread: new Set(["one", "two"]),
        }),
      );
      render(<Badge />);
      expect(screen.getByTestId("badge")).toHaveTextContent("2");
      show("two");
      expect(screen.getByTestId("badge")).toHaveTextContent("1");
      show("one");
      expect(screen.getByTestId("badge")).toHaveTextContent("1");
    } finally {
      act(dispose);
    }
  });
});

describe("docking a conversation in the tool window", () => {
  it("shows the task in the tool window, closing its editor tab, and undocks back to one", async () => {
    act(() => dockTask("one"));
    expect(useAgents.getState().docked).toBe("one");
    expect(backend.showToolWindow).toHaveBeenCalledWith("agents", true);
    expect(backend.closeInput).toHaveBeenCalledWith("agent:one");
    act(() => undockTask());
    expect(useAgents.getState().docked).toBeNull();
    expect(backend.openInput).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "agent-session", key: "agent:one" }),
      { focus: true },
    );
  });

  it("undocks a removed task", async () => {
    act(() => dockTask("one"));
    emit({ type: "removed", id: "one" });
    expect(useAgents.getState().docked).toBeNull();
  });

  it("drops a dragged task into the editor: undocking when docked, opening a tab otherwise", () => {
    const dispose = activate();
    const execute = vi.spyOn(actions, "executeAction");
    act(() => dropOnEditor({ type: TASK_DRAG, payload: "two" }));
    expect(execute).toHaveBeenCalledWith("agents.openTaskInEditor", "two");
    expect(useAgents.getState().docked).toBeNull();
    expect(backend.openInput).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "agent-session", key: "agent:two" }),
      { focus: true },
    );
    backend.openInput.mockClear();
    act(() => dockTask("one"));
    act(() => dropOnEditor({ type: TASK_DRAG, payload: "one" }));
    expect(execute).toHaveBeenCalledWith("agents.openTaskInEditor", "one");
    expect(useAgents.getState().docked).toBeNull();
    expect(backend.openInput).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "agent-session", key: "agent:one" }),
      { focus: true },
    );
    dispose();
  });

  it("moves the active session and applies the header choice to every subsequent session", () => {
    backend.active = { kind: "agent-session", key: "agent:two", data: { task: "two" } };
    backend.tabs = ["one", "two"].map((id) => ({
      input: { kind: "agent-session", key: `agent:${id}`, data: { task: id } },
      title: id,
      icon: "toolwindow-agents",
      lastActive: 0,
    }));
    act(() => setSessionLocation("toolWindow"));
    expect(backend.closeInput).toHaveBeenCalledWith("agent:one");
    expect(backend.closeInput).toHaveBeenCalledWith("agent:two");
    expect(useAgents.getState().docked).toBe("two");
    expect(backend.openInput).not.toHaveBeenCalled();
    act(() => openTask("one"));
    expect(useAgents.getState().docked).toBe("one");
    expect(backend.openInput).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem("openidea.agents.sessionLocation.v1")!)).toBe("toolWindow");
    act(() => setSessionLocation("editor"));
    expect(useAgents.getState().docked).toBeNull();
    expect(backend.openInput).toHaveBeenLastCalledWith(expect.objectContaining({ key: "agent:one" }), { focus: true });
    act(() => openTask("two"));
    expect(backend.openInput).toHaveBeenLastCalledWith(expect.objectContaining({ key: "agent:two" }), { focus: true });
  });

  it("opens new tasks in the selected location and moves an unfinished draft with the layout", () => {
    act(() => setSessionLocation("toolWindow"));
    backend.openInput.mockClear();
    act(() => openHome("Keep this draft"));
    expect(useAgents.getState().homeOpen).toBe(true);
    expect(useAgents.getState().docked).toBeNull();
    expect(backend.openInput).not.toHaveBeenCalled();
    act(() => setSessionLocation("editor"));
    expect(useAgents.getState().homeOpen).toBe(false);
    expect(backend.openInput).toHaveBeenCalledWith(expect.objectContaining({ kind: "agent-home" }), { focus: true });
    expect(useAgents.getState().composers.get("home")?.text).toBe("Keep this draft");
  });

  it("drops the dock when the project changes", async () => {
    act(() => dockTask("one"));
    disconnect();
    expect(useAgents.getState().docked).toBeNull();
    expect(useAgents.getState().sessionLocation).toBe("toolWindow");
  });
});

describe("streaming while the conversation loads", () => {
  it("applies what arrived meanwhile on top of the loaded copy", async () => {
    let resolve!: (entries: AgentEntry[]) => void;
    backend.entries = new Promise((r) => (resolve = r));
    const load = loadEntries("one");
    // Sent before the copy was read, then after.
    emit({ type: "entry", task: "one", subagent: null, index: 1, entry: { type: "agent", text: "He" } });
    emit({ type: "append", task: "one", subagent: null, index: 1, from: 2, text: "llo" });
    emit({ type: "append", task: "one", subagent: null, index: 1, from: 5, text: " there" });
    const user: AgentEntry = { type: "user", text: "Hi", attachments: [] };
    await act(async () => {
      resolve([user, { type: "agent", text: "Hello" }]);
      await load;
    });
    expect(useAgents.getState().entries.get("one")).toEqual([user, { type: "agent", text: "Hello there" }]);
    emit({ type: "append", task: "one", subagent: null, index: 1, from: 11, text: "!" });
    expect(useAgents.getState().entries.get("one")?.[1]).toEqual({ type: "agent", text: "Hello there!" });
    expect(useAgents.getState().entryLoads.size).toBe(0);
  });
});

describe("the diff of an agent change", () => {
  const change = (path: string) => ({
    path,
    relPath: path.slice("/project/".length),
    kind: "modified" as const,
    added: 1,
    removed: 1,
    oldPath: null,
  });

  it("lists the task's other changed files, so F7 moves on to the next one", async () => {
    useAgents.setState({ changes: new Map([["one", [change("/project/a.ts"), change("/project/b.ts")]]]) });
    await openChangeDiff(task("one"), "/project/b.ts");
    const input = backend.openInput.mock.lastCall![0];
    expect(input.data.path).toBe("/project/b.ts");
    expect(input.data.left).toEqual({ type: "text", text: "base of /project/b.ts", label: "Base" });
    expect(input.data.chain.map((d: { path: string }) => d.path)).toEqual(["/project/a.ts", "/project/b.ts"]);
    expect(input.data.chain[0].left.text).toBe("base of /project/a.ts");
  });

  it("opens a file outside the change list on its own", async () => {
    useAgents.setState({ changes: new Map([["one", [change("/project/a.ts")]]]) });
    await openChangeDiff(task("one"), "/project/c.ts");
    expect(backend.openInput.mock.lastCall![0].data.chain).toBeUndefined();
  });
});
