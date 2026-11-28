import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const ipc = vi.hoisted(() => ({
  debugReadMemory: vi.fn(),
  debugEvaluateIn: vi.fn(),
  debugScopes: vi.fn(),
  debugVariables: vi.fn(),
}));

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return { ...real, commands: { ...real.commands, ...ipc } };
});

import type { DebugCapabilities, MemoryBlock, Variable } from "@/platform/ipc";
import { registerActions } from "@/platform/actions";
import { setLocale } from "@/platform/i18n";
import { hideContextMenu, useContextMenuStore } from "@/ui/Menu";
import { addWatch, removeAllWatches, useDebug, type DebugSession } from "../state";
import { DebugToolWindow } from "../ui/DebugToolWindow";
import { revealMemoryView, showMemoryAt, useMemoryView } from "../memoryView/memoryViewState";

const ok = <T,>(data: T) => Promise.resolve({ status: "ok" as const, data });
const fail = (message: string) =>
  Promise.resolve({ status: "error" as const, error: { kind: "invalidInput", message } });

// The reporter's `msg` (#5921) at the address GDB gave it, 9 bytes into its row.
const MSG = "Hello, World!\n\0";
const MSG_AT = 0x7fffffff9f69;

/** A process whose memory is `MSG` at `MSG_AT` and each other byte's low address byte; nothing below 0x1000 is mapped. */
function memoryAt(reference: string, offset: number, count: number): MemoryBlock {
  const start = Number(BigInt(reference)) + offset;
  const data = Array.from({ length: count }, (_, i) => {
    const a = start + i;
    return a >= MSG_AT && a < MSG_AT + MSG.length ? MSG.charCodeAt(a - MSG_AT) : a & 0xff;
  });
  return { address: `0x${start.toString(16)}`, data, unreadableBytes: 0 };
}

const caps = (readMemory: boolean) => ({ readMemory }) as DebugCapabilities;

const session: DebugSession = {
  id: 1,
  name: "app-c",
  adapter: "gdb",
  parent: null,
  launch: null,
  process: null,
  status: "paused",
  stoppedThread: 1,
  stopReason: "breakpoint",
  stopDescription: null,
  threads: [{ id: 1, name: "main" }],
  selectedThread: 1,
  frames: [{ id: 7, name: "run", path: "/p/src/main.c", line: 13, column: 0, presentationHint: null }],
  selectedFrame: 7,
  hits: 1,
  stops: 1,
  exitCode: null,
  caps: caps(true),
};

const variable = (p: Partial<Variable>): Variable => ({
  name: "x",
  value: "",
  typeName: null,
  variablesReference: 0,
  evaluateName: null,
  ...p,
});

function readArgs() {
  return ipc.debugReadMemory.mock.calls.map((c) => c.slice(1));
}

async function goTo(expression: string) {
  const field = screen.getByRole("textbox", { name: "Address or expression" });
  fireEvent.change(field, { target: { value: expression } });
  fireEvent.submit(field.closest("form")!);
}

beforeEach(() => {
  setLocale("en");
  useMemoryView.setState({ bySession: {}, revealPending: false });
  useDebug.setState({ sessions: { 1: session }, active: 1 });
  ipc.debugReadMemory.mockImplementation((_s: number, reference: string, offset: number, count: number) =>
    Number(BigInt(reference)) + offset < 0x1000
      ? fail(
          `readMemory failed: Cannot access memory at address 0x${(Number(BigInt(reference)) + offset).toString(16)}`,
        )
      : ok(memoryAt(reference, offset, count)),
  );
  ipc.debugEvaluateIn.mockImplementation((_s: number, _f: number | null, expression: string) => {
    if (expression === "&msg[0]")
      return ok(
        variable({ name: expression, value: `0x7fffffff9f69 "Hello, World!\\n"`, memoryReference: "0x7fffffff9f69" }),
      );
    if (expression === "0x2000") return ok(variable({ name: expression, value: "8192", typeName: "long" }));
    if (expression === "total") return ok(variable({ name: expression, value: "{a = 1}", typeName: "struct t" }));
    if (expression === "null_ptr") return ok(variable({ name: expression, value: "0x0", memoryReference: "0x0" }));
    return fail(`No symbol "${expression}" in current context.`);
  });
  ipc.debugScopes.mockImplementation(() => ok([{ name: "Locals", variablesReference: 1, expensive: false }]));
  ipc.debugVariables.mockImplementation(() =>
    ok([
      variable({
        name: "items",
        value: "0x7fffffff9f40",
        typeName: "const char **",
        evaluateName: "items",
        memoryReference: "0x7fffffff9f40",
      }),
      variable({ name: "total", value: "6", typeName: "int", evaluateName: "total" }),
    ]),
  );
});

afterEach(() => {
  cleanup();
  hideContextMenu();
  vi.clearAllMocks();
});

describe("native Memory View", () => {
  it("is a tab of sessions whose adapter reads memory, and only those", () => {
    useDebug.setState({ sessions: { 1: { ...session, caps: caps(false) } } });
    const { unmount } = render(<DebugToolWindow />);
    expect(screen.queryByRole("tab", { name: "Memory View" })).toBeNull();
    unmount();
    useDebug.setState({ sessions: { 1: session } });
    render(<DebugToolWindow />);
    fireEvent.click(screen.getByRole("tab", { name: "Memory View" }));
    expect(screen.getByText("Enter an address or an expression, or choose View Memory on a variable.")).toBeTruthy();
    // A JVM session's own Memory tab is a different view.
    expect(screen.queryByRole("tab", { name: "Memory" })).toBeNull();
  });

  it("shows the bytes at an address expression in aligned address, hex and ASCII columns", async () => {
    render(<DebugToolWindow />);
    fireEvent.click(screen.getByRole("tab", { name: "Memory View" }));
    await goTo("&msg[0]");
    await waitFor(() => expect(screen.getAllByRole("row")).toHaveLength(1 + 16));
    expect(ipc.debugEvaluateIn).toHaveBeenCalledWith(1, 7, "&msg[0]", "watch");
    // One read of a page, from the start of the row that holds the address.
    expect(readArgs()).toEqual([["0x7fffffff9f69", -9, 256]]);
    const [, first, second] = screen.getAllByRole("row");
    expect(within(first!).getByRole("rowheader").textContent).toBe("0x00007FFFFFFF9F60");
    expect(within(second!).getByRole("rowheader").textContent).toBe("0x00007FFFFFFF9F70");
    const [hex, ascii] = within(first!).getAllByRole("gridcell");
    expect(hex!.textContent).toBe("606162636465666768" + "48656C6C6F2C20");
    expect(ascii!.textContent).toBe("`abcdefghHello, ");
    expect(within(second!).getAllByRole("gridcell")[1]!.textContent!.slice(0, 8)).toBe("World!..");
    // The byte at the address is marked, in both columns.
    const marked = first!.querySelectorAll("[class*=target]");
    expect([...marked].map((m) => m.textContent)).toEqual(["48", "H"]);
  });

  it("turns pages and reads the page again after each stop", async () => {
    render(<DebugToolWindow />);
    fireEvent.click(screen.getByRole("tab", { name: "Memory View" }));
    await goTo("&msg[0]");
    await waitFor(() => expect(readArgs()).toHaveLength(1));
    fireEvent.click(await screen.findByRole("button", { name: "Next Page" }));
    await waitFor(() => expect(readArgs().at(-1)).toEqual(["0x7fffffff9f69", 247, 256]));
    fireEvent.click(await screen.findByRole("button", { name: "Previous Page" }));
    await waitFor(() => expect(readArgs().at(-1)).toEqual(["0x7fffffff9f69", -9, 256]));
    const before = readArgs().length;

    // Running: nothing is read; the next stop reads the same page again.
    act(() => useDebug.setState({ sessions: { 1: { ...session, status: "running" } } }));
    expect(screen.getByText("Memory is read while the program is paused.")).toBeTruthy();
    expect(readArgs()).toHaveLength(before);
    act(() => useDebug.setState({ sessions: { 1: { ...session, stops: 2, stopReason: "step" } } }));
    await waitFor(() => expect(readArgs()).toHaveLength(before + 1));
    expect(readArgs().at(-1)).toEqual(["0x7fffffff9f69", -9, 256]);
    expect(screen.getByRole("tab", { name: "Memory View" }).getAttribute("aria-selected")).toBe("true");
  });

  it("says why memory cannot be shown, and the session goes on", async () => {
    render(<DebugToolWindow />);
    fireEvent.click(screen.getByRole("tab", { name: "Memory View" }));
    await goTo("null_ptr");
    expect((await screen.findByRole("alert")).textContent).toBe(
      "readMemory failed: Cannot access memory at address 0x0",
    );
    await goTo("total");
    expect((await screen.findByRole("alert")).textContent).toBe(
      "“total” is not an address. Enter a pointer or an address, such as &buffer[0].",
    );
    await goTo("nope");
    expect((await screen.findByRole("alert")).textContent).toBe('No symbol "nope" in current context.');
    // A number is an address: its value is read as one.
    await goTo("0x2000");
    await waitFor(() => expect(readArgs().at(-1)).toEqual(["0x2000", 0, 256]));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(useDebug.getState().sessions[1]!.status).toBe("paused");
  });

  it("aligns pages of references that are not addresses after a first read", async () => {
    ipc.debugReadMemory.mockImplementation((_s: number, _reference: string, offset: number, count: number) =>
      ok(memoryAt(`${MSG_AT}`, offset, count)),
    );
    await act(() => showMemoryAt(1, "mem:frame/7", "buffer"));
    expect(readArgs()).toEqual([
      ["mem:frame/7", 0, 256],
      ["mem:frame/7", -9, 256],
    ]);
    expect(useMemoryView.getState().bySession[1]).toMatchObject({ start: -9, target: BigInt(MSG_AT) });
  });

  it("offers View Memory on variables and watches with a memory reference", async () => {
    const viewMemory = vi.fn();
    const unregister = registerActions([
      { id: "debug.viewMemory", title: "View Memory", run: ({ arg }) => viewMemory(arg) },
    ]);
    render(<DebugToolWindow />);
    fireEvent.click(screen.getByRole("tab", { name: "Threads & Variables" }));
    const labels = async (name: string) => {
      fireEvent.contextMenu((await screen.findByText(name)).closest("[role=treeitem]")!);
      return (useContextMenuStore.getState().menu?.items ?? []).map((i) => ("label" in i ? i.label : "-"));
    };
    expect(await labels("total")).toContain("Copy Value");
    expect(await labels("total")).not.toContain("View Memory");
    hideContextMenu();
    expect(await labels("items")).toContain("View Memory");
    const view = useContextMenuStore.getState().menu!.items.find((i) => "label" in i && i.label === "View Memory");
    act(() => (view as { run: () => void }).run());
    await waitFor(() => expect(viewMemory).toHaveBeenCalledWith("0x7fffffff9f40"));
    hideContextMenu();
    // A watch carries its evaluation result's reference.
    act(() => addWatch("&msg[0]"));
    expect(await labels("&msg[0]")).toContain("View Memory");
    const watch = useContextMenuStore.getState().menu!.items.find((i) => "label" in i && i.label === "View Memory");
    act(() => (watch as { run: () => void }).run());
    await waitFor(() => expect(viewMemory).toHaveBeenLastCalledWith("0x7fffffff9f69"));
    hideContextMenu();
    // Not where the adapter cannot read memory.
    act(() => useDebug.setState({ sessions: { 1: { ...session, caps: caps(false) } } }));
    expect(await labels("items")).not.toContain("View Memory");
    hideContextMenu();
    act(() => removeAllWatches());
    unregister();
  });

  it("comes to the front when View Memory asks for it", () => {
    render(<DebugToolWindow />);
    fireEvent.click(screen.getByRole("tab", { name: "Console" }));
    act(() => revealMemoryView());
    expect(screen.getByRole("tab", { name: "Memory View" }).getAttribute("aria-selected")).toBe("true");
    expect(useMemoryView.getState().revealPending).toBe(false);
  });

  it("opens on the Memory View when View Memory opened the tool window", () => {
    act(() => revealMemoryView());
    render(<DebugToolWindow />);
    expect(screen.getByRole("tab", { name: "Memory View" }).getAttribute("aria-selected")).toBe("true");
  });
});
