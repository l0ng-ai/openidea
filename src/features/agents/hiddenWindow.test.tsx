import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { AgentEntry, AgentTask } from "@/bindings";
import { useProject } from "@/platform/project";
import { EditorShownProvider } from "@/workbench/contributions";
import { SessionEditor } from "./SessionEditor";
import { SESSION_KIND, sessionKey } from "./model";
import { focusedSession } from "./sessionFocus";
import { disconnect, useAgents } from "./store";
import styles from "./Session.module.css";

vi.mock("@/platform/ipc", async (original) => ({
  ...(await original<typeof import("@/platform/ipc")>()),
  commands: {
    fsProbe: async () => ({ status: "ok", data: { size: 1, binary: false, tooLarge: false } }),
    agentChanges: async () => ({ status: "ok", data: [] }),
    agentGroupedChanges: async () => ({ status: "ok", data: { uncommitted: [], commits: [] } }),
    vcsBranchInfo: async () => ({ status: "ok", data: { head: "main" } }),
    agentEntries: async () => ({ status: "ok", data: [] }),
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

const TURNS = 60;
/** Hidden for longer than any plausible "a while". */
const LONG_HIDDEN_MS = 10 * 60_000;

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
  capabilities: { rollback: true },
  commands: [],
  usage: null,
  queue: [],
});

/** A request, a run of calls and a reply: what a turn looks like in a real session. */
const history = (turns: number): AgentEntry[] =>
  Array.from({ length: turns }, (_, i): AgentEntry[] => [
    { type: "user", text: `Request ${i}`, attachments: [], sentMs: null },
    ...Array.from({ length: 3 }, (_, k): AgentEntry => ({
      type: "tool",
      id: `tool-${i}-${k}`,
      title: `Read src/file${k}.ts`,
      kind: "read",
      status: "completed",
      locations: [],
      output: null,
      diffs: [],
    })),
    { type: "agent", text: `Reply ${i}` },
  ]).flat();

const input = (id: string) => ({ kind: SESSION_KIND, key: sessionKey(id), data: { task: id } });
const session = (shown: boolean, id = "A") => (
  <EditorShownProvider value={shown}>
    <SessionEditor input={input(id)} />
  </EditorShownProvider>
);
const stream = () => document.querySelector<HTMLDivElement>(`.${styles.stream}`)!;
/** Conversation rows in the DOM, whatever their kind. */
const rows = () => stream().querySelectorAll(`.${styles.conversationRow}`).length;
const nodes = () => stream().getElementsByTagName("*").length;

/** The scroll geometry jsdom lacks: a conversation as tall as its rows. */
function layOut(el: HTMLElement, viewport = 400) {
  Object.defineProperty(el, "clientHeight", { configurable: true, value: viewport });
  Object.defineProperty(el, "scrollHeight", {
    configurable: true,
    get: () => viewport + el.querySelectorAll(`.${styles.conversationRow}`).length * 20,
  });
}

/** Lets the opening batch and every background batch after it paint. */
async function settle(last: string) {
  await screen.findByText("Request 0", {}, { timeout: 10_000 });
  await screen.findByText(last);
}

beforeEach(() => {
  useProject.setState({ settings: null });
  disconnect();
  useAgents.setState({
    loaded: true,
    sessionLocation: "editor",
    homeOpen: false,
    tasks: new Map([task("A")].map((t) => [t.id, t])),
    entries: new Map([["A", history(TURNS)]]),
    external: [],
    externalError: null,
  });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("a kept-alive session tab that stays hidden", () => {
  it("keeps an unsent edit to an earlier message even after returning to the end", async () => {
    const view = render(session(true));
    await settle("Reply 59");
    layOut(stream());
    const edit = screen.getAllByRole("button", { name: "Edit" })[0]!;
    fireEvent.click(edit);
    const draft = within(stream()).getByRole("textbox", { name: "Message" });
    fireEvent.change(draft, { target: { value: "Unsent revision" } });
    draft.blur();
    stream().scrollTop = stream().scrollHeight - stream().clientHeight;
    fireEvent.scroll(stream());

    vi.useFakeTimers();
    view.rerender(session(false));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LONG_HIDDEN_MS);
    });
    view.rerender(session(true));
    expect(within(stream()).getByRole("textbox", { name: "Message" })).toHaveValue("Unsent revision");
  });

  it("keeps a text selection in the earlier rows while hidden", async () => {
    const view = render(session(true));
    await settle("Reply 59");
    const selection = window.getSelection()!;
    selection.selectAllChildren(screen.getByText("Request 0"));

    vi.useFakeTimers();
    view.rerender(session(false));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LONG_HIDDEN_MS);
    });
    view.rerender(session(true));
    expect(selection.toString()).toBe("Request 0");
    selection.removeAllRanges();
  });

  it("gives back the history it painted behind the tail and is at the latest message when shown again", async () => {
    const view = render(session(true));
    await settle("Reply 59");
    layOut(stream());
    const full = nodes();
    expect(rows()).toBeGreaterThan(150);

    vi.useFakeTimers();
    view.rerender(session(false));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LONG_HIDDEN_MS);
    });
    // The recent tail stays; the earlier turns leave the DOM.
    expect(rows()).toBeLessThan(60);
    expect(nodes()).toBeLessThan(full / 4);
    expect(screen.getByText("Reply 59")).toBeInTheDocument();
    expect(screen.queryByText("Request 0")).toBeNull();

    vi.useRealTimers();
    view.rerender(session(true));
    expect(screen.getByText("Reply 59")).toBeInTheDocument();
    expect(stream().scrollTop).toBe(stream().scrollHeight);
    // Shown again, it paints the history behind the tail again, as when it opened.
    await screen.findByText("Request 0", {}, { timeout: 10_000 });
    expect(stream().scrollTop).toBe(stream().scrollHeight);
    expect(rows()).toBeGreaterThan(150);
  });

  it("keeps the whole window of a tab scrolled up, so its position survives", async () => {
    const view = render(session(true));
    await settle("Reply 59");
    const el = stream();
    layOut(el);
    fireEvent.wheel(el, { deltaY: -200 });
    el.scrollTop = 1000;
    fireEvent.scroll(el);
    const before = rows();

    vi.useFakeTimers();
    view.rerender(session(false));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LONG_HIDDEN_MS);
    });
    expect(rows()).toBe(before);
    expect(screen.getByText("Request 0")).toBeInTheDocument();

    vi.useRealTimers();
    view.rerender(session(true));
    expect(stream().scrollTop).toBe(1000);
  });

  it("stays trimmed while a reply streams in, and shows the reply once shown", async () => {
    const view = render(session(true));
    await settle("Reply 59");
    layOut(stream());
    vi.useFakeTimers();
    view.rerender(session(false));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LONG_HIDDEN_MS);
    });
    const trimmed = rows();
    expect(trimmed).toBeLessThan(60);

    act(() =>
      useAgents.setState({
        entries: new Map([["A", [...history(TURNS), { type: "agent", text: "A late reply" } as AgentEntry]]]),
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LONG_HIDDEN_MS);
    });
    expect(rows()).toBeLessThanOrEqual(trimmed + 1);

    vi.useRealTimers();
    view.rerender(session(true));
    expect(screen.getByText("A late reply")).toBeInTheDocument();
    expect(stream().scrollTop).toBe(stream().scrollHeight);
  });

  it("lets Find in Conversation search the whole history once shown again", async () => {
    const view = render(session(true));
    await settle("Reply 59");
    layOut(stream());
    vi.useFakeTimers();
    view.rerender(session(false));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LONG_HIDDEN_MS);
    });
    expect(screen.queryByText("Request 0")).toBeNull();

    vi.useRealTimers();
    // jsdom has no layout: every range counts as painted.
    vi.spyOn(Range.prototype, "getClientRects").mockImplementation(
      () => [new DOMRect(0, 0, 20, 12)] as unknown as DOMRectList,
    );
    view.rerender(session(true));
    fireEvent.focusIn(stream());
    act(() => focusedSession()!.openFind());
    fireEvent.change(await screen.findByLabelText("Find in Conversation"), { target: { value: "Request 0" } });
    // The one request in the trimmed part of the history is found.
    expect(await screen.findByText("1/1", {}, { timeout: 10_000 })).toBeInTheDocument();
  });
});
