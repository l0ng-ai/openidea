/**
 * A streamed chunk changes the last message only: the rows of the history above it must
 * not render again, however long the conversation is.
 */
import { act, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEntry, AgentEvent, AgentTask } from "@/bindings";
import { useProject } from "@/platform/project";
import { SessionEditor } from "./SessionEditor";
import { SESSION_KIND, sessionKey } from "./model";
import { connect, disconnect, useAgents } from "./store";

const harness = vi.hoisted(() => ({
  tasks: [] as unknown[],
  /** The agents store only subscribes in the desktop app; nothing else here may take the desktop paths. */
  tauri: false,
  channel: null as null | { onmessage: (event: unknown) => void },
  /** Renders of each agent message by its text, and of each fold by its id. */
  replies: new Map<string, number>(),
  folds: new Map<string, number>(),
}));

vi.mock("@tauri-apps/api/core", async (original) => ({
  ...(await original<typeof import("@tauri-apps/api/core")>()),
  Channel: class {
    onmessage: (event: unknown) => void = () => {};
    constructor() {
      harness.channel = this;
    }
  },
}));
vi.mock("@/platform/ipc", async (original) => ({
  ...(await original<typeof import("@/platform/ipc")>()),
  isTauri: () => harness.tauri,
  commands: {
    agentSubscribe: async () => ({ status: "ok", data: harness.tasks }),
    agentProviders: async () => ({ status: "ok", data: [] }),
    agentEntries: async () => ({ status: "ok", data: [] }),
    agentChanges: async () => ({ status: "ok", data: [] }),
    agentGroupedChanges: async () => ({
      status: "ok",
      data: { uncommitted: [], commits: [] },
    }),
    agentContextUsage: async () => ({
      status: "error",
      error: { kind: "unavailable", message: "none" },
    }),
    vcsBranchInfo: async () => ({ status: "ok", data: { head: "main" } }),
    vcsBranches: async () => ({ status: "ok", data: [] }),
    fsProbe: async () => ({
      status: "ok",
      data: { size: 1, binary: false, tooLarge: false },
    }),
  },
}));
vi.mock("@/workbench/contributions", async (original) => ({
  ...(await original<typeof import("@/workbench/contributions")>()),
  editorService: () => ({ closeInput: vi.fn(), openInput: vi.fn() }),
  maybeEditorService: () => ({ activePath: () => null }),
  toolWindowService: () => ({ show: vi.fn() }),
}));
// Counts renders of what the rows paint. The factories run before the imports bind, hence the dynamic import.
vi.mock("./AgentReply", async (original) => {
  const { createElement } = await import("react");
  const actual = await original<typeof import("./AgentReply")>();
  return {
    ...actual,
    AgentReply: (props: Parameters<typeof actual.AgentReply>[0]) => {
      harness.replies.set(props.text, (harness.replies.get(props.text) ?? 0) + 1);
      return createElement(actual.AgentReply, props);
    },
  };
});
vi.mock("./session/Folds", async (original) => {
  const { createElement } = await import("react");
  const actual = await original<typeof import("./session/Folds")>();
  return {
    ...actual,
    Fold: (props: Parameters<typeof actual.Fold>[0]) => {
      if (props.id) harness.folds.set(props.id, (harness.folds.get(props.id) ?? 0) + 1);
      return createElement(actual.Fold, props);
    },
  };
});

const task: AgentTask = {
  id: "T",
  title: "T",
  provider: "codex",
  status: "running",
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
};
const input = {
  kind: SESSION_KIND,
  key: sessionKey(task.id),
  data: { task: task.id },
};

const user = (text: string): AgentEntry => ({
  type: "user",
  text,
  attachments: [],
  steered: false,
  sentMs: 1000,
  doneMs: 5000,
});

/** Finished turns as agents write them: a question, reasoning, tool calls, a reply. */
function history(turns: number): AgentEntry[] {
  return Array.from({ length: turns }, (_, i): AgentEntry[] => [
    user(`Question ${i}`),
    { type: "thought", text: `Thinking ${i}`, startedMs: 1000 },
    {
      type: "tool",
      id: `read-${i}`,
      title: `Read src/file${i}.ts`,
      kind: "read",
      status: "completed",
      locations: [],
      output: null,
      diffs: [],
      startedMs: 1100,
      endedMs: 1200,
    },
    {
      type: "tool",
      id: `edit-${i}`,
      title: `Edit src/file${i}.ts`,
      kind: "edit",
      status: "completed",
      locations: [],
      output: null,
      diffs: [{ path: `/project/src/file${i}.ts`, added: 2, removed: 1 }],
      startedMs: 1300,
      endedMs: 1400,
    },
    { type: "agent", text: `Reply ${i}` },
  ]).flat();
}

const send = (event: AgentEvent) => act(() => harness.channel!.onmessage(event));

/** Opens a conversation of `turns` finished turns and a new one whose reply starts streaming. */
async function openStreaming(turns: number): Promise<{ stream: (chunks: number) => string; at: number }> {
  const entries = [...history(turns), user("Now?")];
  harness.tasks = [task];
  harness.tauri = true;
  await connect();
  harness.tauri = false;
  useAgents.setState({ entries: new Map([[task.id, entries]]) });
  render(<SessionEditor input={input} />);
  await screen.findByText(`Reply ${turns - 1}`);
  send({
    type: "entry",
    task: task.id,
    subagent: null,
    index: entries.length,
    entry: { type: "agent", text: "" },
  });
  let text = "";
  return {
    /** Index of the streaming reply: what comes next in the conversation follows it. */
    at: entries.length,
    stream(chunks) {
      for (let i = 0; i < chunks; i++) {
        const chunk = `word${i} `;
        send({
          type: "append",
          task: task.id,
          subagent: null,
          index: entries.length,
          from: text.length,
          text: chunk,
        });
        text += chunk;
      }
      return text;
    },
  };
}

beforeEach(() => {
  harness.replies.clear();
  harness.folds.clear();
  harness.channel = null;
  disconnect();
  useProject.setState({ settings: { agents: { smoothText: false } } as never });
});
afterEach(() => {
  disconnect();
  useProject.setState({ settings: null });
});

describe("streaming into a long conversation", () => {
  it.each([
    { turns: 5, foldTurns: true },
    { turns: 40, foldTurns: true },
    { turns: 5, foldTurns: false },
    { turns: 40, foldTurns: false },
  ])(
    "renders none of the $turns earlier turns again for a chunk (fold turns: $foldTurns)",
    async ({ turns, foldTurns }) => {
      useProject.setState({
        settings: { agents: { smoothText: false, foldTurns } } as never,
      });
      const { stream } = await openStreaming(turns);
      // The first chunk opens the streaming message; what follows is the steady state.
      stream(1);
      harness.replies.clear();
      harness.folds.clear();

      const text = stream(20);
      await screen.findByText(/word19$/);

      const renders = (counts: Map<string, number>, keep: (key: string) => boolean) =>
        [...counts].filter(([key]) => keep(key)).map(([key, count]) => `${key}: ${count}`);
      expect({
        earlierReplies: renders(harness.replies, (reply) => reply.startsWith("Reply ")),
        folds: renders(harness.folds, () => true),
      }).toEqual({ earlierReplies: [], folds: [] });
      // The message that grows does render for every chunk: the counters see renders at all.
      expect(harness.replies.get(text)).toBeGreaterThan(0);
    },
  );

  it("still shows what a new turn changes in the turns above it", async () => {
    useProject.setState({ settings: { agents: { smoothText: false, foldTurns: true } } as never });
    const { stream, at } = await openStreaming(3);
    stream(3);
    send({
      type: "entry",
      task: task.id,
      subagent: null,
      index: at + 1,
      entry: {
        type: "tool",
        id: "late",
        title: "Read late.ts",
        kind: "read",
        status: "completed",
        locations: [],
        output: null,
        diffs: [],
      },
    });
    send({
      type: "entry",
      task: task.id,
      subagent: null,
      index: at + 2,
      entry: { type: "agent", text: "Final answer" },
    });
    const copies = () => screen.getAllByRole("button", { name: "Copy Markdown" }).length;
    // The turn in progress has no actions yet; the three before it do, and its work is open.
    expect(copies()).toBe(3);
    expect(harness.folds.has(`turn:${at - 1}`)).toBe(false);

    send({ type: "entry", task: task.id, subagent: null, index: at + 3, entry: user("Next?") });

    // The turn that began mid-stream has ended: its reply has actions and its work is folded.
    expect(copies()).toBe(4);
    expect(harness.folds.has(`turn:${at - 1}`)).toBe(true);
    expect(screen.getByText("Final answer")).toBeInTheDocument();
    expect(screen.getByText("Next?")).toBeInTheDocument();
  });

  it.each([{ foldTurns: true }, { foldTurns: false }])(
    "still shows an earlier edit that arrives while a reply streams (fold turns: $foldTurns)",
    async ({ foldTurns }) => {
      useProject.setState({ settings: { agents: { smoothText: false, foldTurns } } as never });
      const { stream } = await openStreaming(3);
      stream(3);
      const added = () => within(document.body).queryAllByText("+7").length;
      expect(added()).toBe(0);

      // Turn 1's edit (index 8) is rewritten, and so is the reply of turn 2 (index 14).
      send({
        type: "entry",
        task: task.id,
        subagent: null,
        index: 8,
        entry: {
          type: "tool",
          id: "edit-1",
          title: "Edit src/file1.ts",
          kind: "edit",
          status: "completed",
          locations: [],
          output: null,
          diffs: [{ path: "/project/src/file1.ts", added: 7, removed: 1 }],
        },
      });
      send({
        type: "entry",
        task: task.id,
        subagent: null,
        index: 14,
        entry: { type: "agent", text: "Reply 2, revised" },
      });

      expect(await screen.findByText("Reply 2, revised")).toBeInTheDocument();
      expect(added()).toBe(1);
      expect(screen.getByText("Reply 1")).toBeInTheDocument();
    },
  );
});
