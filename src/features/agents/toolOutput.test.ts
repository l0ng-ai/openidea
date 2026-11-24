import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEntry, AgentEvent, AgentTask } from "@/bindings";
import { deferred } from "@/test/deferred";
import { entriesKey } from "./model";
import { connect, disconnect, loadEntries, useAgents } from "./store";

const backend = vi.hoisted(() => ({
  channel: null as { onmessage: (event: AgentEvent) => void } | null,
  entries: vi.fn(),
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
      return { status: "ok", data: [task] };
    },
    agentProviders: async () => ({ status: "ok", data: [] }),
    agentEntries: async () => ({ status: "ok", data: await backend.entries() }),
  },
}));

vi.mock("@/workbench/contributions", async (original) => ({
  ...(await original<typeof import("@/workbench/contributions")>()),
  editorService: () => ({ openTabs: () => [] }),
}));

const task: AgentTask = {
  id: "one",
  title: "one",
  status: "running",
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
};
const call = (output: string | null, status: "running" | "completed" = "running"): AgentEntry => ({
  type: "tool",
  id: "build",
  title: "cargo build",
  kind: "execute",
  status,
  locations: [],
  output,
  diffs: [],
  startedMs: 1,
  endedMs: null,
});
const emit = (event: AgentEvent) => backend.channel!.onmessage(event);
const entry = (index: number, e: AgentEntry): AgentEvent => ({
  type: "entry",
  task: "one",
  subagent: null,
  index,
  entry: e,
});
const more = (index: number, from: number, text: string): AgentEvent => ({
  type: "toolOutput",
  task: "one",
  subagent: null,
  index,
  from,
  text,
});
const shown = () => useAgents.getState().entries.get(entriesKey("one", null));
const output = () => {
  const tool = shown()?.[1];
  return tool?.type === "tool" ? tool.output : undefined;
};

beforeEach(async () => {
  disconnect();
  backend.entries.mockReset();
  backend.entries.mockResolvedValue([{ type: "user", text: "build it", attachments: [] }]);
  await connect();
  await loadEntries("one");
});

describe("a running tool's output", () => {
  it("grows by what each event adds, and the last entry settles it", () => {
    emit(entry(1, call("$ cargo build")));
    emit(more(1, 13, "\nCompiling é"));
    emit(more(1, 25, " 👋\nDone"));
    expect(shown()![1]).toEqual(call("$ cargo build\nCompiling é 👋\nDone"));
    emit(entry(1, call("$ cargo build\nCompiling é 👋\nDone\n", "completed")));
    expect(shown()![1]).toEqual(call("$ cargo build\nCompiling é 👋\nDone\n", "completed"));
  });

  it("starts from nothing when the call had no output yet", () => {
    emit(entry(1, call(null)));
    emit(more(1, 0, "first"));
    expect(output()).toBe("first");
  });

  it("takes text it already holds once, and loads the conversation again when it misses some", async () => {
    emit(entry(1, call("abc")));
    emit(more(1, 0, "abc"));
    expect(output()).toBe("abc");
    backend.entries.mockResolvedValue([{ type: "user", text: "build it", attachments: [] }, call("abcdef")]);
    emit(more(1, 5, "g"));
    await vi.waitFor(() => expect(output()).toBe("abcdef"));
    expect(backend.entries).toHaveBeenCalledTimes(2);
  });

  it("lands on a copy that loads while the output streams", async () => {
    const read = deferred<AgentEntry[]>();
    backend.entries.mockReturnValue(read.promise);
    useAgents.setState({ entries: new Map(), entryLoads: new Map() });
    const loading = loadEntries("one");
    emit(more(1, 3, "def"));
    emit(more(1, 6, "ghi"));
    read.resolve([{ type: "user", text: "build it", attachments: [] }, call("abcdef")]);
    await loading;
    expect(output()).toBe("abcdefghi");
  });
});
