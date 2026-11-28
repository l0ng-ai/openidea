/** Native Memory View (DAP `readMemory`): what each session's view shows, and reading it. */
import { create } from "zustand";
import { call, commands, type DebugSessionId, type MemoryBlock } from "@/platform/ipc";
import { formatMessage, tx } from "@/platform/i18n";
import { evaluate, useDebug } from "../state";
import { PAGE_BYTES, parseAddress, rowOffset } from "./bytes";

export interface MemoryViewEntry {
  /** What the address field shows. */
  expression: string;
  /** The memory reference pages are read relative to: an evaluation result's or a variable's. */
  reference: string | null;
  /** Address of `reference` once known: the byte the view marks. */
  target: bigint | null;
  /** Offset from `reference` of the page shown; it starts a row. */
  start: number;
  block: MemoryBlock | null;
  error: string | null;
  loading: boolean;
  /** The session's `stops` when `block` (or `error`) was read: a later stop reads the page again. */
  readAtStop: number;
}

interface MemoryViewState {
  bySession: Record<DebugSessionId, MemoryViewEntry>;
  /** Set by View Memory until the Debug tool window has brought the Memory View to the front. */
  revealPending: boolean;
}

export const useMemoryView = create<MemoryViewState>(() => ({ bySession: {}, revealPending: false }));

const emptyEntry = (): MemoryViewEntry => ({
  expression: "",
  reference: null,
  target: null,
  start: 0,
  block: null,
  error: null,
  loading: false,
  readAtStop: -1,
});

/** The read each session waits for; a newer one (or `forgetMemoryView`) makes an older reply stale. */
const inflight = new Map<DebugSessionId, symbol>();

function patchEntry(id: DebugSessionId, patch: Partial<MemoryViewEntry>) {
  useMemoryView.setState((s) => ({
    bySession: { ...s.bySession, [id]: { ...(s.bySession[id] ?? emptyEntry()), ...patch } },
  }));
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Reads the page at the entry's `start`. Before the reference's address is known (references
 * are opaque in DAP), a first read at the reference itself tells it, and the page then moves back
 * to the start of its row.
 */
export async function readPage(id: DebugSessionId): Promise<void> {
  const entry = useMemoryView.getState().bySession[id];
  const session = useDebug.getState().sessions[id];
  if (!entry?.reference || !session || session.status !== "paused") return;
  const reference = entry.reference;
  const token = Symbol("memory view");
  inflight.set(id, token);
  const stop = session.stops;
  patchEntry(id, { loading: true });
  const read = (offset: number) => call(commands.debugReadMemory(id, reference, offset, PAGE_BYTES));
  try {
    let { target, start } = entry;
    let block = await read(start);
    if (target === null && inflight.get(id) === token) {
      target = parseAddress(block.address);
      const back = target === null ? 0 : rowOffset(target);
      if (back) block = await read((start = -back));
    }
    if (inflight.get(id) !== token) return;
    patchEntry(id, { target, start, block, error: null, readAtStop: stop });
  } catch (e) {
    if (inflight.get(id) !== token) return;
    patchEntry(id, { block: null, error: message(e), readAtStop: stop });
  } finally {
    if (inflight.get(id) === token) {
      inflight.delete(id);
      patchEntry(id, { loading: false });
    }
  }
}

/** Shows the memory at `reference` (a variable's, or an evaluation result's); the address field shows `expression`. */
export function showMemoryAt(id: DebugSessionId, reference: string, expression: string): Promise<void> {
  // Adapters that write references as addresses (lldb-dap, CodeLLDB, cppdbg, GDB) need no read to align the page.
  const target = parseAddress(reference);
  patchEntry(id, {
    expression,
    reference,
    target,
    start: target === null ? 0 : 0 - rowOffset(target),
    block: null,
    error: null,
  });
  return readPage(id);
}

/** Address field: evaluates `expression` (`&msg[0]`, `buffer`, `0x7ffd5c4a`) and shows the memory it points to. */
export async function goToExpression(id: DebugSessionId, expression: string): Promise<void> {
  const text = expression.trim();
  const session = useDebug.getState().sessions[id];
  if (!text || !session) return;
  patchEntry(id, { expression: text });
  let reference: string | null;
  try {
    const value = await evaluate(text, "watch", session);
    // A plain number (`0x601040`, an integer variable) has no reference: its value is the address.
    const address = value.memoryReference ? null : parseAddress(value.value);
    reference = value.memoryReference ?? (address === null ? null : `0x${address.toString(16)}`);
    if (!reference) {
      patchEntry(id, {
        reference: null,
        block: null,
        error: formatMessage(
          tx("“{expression}” is not an address. Enter a pointer or an address, such as &buffer[0]."),
          {
            expression: text,
          },
        ),
      });
      return;
    }
  } catch (e) {
    patchEntry(id, { reference: null, block: null, error: message(e) });
    return;
  }
  if (useMemoryView.getState().bySession[id]?.expression !== text) return;
  await showMemoryAt(id, reference, text);
}

/** Previous (-1) or next (1) page. */
export function turnPage(id: DebugSessionId, pages: number): Promise<void> {
  const entry = useMemoryView.getState().bySession[id];
  if (!entry?.reference) return Promise.resolve();
  patchEntry(id, { start: entry.start + pages * PAGE_BYTES });
  return readPage(id);
}

export function revealMemoryView(): void {
  useMemoryView.setState({ revealPending: true });
}

/** The Debug tool window shows the Memory View: the request is done. */
export function memoryViewRevealed(): void {
  useMemoryView.setState({ revealPending: false });
}

export function forgetMemoryView(id: DebugSessionId): void {
  inflight.delete(id);
  useMemoryView.setState((s) => {
    if (!(id in s.bySession)) return s;
    const { [id]: _gone, ...rest } = s.bySession;
    return { bySession: rest };
  });
}
