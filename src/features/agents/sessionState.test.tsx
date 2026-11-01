import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { registerActions } from "@/platform/actions";
import type { AgentEntry, AgentTask } from "@/bindings";
import { AgentsView } from "./AgentsView";
import { SessionEditor } from "./SessionEditor";
import { entriesKey, SESSION_KIND, sessionKey, type SubagentEntry } from "./model";
import { disconnect, useAgents } from "./store";
import { taskActions } from "./taskActions";
import styles from "./Session.module.css";

const backend = vi.hoisted(() => ({ entries: new Map<string, AgentEntry[]>() }));
vi.mock("@/platform/ipc", async (original) => ({
  ...(await original<typeof import("@/platform/ipc")>()),
  commands: {
    agentEntries: async (id: string, sub: string | null) => ({
      status: "ok",
      data: backend.entries.get(sub ? `${id}/${sub}` : id) ?? [],
    }),
    agentChanges: async () => ({ status: "ok", data: [] }),
    vcsBranchInfo: async () => ({ status: "ok", data: { head: "main" } }),
  },
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));
vi.mock("@/workbench/contributions", async (original) => ({
  ...(await original<typeof import("@/workbench/contributions")>()),
  editorService: () => ({ closeInput: vi.fn(), openInput: vi.fn() }),
  toolWindowService: () => ({ show: vi.fn() }),
}));

const task = (id: string): AgentTask => ({
  id,
  title: id,
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
});
const subagent: SubagentEntry = {
  type: "subagent",
  id: "child",
  title: "Explore task A",
  description: null,
  status: "done",
  error: null,
  prompt: null,
  reply: null,
  tools: 0,
  activity: null,
  startedMs: 0,
  endedMs: 1,
  cancellable: false,
};
const input = (id: string) => ({ kind: SESSION_KIND, key: sessionKey(id), data: { task: id } });
const stream = () => document.querySelector<HTMLDivElement>(`.${styles.stream}`)!;

const scrollTopDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTop");
afterEach(() => {
  vi.restoreAllMocks();
  if (scrollTopDescriptor) Object.defineProperty(HTMLElement.prototype, "scrollTop", scrollTopDescriptor);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollTop");
});

beforeEach(() => {
  disconnect();
  backend.entries = new Map([
    ["A", [{ type: "agent", text: "Answer A" }, subagent]],
    [entriesKey("A", "child"), [{ type: "agent", text: "Child answer" }]],
    ["B", [{ type: "agent", text: "Answer B" }]],
  ]);
  useAgents.setState({
    loaded: true,
    tasks: new Map([task("A"), task("B")].map((t) => [t.id, t])),
    entries: new Map(backend.entries),
  });
});

describe("session state across tasks and hosts", () => {
  it("returns to the task conversation when the docked task changes after opening a subagent", async () => {
    const dispose = registerActions(taskActions);
    try {
      useAgents.setState({ docked: "A" });
      render(<AgentsView />);
      fireEvent.click(screen.getByRole("button", { name: /Explore task A/ }));
      expect(await screen.findByText("Child answer")).toBeInTheDocument();
      expect(screen.queryByRole("textbox", { name: "Message" })).not.toBeInTheDocument();
      fireEvent.mouseDown(within(screen.getByRole("tree", { name: "Agent tasks" })).getByText("B"), { button: 0 });
      expect(await screen.findByText("Answer B")).toBeInTheDocument();
      expect(screen.getByRole("textbox", { name: "Message" })).toBeInTheDocument();
      expect(screen.queryByText("Child answer")).not.toBeInTheDocument();
      expect(
        screen.queryByText("Subagents take their instructions from the agent that started them."),
      ).not.toBeInTheDocument();
      expect(document.querySelector(`.${styles.subagentBar}`)).toBeNull();
    } finally {
      dispose();
    }
  });

  it.each([false, true])("retains scrolling and follow-output (%s) when moving in both directions", async (stick) => {
    // Give jsdom measurable scroll geometry; each host has a different viewport.
    let viewport = 400;
    let height = 2000;
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(() => height);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(() => viewport);
    const tops = new WeakMap<HTMLElement, number>();
    Object.defineProperty(HTMLElement.prototype, "scrollTop", {
      configurable: true,
      get(this: HTMLElement) {
        return tops.get(this) ?? 0;
      },
      set(this: HTMLElement, top: number) {
        tops.set(this, Math.max(0, Math.min(top, height - viewport)));
      },
    });
    const view = render(<SessionEditor input={input("A")} />);
    await screen.findByText("Answer A");
    stream().scrollTop = stick ? height - viewport : 230;
    fireEvent.scroll(stream());
    expect(useAgents.getState().scrollPositions.get("A")).toEqual({ top: stick ? 1600 : 230, stick });
    view.unmount();
    viewport = 150;
    useAgents.setState({ docked: "A" });
    const dock = render(<AgentsView />);
    await screen.findByText("Answer A");
    expect(stream().scrollTop).toBe(stick ? height - viewport : 230);
    height = 2400;
    act(() =>
      useAgents.setState({
        entries: new Map(backend.entries).set("A", [
          ...backend.entries.get("A")!,
          { type: "agent", text: "More output" },
        ]),
      }),
    );
    expect(stream().scrollTop).toBe(stick ? height - viewport : 230);
    dock.unmount();
    viewport = 400;
    useAgents.setState({ docked: null });
    render(<SessionEditor input={input("A")} />);
    await screen.findByText("Answer A");
    expect(stream().scrollTop).toBe(stick ? height - viewport : 230);
  });

  it("keeps task and subagent scroll positions separate", async () => {
    useAgents.getState().scrollPositions.set("A", { top: 120, stick: false });
    useAgents.getState().scrollPositions.set("A/child", { top: 70, stick: false });
    useAgents.getState().scrollPositions.set("B", { top: 340, stick: false });
    const view = render(<SessionEditor input={input("A")} />);
    await screen.findByText("Answer A");
    expect(stream().scrollTop).toBe(120);
    fireEvent.click(screen.getByRole("button", { name: /Explore task A/ }));
    await screen.findByText("Child answer");
    expect(stream().scrollTop).toBe(70);
    view.rerender(<SessionEditor input={input("B")} />);
    await screen.findByText("Answer B");
    expect(stream().scrollTop).toBe(340);
    view.rerender(<SessionEditor input={input("A")} />);
    await screen.findByText("Answer A");
    expect(stream().scrollTop).toBe(120);
  });

  it("restores after entries load and clears positions on project disconnect", async () => {
    useAgents.getState().scrollPositions.set("A", { top: 230, stick: false });
    useAgents.setState({ entries: new Map() });
    render(<SessionEditor input={input("A")} />);
    await waitFor(() => expect(screen.getByText("Answer A")).toBeInTheDocument());
    expect(stream().scrollTop).toBe(230);
    act(() => disconnect());
    expect(useAgents.getState().scrollPositions.size).toBe(0);
  });
});
