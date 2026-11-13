import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { AgentEntry, AgentTask } from "@/bindings";

const ipc = vi.hoisted(() => ({ entries: vi.fn() }));
vi.mock("@/platform/ipc", async (original) => ({
  ...(await original<typeof import("@/platform/ipc")>()),
  commands: {
    agentEntries: ipc.entries,
    agentChanges: async () => ({ status: "ok", data: [] }),
    agentGroupedChanges: async () => ({ status: "ok", data: { uncommitted: [], commits: [] } }),
    vcsBranchInfo: async () => ({ status: "ok", data: { head: "main" } }),
  },
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));

const mermaid = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }));
vi.mock("mermaid", () => ({ default: { initialize: mermaid.initialize, render: mermaid.render } }));

import { SessionEditor } from "./SessionEditor";
import { resetMermaidForTests } from "../viewers/markdown/mermaid";
import { useAgents } from "./store";

const entries: AgentEntry[] = [{ type: "agent", text: "```mermaid\nflowchart TD\n    A-->B\n```" }];

const task: AgentTask = {
  id: "mermaid",
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
  resetMermaidForTests();
  ipc.entries.mockReset().mockResolvedValue({ status: "ok", data: entries });
  useAgents.setState({
    loaded: true,
    tasks: new Map([[task.id, task]]),
    entries: new Map(),
    composers: new Map(),
    focus: null,
  });
});

it("redraws a diagram when the theme changes", async () => {
  mermaid.render.mockReset().mockResolvedValue({ svg: `<svg id="x"><style>#x .actor{fill:none}</style></svg>` });
  const root = document.documentElement;
  const previous = root.dataset.theme;
  try {
    const { container } = render(
      <SessionEditor input={{ kind: "agent-session", key: task.id, data: { task: task.id } }} />,
    );
    await waitFor(() => {
      const block = container.querySelector("[data-mermaid]");
      expect(block).toHaveAttribute("data-mermaid-state", "ok");
    });
    expect(mermaid.render).toHaveBeenCalledTimes(1);

    root.dataset.theme = previous === "dark" ? "light" : "dark";
    await waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(2));
  } finally {
    if (previous === undefined) delete root.dataset.theme;
    else root.dataset.theme = previous;
  }
});

it.each([false, true])("preserves scroll ownership when a diagram finishes (away: %s)", async (away) => {
  // The diagram is still rendering when the conversation arrives at its end.
  let draw!: () => void;
  mermaid.render.mockReset().mockImplementation(
    (id: string) =>
      new Promise<{ svg: string }>((resolve) => {
        draw = () => resolve({ svg: `<svg id="${id}"><text>flowchart TD</text></svg>` });
      }),
  );
  const { container } = render(
    <SessionEditor input={{ kind: "agent-session", key: task.id, data: { task: task.id } }} />,
  );
  const block = await waitFor(() => {
    const el = container.querySelector("[data-mermaid]");
    expect(el).not.toBeNull();
    return el as HTMLElement;
  });
  // The stream holds the conversation at the end (the default when no offset was kept).
  const scroller = block.closest<HTMLElement>("div[tabindex='-1']")!;
  Object.defineProperty(scroller, "scrollHeight", { value: 1000, configurable: true });
  expect(scroller.scrollTop).toBe(0);
  if (away) {
    Object.defineProperty(scroller, "clientHeight", { value: 400, configurable: true });
    scroller.scrollTop = 600;
    fireEvent.scroll(scroller);
    fireEvent.wheel(scroller, { deltaY: -4 });
    scroller.scrollTop = 588;
    fireEvent.scroll(scroller);
  }
  // The draw lands after the last streamed chunk: the viewport must follow it.
  await act(async () => draw());
  await waitFor(() => expect(block).toHaveAttribute("data-mermaid-state", "ok"));
  expect(scroller.scrollTop).toBe(away ? 588 : 1000);
});
