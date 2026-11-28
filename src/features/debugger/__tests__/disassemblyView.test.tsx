import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const ipc = vi.hoisted(() => ({
  debugDisassemble: vi.fn(),
  debugScopes: vi.fn(),
  debugVariables: vi.fn(),
}));

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return { ...real, commands: { ...real.commands, ...ipc } };
});

import type { DebugCapabilities, Instruction, StackFrame } from "@/platform/ipc";
import { registerActions } from "@/platform/actions";
import { setLocale } from "@/platform/i18n";
import { hideContextMenu, useContextMenuStore } from "@/ui/Menu";
import { useDebug, type DebugSession } from "../state";
import { DebugToolWindow } from "../ui/DebugToolWindow";
import { revealDisassembly, useDisassembly } from "../disassembly/disassemblyState";

const ok = <T,>(data: T) => Promise.resolve({ status: "ok" as const, data });
const fail = (message: string) =>
  Promise.resolve({ status: "error" as const, error: { kind: "invalidInput", message } });

/** A program of 4-byte instructions from 0x401000 (`sum`) to 0x402000; `before` works like lldb-dap's. */
function program(reference: string, before: number, count: number): Instruction[] {
  const start = Number(BigInt(reference)) - 4 * before;
  return Array.from({ length: count }, (_, i) => start + 4 * i)
    .filter((a) => a >= 0x401000 && a < 0x402000)
    .map((a) => ({
      address: `0x${a.toString(16)}`,
      instruction: `insn ${(a - 0x401000) / 4}`,
      bytes: "488b45d8",
      symbol: a === 0x401000 ? "sum" : null,
    }));
}

const caps = (p: Partial<DebugCapabilities>) =>
  ({ disassemble: true, instructionStepping: true, ...p }) as DebugCapabilities;

const frame = (id: number, name: string, pc: string | null, path: string | null = "/p/main.c"): StackFrame => ({
  id,
  name,
  path,
  line: 13,
  column: 0,
  presentationHint: null,
  instructionPointerReference: pc,
});

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
  frames: [frame(0, "sum", "0x401100"), frame(1, "run", "0x401f00")],
  selectedFrame: 0,
  hits: 1,
  stops: 1,
  exitCode: null,
  caps: caps({}),
};

const reads = () => ipc.debugDisassemble.mock.calls.map((c) => c.slice(1));
const currentRow = () => screen.getAllByRole("row").find((r) => r.getAttribute("aria-current") === "location");
const currentAddress = () => (currentRow() ? within(currentRow()!).getByRole("rowheader").textContent : null);
const patchSession = (p: Partial<DebugSession>) =>
  act(() => useDebug.setState((s) => ({ sessions: { 1: { ...s.sessions[1]!, ...p } } })));

function openTab() {
  render(<DebugToolWindow />);
  fireEvent.click(screen.getByRole("tab", { name: "Disassembly" }));
}

beforeEach(() => {
  setLocale("en");
  useDisassembly.setState({ bySession: {}, revealPending: false });
  useDebug.setState({ sessions: { 1: session }, active: 1 });
  ipc.debugDisassemble.mockImplementation((_s: number, reference: string, before: number, count: number) =>
    Number(BigInt(reference)) < 0x1000
      ? fail(`disassemble failed: Cannot access memory at address ${reference}`)
      : ok(program(reference, before, count)),
  );
  ipc.debugScopes.mockImplementation(() => ok([]));
  ipc.debugVariables.mockImplementation(() => ok([]));
});

afterEach(() => {
  cleanup();
  hideContextMenu();
  vi.clearAllMocks();
});

describe("Disassembly view", () => {
  it("is a tab of sessions whose adapter disassembles, and only those", () => {
    useDebug.setState({ sessions: { 1: { ...session, caps: caps({ disassemble: false }) } } });
    const { unmount } = render(<DebugToolWindow />);
    expect(screen.queryByRole("tab", { name: "Disassembly" })).toBeNull();
    unmount();
    useDebug.setState({ sessions: { 1: session } });
    render(<DebugToolWindow />);
    expect(screen.getByRole("tab", { name: "Disassembly" })).toBeTruthy();
  });

  it("shows the selected frame's instructions with the current one highlighted", async () => {
    openTab();
    await waitFor(() => expect(currentAddress()).toBe("0x00401100"));
    expect(reads()).toEqual([["0x401100", 32, 128]]);
    const row = currentRow()!;
    const [bytes, instruction] = within(row).getAllByRole("gridcell");
    expect(bytes!.textContent).toBe("48 8B 45 D8");
    expect(instruction!.textContent).toBe("insn 64");
    expect(screen.getByRole("grid", { name: "Disassembly" })).toBeTruthy();
  });

  it("moves the highlight through the instructions shown while stepping, and reads again past them", async () => {
    openTab();
    await waitFor(() => expect(currentAddress()).toBe("0x00401100"));
    // A step to an instruction already shown reads nothing.
    patchSession({ status: "running", frames: [], selectedFrame: null });
    expect(screen.getByText("Instructions are shown while the program is paused.")).toBeTruthy();
    patchSession({
      status: "paused",
      stops: 2,
      stopReason: "step",
      frames: [frame(0, "sum", "0x401104")],
      selectedFrame: 0,
    });
    await waitFor(() => expect(currentAddress()).toBe("0x00401104"));
    expect(reads()).toHaveLength(1);
    // One outside them (a call into another function) reads around it.
    patchSession({ stops: 3, frames: [frame(0, "parse", "0x401e00")], selectedFrame: 0 });
    await waitFor(() => expect(currentAddress()).toBe("0x00401E00"));
    expect(reads().at(-1)).toEqual(["0x401e00", 32, 128]);
  });

  it("follows frame selection, also to frames without source", async () => {
    useDebug.setState({
      sessions: {
        1: { ...session, frames: [frame(9, "atoi@plt", "0x401040", null), ...session.frames], selectedFrame: 9 },
      },
    });
    openTab();
    await waitFor(() => expect(currentAddress()).toBe("0x00401040"));
    expect(screen.getByText("atoi@plt")).toBeTruthy();
    // `sum` was shown at its start: its symbol labels the instructions that follow.
    expect(screen.getByText("sum:")).toBeTruthy();
    patchSession({ selectedFrame: 0 });
    await waitFor(() => expect(currentAddress()).toBe("0x00401100"));
    patchSession({ selectedFrame: 1 });
    await waitFor(() => expect(currentAddress()).toBe("0x00401F00"));
  });

  it("says why there is nothing to show, and does not ask again for the same address", async () => {
    useDebug.setState({ sessions: { 1: { ...session, frames: [frame(0, "??", "0x10")] } } });
    openTab();
    expect((await screen.findByRole("alert")).textContent).toBe(
      "disassemble failed: Cannot access memory at address 0x10",
    );
    patchSession({ stops: 2 });
    expect(reads()).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(reads()).toHaveLength(2));
    patchSession({ frames: [frame(0, "jit", null)] });
    expect(screen.getByText("The debugger gives no instruction address for this frame.")).toBeTruthy();
  });

  it("offers instruction steps, disabled with the reason where the adapter has none", async () => {
    const stepOver = vi.fn();
    const unregister = registerActions([
      { id: "debug.stepOverInstruction", title: "Step Over Instruction", run: stepOver },
      { id: "debug.stepIntoInstruction", title: "Step Into Instruction", run: vi.fn() },
    ]);
    openTab();
    fireEvent.click(screen.getByRole("button", { name: "Step Over Instruction" }));
    expect(stepOver).toHaveBeenCalled();
    patchSession({ caps: caps({ instructionStepping: false }) });
    const button = screen.getByRole("button", { name: "Step Over Instruction" });
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(button.getAttribute("data-tooltip") ?? button.getAttribute("title") ?? "").toContain(
      "Instruction stepping is not supported by gdb",
    );
    unregister();
  });

  it("is offered on frames with an instruction address", async () => {
    const show = vi.fn();
    const unregister = registerActions([
      { id: "debug.showDisassembly", title: "Show Disassembly", run: ({ arg }) => show(arg) },
    ]);
    render(<DebugToolWindow />);
    fireEvent.click(screen.getByRole("tab", { name: "Threads & Variables" }));
    fireEvent.contextMenu(await screen.findByText("run"));
    const item = useContextMenuStore
      .getState()
      .menu!.items.find((i) => "label" in i && i.label === "Show Disassembly") as {
      run: () => void;
      disabled?: boolean;
    };
    expect(item.disabled).toBe(false);
    act(() => item.run());
    await waitFor(() => expect(show).toHaveBeenCalledWith(1));
    hideContextMenu();
    patchSession({ caps: caps({ disassemble: false }) });
    fireEvent.contextMenu(await screen.findByText("run"));
    const labels = useContextMenuStore.getState().menu!.items.map((i) => ("label" in i ? i.label : "-"));
    expect(labels).not.toContain("Show Disassembly");
    unregister();
  });

  it("comes to the front when Show Disassembly asks for it", () => {
    render(<DebugToolWindow />);
    fireEvent.click(screen.getByRole("tab", { name: "Console" }));
    act(() => revealDisassembly());
    expect(screen.getByRole("tab", { name: "Disassembly" }).getAttribute("aria-selected")).toBe("true");
    expect(useDisassembly.getState().revealPending).toBe(false);
  });
});
