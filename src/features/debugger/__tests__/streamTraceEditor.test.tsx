import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

const ipc = vi.hoisted(() => ({
  debugJvmMemoryFields: vi.fn(),
  debugStreamTraceAbort: vi.fn(),
  cancelRequest: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return { ...real, isTauri: () => true, commands: { ...real.commands, ...ipc } };
});

import type {
  DebugCapabilities,
  JvmFieldsResult,
  StreamTraceResult,
  TraceBanner,
  TraceUnavailable,
} from "@/platform/ipc";
import { getAction, isActionEnabled } from "@/platform/actions";
import { provideNotificationService } from "@/workbench/contributions";
import { registerDebugActions } from "../actions";
import { publishContext, useDebug, type DebugSession } from "../state";
import { useOverlays } from "../ui/popoverStore";
import { useStreamTrace, type TraceEntry } from "../streams/streamStore";
import { STREAM_TRACE_KIND } from "../streams/streamTraceInput";
import { StreamTraceEditor } from "../streams/StreamTraceEditor";
import { StreamAbortDialog } from "../streams/StreamAbortDialog";
import { CELL_LIMIT } from "../streams/TraceColumns";
import { CHAIN_A, CHAIN_A_READY } from "./streamChainA";

const session = {
  id: 1,
  name: "Main",
  adapter: "java-debug",
  parent: null,
  launch: null,
  process: null,
  status: "paused",
  stoppedThread: 1,
  stopReason: "step",
  stopDescription: null,
  threads: [{ id: 1, name: "main" }],
  selectedThread: 1,
  frames: [],
  selectedFrame: null,
  hits: 1,
  stops: 2,
  exitCode: null,
  caps: { streamTrace: true } as DebugCapabilities,
} as DebugSession;

const RUNNING: TraceEntry = {
  request: 5,
  chain: CHAIN_A,
  progress: { phase: "running", records: 12, dropped: 0, elapsedMs: 3400 },
  result: null,
  error: null,
  stoppedRecording: false,
  abort: null,
  thread: 1,
  endStop: null,
};

/** One object record mapped to a string: enough to open a value. */
const OBJECTS: typeof CHAIN_A_READY = {
  status: "ready",
  chain: CHAIN_A,
  steps: ["", "map"],
  records: [
    { step: 0, value: { kind: "object", id: 50, typeName: "com.x.Order" } },
    { step: 1, value: { kind: "string", id: 51, text: "order", length: 5 } },
  ],
  links: [
    { parent: null, ambiguous: false },
    { parent: 0, ambiguous: false },
  ],
  terminal: { kind: "void" },
  banners: [],
  generation: 9,
};

const FIELDS: JvmFieldsResult = {
  status: "ready",
  fields: [{ name: "total", value: { kind: "primitive", typeName: "int", text: "3" } }],
};

const ok = <T,>(data: T) => Promise.resolve({ status: "ok" as const, data });
const notify = vi.fn();

function setEntry(patch: Partial<TraceEntry>) {
  useStreamTrace.setState({ bySession: { 1: { ...RUNNING, ...patch } } });
  publishContext();
}

const ready = (result: StreamTraceResult, patch: Partial<TraceEntry> = {}) =>
  setEntry({ result, progress: null, ...patch });

const chainA = (patch: Partial<typeof CHAIN_A_READY>): typeof CHAIN_A_READY => ({ ...CHAIN_A_READY, ...patch });

function show() {
  return render(
    <>
      <StreamTraceEditor input={{ kind: STREAM_TRACE_KIND, key: `${STREAM_TRACE_KIND}:1`, data: { session: 1 } }} />
      <StreamAbortDialog />
    </>,
  );
}

const item = (text: string) =>
  within(screen.getByRole("tree")).getByText(text).closest<HTMLElement>("[role=treeitem]")!;
const toggle = (row: HTMLElement) => fireEvent.mouseDown(row.querySelector("[data-tree-toggle]")!, { button: 0 });

let dispose: () => void;
beforeEach(() => {
  for (const m of Object.values(ipc)) m.mockClear();
  notify.mockClear();
  provideNotificationService({ notify });
  dispose = registerDebugActions();
  useOverlays.setState({ streamAbort: null });
  useDebug.setState({ sessions: { 1: session }, active: 1 });
  useStreamTrace.setState({ bySession: {} });
  publishContext();
});
afterEach(() => {
  cleanup();
  dispose();
  useDebug.setState({ sessions: {}, active: null });
  useStreamTrace.setState({ bySession: {} });
});

describe("stream trace actions", () => {
  it("registers Stop Recording and Abort, enabled while the active session traces", () => {
    expect(getAction("debug.streamTrace.stopRecording")?.title).toBe("Stop Recording");
    expect(getAction("debug.streamTrace.abort")?.title).toBe("Abort Operation…");
    const enabled = (id: string) => isActionEnabled(getAction(id)!);
    expect(enabled("debug.streamTrace.stopRecording")).toBe(false);
    expect(enabled("debug.streamTrace.abort")).toBe(false);
    setEntry({});
    expect(enabled("debug.streamTrace.stopRecording")).toBe(true);
    expect(enabled("debug.streamTrace.abort")).toBe(true);
    ready(CHAIN_A_READY);
    expect(enabled("debug.streamTrace.stopRecording")).toBe(false);
  });
});

describe("StreamTraceEditor", () => {
  it("shows progress, Stop Recording and Abort while the trace runs", () => {
    setEntry({});
    show();
    expect(screen.getByRole("progressbar")).toBeTruthy();
    expect(screen.getByText("12 records · 3 s")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop Recording" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Abort Operation…" })).toBeTruthy();
  });

  it("the buttons act on the tab's session, not the active one", () => {
    setEntry({});
    const other = { ...session, id: 2, name: "Other" } as DebugSession;
    useDebug.setState({ sessions: { 1: session, 2: other }, active: 2 });
    publishContext();
    show();
    const stop = screen.getByRole("button", { name: "Stop Recording" });
    expect((stop as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Abort Operation…" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(stop);
    expect(ipc.cancelRequest).toHaveBeenCalledWith(5);
    expect(useStreamTrace.getState().bySession[1]?.stoppedRecording).toBe(true);
  });

  it("Stop Recording follows the tab's trace while another session's trace is active", () => {
    useStreamTrace.setState({
      bySession: { 1: { ...RUNNING, stoppedRecording: true }, 2: { ...RUNNING, request: 6 } },
    });
    const other = { ...session, id: 2, name: "Other" } as DebugSession;
    useDebug.setState({ sessions: { 1: session, 2: other }, active: 2 });
    publishContext();
    show();
    expect((screen.getByRole("button", { name: "Stop Recording" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Abort Operation…" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("Stop Recording runs its action: the request is cancelled and breakpoints stay off", () => {
    setEntry({});
    show();
    fireEvent.click(screen.getByRole("button", { name: "Stop Recording" }));
    expect(ipc.cancelRequest).toHaveBeenCalledWith(5);
    expect(useStreamTrace.getState().bySession[1]?.stoppedRecording).toBe(true);
    expect(screen.getByRole("status").textContent).toContain("Breakpoints stay off until toList finishes");
  });

  it("Abort asks first; its Abort button aborts the operation", async () => {
    ipc.debugStreamTraceAbort.mockReturnValue(ok({ kind: "interrupted" }));
    setEntry({});
    show();
    fireEvent.click(screen.getByRole("button", { name: "Abort Operation…" }));
    expect(useOverlays.getState().streamAbort).toBe(1);
    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByText(
        "The program will receive java.lang.RuntimeException: oi-cancel. Abort the stream operation?",
      ),
    ).toBeTruthy();
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Abort" })));
    expect(ipc.debugStreamTraceAbort).toHaveBeenCalledWith(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useStreamTrace.getState().bySession[1]?.abort).toEqual({ kind: "interrupted" });
  });

  it("Enter in the Abort dialog cancels: Cancel is the default and has the focus", () => {
    setEntry({});
    show();
    fireEvent.click(screen.getByRole("button", { name: "Abort Operation…" }));
    const dialog = screen.getByRole("dialog");
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    expect(cancel.hasAttribute("data-dialog-default")).toBe(true);
    expect(within(dialog).getByRole("button", { name: "Abort" }).hasAttribute("data-dialog-default")).toBe(false);
    expect(document.activeElement).toBe(cancel);
    fireEvent.keyDown(dialog, { key: "Enter" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(ipc.debugStreamTraceAbort).not.toHaveBeenCalled();
  });

  it("Cancel in the Abort dialog leaves the operation alone", () => {
    setEntry({});
    show();
    fireEvent.click(screen.getByRole("button", { name: "Abort Operation…" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(ipc.debugStreamTraceAbort).not.toHaveBeenCalled();
  });

  it("reports an abort the host refused", async () => {
    ipc.debugStreamTraceAbort.mockReturnValue(
      Promise.resolve({ status: "error", error: { kind: "internal", message: "gone" } }),
    );
    setEntry({});
    show();
    fireEvent.click(screen.getByRole("button", { name: "Abort Operation…" }));
    await act(async () => fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Abort" })));
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ level: "error", title: "Cannot abort the operation" }),
    );
  });

  it("says which threads hold the locks a stuck operation needs", () => {
    setEntry({
      abort: {
        kind: "stuck",
        holders: [
          [3, "main"],
          [7, "worker-1"],
        ],
      },
    });
    show();
    expect(screen.getByRole("alert").textContent).toBe("The operation is stuck: main, worker-1 hold locks it needs");
  });

  it("a stuck operation with no lock holders says how to end it", () => {
    setEntry({ abort: { kind: "stuck", holders: [] } });
    show();
    expect(screen.getByRole("alert").textContent).toBe("The operation is stuck; stop the debug session to end it");
  });

  it("shows a result banner", () => {
    ready(chainA({ banners: [{ kind: "truncated", dropped: 3 }] }));
    show();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Recording stopped after 24 records (3 more not recorded)");
  });

  it.each<[TraceBanner, string]>([
    [{ kind: "countFromSize" }, "count() was computed from the source size; the pipeline did not run"],
    [{ kind: "sortedPassThrough", step: 3 }, "sorted() kept the order: the source was already sorted"],
    [{ kind: "sequentialized" }, "The parallel chain ran sequentially so it could be traced"],
    [{ kind: "breakpointsSkipped", count: 1 }, "1 breakpoint was off while the chain ran"],
    [{ kind: "breakpointsSkipped", count: 2 }, "2 breakpoints were off while the chain ran"],
    [{ kind: "breakpointsResumed", count: 1 }, "1 breakpoint hit while the chain ran was resumed"],
    [{ kind: "breakpointsResumed", count: 4 }, "4 breakpoint hits while the chain ran were resumed"],
  ])("banner %j", (banner, text) => {
    ready(chainA({ banners: [banner] }));
    show();
    expect(screen.getByRole("status").textContent).toBe(text);
  });

  it("names the exception the chain threw", () => {
    ready(
      chainA({
        terminal: { kind: "threw", exception: { kind: "object", id: 8, typeName: "java.lang.IllegalStateException" } },
        banners: [{ kind: "threw" }],
      }),
    );
    show();
    expect(screen.getByRole("status").textContent).toBe("The chain threw IllegalStateException@8");
  });

  it("lays chain A out flat: five step columns and the result", () => {
    ready(CHAIN_A_READY);
    show();
    const columns = screen.getAllByTestId("stream-trace-column");
    expect(columns.map((c) => within(c).getAllByRole("listitem").length)).toEqual([8, 4, 4, 4, 4]);
    expect(within(screen.getByTestId("stream-trace-result")).getByText("ImmutableCollections$ListN@7")).toBeTruthy();
  });

  it("clicking a value highlights what it became", () => {
    ready(CHAIN_A_READY);
    show();
    const [source] = screen.getAllByTestId("stream-trace-column");
    fireEvent.click(within(source!).getByRole("button", { name: "8" }));
    const related = [...document.querySelectorAll("[data-related]")].map((c) => c.textContent);
    expect(related.sort()).toEqual(["8", "8", "81", "81", '"81"'].sort());
    expect(within(source!).getByRole("button", { name: "8" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("draws one curve per link, the related ones marked after a click", () => {
    ready(CHAIN_A_READY);
    const { container } = show();
    const paths = () => [...container.querySelectorAll("svg path")];
    // 4 links into each of the steps 1–4; the 8 source values have no parent.
    expect(paths()).toHaveLength(16);
    expect(paths().filter((p) => /ambiguous/.test(p.getAttribute("class")!))).toHaveLength(0);
    fireEvent.click(within(screen.getAllByTestId("stream-trace-column")[0]!).getByRole("button", { name: "8" }));
    // 0=8 → 1=8 → 2=81 → 3=81 → 4="81".
    expect(paths().filter((p) => /relatedCurve/.test(p.getAttribute("class")!))).toHaveLength(4);
  });

  it("dashes a link the host could only guess", () => {
    ready({
      ...OBJECTS,
      links: [
        { parent: null, ambiguous: false },
        { parent: 0, ambiguous: true },
      ],
    });
    const { container } = show();
    const [path] = [...container.querySelectorAll("svg path")];
    expect(path!.getAttribute("class")).toMatch(/ambiguous/);
  });

  it("caps each column and draws no curve to a value past the cap", () => {
    const source = Array.from({ length: CELL_LIMIT + 5 }, (_, i) => ({
      step: 0,
      value: { kind: "boxed" as const, id: i, typeName: "java.lang.Integer", text: String(i) },
    }));
    const mapped = [3, CELL_LIMIT + 2].map((from, i) => ({
      step: 1,
      value: { kind: "boxed" as const, id: 90_000 + i, typeName: "java.lang.Integer", text: String(from * 2) },
    }));
    ready(
      chainA({
        steps: ["stream", "map"],
        records: [...source, ...mapped],
        links: [
          ...source.map(() => ({ parent: null, ambiguous: false })),
          { parent: 3, ambiguous: false },
          { parent: CELL_LIMIT + 2, ambiguous: false },
        ],
        terminal: { kind: "void" },
      }),
    );
    const { container } = show();
    expect(screen.getByText("Each step shows its first 1,000 values")).toBeTruthy();
    const [first, second] = screen.getAllByTestId("stream-trace-column");
    expect(within(first!).getAllByRole("listitem")).toHaveLength(CELL_LIMIT);
    expect(within(second!).getAllByRole("listitem")).toHaveLength(2);
    expect(container.querySelectorAll("svg path")).toHaveLength(1);
  });

  it("a reply that lands before its stop shows no outdated note and its values open", async () => {
    ipc.debugJvmMemoryFields.mockReturnValue(ok(FIELDS));
    useDebug.setState({ sessions: { 1: { ...session, status: "running" } } });
    ready(OBJECTS);
    show();
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Order@50" }));
    toggle(item("Order@50"));
    expect(await screen.findByText("total")).toBeTruthy();
    expect(ipc.debugJvmMemoryFields).toHaveBeenCalledWith(1, { generation: 9, id: 50 });
    // Its stop's event arrives.
    act(() => {
      useDebug.setState({ sessions: { 1: { ...session, stops: 3 } } });
      ready(OBJECTS, { endStop: 3 });
    });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("Split shows two adjacent steps", () => {
    ready(CHAIN_A_READY);
    show();
    fireEvent.click(screen.getByRole("tab", { name: "Split" }));
    expect(screen.getAllByRole("list")).toHaveLength(2);
    expect(screen.queryByTestId("stream-trace-result")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "sorted → map" }));
    const lists = screen.getAllByRole("list");
    expect(lists).toHaveLength(2);
    expect(
      within(lists[1]!)
        .getAllByRole("listitem")
        .map((c) => c.textContent),
    ).toEqual(['"21"', '"41"', '"61"', '"81"']);
  });

  it("opens an object value through the memory reader", async () => {
    ipc.debugJvmMemoryFields.mockReturnValue(ok(FIELDS));
    ready(OBJECTS, { endStop: 2 });
    show();
    expect(screen.getAllByTestId("stream-trace-column")[0]!.textContent).toContain("Source");
    fireEvent.click(screen.getByRole("button", { name: "Order@50" }));
    toggle(item("Order@50"));
    expect(await screen.findByText("total")).toBeTruthy();
    expect(ipc.debugJvmMemoryFields).toHaveBeenCalledWith(1, { generation: 9, id: 50 });
  });

  it("stops opening values once the program ran on", () => {
    ready(OBJECTS, { endStop: 2 });
    show();
    const note = "Values can no longer be expanded after the program resumed";
    expect(screen.queryByText(note)).toBeNull();
    act(() => useDebug.setState({ sessions: { 1: { ...session, stops: 3 } } }));
    expect(screen.getByText(note)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Order@50" }));
    expect(item("Order@50").getAttribute("aria-expanded")).toBeNull();
    expect(ipc.debugJvmMemoryFields).not.toHaveBeenCalled();
    // The previews stay.
    expect(screen.getByRole("button", { name: '"order"' })).toBeTruthy();
  });

  it.each<[TraceUnavailable, string]>([
    [{ kind: "notSuspended" }, "The program is not stopped"],
    [{ kind: "busy" }, "Another stream trace is running"],
    [{ kind: "noSession" }, "The Java debugger has no session for this program"],
    [{ kind: "noBackend" }, "Stream tracing needs the Java debugger's inspector"],
    [{ kind: "unsupported", detail: "JDK 8" }, "JDK 8"],
    [{ kind: "notAtChainStart", detail: "the stop moved" }, "the stop moved"],
  ])("explains %j", (reason, text) => {
    ready({ status: "unavailable", reason });
    show();
    expect(screen.getByRole("alert").textContent).toBe(text);
  });

  it("shows a failed trace as an error", () => {
    ready({ status: "failed", detail: "the debug session ended" });
    show();
    expect(screen.getByRole("alert").textContent).toBe("the debug session ended");
  });

  it.each(["cancelled before the trace started", "cancelled before the terminal ran"])(
    "a recording stopped before the chain ran (%s) is a note, not an error",
    (detail) => {
      ready({ status: "cancelled", detail }, { stoppedRecording: true });
      show();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.getByText("Recording stopped before the trace started")).toBeTruthy();
    },
  );

  it("an operation aborted before the chain ran is a note, not an error", () => {
    ready({ status: "cancelled", detail: "cancelled before the terminal ran" });
    show();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("The trace was cancelled before the chain ran")).toBeTruthy();
  });
});
