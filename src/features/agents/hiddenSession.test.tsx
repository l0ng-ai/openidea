import { Profiler } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import type { AgentEntry, AgentEvent, AgentTask } from "@/bindings";
import { EditorShownProvider } from "@/workbench/contributions";
import { SessionEditor } from "./SessionEditor";
import { SESSION_KIND, sessionKey } from "./model";
import { extractSessionAssets } from "./sessionAssetsModel";
import { caretOf, textOf, typeIn } from "./composerTesting";
import { connect, disconnect, useAgents } from "./store";

const backend = vi.hoisted(() => ({
  channel: null as { onmessage: (event: AgentEvent) => void } | null,
  tasks: [] as AgentTask[],
  entries: [] as AgentEntry[],
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
    agentCommands: async () => ({ status: "ok", data: [] }),
    agentChanges: async () => ({ status: "ok", data: [] }),
    agentGroupedChanges: async () => ({ status: "ok", data: { uncommitted: [], commits: [] } }),
    agentEntries: async () => ({ status: "ok", data: backend.entries }),
    vcsBranchInfo: async () => ({ status: "ok", data: { head: "main" } }),
    vcsRemotes: async () => ({ status: "ok", data: [] }),
  },
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));
vi.mock("@/workbench/contributions", async (original) => ({
  ...(await original<typeof import("@/workbench/contributions")>()),
  editorService: () => ({ closeInput: vi.fn(), openInput: vi.fn(), openTabs: () => [] }),
  toolWindowService: () => ({ show: vi.fn() }),
}));
vi.mock("./sessionAssetsModel", async (original) => {
  const model = await original<typeof import("./sessionAssetsModel")>();
  return { ...model, extractSessionAssets: vi.fn(model.extractSessionAssets) };
});

const TURNS = 30;
const task: AgentTask = {
  id: "one",
  title: "one",
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
const conversation = (): AgentEntry[] =>
  Array.from({ length: TURNS }, (_, i): AgentEntry[] => [
    { type: "user", text: `Question ${i}`, attachments: [], sentMs: null },
    { type: "agent", text: `Answer ${i}` },
  ]).flat();
const LAST = TURNS * 2 - 1;
const input = { kind: SESSION_KIND, key: sessionKey("one"), data: { task: "one" } };

/** One chunk of the reply in flight, through the path the backend's events take. */
let streamed = "Answer 29";
const stream = (chunks: number) => {
  for (let i = 0; i < chunks; i++) {
    const text = ` chunk ${i} of the reply.`;
    act(() =>
      backend.channel!.onmessage({
        type: "append",
        task: "one",
        subagent: null,
        index: LAST,
        from: streamed.length,
        text,
      }),
    );
    streamed += text;
  }
};
const settle = () => act(() => new Promise<void>((done) => setTimeout(done, 250)));

let commits = 0;
const session = (shown: boolean) => (
  <Profiler id="session" onRender={() => commits++}>
    <EditorShownProvider value={shown}>
      <SessionEditor input={input} />
    </EditorShownProvider>
  </Profiler>
);

beforeEach(async () => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  disconnect();
  localStorage.clear();
  backend.tasks = [task];
  backend.entries = conversation();
  streamed = "Answer 29";
  commits = 0;
  vi.mocked(extractSessionAssets).mockClear();
  useAgents.setState({ sessionLocation: "editor" });
  await connect();
});
afterEach(() => {
  disconnect();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a kept-alive session hidden behind another tab", () => {
  it("does no render work while its reply streams", async () => {
    // Freeze the working indicator's clock while counting streamed renders.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const view = render(session(true));
    expect(await screen.findByText("Answer 29")).toBeInTheDocument();
    view.rerender(session(false));
    await settle();
    commits = 0;
    vi.mocked(extractSessionAssets).mockClear();
    const frames = vi.spyOn(window, "requestAnimationFrame");

    stream(20);
    await settle();

    expect({
      commits,
      assetScans: vi.mocked(extractSessionAssets).mock.calls.length,
      revealFrames: frames.mock.calls.length,
    }).toEqual({ commits: 0, assetScans: 0, revealFrames: 0 });
  });

  it("shows the whole reply and the draft at once when it is shown again", async () => {
    const view = render(session(true));
    expect(await screen.findByText("Answer 29")).toBeInTheDocument();
    const message = screen.getByRole("textbox", { name: "Message" });
    typeIn(message, "Draft to keep", 3);
    view.rerender(session(false));

    stream(20);
    await settle();
    expect(screen.queryByText(/chunk 19 of the reply/)).not.toBeInTheDocument();

    view.rerender(session(true));
    // No frame has run: the unseen text isn't paced in.
    expect(screen.getByText(new RegExp(`${streamed}$`.replace(/\./g, "\\.")))).toBeInTheDocument();
    expect(textOf(screen.getByRole("textbox", { name: "Message" }))).toBe("Draft to keep");
    expect(caretOf(screen.getByRole("textbox", { name: "Message" }))).toBe(3);
  });
});
