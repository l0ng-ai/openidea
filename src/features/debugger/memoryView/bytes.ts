/** Rows of the native Memory View: aligned address, hexadecimal bytes and their ASCII text. */

/** Bytes per row; rows start at addresses that are multiples of it. */
export const ROW_BYTES = 16;
/** Bytes one page of the view reads. */
export const PAGE_BYTES = 256;

export interface MemoryRow {
  /** Address of the row's first byte. */
  address: bigint;
  /** `null`: a byte the debugger could not read. */
  bytes: (number | null)[];
}

/**
 * An address as DAP writes it (`readMemory`'s `address`: hexadecimal with `0x`, decimal otherwise),
 * or the address at the start of a value (`0x7ffd5c4a "Hello"`, `140737488346985`). `null` when the
 * text doesn't start with one.
 */
export function parseAddress(text: string): bigint | null {
  const m = /^\s*(0[xX][0-9a-fA-F]+|\d+)(?![\w.])/.exec(text);
  if (!m) return null;
  try {
    return BigInt(m[1]!);
  } catch {
    return null;
  }
}

/** How many bytes `address` lies past the start of its row. */
export function rowOffset(address: bigint): number {
  return Number(address % BigInt(ROW_BYTES));
}

/** The bytes of a read that starts at `address`, followed by `unreadable` bytes that could not be read. */
export function memoryRows(address: bigint, data: readonly number[], unreadable: number): MemoryRow[] {
  const bytes: (number | null)[] = [...data, ...Array<null>(unreadable).fill(null)];
  const rows: MemoryRow[] = [];
  for (let i = 0; i < bytes.length; i += ROW_BYTES) {
    rows.push({ address: address + BigInt(i), bytes: bytes.slice(i, i + ROW_BYTES) });
  }
  return rows;
}

/** Hex digits the address column shows: 8 for 32-bit addresses, 16 once one doesn't fit. */
export function addressWidth(rows: readonly MemoryRow[]): number {
  const last = rows.at(-1);
  return last && last.address + BigInt(ROW_BYTES - 1) > 0xffffffffn ? 16 : 8;
}

export function formatAddress(address: bigint, width: number): string {
  return `0x${address.toString(16).toUpperCase().padStart(width, "0")}`;
}

/** `48`, or `??` for a byte that could not be read. */
export function hexByte(byte: number | null): string {
  return byte === null ? "??" : byte.toString(16).toUpperCase().padStart(2, "0");
}

/** The byte as printable ASCII; `.` for any other byte, ` ` for one that could not be read. */
export function asciiChar(byte: number | null): string {
  if (byte === null) return " ";
  return byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : ".";
}
