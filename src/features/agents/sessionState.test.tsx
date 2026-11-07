import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { registerActions } from "@/platform/actions";
import { useProject } from "@/platform/project";
import { EditorShownProvider } from "@/workbench/contributions";
import type { AgentChange, AgentEntry, AgentTask } from "@/bindings";
import { AgentsView } from "./AgentsView";
import { SessionEditor, conversationRows } from "./SessionEditor";
import { entriesKey, SESSION_KIND, sessionKey, type SubagentEntry } from "./model";
import { disconnect, useAgents } from "./store";
import { taskActions } from "./taskActions";
import { replyActions } from "./replyActions";
import styles from "./Session.module.css";
import tagStyles from "@/ui/InlineTag.module.css";

const backend = vi.hoisted(() => ({
  entries: new Map<string, AgentEntry[]>(),
  changes: [] as AgentChange[],
  answers: [] as Array<[string, number, string | null]>,
  fetched: [] as string[],
}));
vi.mock("@/platform/ipc", async (original) => ({
  ...(await original<typeof import("@/platform/ipc")>()),
  commands: {
    agentEntries: async (id: string, sub: string | null) => {
      const key = sub ? `${id}/${sub}` : id;
      backend.fetched.push(key);
      return { status: "ok", data: backend.entries.get(key) ?? [] };
    },
    agentChanges: async () => ({ status: "ok", data: backend.changes }),
    vcsBranchInfo: async () => ({ status: "ok", data: { head: "main" } }),
    agentRespond: async (task: string, permission: number, option: string | null) => {
      backend.answers.push([task, permission, option]);
      return { status: "ok", data: null };
    },
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
const tool = (id: string, overrides: Partial<Extract<AgentEntry, { type: "tool" }>> = {}): AgentEntry => ({
  type: "tool",
  id,
  title: id,
  kind: "read",
  status: "completed",
  locations: [],
  output: null,
  diffs: [],
  ...overrides,
});

let disposeActions: () => void;
const scrollTopDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTop");
afterEach(() => {
  disposeActions();
  vi.restoreAllMocks();
  if (scrollTopDescriptor) Object.defineProperty(HTMLElement.prototype, "scrollTop", scrollTopDescriptor);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollTop");
});

beforeEach(() => {
  disposeActions = registerActions(replyActions);
  disconnect();
  localStorage.clear();
  backend.changes = [];
  backend.entries = new Map([
    ["A", [{ type: "agent", text: "Answer A" }, subagent]],
    [entriesKey("A", "child"), [{ type: "agent", text: "Child answer" }]],
    ["B", [{ type: "agent", text: "Answer B" }]],
  ]);
  useAgents.setState({
    loaded: true,
    sessionLocation: "editor",
    homeOpen: false,
    tasks: new Map([task("A"), task("B")].map((t) => [t.id, t])),
    entries: new Map(backend.entries),
  });
});

describe("conversation rows", () => {
  it("builds only the requested tail, with absolute indexes", () => {
    const entries = Array.from({ length: 45 }, (_, i) => ({ type: "agent", text: `reply ${i}` }) as AgentEntry);
    const rows = conversationRows(entries, 40);
    expect(rows).toHaveLength(5);
    expect(rows.map((row) => row.index)).toEqual([40, 41, 42, 43, 44]);
  });
});

describe("process folding", () => {
  it("folds reasoning and tool calls into one block", async () => {
    backend.entries.set("A", [
      { type: "thought", text: "think one" },
      tool("one"),
      { type: "thought", text: "think two" },
      tool("two"),
      { type: "agent", text: "Answer A" },
    ]);
    useAgents.setState({ entries: new Map(backend.entries) });
    render(<SessionEditor input={input("A")} />);
    const summary = await screen.findByText("Reasoning · 2 tool calls");
    expect(summary.closest("details")!.open).toBe(false);
    expect(screen.getByText("think one")).toBeInTheDocument();
  });
});

describe("message tags", () => {
  it("shows file references and skills as distinct tags", async () => {
    backend.entries.set("A", [
      {
        type: "user",
        text: "fix @src/a.ts and run /triage",
        attachments: ["a.ts"],
        images: [],
        sentMs: 1,
        doneMs: 2,
        steered: false,
      },
    ]);
    useAgents.setState({ entries: new Map(backend.entries) });
    render(<SessionEditor input={input("A")} />);
    expect(await screen.findByText("@src/a.ts")).toHaveClass(tagStyles.tag!);
    expect(screen.getByText("/triage")).toHaveClass(tagStyles.accent!);
  });
});

describe("scrolling", () => {
  it("hides Jump to Latest and follows new replies after retracting the conversation", async () => {
    render(<SessionEditor input={input("A")} />);
    const el = stream();
    let height = 1000;
    Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => height });
    Object.defineProperty(el, "clientHeight", { configurable: true, value: 400 });
    el.scrollTop = 100;
    fireEvent.scroll(el);
    expect(screen.getByRole("button", { name: "Jump to Latest" })).toBeInTheDocument();
    height = 400;
    act(() => useAgents.setState({ entries: new Map([["A", []]]) }));
    expect(screen.queryByRole("button", { name: "Jump to Latest" })).toBeNull();
    height = 1400;
    act(() => useAgents.setState({ entries: new Map([["A", [{ type: "agent", text: "New reply" }]]]) }));
    expect(el.scrollTop).toBe(1400);
    expect(screen.queryByRole("button", { name: "Jump to Latest" })).toBeNull();
  });

  it("defers prepending during a pointer drag and preserves the first row's viewport position", async () => {
    const entries = Array.from({ length: 90 }, (_, i): AgentEntry => ({ type: "agent", text: `History ${i}` }));
    useAgents.setState({ entries: new Map([["A", entries]]) });
    // Mount hidden so the initial batch hasn't yet restored the bottom offset.
    const view = render(
      <EditorShownProvider value={false}>
        <SessionEditor input={input("A")} />
      </EditorShownProvider>,
    );
    const el = stream();
    Object.defineProperty(el, "scrollHeight", { configurable: true, value: 3000 });
    Object.defineProperty(el, "clientHeight", { configurable: true, value: 400 });
    // Give the conversation a new tail while the scrollbar is held.
    fireEvent.pointerDown(el);
    act(() =>
      useAgents.setState({
        entries: new Map([["A", [...entries, ...entries.map((e, i) => ({ ...e, text: `New ${i}` }))]]]),
      }),
    );
    el.scrollTop = 20;
    fireEvent.scroll(el);
    const count = el.children.length;
    const first = el.firstElementChild!;
    const top = vi.spyOn(first, "getBoundingClientRect");
    top.mockReturnValue({ top: 100 } as DOMRect);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 180));
    });
    expect(el.children.length).toBe(count);
    // Its old top is measured at release, then shifts down when rows are inserted.
    top.mockReturnValueOnce({ top: 100 } as DOMRect).mockReturnValue({ top: 500 } as DOMRect);
    fireEvent.pointerUp(window);
    await waitFor(() => expect(el.children.length).toBeGreaterThan(count));
    expect(el.scrollTop).toBe(420);
    view.unmount();
  });

  it("offers one click back to the latest message after scrolling up", async () => {
    render(<SessionEditor input={input("A")} />);
    expect(await screen.findByText("Answer A")).toBeInTheDocument();
    const el = stream();
    Object.defineProperty(el, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(el, "clientHeight", { configurable: true, value: 400 });
    el.scrollTop = 100;
    fireEvent.scroll(el);
    const jump = await screen.findByRole("button", { name: "Jump to Latest" });
    Object.defineProperty(el, "scrollTo", { configurable: true, value: vi.fn() });
    fireEvent.click(jump);
    expect(el.scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: "smooth" });
    expect(screen.queryByRole("button", { name: "Jump to Latest" })).toBeNull();
  });
});

describe("tool calls", () => {
  it.each(["pending", "running"] as const)(
    "keeps %s tools outside folds with their output expanded",
    async (status) => {
      backend.entries.set("A", [
        tool("done one"),
        tool("done two"),
        tool("live", { status, output: "Reading files…" }),
      ]);
      useAgents.setState({ entries: new Map(backend.entries) });
      render(<SessionEditor input={input("A")} />);
      const output = await screen.findByText("Reading files…");
      expect(output.closest("details")!.open).toBe(true);
      expect(output.closest(`.${styles.processRun}`)).toBeNull();
      expect(screen.getByText("2 tool calls").closest("details")!.open).toBe(false);
    },
  );

  it("folds consecutive finished tool calls into one collapsed row", async () => {
    const edit = (id: string) => tool(id, { kind: "edit", diffs: [{ path: "/project/a.ts", added: 2, removed: 1 }] });
    backend.entries.set("A", [edit("one"), edit("two"), { type: "agent", text: "Answer A" }]);
    useAgents.setState({ entries: new Map(backend.entries) });
    render(<SessionEditor input={input("A")} />);
    const summary = await screen.findByText("2 tool calls");
    expect(summary.closest("details")!.open).toBe(false);
    expect(screen.getByText("+4")).toBeInTheDocument();
    expect(screen.getByText("−2")).toBeInTheDocument();
  });
});

describe("a pending question", () => {
  it("shows the whole question in the banner, with every answer, and sends the chosen one", async () => {
    const question =
      'Scenario 4 ("follows the TR") still leaves the "About your request" section empty after two rewrites.\nHow should we continue?';
    const entries: AgentEntry[] = [
      {
        type: "permission",
        id: 7,
        title: question,
        options: [
          { id: "a", name: "Ship it as is and record it (Recommended)", kind: "allow_once" },
          { id: "b", name: "Detect the request in code", kind: "allow_once" },
          { id: "c", name: "Skip", kind: "reject_once" },
        ],
        chosen: null,
      },
    ];
    backend.entries.set("A", entries);
    backend.answers = [];
    useAgents.setState({ entries: new Map(backend.entries) });
    render(<SessionEditor input={input("A")} />);
    const banner = await screen.findByRole("alert", { name: question });
    expect(banner.querySelector(`.${styles.bannerText}`)?.textContent).toBe(question);
    const answers = within(banner.querySelector<HTMLElement>(`.${styles.bannerActions}`)!).getAllByRole("button");
    expect(answers.map((b) => b.textContent)).toEqual([
      "Ship it as is and record it (Recommended)",
      "Detect the request in code",
      "Skip",
    ]);
    fireEvent.click(answers[1]!);
    await waitFor(() => expect(backend.answers).toEqual([["A", 7, "b"]]));
  });
});

describe("a pending AskUserQuestion", () => {
  it("keeps separate answers for Codex question ids with identical wording", async () => {
    backend.entries.set("A", [
      {
        type: "permission",
        id: 11,
        title: "Which?",
        chosen: null,
        options: [],
        questions: ["first", "second"].map((answerKey, index) => ({
          answerKey,
          header: answerKey,
          question: "Which?",
          multiSelect: false,
          options: [{ label: index === 0 ? "One" : "Two", description: "", preview: null }],
        })),
      },
    ]);
    backend.answers = [];
    useAgents.setState({ entries: new Map(backend.entries) });
    render(<SessionEditor input={input("A")} />);
    const card = await screen.findByRole("form", { name: "Which?" });
    fireEvent.click(within(card).getByRole("radio", { name: /^One/ }));
    fireEvent.click(within(card).getByRole("radio", { name: /^Two/ }));
    fireEvent.click(within(card).getByRole("button", { name: "Submit" }));
    await waitFor(() =>
      expect(backend.answers).toEqual([["A", 11, JSON.stringify({ first: ["One"], second: ["Two"] })]]),
    );
  });

  it("shows every question with its descriptions in a card and sends all answers at once", async () => {
    backend.entries.set("A", [
      {
        type: "permission",
        id: 9,
        title: "Which layout?",
        options: [{ id: "reject", name: "Skip", kind: "reject_once" }],
        questions: [
          {
            header: "Layout",
            question: "Which layout?",
            multiSelect: false,
            options: [
              { label: "Table (Recommended)", description: "One row per check", preview: null },
              { label: "List", description: "Grouped under headings", preview: null },
            ],
          },
          {
            header: "Checks",
            question: "Which checks?",
            multiSelect: true,
            options: [
              { label: "Disk", description: "", preview: null },
              { label: "Updates", description: "", preview: null },
            ],
          },
        ],
        chosen: null,
      },
    ]);
    backend.answers = [];
    useAgents.setState({ entries: new Map(backend.entries) });
    render(<SessionEditor input={input("A")} />);
    const card = await screen.findByRole("form", { name: "Which layout?" });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(within(card).getByText("One row per check")).toBeTruthy();
    expect(within(card).getByText("Recommended")).toBeTruthy();
    const submit = within(card).getByRole("button", { name: "Submit" });
    fireEvent.click(within(card).getByRole("radio", { name: /^List/ }));
    expect(submit).toHaveProperty("disabled", true);
    fireEvent.click(within(card).getByRole("checkbox", { name: /^Disk/ }));
    const others = within(card).getAllByRole("checkbox", { name: /^Other/ });
    fireEvent.click(others[0]!);
    expect(submit).toHaveProperty("disabled", true);
    fireEvent.change(within(card).getByPlaceholderText("Type your answer"), { target: { value: "GPU temps" } });
    fireEvent.click(submit);
    await waitFor(() =>
      expect(backend.answers).toEqual([
        ["A", 9, JSON.stringify({ "Which layout?": ["List"], "Which checks?": ["Disk", "GPU temps"] })],
      ]),
    );
  });

  it("picks options with number keys, previews the picked or hovered one, and skips with Escape", async () => {
    backend.entries.set("A", [
      {
        type: "permission",
        id: 10,
        title: "Which layout?",
        options: [{ id: "reject", name: "Skip", kind: "reject_once" }],
        questions: [
          {
            header: "",
            question: "Which layout?",
            multiSelect: false,
            options: [
              { label: "Table", description: "", preview: "| a | b |" },
              { label: "List", description: "", preview: null },
            ],
          },
        ],
        chosen: null,
      },
    ]);
    backend.answers = [];
    useAgents.setState({ entries: new Map(backend.entries) });
    render(<SessionEditor input={input("A")} />);
    const card = await screen.findByRole("form", { name: "Which layout?" });
    const table = within(card).getByRole("radio", { name: /^Table/ });
    const list = within(card).getByRole("radio", { name: /^List/ });
    fireEvent.focus(table);
    fireEvent.keyDown(table, { key: "2" });
    expect(list).toHaveProperty("checked", true);
    const shown = () => card.querySelector<HTMLElement>(`.${styles.questionPreviewActive}`)!;
    const caption = () => shown().querySelector(`.${styles.questionPreviewCaption}`)?.textContent;
    expect(card.querySelectorAll(`.${styles.questionPreviewActive}`)).toHaveLength(1);
    expect(caption()).toBe("List");
    expect(within(shown()).getByText("No preview")).toBeTruthy();
    expect(within(shown()).queryByText("| a | b |")).toBeNull();
    fireEvent.mouseEnter(table.closest("label")!.parentElement!);
    expect(caption()).toBe("Table");
    expect(within(shown()).getByText("| a | b |")).toBeTruthy();
    fireEvent.mouseLeave(table.closest("label")!.parentElement!);
    fireEvent.keyDown(table, { key: "3" });
    expect(caption()).toBe("Other");
    expect(within(shown()).queryByText("| a | b |")).toBeNull();
    fireEvent.keyDown(table, { key: "Escape" });
    await waitFor(() => expect(backend.answers).toEqual([["A", 10, "reject"]]));
  });
});

describe("a pending permission request in the conversation", () => {
  it("is answered from its line too, and one without options can be cancelled", async () => {
    backend.entries.set("A", [
      {
        type: "permission",
        id: 3,
        title: "ls d:/project",
        options: [
          { id: "once", name: "Allow once", kind: "allow_once" },
          { id: "reject", name: "Reject", kind: "reject_once" },
        ],
        chosen: null,
      },
    ]);
    backend.entries.set("B", [
      { type: "permission", id: 4, title: "The agent asks for permission", options: [], chosen: null },
    ]);
    backend.answers = [];
    useAgents.setState({ entries: new Map(backend.entries) });
    const { unmount } = render(<SessionEditor input={input("A")} />);
    const line = (await screen.findAllByText("ls d:/project")).find((e) =>
      e.classList.contains(styles.permissionTitle!),
    )!.parentElement!;
    const answers = within(line.querySelector<HTMLElement>(`.${styles.permissionAnswers}`)!).getAllByRole("button");
    expect(answers.map((b) => b.textContent)).toEqual(["Allow once", "Reject"]);
    fireEvent.click(answers[0]!);
    await waitFor(() => expect(backend.answers).toEqual([["A", 3, "once"]]));
    unmount();

    render(<SessionEditor input={input("B")} />);
    const banner = await screen.findByRole("alert", { name: "The agent asks for permission" });
    fireEvent.click(within(banner).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(backend.answers).toEqual([
        ["A", 3, "once"],
        ["B", 4, null],
      ]),
    );
  });
});

describe("session state across tasks and hosts", () => {
  it("leaves a task unread while its kept-alive tab is hidden, and reads it once shown", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    useAgents.setState({ unread: new Set(["A"]) });
    const session = (shown: boolean) => (
      <EditorShownProvider value={shown}>
        <SessionEditor input={input("A")} />
      </EditorShownProvider>
    );
    const { rerender } = render(session(false));
    expect(useAgents.getState().unread.has("A")).toBe(true);
    rerender(session(true));
    expect(useAgents.getState().unread.has("A")).toBe(false);
  });

  it("fetches a conversation once and shows it again from the store when its tab reopens", async () => {
    const entries = new Map(useAgents.getState().entries);
    entries.delete("A");
    useAgents.setState({ entries });
    backend.fetched = [];
    const first = render(<SessionEditor input={input("A")} />);
    expect(await screen.findByText("Answer A")).toBeInTheDocument();
    first.unmount();
    render(<SessionEditor input={input("A")} />);
    expect(screen.getByText("Answer A")).toBeInTheDocument();
    await act(async () => {});
    expect(backend.fetched).toEqual(["A"]);
  });

  it("opens a long conversation at its end and renders the earlier entries after it", async () => {
    const entries = Array.from({ length: 150 }, (_, i): AgentEntry => ({ type: "agent", text: `Reply ${i}` }));
    useAgents.setState({ entries: new Map(useAgents.getState().entries).set("A", entries) });
    render(<SessionEditor input={input("A")} />);
    expect(screen.getByText("Reply 149")).toBeInTheDocument();
    expect(await screen.findByText("Reply 0")).toBeInTheDocument();
    expect(stream().children).toHaveLength(150);
  });

  it("returns to the task conversation when the docked task changes after opening a subagent", async () => {
    const dispose = registerActions(taskActions);
    try {
      useAgents.setState({ docked: "A", sessionLocation: "toolWindow" });
      render(<AgentsView />);
      fireEvent.click(screen.getByRole("button", { name: /Explore task A/ }));
      expect(await screen.findByText("Child answer")).toBeInTheDocument();
      expect(screen.queryByRole("textbox", { name: "Message" })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Agent sessions" }));
      fireEvent.click(within(screen.getByRole("tree", { name: "Agent tasks" })).getByText("B"));
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

  it("keeps docked changes opt-in, preserves the draft, and returns to the same conversation", async () => {
    backend.changes = [
      {
        path: "/project/very-long-file-name.ts",
        relPath: "very-long-file-name.ts",
        kind: "modified",
        added: 8,
        removed: 2,
      },
    ];
    localStorage.setItem("openidea.agents.changesOpen.v1", JSON.stringify({ A: true }));
    useAgents.setState({ docked: "A", sessionLocation: "toolWindow" });
    render(<AgentsView />);
    await screen.findByText("Answer A");
    await waitFor(() => expect(screen.getByRole("button", { name: "Show changes" })).toBeEnabled());
    expect(screen.queryByRole("complementary", { name: "Changes" })).toBeNull();
    const markVisible = vi.spyOn(await import("./store"), "markVisible");
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const message = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(message, { target: { value: "Draft to keep" } });
    const conversation = stream();
    fireEvent.click(screen.getByRole("button", { name: "Show changes" }));
    expect(screen.getByRole("complementary", { name: "Changes" })).toBeVisible();
    expect(screen.getByText("Answer A")).not.toBeVisible();
    expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull();
    act(() => useAgents.setState({ unread: new Set(["A"]) }));
    fireEvent(window, new Event("focus"));
    expect(useAgents.getState().unread.has("A")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Back to conversation" }));
    expect(screen.getByText("Answer A")).toBeVisible();
    expect(stream()).toBe(conversation);
    expect(markVisible).toHaveBeenCalledWith("A");
    expect(useAgents.getState().unread.has("A")).toBe(false);
    expect(screen.getByRole("textbox", { name: "Message" })).toBe(message);
    expect(message).toHaveValue("Draft to keep");
    expect(useAgents.getState().composers.get("A")?.text).toBe("Draft to keep");
    expect(JSON.parse(localStorage.getItem("openidea.agents.changesOpen.v1")!).A).toBe(true);
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
    useAgents.setState({ docked: "A", sessionLocation: "toolWindow" });
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

describe("meters in the task header", () => {
  afterEach(() => {
    useProject.setState({ settings: null });
    useAgents.setState({ limits: new Map() });
  });

  it("shows the provider's usage limits by default and each meter as Settings › Tools › Agents › Chat allows", async () => {
    const reported: AgentTask = {
      ...task("A"),
      usage: { used: 24_000, size: 200_000, cost: { amount: 0.42, currency: "USD" } },
    };
    const limits = [
      { window: "five_hour", usedPercent: 19, resetsMs: null },
      { window: "seven_day", usedPercent: 9.4, resetsMs: null },
    ];
    useAgents.setState({ tasks: new Map([["A", reported]]), limits: new Map([["codex", limits]]) });
    render(<SessionEditor input={input("A")} />);
    await screen.findByText("Answer A");
    expect(screen.getByText("12%")).toBeInTheDocument();
    expect(screen.getByText("5h 19%")).toBeInTheDocument();
    expect(screen.getByText("7d 9%")).toBeInTheDocument();
    expect(screen.queryByText("$0.42")).toBeNull();
    act(() =>
      useProject.setState({
        settings: { agents: { showContextUsage: false, showUsageLimits: false, showCost: true } },
      }),
    );
    expect(screen.queryByText("12%")).toBeNull();
    expect(screen.queryByText("5h 19%")).toBeNull();
    expect(screen.getByText("$0.42")).toBeInTheDocument();
  });
});
