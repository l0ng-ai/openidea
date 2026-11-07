import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const ipc = vi.hoisted(() => ({ debugJvmMemoryClasses: vi.fn() }));

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return { ...real, isTauri: () => true, commands: { ...real.commands, ...ipc } };
});

import type { JvmClassRow, JvmMemoryResult, JvmMemoryUnavailable } from "@/platform/ipc";
import { useDebug, type DebugSession } from "../state";
import { registerActions } from "@/platform/actions";
import { setLocale } from "@/platform/i18n";
import { refreshMemory, useMemory } from "../memory/memoryState";
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
  },
});

const unavailable = (reason: JvmMemoryUnavailable): JvmMemoryResult => ({ status: "unavailable", reason });
const ok = <T,>(data: T) => Promise.resolve({ status: "ok" as const, data });
const fail = (message: string) => Promise.resolve({ status: "error" as const, error: { kind: "internal", message } });

const HEAP = ready([
  row("Heap$Live", { module: "java.base", instances: 1_000_000, bytes: 16_000_000, deltaInstances: 3 }),
  row("Cache$Entry", { instances: 40, bytes: 2_000, deltaInstances: 0 }),
  row("Dup", { instances: 2, bytes: 64, ambiguous: true }),
]);

let unregister: () => void;

beforeEach(() => {
  useMemory.setState({ bySession: {} });
  useDebug.setState({ sessions: { 1: session }, active: 1, stopSeq: 0 });
  ipc.debugJvmMemoryClasses.mockReset();
  // The real action lives in actions.ts (covered by actions.test.ts); the button only needs its id to resolve.
  unregister = registerActions([
    { id: "debug.memory.refresh", title: "Refresh Memory View", run: () => void refreshMemory(1) },
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
    expect(screen.getByText("1,000,000")).toBeTruthy();
    expect(screen.getByText("15.3 MB")).toBeTruthy();
    expect(screen.getByText("+3")).toBeTruthy();
    expect(screen.getByText("3 classes · 1,000,042 objects · 15.3 MB")).toBeTruthy();
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
    const order = () => screen.getAllByRole("option").map((o) => o.textContent?.slice(0, 3));

    expect(header("Shallow Size").getAttribute("aria-sort")).toBe("descending");
    expect(header("Class").getAttribute("aria-sort")).toBe("none");
    expect(order()).toEqual(["Hea", "Cac", "Dup"]);

    fireEvent.click(screen.getByRole("button", { name: "Class" }));
    expect(header("Class").getAttribute("aria-sort")).toBe("ascending");
    expect(order()).toEqual(["Cac", "Dup", "Hea"]);

    fireEvent.click(screen.getByRole("button", { name: "Class" }));
    expect(header("Class").getAttribute("aria-sort")).toBe("descending");
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
});
