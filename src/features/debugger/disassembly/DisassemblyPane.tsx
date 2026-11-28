/** Disassembly tab of the Debug tool window: the selected frame's machine code around its program counter. */
import { Fragment, useEffect, useMemo, useRef } from "react";
import clsx from "clsx";
import { EmptyState, Icon, IconButton, T } from "@/ui";
import { formatMessage, useTx } from "@/platform/i18n";
import type { Instruction } from "@/platform/ipc";
import { formatAddress, parseAddress } from "../memoryView/bytes";
import { selectedFrame, sessionSupports, type DebugSession } from "../state";
import { readInstructions, sameAddress, showInstructionsAt, useDisassembly } from "./disassemblyState";
import styles from "./DisassemblyPane.module.css";

const NONE: Instruction[] = [];

/** `488b45d8` as `48 8B 45 D8`. */
function spacedBytes(hex: string | null | undefined): string {
  return (hex ?? "").toUpperCase().match(/../g)?.join(" ") ?? "";
}

/** The instruction's address in the address column (the adapter's text when it is not a number). */
function addressText(i: Instruction, width: number): string {
  const a = parseAddress(i.address);
  return a === null ? i.address : formatAddress(a, width);
}

export function DisassemblyPane({ session }: { session: DebugSession }) {
  const tx = useTx();
  const id = session.id;
  const entry = useDisassembly((s) => s.bySession[id]);
  const paused = session.status === "paused";
  const frame = paused ? selectedFrame(session) : null;
  const pc = frame?.instructionPointerReference ?? null;

  // Stepping and frame selection move the program counter: the view follows it.
  useEffect(() => {
    if (paused && pc) void showInstructionsAt(id, pc);
  }, [id, paused, pc]);

  const instructions = entry?.instructions ?? NONE;
  const width = useMemo(
    () => (instructions.some((i) => (parseAddress(i.address) ?? 0n) > 0xffffffffn) ? 16 : 8),
    [instructions],
  );
  // As wide as the longest machine code shown, so every row's instruction starts in the same column.
  const bytesWidth = useMemo(
    () => ({ minWidth: `${Math.max(5, ...instructions.map((i) => spacedBytes(i.bytes).length))}ch` }),
    [instructions],
  );
  const current = useRef<HTMLDivElement>(null);
  useEffect(() => {
    current.current?.scrollIntoView?.({ block: "nearest" });
  }, [pc, instructions]);

  const stepping = sessionSupports("instructionStepping", session);
  const noStepping = stepping
    ? undefined
    : formatMessage(tx("Instruction stepping is not supported by {adapter}"), {
        adapter: session.adapter || tx("this debugger"),
      });
  const busy = !!entry?.loading;

  return (
    <div className={styles.root} aria-busy={busy || undefined}>
      <div className={styles.toolbar} role="toolbar" aria-label={tx("Disassembly")}>
        <IconButton
          icon="step-over"
          action="debug.stepOverInstruction"
          title={noStepping}
          aria-label="Step Over Instruction"
          size="small"
          disabled={!paused || !stepping}
        />
        <IconButton
          icon="step-into"
          action="debug.stepIntoInstruction"
          title={noStepping}
          aria-label="Step Into Instruction"
          size="small"
          disabled={!paused || !stepping}
        />
        <IconButton
          icon="refresh"
          title="Refresh"
          size="small"
          disabled={!paused || !pc || busy}
          onClick={() => pc && void readInstructions(id, pc)}
        />
        {frame && <span className={styles.frame}>{frame.name}</span>}
      </div>
      {!paused && (
        <div className={styles.note} role="status">
          <T>Instructions are shown while the program is paused.</T>
        </div>
      )}
      {paused && frame && !pc && (
        <div className={styles.note} role="status">
          <T>The debugger gives no instruction address for this frame.</T>
        </div>
      )}
      {entry?.error && (
        <div className={styles.error} role="alert">
          {entry.error}
        </div>
      )}
      {instructions.length > 0 ? (
        <div className={clsx(styles.grid, !paused && styles.dimmed)} role="grid" aria-label={tx("Disassembly")}>
          <div className={clsx(styles.row, styles.head)} role="row">
            <span className={styles.marker} />
            <span role="columnheader" className={styles.address}>
              {tx("Address")}
            </span>
            <span role="columnheader" className={styles.bytes} style={bytesWidth}>
              {tx("Bytes")}
            </span>
            <span role="columnheader" className={styles.instruction}>
              {tx("Instruction")}
            </span>
          </div>
          {instructions.map((i, n) => {
            const isPc = !!pc && paused && sameAddress(i.address, pc);
            const symbol = i.symbol && i.symbol !== instructions[n - 1]?.symbol ? i.symbol : null;
            return (
              <Fragment key={i.address}>
                {symbol && (
                  <div className={clsx(styles.row, styles.symbol)} role="row">
                    <span role="gridcell" className={styles.symbolName}>
                      {symbol}:
                    </span>
                  </div>
                )}
                <div
                  ref={isPc ? current : undefined}
                  className={clsx(styles.row, isPc && styles.current)}
                  role="row"
                  aria-current={isPc ? "location" : undefined}
                >
                  <span className={styles.marker} aria-hidden>
                    {isPc && <Icon name="arrow-right" size={12} />}
                  </span>
                  <span role="rowheader" className={styles.address}>
                    {addressText(i, width)}
                  </span>
                  <span role="gridcell" className={styles.bytes} style={bytesWidth}>
                    {spacedBytes(i.bytes)}
                  </span>
                  <span role="gridcell" className={styles.instruction}>
                    {i.instruction}
                  </span>
                </div>
              </Fragment>
            );
          })}
        </div>
      ) : (
        !entry?.error &&
        !busy &&
        paused &&
        !!pc && (
          <div className={styles.empty}>
            <EmptyState title="Disassembly">
              <T>No instructions at this address.</T>
            </EmptyState>
          </div>
        )
      )}
    </div>
  );
}
