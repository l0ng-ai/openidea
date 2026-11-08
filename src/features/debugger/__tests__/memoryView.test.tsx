import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const ipc = vi.hoisted(() => ({ debugJvmMemoryClasses: vi.fn(), debugJvmMemoryInstances: vi.fn() }));

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return { ...real, isTauri: () => true, commands: { ...real.commands, ...ipc } };
});

import type {
  DebugCapabilities,
  JvmClassRow,
  JvmInstancesResult,
  JvmMemoryResult,
  JvmMemoryUnavailable,
} from "@/platform/ipc";
import { useDebug, type DebugSession } from "../state";
import { registerActions } from "@/platform/actions";
import { setLocale } from "@/platform/i18n";
import { refreshMemory, useMemory } from "../memory/memoryState";
import { showInstances, useInstances } from "../memory/instancesState";
import { MemoryView } from "../memory/MemoryView";

const session = {
  id: 1,
  name: "main",
  adapter: "java-debug",
  parent: null,
  launch: null,
  process: null,
  status: "paused",
  stoppedThread: 1,
  stopReason: "breakpoint",
  stopDescription: null,
  threads: [],
  selectedThread: 1,
  frames: [],
  selectedFrame: null,
  hits: 1,
  stops: 0,
  exitCode: null,
  caps: null,
} as DebugSession;

const row = (name: string, p: Partial<JvmClassRow> = {}): JvmClassRow => ({
  name,
  module: null,
  instances: 1,
  bytes: 16,
  deltaInstances: null,
  deltaBytes: null,
  ambiguous: false,
  ...p,
});

const ready = (rows: JvmClassRow[]): JvmMemoryResult => ({
  status: "ready",
  snapshot: {
    rows,
    totalInstances: rows.reduce((n, r) => n + r.instances, 0),
    totalBytes: rows.reduce((n, r) => n + r.bytes, 0),
    javaVersion: "21",
    takenWhileSuspended: true,
    hasBaseline: true,
    elapsedMs: 5,
    source: "histogram",
  },
});

const unavailable = (reason: JvmMemoryUnavailable): JvmMemoryResult => ({
  status: "unavailable",
  reason,
  canCountWhenPaused: false,
});
const ok = <T,>(data: T) => Promise.resolve({ status: "ok" as const, data });
const fail = (message: string) => Promise.resolve({ status: "error" as const, error: { kind: "internal", message } });

const HEAP = ready([
  row("Heap$Live", { module: "java.base", instances: 1_000_000, bytes: 16_000_000, deltaInstances: 3 }),
  row("Cache$Entry", { instances: 40, bytes: 2_000, deltaInstances: 0 }),
  row("Dup", { instances: 2, bytes: 64, ambiguous: true }),
]);

const withInstances = { ...session, caps: { jvmInstances: true } as DebugCapabilities } as DebugSession;

const debuggerCounts = (rows: JvmClassRow[]): JvmMemoryResult => {
  const r = ready(rows) as Extract<JvmMemoryResult, { status: "ready" }>;
  return { ...r, snapshot: { ...r.snapshot, source: "debugger", totalBytes: 0 } };
};

const NO_INSTANCES: JvmInstancesResult = { status: "ready", generation: 1, instances: [], truncated: false };

let unregister: () => void;

beforeEach(() => {
  useMemory.setState({ bySession: {} });
  useInstances.setState({ bySession: {} });
  useDebug.setState({ sessions: { 1: session }, active: 1, stopSeq: 0 });
  ipc.debugJvmMemoryClasses.mockReset();
  ipc.debugJvmMemoryInstances.mockReset();
  // The real actions live in actions.ts (covered by actions.test.ts); the buttons only need their ids to resolve.
  unregister = registerActions([
    { id: "debug.memory.refresh", title: "Refresh Memory View", run: () => void refreshMemory(1) },
    {
      id: "debug.memory.showInstances",
      title: "Show Instances",
      run: ({ arg }) => void showInstances(1, arg as string),
    },
    { id: "debug.memory.jumpToSource", title: "Jump to Source", run: () => {} },
  ]);
});

afterEach(() => {
  unregister();
  cleanup();
});

describe("MemoryView", () => {
  it("loads a snapshot when the tab first opens", async () => {
    ipc.debugJvmMemoryClasses.mockReturnValue(ok(HEAP));
    const { unmount } = render(<MemoryView session={session} />);
    await screen.findByText("Heap$Live");
    expect(ipc.debugJvmMemoryClasses).toHaveBeenCalledTimes(1);
    unmount();
    render(<MemoryView session={session} />);
    expect(screen.getByText("Heap$Live")).toBeTruthy();
    expect(ipc.debugJvmMemoryClasses).toHaveBeenCalledTimes(1);
  });

  it("renders rows with formatted size and delta", async () => {
    ipc.debugJvmMemoryClasses.mockReturnValue(ok(HEAP));
    render(<MemoryView session={session} />);
    await screen.findByText("Heap$Live");
    expect(screen.getByText("java.base")).toBeTruthy();
    expect(screen.getByText((1_000_000).toLocaleString())).toBeTruthy();
    expect(screen.getByText("15.3 MB")).toBeTruthy();
    expect(screen.getByText("+3")).toBeTruthy();
    expect(screen.getByText(`3 classes · ${(1_000_042).toLocaleString()} objects · 15.3 MB`)).toBeTruthy();
    expect(screen.getByText("Counts include objects that are unreachable but not yet collected.")).toBeTruthy();
  });

  it("annotates classes that several class loaders define", async () => {
    ipc.debugJvmMemoryClasses.mockReturnValue(ok(HEAP));
    render(<MemoryView session={session} />);
    await screen.findByText("Dup");
    expect(screen.getAllByRole("img", { name: "Loaded by more than one class loader" })).toHaveLength(1);
  });

  it("explains why memory is unavailable", async () => {
    ipc.debugJvmMemoryClasses.mockReturnValue(ok(unavailable({ kind: "unsafeWhileSuspended", javaMajor: 11 })));
    render(<MemoryView session={session} />);
    expect(
      await screen.findByText("JDK 11 cannot report memory while suspended. Resume the program, then refresh."),
    ).toBeTruthy();
  });

  it.each<[JvmMemoryUnavailable, string]>([
    [
      { kind: "attachedJvmNotFound" },
      "Memory view needs a JVM on this computer started with -XX:+StartAttachListener. Programs the IDE debugs get it automatically.",
    ],
    [{ kind: "listenModeNotSupported" }, "Memory view is not available when the IDE listens for the JVM to connect."],
    [{ kind: "unsupportedPlatform" }, "Memory view is not available on this platform yet."],
    [{ kind: "noJvmProcess" }, "Could not find the program's JVM process."],
    [
      { kind: "listenerNotRunning" },
      "The JVM does not accept attach requests. Restart the debug session without -XX:+DisableAttachMechanism.",
    ],
    [
      { kind: "unsafeWhileSuspended", javaMajor: 0 },
      "This JDK cannot report memory while suspended. Resume the program, then refresh.",
    ],
    [{ kind: "programExited" }, "The program has exited."],
    [{ kind: "timedOut" }, "The JVM did not answer within 10 seconds."],
  ])("words the %j reason", async (reason, text) => {
    ipc.debugJvmMemoryClasses.mockReturnValue(ok(unavailable(reason)));
    render(<MemoryView session={session} />);
    expect(await screen.findByText(text)).toBeTruthy();
  });

  it("translates the toolbar and the attach hint in zh", async () => {
    await setLocale("zh");
    try {
      ipc.debugJvmMemoryClasses.mockReturnValue(ok(unavailable({ kind: "attachedJvmNotFound" })));
      render(<MemoryView session={session} />);
      expect(
        await screen.findByText(
          "Memory 视图需要本机上以 -XX:+StartAttachListener 启动的 JVM。由 IDE 调试的程序会自动添加该选项。",
        ),
      ).toBeTruthy();
      expect(screen.getByRole("button", { name: "刷新内存视图" }).getAttribute("data-tooltip")).toBe("刷新内存视图");
      const filter = screen.getByRole("textbox", { name: "筛选类" });
      expect(filter.getAttribute("placeholder")).toBe("筛选类");
      expect(screen.getByRole("checkbox", { name: "仅显示有变化的" })).toBeTruthy();
    } finally {
      await setLocale("en");
    }
  });

  it("marks the snapshot outdated after a stop of this session only", async () => {
    ipc.debugJvmMemoryClasses.mockReturnValue(ok(HEAP));
    const { rerender } = render(<MemoryView session={session} />);
    await screen.findByText("Heap$Live");
    const banner = "Taken before the last stop. Refresh to update.";
    expect(screen.queryByText(banner)).toBeNull();
    // A stop in another session, a value edit or a session switch bump the global counter only.
    act(() => useDebug.setState({ stopSeq: 5 }));
    expect(screen.queryByText(banner)).toBeNull();
    rerender(<MemoryView session={{ ...session, stops: 1 }} />);
    expect(screen.getByText(banner)).toBeTruthy();
    useDebug.setState({ sessions: { 1: { ...session, stops: 1 } } });
    ipc.debugJvmMemoryClasses.mockReturnValue(ok(HEAP));
    fireEvent.click(screen.getByRole("button", { name: "Refresh Memory View" }));
    await waitFor(() => expect(screen.queryByText(banner)).toBeNull());
  });

  it("does not call a missing snapshot outdated", async () => {
    ipc.debugJvmMemoryClasses.mockReturnValue(ok(unavailable({ kind: "programExited" })));
    render(<MemoryView session={session} />);
    await screen.findByText("The program has exited.");
    expect(screen.queryByText("Taken before the last stop. Refresh to update.")).toBeNull();
  });

  it("filters and toggles changed only", async () => {
    ipc.debugJvmMemoryClasses.mockReturnValue(ok(HEAP));
    render(<MemoryView session={session} />);
    await screen.findByText("Heap$Live");

    fireEvent.change(screen.getByRole("textbox", { name: "Filter classes" }), { target: { value: "cache" } });
    expect(screen.queryByText("Heap$Live")).toBeNull();
    expect(screen.getByText("Cache$Entry")).toBeTruthy();

    fireEvent.change(screen.getByRole("textbox", { name: "Filter classes" }), { target: { value: "" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Changed only" }));
    expect(screen.getByText("Heap$Live")).toBeTruthy();
    expect(screen.queryByText("Cache$Entry")).toBeNull();
    expect(screen.queryByText("Dup")).toBeNull();
  });

  it("sorts by the clicked column and reports it with aria-sort", async () => {
    ipc.debugJvmMemoryClasses.mockReturnValue(ok(HEAP));
    render(<MemoryView session={session} />);
    await screen.findByText("Heap$Live");
    const header = (name: string) => screen.getByRole("columnheader", { name });
    const body = () => screen.getAllByRole("rowgroup")[1]!;
    const order = () =>
      within(body())
        .getAllByRole("row")
        .map((o) => o.textContent?.slice(0, 3));

    expect(header("Shallow Size").getAttribute("aria-sort")).toBe("descending");
    expect(header("Class").getAttribute("aria-sort")).toBe("none");
    expect(order()).toEqual(["Hea", "Cac", "Dup"]);

    fireEvent.click(screen.getByRole("button", { name: "Class" }));
    expect(header("Class").getAttribute("aria-sort")).toBe("ascending");
    expect(order()).toEqual(["Cac", "Dup", "Hea"]);

    fireEvent.click(screen.getByRole("button", { name: "Class" }));
    expect(header("Class").getAttribute("aria-sort")).toBe("descending");
  });

  it("exposes the classes as a table whose cells sit under the column headers", async () => {
    ipc.debugJvmMemoryClasses.mockReturnValue(ok(HEAP));
    render(<MemoryView session={session} />);
    await screen.findByText("Heap$Live");
    const table = screen.getByRole("table", { name: "Memory" });
    expect(table.getAttribute("aria-rowcount")).toBe("4");
    const headers = within(table)
      .getAllByRole("columnheader")
      .map((h) => h.textContent);
    expect(headers).toEqual(["Class", "Count", "Diff", "Shallow Size"]);
    const [head, body] = within(table).getAllByRole("rowgroup");
    expect(within(head!).getByRole("row").getAttribute("aria-rowindex")).toBe("1");
    const rows = within(body!).getAllByRole("row");
    expect(rows.map((r) => r.getAttribute("aria-rowindex"))).toEqual(["2", "3", "4"]);
    const cells = within(rows[0]!)
      .getAllByRole("cell")
      .map((c) => c.textContent);
    expect(cells).toHaveLength(headers.length);
    expect(cells[0]).toContain("Heap$Live");
    expect(cells[3]).toBe("15.3 MB");
  });

  it("keeps the old snapshot under the reason when a refresh is refused", async () => {
    ipc.debugJvmMemoryClasses.mockReturnValueOnce(ok(HEAP));
    render(<MemoryView session={session} />);
    await screen.findByText("Heap$Live");
    ipc.debugJvmMemoryClasses.mockReturnValueOnce(ok(unavailable({ kind: "unsafeWhileSuspended", javaMajor: 11 })));
    fireEvent.click(screen.getByRole("button", { name: "Refresh Memory View" }));
    const reason = "JDK 11 cannot report memory while suspended. Resume the program, then refresh.";
    expect((await screen.findByText(reason)).getAttribute("role")).toBe("status");
    expect(screen.getByText("Heap$Live")).toBeTruthy();
  });

  it("shows the reason alone when there is no earlier snapshot", async () => {
    ipc.debugJvmMemoryClasses.mockReturnValue(ok(unavailable({ kind: "timedOut" })));
    render(<MemoryView session={session} />);
    expect((await screen.findByText("The JVM did not answer within 10 seconds.")).getAttribute("role")).toBeNull();
    expect(screen.queryByRole("columnheader")).toBeNull();
  });

  it("keeps the old snapshot and shows the error when a refresh fails", async () => {
    ipc.debugJvmMemoryClasses.mockReturnValueOnce(ok(HEAP));
    render(<MemoryView session={session} />);
    await screen.findByText("Heap$Live");
    ipc.debugJvmMemoryClasses.mockReturnValueOnce(fail("boom"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh Memory View" }));
    expect((await screen.findByRole("alert")).textContent).toBe("boom");
    expect(screen.getByText("Heap$Live")).toBeTruthy();
  });

  describe("instances", () => {
    const ORDER_ROWS = [row("com.x.Order", { instances: 3, bytes: 72 }), row("com.x.Line", { bytes: 8 })];
    const ORDERS = ready(ORDER_ROWS);
    const rowOf = (name: string) => screen.getByText(name).closest<HTMLElement>("[role=row]")!;
    const body = () => screen.getAllByRole("rowgroup")[1]!;

    it("opens the instances of the selected class with Enter", async () => {
      ipc.debugJvmMemoryClasses.mockReturnValue(ok(ORDERS));
      ipc.debugJvmMemoryInstances.mockReturnValue(ok(NO_INSTANCES));
      render(<MemoryView session={withInstances} />);
      await screen.findByText("com.x.Order");
      fireEvent.mouseDown(rowOf("com.x.Line"), { button: 0 });
      fireEvent.click(rowOf("com.x.Line"));
      // A click only selects.
      expect(ipc.debugJvmMemoryInstances).not.toHaveBeenCalled();
      expect(useMemory.getState().bySession[1]!.selected).toBe("com.x.Line");
      fireEvent.keyDown(body(), { key: "ArrowUp" });
      expect(useMemory.getState().bySession[1]!.selected).toBe("com.x.Order");
      fireEvent.keyDown(body(), { key: "Enter" });
      await waitFor(() => expect(ipc.debugJvmMemoryInstances).toHaveBeenCalledWith(1, "com.x.Order", 1000));
      expect(await screen.findByText("Instances of com.x.Order")).toBeTruthy();
    });

    it("Enter on a row's Show Instances button opens that row's class, not the selected one", async () => {
      const user = userEvent.setup();
      ipc.debugJvmMemoryClasses.mockReturnValue(ok(ORDERS));
      ipc.debugJvmMemoryInstances.mockReturnValue(ok(NO_INSTANCES));
      render(<MemoryView session={withInstances} />);
      await screen.findByText("com.x.Order");
      fireEvent.mouseDown(rowOf("com.x.Order"), { button: 0 });
      expect(useMemory.getState().bySession[1]!.selected).toBe("com.x.Order");
      within(rowOf("com.x.Line")).getByRole("button", { name: "Show Instances" }).focus();
      await user.keyboard("{Enter}");
      await waitFor(() => expect(ipc.debugJvmMemoryInstances).toHaveBeenCalledWith(1, "com.x.Line", 1000));
      expect(ipc.debugJvmMemoryInstances).toHaveBeenCalledTimes(1);
    });

    it("opens the instances of a class with a double-click or its row button", async () => {
      ipc.debugJvmMemoryClasses.mockReturnValue(ok(ORDERS));
      ipc.debugJvmMemoryInstances.mockReturnValue(ok(NO_INSTANCES));
      render(<MemoryView session={withInstances} />);
      await screen.findByText("com.x.Order");
      fireEvent.doubleClick(screen.getByText("com.x.Line"));
      await waitFor(() => expect(ipc.debugJvmMemoryInstances).toHaveBeenLastCalledWith(1, "com.x.Line", 1000));
      fireEvent.click(within(rowOf("com.x.Order")).getByRole("button", { name: "Show Instances" }));
      await waitFor(() => expect(ipc.debugJvmMemoryInstances).toHaveBeenLastCalledWith(1, "com.x.Order", 1000));
    });

    it("has no Show Instances button without jvmInstances", async () => {
      ipc.debugJvmMemoryClasses.mockReturnValue(ok(ORDERS));
      render(<MemoryView session={session} />);
      await screen.findByText("com.x.Order");
      expect(screen.queryByRole("button", { name: "Show Instances" })).toBeNull();
      fireEvent.mouseDown(rowOf("com.x.Order"), { button: 0 });
      fireEvent.keyDown(body(), { key: "Enter" });
      fireEvent.doubleClick(screen.getByText("com.x.Order"));
      expect(ipc.debugJvmMemoryInstances).not.toHaveBeenCalled();
    });

    it("hides Shallow Size for debugger counts", async () => {
      ipc.debugJvmMemoryClasses.mockReturnValue(ok(debuggerCounts(ORDER_ROWS)));
      render(<MemoryView session={withInstances} />);
      await screen.findByText("com.x.Order");
      const headers = screen.getAllByRole("columnheader").map((h) => h.textContent);
      expect(headers).toEqual(["Class", "Count", "Diff"]);
      expect(within(rowOf("com.x.Order")).getAllByRole("cell")).toHaveLength(3);
      // Without sizes the table sorts by count.
      expect(screen.getByRole("columnheader", { name: "Count" }).getAttribute("aria-sort")).toBe("descending");
      expect(screen.getByText("Counted by the debugger: reachable objects only, no sizes.")).toBeTruthy();
      expect(screen.queryByText("Counts include objects that are unreachable but not yet collected.")).toBeNull();
      expect(screen.getByText("2 classes · 4 objects")).toBeTruthy();
    });

    it("offers counting when paused", async () => {
      ipc.debugJvmMemoryClasses.mockReturnValue(
        ok({ status: "unavailable", reason: { kind: "listenerNotRunning" }, canCountWhenPaused: true }),
      );
      render(<MemoryView session={{ ...session, status: "running" }} />);
      expect(
        await screen.findByText(
          "The JVM does not accept attach requests. Restart the debug session without -XX:+DisableAttachMechanism.",
        ),
      ).toBeTruthy();
      expect(screen.getByText("Pause the program to count objects through the debugger.")).toBeTruthy();
    });

    it("says the debugger is counting while paused", async () => {
      ipc.debugJvmMemoryClasses.mockReturnValue(new Promise(() => {}));
      const counting = "Counting objects through the debugger. This can take several seconds on a large heap.";
      const { unmount } = render(<MemoryView session={withInstances} />);
      expect(await screen.findByText(counting)).toBeTruthy();
      unmount();
      render(<MemoryView session={session} />);
      expect(screen.queryByText(counting)).toBeNull();
    });

    it.each([
      [{ kind: "unsupported", detail: "no VM field" }, "The debugger cannot list instances: no VM field"],
      [{ kind: "degraded", detail: "id in range" }, "The debugger link stopped reading the JVM. Debugging continues."],
      [{ kind: "closed" }, "The connection to the JVM is closed."],
    ] as const)("explains the %j instance backend and keeps the table", async (jvmBackend, text) => {
      ipc.debugJvmMemoryClasses.mockReturnValue(ok(ORDERS));
      render(<MemoryView session={{ ...session, jvmBackend }} />);
      expect(await screen.findByText(text)).toBeTruthy();
      expect(screen.getByText("com.x.Order")).toBeTruthy();
    });

    it("shows the instances of the open class under the table", async () => {
      ipc.debugJvmMemoryClasses.mockReturnValue(ok(ORDERS));
      ipc.debugJvmMemoryInstances.mockReturnValue(ok(NO_INSTANCES));
      await showInstances(1, "com.x.Order");
      render(<MemoryView session={withInstances} />);
      expect(await screen.findByText("Instances of com.x.Order")).toBeTruthy();
      expect(screen.getByRole("table", { name: "Memory" })).toBeTruthy();
    });
  });
});
