/** Disassembly view (DAP `disassemble`): the instructions each session's view shows, and reading them. */
import { create } from "zustand";
import { call, commands, type DebugSessionId, type Instruction } from "@/platform/ipc";
import { parseAddress } from "../memoryView/bytes";
import { useDebug } from "../state";

/** Instructions read ahead of the program counter (adapters that cannot go back start at it), and in all. */
export const BEFORE = 32;
export const COUNT = 128;

export interface DisassemblyEntry {
  instructions: Instruction[];
  /** The instruction pointer the last read was for. */
  reference: string | null;
  error: string | null;
  loading: boolean;
}

interface DisassemblyState {
  bySession: Record<DebugSessionId, DisassemblyEntry>;
  /** Set by Show Disassembly until the Debug tool window has brought the Disassembly view to the front. */
  revealPending: boolean;
}

export const useDisassembly = create<DisassemblyState>(() => ({ bySession: {}, revealPending: false }));

const emptyEntry = (): DisassemblyEntry => ({ instructions: [], reference: null, error: null, loading: false });

/** The read each session waits for; a newer one (or `forgetDisassembly`) makes an older reply stale. */
const inflight = new Map<DebugSessionId, symbol>();

function patchEntry(id: DebugSessionId, patch: Partial<DisassemblyEntry>) {
  useDisassembly.setState((s) => ({
    bySession: { ...s.bySession, [id]: { ...(s.bySession[id] ?? emptyEntry()), ...patch } },
  }));
}

/** Whether `a` and `b` are the same address (`0x00401000` and `0x401000`). */
export function sameAddress(a: string, b: string): boolean {
  const x = parseAddress(a);
  return x === null ? a === b : x === parseAddress(b);
}

/** Reads the instructions around `pc`, whatever is shown. */
export async function readInstructions(id: DebugSessionId, pc: string): Promise<void> {
  const session = useDebug.getState().sessions[id];
  if (!session || session.status !== "paused") return;
  const token = Symbol("disassembly");
  inflight.set(id, token);
  patchEntry(id, { reference: pc, loading: true });
  try {
    const instructions = await call(commands.debugDisassemble(id, pc, BEFORE, COUNT));
    if (inflight.get(id) !== token) return;
    patchEntry(id, { instructions, error: null });
  } catch (e) {
    if (inflight.get(id) !== token) return;
    patchEntry(id, { instructions: [], error: e instanceof Error ? e.message : String(e) });
  } finally {
    if (inflight.get(id) === token) {
      inflight.delete(id);
      patchEntry(id, { loading: false });
    }
  }
}

/**
 * Shows the instructions around `pc`, the selected frame's instruction pointer. Instructions already
 * shown stay when they hold it, so the highlight moves through them while stepping; a failed read is
 * not repeated for the same `pc` (Refresh does that).
 */
export function showInstructionsAt(id: DebugSessionId, pc: string): Promise<void> {
  const entry = useDisassembly.getState().bySession[id];
  if (entry?.instructions.some((i) => sameAddress(i.address, pc))) return Promise.resolve();
  if (entry?.reference === pc && (entry.loading || entry.error)) return Promise.resolve();
  return readInstructions(id, pc);
}

export function revealDisassembly(): void {
  useDisassembly.setState({ revealPending: true });
}

/** The Debug tool window shows the Disassembly view: the request is done. */
export function disassemblyRevealed(): void {
  useDisassembly.setState({ revealPending: false });
}

export function forgetDisassembly(id: DebugSessionId): void {
  inflight.delete(id);
  useDisassembly.setState((s) => {
    if (!(id in s.bySession)) return s;
    const { [id]: _gone, ...rest } = s.bySession;
    return { bySession: rest };
  });
}
