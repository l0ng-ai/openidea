/** Memory View tab of the Debug tool window: a native program's memory as address, hex and ASCII columns. */
import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { EmptyState, IconButton, Input, T } from "@/ui";
import { formatMessage, useTx } from "@/platform/i18n";
import type { DebugSession } from "../state";
import {
  ROW_BYTES,
  addressWidth,
  asciiChar,
  formatAddress,
  hexByte,
  memoryRows,
  parseAddress,
  type MemoryRow,
} from "./bytes";
import { goToExpression, readPage, turnPage, useMemoryView } from "./memoryViewState";
import styles from "./MemoryViewPane.module.css";

const COLUMN_OFFSETS = Array.from({ length: ROW_BYTES }, (_, i) => i.toString(16).toUpperCase().padStart(2, "0"));

function Row({ row, width, target }: { row: MemoryRow; width: number; target: bigint | null }) {
  const marked = target !== null && target >= row.address && target < row.address + BigInt(ROW_BYTES);
  const at = marked ? Number(target - row.address) : -1;
  return (
    <div className={styles.row} role="row">
      <span role="rowheader" className={styles.address}>
        {formatAddress(row.address, width)}
      </span>
      <span role="gridcell" className={styles.hex}>
        {COLUMN_OFFSETS.map((_, i) => {
          const byte = row.bytes[i];
          return (
            <span key={i} className={clsx(styles.byte, i === at && styles.target, byte === null && styles.unreadable)}>
              {byte === undefined ? "  " : hexByte(byte)}
            </span>
          );
        })}
      </span>
      <span role="gridcell" className={styles.ascii}>
        {row.bytes.map((byte, i) => (
          <span key={i} className={clsx(i === at && styles.target, byte === null && styles.unreadable)}>
            {asciiChar(byte)}
          </span>
        ))}
      </span>
    </div>
  );
}

export function MemoryViewPane({ session }: { session: DebugSession }) {
  const tx = useTx();
  const id = session.id;
  const entry = useMemoryView((s) => s.bySession[id]);
  const [text, setText] = useState(entry?.expression ?? "");
  const committed = entry?.expression ?? "";
  // View Memory on a variable fills the field with its expression.
  const [shown, setShown] = useState(committed);
  if (shown !== committed) {
    setShown(committed);
    setText(committed);
  }
  const paused = session.status === "paused";

  // The memory may have changed at each stop: the page is read again (also when the tab comes back).
  const stale = !!entry?.reference && paused && !entry.loading && entry.readAtStop !== session.stops;
  useEffect(() => {
    if (stale) void readPage(id);
  }, [id, stale]);

  const block = entry?.block ?? null;
  const rows = useMemo(() => {
    const start = block ? parseAddress(block.address) : null;
    return block && start !== null ? memoryRows(start, block.data, block.unreadableBytes) : [];
  }, [block]);
  const width = addressWidth(rows);
  const busy = !!entry?.loading;
  const canPage = paused && !!entry?.reference && !busy;

  return (
    <div className={styles.root} aria-busy={busy || undefined}>
      <form
        className={styles.toolbar}
        role="toolbar"
        aria-label={tx("Memory View")}
        onSubmit={(e) => {
          e.preventDefault();
          void goToExpression(id, text);
        }}
      >
        <Input
          mono
          className={styles.address}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Address or expression, such as &buffer[0]"
          aria-label="Address or expression"
          disabled={!paused}
        />
        <IconButton
          icon="arrow-right"
          type="submit"
          title="Go to Address"
          size="small"
          disabled={!paused || !text.trim()}
        />
        <IconButton
          icon="chevron-up"
          title="Previous Page"
          size="small"
          disabled={!canPage}
          onClick={() => void turnPage(id, -1)}
        />
        <IconButton
          icon="chevron-down"
          title="Next Page"
          size="small"
          disabled={!canPage}
          onClick={() => void turnPage(id, 1)}
        />
        <IconButton icon="refresh" title="Refresh" size="small" disabled={!canPage} onClick={() => void readPage(id)} />
      </form>
      {!paused && (
        <div className={styles.note} role="status">
          <T>Memory is read while the program is paused.</T>
        </div>
      )}
      {entry?.error && (
        <div className={styles.error} role="alert">
          {entry.error}
        </div>
      )}
      {block && block.data.length === 0 && (
        <div className={styles.error} role="alert">
          {formatMessage(tx("The memory at {address} cannot be read."), { address: block.address })}
        </div>
      )}
      {rows.length > 0 ? (
        <div className={clsx(styles.grid, !paused && styles.dimmed)} role="grid" aria-label={tx("Memory")}>
          <div className={clsx(styles.row, styles.head)} role="row">
            <span role="columnheader" className={styles.address}>
              {tx("Address")}
            </span>
            <span role="columnheader" className={styles.hex}>
              {COLUMN_OFFSETS.map((o) => (
                <span key={o} className={styles.byte}>
                  {o}
                </span>
              ))}
            </span>
            <span role="columnheader" className={styles.ascii}>
              {tx("ASCII")}
            </span>
          </div>
          {rows.map((row) => (
            <Row key={row.address.toString()} row={row} width={width} target={entry?.target ?? null} />
          ))}
        </div>
      ) : (
        !entry?.error &&
        !busy && (
          <div className={styles.empty}>
            <EmptyState title="Memory View">
              <T>Enter an address or an expression, or choose View Memory on a variable.</T>
            </EmptyState>
          </div>
        )
      )}
    </div>
  );
}
