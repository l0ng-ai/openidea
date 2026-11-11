import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { registerActions } from "@/platform/actions";
import { useProject } from "@/platform/project";
import { EditorShownProvider } from "@/workbench/contributions";
import { hideContextMenu, useContextMenuStore } from "@/ui";
import type { AgentChange, AgentEntry, AgentTask } from "@/bindings";
import { AgentsView } from "./AgentsView";
import { SessionEditor, conversationRows } from "./SessionEditor";
import { entriesKey, SESSION_KIND, sessionKey, type SubagentEntry } from "./model";
import { disconnect, useAgents } from "./store";
import { taskActions } from "./taskActions";
import { replyActions } from "./replyActions";
import { focusedSession } from "./sessionFocus";
import styles from "./Session.module.css";
import tagStyles from "@/ui/InlineTag.module.css";

const backend = vi.hoisted(() => ({
  entries: new Map<string, AgentEntry[]>(),
  changes: [] as AgentChange[],
  answers: [] as Array<[string, number, string | null]>,
  fetched: [] as string[],
  entryError: null as string | null,
  entryWait: null as Promise<void> | null,
  external: [] as Array<{
    provider: string;
    sessionId: string;
    title: string;
    cwd: string | null;
    updatedMs: number;
  }>,
  imported: [] as Array<[string, string]>,
  externalError: null as string | null,
}));
vi.mock("@/platform/ipc", async (original) => ({
  ...(await original<typeof import("@/platform/ipc")>()),
  commands: {
    agentEntries: async (id: string, sub: string | null) => {
      const key = sub ? `${id}/${sub}` : id;
      backend.fetched.push(key);
      await backend.entryWait;
      if (backend.entryError !== null)
        return { status: "error", error: { kind: "unavailable", message: backend.entryError } };
      return { status: "ok", data: backend.entries.get(key) ?? [] };
    },
    agentChanges: async () => ({ status: "ok", data: backend.changes }),
    vcsBranchInfo: async () => ({ status: "ok", data: { head: "main" } }),
    agentRespond: async (task: string, permission: number, option: string | null) => {
      backend.answers.push([task, permission, option]);
      return { status: "ok", data: null };
    },
    agentExternalSessions: async () => {
      if (backend.externalError !== null) throw new Error(backend.externalError);
      return { status: "ok", data: backend.external };
    },
    agentImportSession: async (provider: string, sessionId: string) => {
      backend.imported.push([provider, sessionId]);
      const found = backend.external.find((e) => e.provider === provider && e.sessionId === sessionId);
      if (!found) throw new Error("unknown session");
      return { status: "ok", data: { ...task("imported"), id: "imported", title: found.title, provider } };
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
  hideContextMenu();
  vi.restoreAllMocks();
  vi.useRealTimers();
  if (scrollTopDescriptor) Object.defineProperty(HTMLElement.prototype, "scrollTop", scrollTopDescriptor);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollTop");
});

beforeEach(() => {
  disposeActions = registerActions([...replyActions, ...taskActions]);
  useProject.setState({ settings: null });
  backend.entryError = null;
  backend.entryWait = null;
  disconnect();
  localStorage.clear();
  backend.changes = [];
  backend.external = [];
  backend.imported = [];
  backend.externalError = null;
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
    external: [],
    externalError: null,
  });
});

describe("conversation rows", () => {
  it("keeps authors above messages and their folded work with matching icon-only actions", async () => {
    useProject.setState({ settings: { agents: { foldTurns: false } } as never });
    const user = (text: string): AgentEntry => ({
      type: "user",
      text,
      attachments: [],
      steered: false,
      sentMs: null,
      doneMs: null,
    });
    backend.entries.set("A", [
      user("First question"),
      { type: "agent", text: "First reply" },
      tool("read"),
      { type: "agent", text: "More detail" },
      user("Next question"),
      { type: "thought", text: "Considering the next question" },
      tool("next"),
      { type: "agent", text: "Next reply" },
    ]);
    useAgents.setState({ entries: new Map(backend.entries) });
    render(<SessionEditor input={input("A")} />);
    await screen.findByText("More detail");
    expect(stream().querySelectorAll(`.${styles.agentAuthor} .${styles.role}`)).toHaveLength(2);
    const author = stream().querySelectorAll(`.${styles.agentAuthor}`)[1]!;
    expect(author.nextElementSibling).toHaveClass(styles.processRun!);
    expect(author.parentElement?.nextElementSibling?.firstElementChild).toHaveClass(styles.agentMessage!);
    const quote = within(stream()).getAllByRole("button", { name: "Quote Reply" });
    const copy = within(stream()).getAllByRole("button", { name: "Copy Markdown" });
    // One per turn: only a turn's final reply carries actions.
    expect(quote).toHaveLength(2);
    for (const button of [...quote, ...copy]) {
      expect(button.textContent).toBe("");
      expect(button.querySelector("svg path")).not.toBeNull();
      expect(button.parentElement).toHaveClass(styles.messageActions!);
    }
    expect(stream()).not.toHaveTextContent("66");
    expect(quote[0]?.className).toBe(copy[0]?.className);
    expect(within(stream()).getAllByRole("button", { name: "Copy" })[0]?.className).toBe(copy[0]?.className);
  });

  it.each([null, "allow"])("keeps tool, reasoning, plan and approval rows in one author run (%s)", async (chosen) => {
    backend.entries.set("A", [
      { type: "agent", text: "I’ll read package.json…" },
      tool("one"),
      tool("two"),
      { type: "agent", text: "More detail" },
      tool("List .", { status: "running" }),
      { type: "permission", id: 1, title: "Run python3", options: [], chosen },
      { type: "plan", items: [{ content: "Check files", status: "in_progress" }] },
      { type: "thought", text: "Consider the result" },
      { type: "agent", text: "Done" },
    ]);
    useAgents.setState({ entries: new Map(backend.entries) });
    render(<SessionEditor input={input("A")} />);
    await screen.findByText("Done");
    expect(stream().querySelectorAll(`.${styles.agentAuthor}`)).toHaveLength(1);
    expect(stream().firstElementChild?.firstElementChild).toHaveClass(styles.agentAuthor!);
  });

  it.each<AgentEntry>([subagent, { type: "message", incoming: true, text: "Parent request" }])(
    "starts another author run after $type entries",
    async (other) => {
      backend.entries.set("A", [
        { type: "agent", text: "Before the switch" },
        other,
        { type: "thought", text: "After the switch" },
        tool("read"),
        { type: "agent", text: "After the work" },
      ]);
      useAgents.setState({ entries: new Map(backend.entries) });
      render(<SessionEditor input={input("A")} />);
      await screen.findByText("After the work");
      const authors = stream().querySelectorAll(`.${styles.agentAuthor}`);
      expect(authors).toHaveLength(2);
      expect(stream().children[1]?.querySelector(`.${styles.agentAuthor}`)).toBeNull();
      expect(authors[1]?.nextElementSibling).toHaveClass(styles.processRun!);
      expect(authors[1]?.parentElement?.nextElementSibling?.firstElementChild).toHaveClass(styles.agentMessage!);
    },
  );

  it("puts the time and hover actions under a turn's final reply only", async () => {
    useProject.setState({ settings: { agents: { foldTurns: false } } as never });
    backend.entries.set("A", [
      { type: "user", text: "Question", attachments: [], steered: false, sentMs: 1000, doneMs: 13000 },
      { type: "agent", text: "First reply" },
      tool("read"),
      { type: "agent", text: "Final reply" },
    ]);
    useAgents.setState({ entries: new Map(backend.entries) });
    render(<SessionEditor input={input("A")} />);
    await screen.findByText("Final reply");
    const [first, last] = stream().querySelectorAll(`.${styles.agentMessage}`);
    expect(first?.children).toHaveLength(1);
    const [card, footer] = last!.children;
    expect(card).toHaveClass(styles.agentCard!);
    expect(footer).toHaveClass(styles.messageFooter!);
    expect(footer?.firstElementChild).toHaveClass(styles.messageTime!);
    expect(footer?.firstElementChild).toHaveTextContent("12s");
    expect(footer?.lastElementChild).toHaveClass(styles.messageActions!);
    // Your message keeps its actions and time beside "You", above it.
    expect(stream().querySelector(`.${styles.userMessage} > .${styles.messageFooter}`)).toBeNull();
    expect(
      stream().querySelector(`.${styles.userMessage} > .${styles.messageHead} .${styles.messageActions}`),
    ).not.toBeNull();
  });

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
    const summary = await screen.findByText("Read 2 files");
    const fold = summary.closest("details")!;
    expect(fold.open).toBe(false);
    // Folded content is rendered once opened, a level at a time.
    const open = (details: HTMLDetailsElement) => {
      details.open = true;
      fireEvent(details, new Event("toggle"));
    };
    expect(screen.queryByText("think one")).toBeNull();
    open(fold);
    // A folded thought shows its first line; opening it shows the rest.
    const thought = (await screen.findByText("think one")).closest("details")!;
    expect(thought.open).toBe(false);
    open(thought);
    expect(thought.querySelector(`.${styles.thoughtBody}`)).toHaveTextContent("think one");
  });
});

describe("turn folding", () => {
  it("folds a finished turn's work under its message and keeps the reply", async () => {
    backend.entries.set("A", [
      { type: "user", text: "Question", attachments: [], steered: false, sentMs: 1000, doneMs: 13000 },
      { type: "thought", text: "think" },
      tool("one"),
      { type: "agent", text: "Interim note" },
      tool("two", { kind: "execute" }),
      { type: "agent", text: "Final reply" },
    ]);
    useAgents.setState({ entries: new Map(backend.entries) });
    render(<SessionEditor input={input("A")} />);
    await screen.findByText("Final reply");
    const summary = screen.getByText("Ran 1 command · Read 1 file · 1 message");
    const fold = summary.closest("details")!;
    expect(fold).toHaveClass(styles.turnFold!);
    expect(fold).toHaveTextContent("12s");
    expect(screen.queryByText("Interim note")).toBeNull();
    fold.open = true;
    fireEvent(fold, new Event("toggle"));
    expect(await screen.findByText("Interim note")).toBeInTheDocument();
  });

  it("leaves the turn the agent works on open", async () => {
    backend.entries.set("A", [
      { type: "user", text: "Question", attachments: [], steered: false, sentMs: 1000, doneMs: null },
      tool("one"),
      { type: "agent", text: "Interim note" },
    ]);
    useAgents.setState({
      entries: new Map(backend.entries),
      tasks: new Map(useAgents.getState().tasks).set("A", {
        ...useAgents.getState().tasks.get("A")!,
        status: "running",
      }),
    });
    render(<SessionEditor input={input("A")} />);
    expect(await screen.findByText("Interim note")).toBeInTheDocument();
    expect(stream().querySelector(`.${styles.turnFold}`)).toBeNull();
    // The turn isn't over: its latest message is no final reply yet.
    expect(stream().querySelector(`.${styles.agentMessage} > .${styles.messageFooter}`)).toBeNull();
    // What the agent is doing ends the conversation, below its latest output.
    const working = within(stream()).getByText("Working…").closest(`.${styles.working}`);
    expect(stream().lastElementChild).toBe(working);
  });
});

describe("opened runs", () => {
  it("stay open when the finished turn folds them away and is opened again", async () => {
    const asked = {
      type: "user",
      text: "Question",
      attachments: [],
      steered: false,
      sentMs: 1000,
      doneMs: null,
    } as const;
    const setTask = (status: AgentTask["status"]) => ({
      tasks: new Map(useAgents.getState().tasks).set("A", { ...useAgents.getState().tasks.get("A")!, status }),
    });
    useAgents.setState({
      entries: new Map([["A", [asked, tool("one"), tool("two"), { type: "agent", text: "Interim" }] as AgentEntry[]]]),
      ...setTask("running"),
    });
    render(<SessionEditor input={input("A")} />);
    const toggle = (details: HTMLDetailsElement) => {
      details.open = !details.open;
      fireEvent(details, new Event("toggle"));
    };
    toggle((await screen.findByText("Read 2 files")).closest("details")!);
    act(() =>
      useAgents.setState({
        entries: new Map([
          [
            "A",
            [
              { ...asked, doneMs: 9000 },
              tool("one"),
              tool("two"),
              { type: "agent", text: "Interim" },
              { type: "agent", text: "Done" },
            ] as AgentEntry[],
          ],
        ]),
        ...setTask("ready"),
      }),
    );
    const turn = screen.getByText("Read 2 files · 1 message").closest("details")!;
    expect(turn).toHaveClass(styles.turnFold!);
    toggle(turn);
    expect(screen.getByText("Read 2 files").closest("details")!.open).toBe(true);
  });
});

describe("folded content", () => {
  it("is rendered for Find in Conversation, so its text is found", async () => {
    backend.entries.set("A", [
      tool("one", { output: "needle in a tool output" }),
      tool("two"),
      { type: "agent", text: "Answer A" },
    ]);
    useAgents.setState({ entries: new Map(backend.entries) });
    render(<SessionEditor input={input("A")} />);
    const summary = await screen.findByText("Read 2 files");
    expect(screen.queryByText("needle in a tool output")).toBeNull();
    fireEvent.focus(summary);
    act(() => focusedSession()!.openFind());
    expect(await screen.findByText("needle in a tool output")).toBeInTheDocument();
    expect(summary.closest("details")!.open).toBe(false);
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

describe("the conversation selection", () => {
  const labels = () =>
    (useContextMenuStore.getState().menu?.items ?? []).flatMap((item) => ("label" in item ? [item.label] : []));
  const select = (node: Node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  };

  it("offers Quote on a right-click, not as a button when the selection ends", async () => {
    render(<SessionEditor input={input("A")} />);
    select(await screen.findByText("Answer A"));
    fireEvent.mouseUp(stream(), { button: 0, clientX: 120, clientY: 90 });
    expect(screen.queryByRole("button", { name: "Quote" })).toBeNull();
    fireEvent.contextMenu(stream(), { clientX: 120, clientY: 90 });
    expect(labels()).toContain("Quote");
  });

  it("offers Copy alone on a right-click without a selection", async () => {
    render(<SessionEditor input={input("A")} />);
    await screen.findByText("Answer A");
    window.getSelection()!.removeAllRanges();
    fireEvent.contextMenu(stream(), { clientX: 10, clientY: 10 });
    expect(labels()).toEqual(["Copy"]);
  });
});

describe("scrolling", () => {
  it("returns to the end when the user sends a message while scrolled up", async () => {
    const reply = { type: "agent", text: "Initial reply" } as AgentEntry;
    useAgents.setState({ entries: new Map([["A", [reply]]]) });
    render(<SessionEditor input={input("A")} />);
    const el = stream();
    let height = 1000;
    Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => height });
    Object.defineProperty(el, "clientHeight", { configurable: true, value: 400 });
    el.scrollTop = 600;
    fireEvent.scroll(el);
    fireEvent.wheel(el, { deltaY: -200 });
    el.scrollTop = 200;
    fireEvent.scroll(el);
    expect(screen.getByRole("button", { name: "Jump to Latest" })).toBeInTheDocument();
    height = 1100;
    const sent = { type: "user", text: "Next", attachments: [], steered: false, sentMs: 1, doneMs: null } as AgentEntry;
    act(() => useAgents.setState({ entries: new Map([["A", [reply, sent]]]) }));
    expect(el.scrollTop).toBe(1100);
    expect(screen.queryByRole("button", { name: "Jump to Latest" })).toBeNull();
  });

  it.each(["wheel", "touch", "ArrowUp", "PageUp", "Home", "Shift+Space"])(
    "releases following before an upward %s scroll, even within the bottom threshold",
    async (method) => {
      useAgents.setState({ entries: new Map([["A", [{ type: "agent", text: "Initial reply" }]]]) });
      render(<SessionEditor input={input("A")} />);
      const el = stream();
      let height = 1000;
      Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => height });
      Object.defineProperty(el, "clientHeight", { configurable: true, value: 400 });
      el.scrollTop = 600;
      fireEvent.scroll(el);
      if (method === "wheel") fireEvent.wheel(el, { deltaY: -4 });
      if (method === "touch") {
        fireEvent.touchStart(el, { touches: [{ clientY: 100 }] });
        fireEvent.touchMove(el, { touches: [{ clientY: 110 }] });
      }
      if (["ArrowUp", "PageUp", "Home"].includes(method)) fireEvent.keyDown(el, { key: method });
      if (method === "Shift+Space") fireEvent.keyDown(el, { key: " ", shiftKey: true });
      // A chunk can land before the browser dispatches the scroll event.
      height = 1004;
      act(() => useAgents.setState({ entries: new Map([["A", [{ type: "agent", text: "Streaming" }]]]) }));
      expect(el.scrollTop).toBe(600);
      el.scrollTop = 588;
      fireEvent.scroll(el);
      // A queued event at the same offset must not re-enable following near the bottom.
      fireEvent.scroll(el);
      el.scrollTop = 592;
      fireEvent.scroll(el);
      height = 1008;
      act(() => useAgents.setState({ entries: new Map([["A", [{ type: "agent", text: "More streaming" }]]]) }));
      expect(el.scrollTop).toBe(592);
      expect(screen.getByRole("button", { name: "Jump to Latest" })).toBeInTheDocument();
      // Scrolling down to the end resumes following.
      fireEvent.wheel(el, { deltaY: 12 });
      el.scrollTop = 608;
      fireEvent.scroll(el);
      height = 1100;
      act(() => useAgents.setState({ entries: new Map([["A", [{ type: "agent", text: "Latest" }]]]) }));
      expect(el.scrollTop).toBe(1100);
    },
  );

  it("does not move the viewport while the scrollbar is held during streaming", () => {
    useAgents.setState({ entries: new Map([["A", [{ type: "agent", text: "Initial reply" }]]]) });
    render(<SessionEditor input={input("A")} />);
    const el = stream();
    let height = 1000;
    Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => height });
    Object.defineProperty(el, "clientHeight", { configurable: true, value: 400 });
    el.scrollTop = 600;
    fireEvent.scroll(el);
    fireEvent.pointerDown(el);
    height = 1100;
    act(() => useAgents.setState({ entries: new Map([["A", [{ type: "agent", text: "Streaming" }]]]) }));
    expect(el.scrollTop).toBe(600);
    el.scrollTop = 588;
    fireEvent.scroll(el);
    fireEvent.pointerUp(window);
    height = 1200;
    act(() => useAgents.setState({ entries: new Map([["A", [{ type: "agent", text: "More streaming" }]]]) }));
    expect(el.scrollTop).toBe(588);
  });

  it("keeps following when an inner tool output consumes the upward wheel", () => {
    const transcript: AgentEntry[] = [tool("live", { status: "running", output: "Tool output" })];
    useAgents.setState({ entries: new Map([["A", transcript]]) });
    render(<SessionEditor input={input("A")} />);
    const el = stream();
    const output = screen.getByText("Tool output");
    let height = 1000;
    Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => height });
    Object.defineProperty(el, "clientHeight", { configurable: true, value: 400 });
    output.style.overflowY = "auto";
    output.scrollTop = 100;
    el.scrollTop = 600;
    fireEvent.scroll(el);
    fireEvent.wheel(output, { deltaY: -4 });
    height = 1100;
    act(() => useAgents.setState({ entries: new Map([["A", [...transcript, { type: "agent", text: "Streaming" }]]]) }));
    expect(el.scrollTop).toBe(1100);
    expect(screen.queryByRole("button", { name: "Jump to Latest" })).toBeNull();
  });

  it("hides Jump to Latest and follows new replies after retracting the conversation", async () => {
    render(<SessionEditor input={input("A")} />);
    const el = stream();
    let height = 1000;
    Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => height });
    Object.defineProperty(el, "clientHeight", { configurable: true, value: 400 });
    fireEvent.wheel(el);
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

  it("keeps following the end when the offset moves back without the user scrolling", async () => {
    render(<SessionEditor input={input("A")} />);
    expect(await screen.findByText("Answer A")).toBeInTheDocument();
    const el = stream();
    let height = 1000;
    Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => height });
    Object.defineProperty(el, "clientHeight", { configurable: true, value: 400 });
    el.scrollTop = 600;
    fireEvent.scroll(el);
    // The conversation grew after it was scrolled to the end, or WebKit moved the offset back
    // while rows laid out: both change the content height.
    height = 1300;
    el.scrollTop = 600;
    fireEvent.scroll(el);
    expect(el.scrollTop).toBe(1300);
    expect(screen.queryByRole("button", { name: "Jump to Latest" })).toBeNull();
    // Scrolling up with the wheel leaves the end.
    fireEvent.wheel(el);
    el.scrollTop = 600;
    fireEvent.scroll(el);
    expect(el.scrollTop).toBe(600);
    expect(await screen.findByRole("button", { name: "Jump to Latest" })).toBeInTheDocument();
  });

  it("leaves the end for a scroll that no layout caused, as dragging the scrollbar thumb", async () => {
    render(<SessionEditor input={input("A")} />);
    expect(await screen.findByText("Answer A")).toBeInTheDocument();
    const el = stream();
    Object.defineProperty(el, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(el, "clientHeight", { configurable: true, value: 400 });
    el.scrollTop = 600;
    fireEvent.scroll(el);
    el.scrollTop = 0;
    fireEvent.scroll(el);
    expect(el.scrollTop).toBe(0);
    expect(await screen.findByRole("button", { name: "Jump to Latest" })).toBeInTheDocument();
  });

  it("offers one click back to the latest message after scrolling up", async () => {
    render(<SessionEditor input={input("A")} />);
    expect(await screen.findByText("Answer A")).toBeInTheDocument();
    const el = stream();
    Object.defineProperty(el, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(el, "clientHeight", { configurable: true, value: 400 });
    fireEvent.wheel(el);
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
  it.each(["pending", "running"] as const)("keeps %s tools in their run, named on its summary", async (status) => {
    backend.entries.set("A", [tool("done one"), tool("done two"), tool("live", { status, output: "Reading files…" })]);
    useAgents.setState({ entries: new Map(backend.entries) });
    render(<SessionEditor input={input("A")} />);
    const summary = (await screen.findByText("Read 3 files")).closest("summary")!;
    expect(summary.closest("details")!).toHaveClass(styles.processRun!);
    expect(summary.closest("details")!.open).toBe(false);
    expect(summary.querySelector(`.${styles.processCurrent}`)).toHaveTextContent("live");
    expect(screen.queryByText("Reading files…")).toBeNull();
  });

  it("folds consecutive finished tool calls into one collapsed row", async () => {
    const edit = (id: string) => tool(id, { kind: "edit", diffs: [{ path: "/project/a.ts", added: 2, removed: 1 }] });
    backend.entries.set("A", [edit("one"), edit("two"), { type: "agent", text: "Answer A" }]);
    useAgents.setState({ entries: new Map(backend.entries) });
    render(<SessionEditor input={input("A")} />);
    const summary = await screen.findByText("Edited 1 file");
    expect(summary.closest("details")!.open).toBe(false);
    expect(screen.getByText("+4")).toBeInTheDocument();
    expect(screen.getByText("−2")).toBeInTheDocument();
  });
});

describe("a pending question", () => {
  it("shows the whole question once inline, with every answer, and sends the chosen one", async () => {
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
    const card = await screen.findByRole("region", { name: "Allow tool call?" });
    expect(within(card).getByText(question.replaceAll("\n", " "))).toBeInTheDocument();
    expect(screen.getAllByText(question.replaceAll("\n", " "))).toHaveLength(1);
    const answers = within(card).getAllByRole("button");
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
    fireEvent.click(within(card).getByRole("tab", { name: "second" }));
    fireEvent.click(within(card).getByRole("radio", { name: /^Two/ }));
    fireEvent.click(within(card).getByRole("button", { name: "Submit" }));
    await waitFor(() =>
      expect(backend.answers).toEqual([["A", 11, JSON.stringify({ first: ["One"], second: ["Two"] })]]),
    );
  });

  it("shows one question at a time with tabs and sends all answers at once", async () => {
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
    const tabs = within(card).getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Layout", "Checks"]);
    const panel = within(card).getByRole("tabpanel", { name: "Layout" });
    expect(panel).toHaveAttribute("tabindex", "0");
    expect(tabs[0]).toHaveAttribute("aria-controls", panel.id);
    tabs[0]!.focus();
    fireEvent.keyDown(tabs[0]!, { key: "ArrowLeft" });
    expect(tabs[1]).toHaveFocus();
    expect(tabs[1]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(tabs[1]!, { key: "Home" });
    expect(tabs[0]).toHaveFocus();
    // Every question stays mounted (one grid cell), so switching tabs keeps the card's height.
    expect(card.querySelectorAll('[role="tabpanel"]')).toHaveLength(2);
    expect(within(card).getByText("One row per check")).toBeTruthy();
    expect(within(card).getByText("Recommended")).toBeTruthy();
    // Only the first question is on screen; the second waits behind its tab.
    expect(within(card).queryByRole("checkbox", { name: /^Disk/ })).toBeNull();
    const submit = within(card).getByRole("button", { name: "Submit" });
    fireEvent.click(within(card).getByRole("radio", { name: /^List/ }));
    expect(submit).toHaveProperty("disabled", true);
    // Paging moves between questions, without losing the answers already given.
    expect(within(card).getByRole("button", { name: "Previous" })).toHaveProperty("disabled", true);
    fireEvent.click(within(card).getByRole("button", { name: "Next" }));
    expect(within(card).getByRole("tab", { name: "Checks" })).toHaveAttribute("aria-selected", "true");
    expect(within(card).getByRole("tabpanel", { name: "Checks" })).toHaveFocus();
    fireEvent.click(within(card).getByRole("tab", { name: "Layout" }));
    expect(within(card).getByRole("radio", { name: /^List/ })).toHaveProperty("checked", true);
    fireEvent.click(within(card).getByRole("tab", { name: "Checks" }));
    fireEvent.click(within(card).getByRole("checkbox", { name: /^Disk/ }));
    fireEvent.click(within(card).getByRole("checkbox", { name: /^Other/ }));
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
    expect(within(card).queryByRole("tablist")).toBeNull();
    expect(within(card).queryByRole("tabpanel")).toBeNull();
    expect(within(card).queryByRole("button", { name: "Next" })).toBeNull();
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

describe("a pending permission request above the composer", () => {
  const command = 'python3 -c \'from pathlib import Path\np = Path("note.txt")\np.write_text("one\\ntwo")\'';
  const options = [
    { id: "opaque-once", name: "Allow Once", kind: "allow_once" },
    { id: "opaque-policy", name: `Always Allow \`${command}\``, kind: "allow_always" },
    { id: "opaque-no", name: "Decline", kind: "reject_once" },
    { id: "opaque-stop", name: "Decline and Stop", kind: "reject_always" },
  ];

  it("shows the requested command while another read tool is pending, with one card and short buttons", async () => {
    backend.entries.set("A", [
      {
        type: "tool",
        id: "pending-read",
        title: "List .",
        kind: "search",
        status: "running",
        output: null,
        diffs: [],
        locations: [],
      },
      { type: "permission", id: 12, title: `Run ${command}`, options, chosen: null },
    ]);
    useAgents.setState({ entries: new Map(backend.entries) });
    render(<SessionEditor input={input("A")} />);
    const card = await screen.findByRole("region", { name: "codex wants to run a command" });
    expect(screen.getAllByRole("region", { name: "codex wants to run a command" })).toHaveLength(1);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(stream()).not.toContainElement(card);
    expect(card.closest(`.${styles.tray}`)).not.toBeNull();
    expect(card.querySelector("pre")?.textContent).toBe(command);
    const buttons = within(card).getAllByRole("button");
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual([
      "Allow Once",
      "Always Allow",
      "Decline",
      "Decline and Stop",
    ]);
    expect(buttons.every((b) => b.tabIndex === 0)).toBe(true);
    expect(buttons[1]?.textContent).toBe("Always Allow");
    expect(buttons[1]?.title).toBe(options[1]?.name);
  });

  it.each(options)("sends the original $kind option id, then records it in the conversation", async (option) => {
    const pending: AgentEntry = { type: "permission", id: 12, title: `Run ${command}`, options, chosen: null };
    backend.answers = [];
    backend.entries.set("A", [pending]);
    useAgents.setState({ entries: new Map(backend.entries) });
    render(<SessionEditor input={input("A")} />);
    const card = await screen.findByRole("region", { name: "codex wants to run a command" });
    const button = within(card).getAllByRole("button")[options.indexOf(option)]!;
    button.focus();
    fireEvent.click(button);
    await waitFor(() => expect(backend.answers).toEqual([["A", 12, option.id]]));
    act(() =>
      useAgents.setState({ entries: new Map(backend.entries).set("A", [{ ...pending, chosen: option.name }]) }),
    );
    expect(card).not.toBeInTheDocument();
    const record = within(stream()).getByRole("region", { name: "codex wants to run a command" });
    expect(record.querySelector("pre")).toBeNull();
    expect(within(record).queryByRole("button")).toBeNull();
    expect(record.textContent).toContain("python3 …");
    expect(record.textContent).not.toContain("write_text");
    await waitFor(() => expect(document.activeElement?.tagName).toBe("TEXTAREA"));
  });

  it("is answered with a number key when the focus isn't in a text field", async () => {
    const pending: AgentEntry = { type: "permission", id: 12, title: `Run ${command}`, options, chosen: null };
    backend.answers = [];
    backend.entries.set("A", [pending]);
    useAgents.setState({ entries: new Map(backend.entries) });
    render(<SessionEditor input={input("A")} />);
    await screen.findByRole("region", { name: "codex wants to run a command" });
    fireEvent.keyDown(document.querySelector("textarea")!, { key: "1" });
    expect(backend.answers).toEqual([]);
    const elsewhere = document.body.appendChild(document.createElement("div"));
    fireEvent.keyDown(elsewhere, { key: "1" });
    fireEvent.keyDown(document.body, { key: "2" });
    elsewhere.remove();
    expect(backend.answers).toEqual([]);
    fireEvent.keyDown(stream(), { key: "3" });
    await waitFor(() => expect(backend.answers).toEqual([["A", 12, "opaque-no"]]));
  });

  it("is answered from its line too, and one without options can be cancelled", async () => {
    backend.entries.set("A", [
      {
        type: "permission",
        id: 3,
        title: "Run ls d:/project",
        options: [
          { id: "once", name: "Allow Once", kind: "allow_once" },
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
    const line = await screen.findByRole("region", { name: "codex wants to run a command" });
    const answers = within(line.querySelector<HTMLElement>(`.${styles.permissionAnswers}`)!).getAllByRole("button");
    expect(answers.map((b) => b.textContent)).toEqual(["Allow Once", "Decline"]);
    fireEvent.click(answers[0]!);
    await waitFor(() => expect(backend.answers).toEqual([["A", 3, "once"]]));
    unmount();

    render(<SessionEditor input={input("B")} />);
    const card = await screen.findByRole("region", { name: "Allow tool call?" });
    fireEvent.click(within(card).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(backend.answers).toEqual([
        ["A", 3, "once"],
        ["B", 4, null],
      ]),
    );
  });
});

describe("conversation loading", () => {
  beforeEach(() => useAgents.setState({ entries: new Map() }));

  it.each(["Remote host disconnected", ""])(
    "shows load errors (%s) in the conversation and retries the same task",
    async (reason) => {
      backend.entryError = reason;
      render(<SessionEditor input={input("A")} />);
      expect(
        await screen.findByText(`Couldn't load the conversation: ${reason || "Unknown error"}`),
      ).toBeInTheDocument();
      expect(within(stream()).queryByRole("status", { name: "Loading" })).toBeNull();
      backend.entryError = null;
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      expect(await screen.findByText("Answer A")).toBeInTheDocument();
      expect(screen.queryByText(/Couldn't load the conversation/)).toBeNull();
    },
  );

  it("shows an empty state when no history was saved", async () => {
    backend.entries.set("A", []);
    render(<SessionEditor input={input("A")} />);
    expect(await screen.findByText("No conversation history")).toBeInTheDocument();
    expect(within(stream()).queryByRole("status", { name: "Loading" })).toBeNull();
  });

  it("bounds a request that never answers, then permits retry without applying its late result", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    backend.entryWait = new Promise<void>((resolve) => {
      finish = resolve;
    });
    render(<SessionEditor input={input("A")} />);
    expect(within(stream()).getByRole("status", { name: "Loading" })).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(35_000));
    expect(
      screen.getByText("Couldn't load the conversation: Loading the conversation timed out. Try again."),
    ).toBeInTheDocument();
    expect(within(stream()).queryByRole("status", { name: "Loading" })).toBeNull();
    backend.entryWait = null;
    backend.entries.set("A", [{ type: "agent", text: "Retried history" }]);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await act(async () => {});
    expect(screen.getByText("Retried history")).toBeInTheDocument();
    backend.entries.set("A", [{ type: "agent", text: "Stale history" }]);
    await act(async () => finish());
    expect(screen.queryByText("Stale history")).toBeNull();
  });

  it("keeps subagent failures separate and retries that subagent", async () => {
    useAgents.setState({ entries: new Map([["A", backend.entries.get("A")!]]) });
    backend.entryError = "No such subagent";
    render(<SessionEditor input={input("A")} />);
    fireEvent.click(screen.getByRole("button", { name: /Explore task A/ }));
    expect(await screen.findByText("Couldn't load the conversation: No such subagent")).toBeInTheDocument();
    backend.entryError = null;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Child answer")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByText("Answer A")).toBeInTheDocument();
  });

  it("reads a restored tab's conversation once the project's agents are connected", async () => {
    // The tab is restored with the project while connecting is still under way.
    backend.fetched = [];
    act(() => disconnect());
    render(<SessionEditor input={input("A")} />);
    await act(async () => {});
    // Connecting finishes and starts from empty caches, as connect() does.
    act(() =>
      useAgents.setState({
        loaded: true,
        tasks: new Map([task("A")].map((t) => [t.id, t])),
        entries: new Map(),
        entryLoads: new Map(),
      }),
    );
    expect(await screen.findByText("Answer A")).toBeInTheDocument();
    expect(backend.fetched.filter((k) => k === "A")).toHaveLength(1);
  });

  it("does not apply entries after disconnecting the project", async () => {
    let finish!: () => void;
    backend.entryWait = new Promise<void>((resolve) => {
      finish = resolve;
    });
    render(<SessionEditor input={input("A")} />);
    act(() => disconnect());
    await act(async () => finish());
    expect(useAgents.getState().entries.size).toBe(0);
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
    await screen.findByRole("button", { name: /1 changed file/ });
    expect(screen.queryByRole("complementary", { name: "Changes" })).toBeNull();
    const markVisible = vi.spyOn(await import("./store"), "markVisible");
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const message = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(message, { target: { value: "Draft to keep" } });
    const conversation = stream();
    fireEvent.click(screen.getByRole("button", { name: /1 changed file/ }));
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
    fireEvent.wheel(stream());
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

describe("sessions from other apps", () => {
  const openHistory = async () => {
    act(() => useAgents.setState({ docked: "A" }));
    render(<AgentsView />);
    fireEvent.click(screen.getByRole("button", { name: "Agent sessions" }));
    await waitFor(() => expect(screen.getByText("Sessions from other apps")).toBeInTheDocument());
  };

  it("lists external sessions in the history popup and imports one as a task", async () => {
    backend.external = [
      { provider: "claude", sessionId: "abc", title: "Login fix", cwd: "/work/app", updatedMs: Date.now() },
      { provider: "codex", sessionId: "thread-1", title: "Add tests", cwd: null, updatedMs: 0 },
    ];
    await openHistory();
    expect(screen.getByText("Login fix")).toBeInTheDocument();
    expect(screen.getByText("Add tests")).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: "Import" })[0]!);
    });
    expect(backend.imported).toEqual([["claude", "abc"]]);
    const state = useAgents.getState();
    expect(state.tasks.get("imported")?.title).toBe("Login fix");
    expect(state.external.map((e) => e.sessionId)).toEqual(["thread-1"]);
  });

  it("shows listing errors instead of the section", async () => {
    backend.externalError = "no home";
    await openHistory();
    expect(screen.getByText("no home")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Import" })).toBeNull();
  });
});
