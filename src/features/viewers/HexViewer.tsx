/**
 * Read-only hex view for binary and very large files: offset | 16 hex bytes |
 * ASCII, virtualised over a scaled scroll range, reading 64 KB pages from the
 * backend as rows come into view.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import clsx from "clsx";
import { call, commands } from "@/platform/ipc";
import { editorService, type EditorInput } from "@/workbench/contributions";
import { Icon, T } from "@/ui";
import { formatSize, type BinaryInputData } from "./fileKinds";
import {
  BYTES_PER_ROW,
  PAGE_SIZE,
  asciiChar,
  decodeBase64,
  formatOffset,
  hexByte,
  hexViewport,
  offsetDigits,
  pagesForRows,
  rowBytes,
  rowCount,
  scrollTopForRow,
} from "./hex";
import { useForwardFocus } from "./forwardFocus";
import styles from "./Viewers.module.css";
import { tx } from "@/platform/i18n";

const ROW_H = 20;
const COLUMNS = Array.from({ length: BYTES_PER_ROW }, (_, i) => i);

export function HexViewer({ input }: { input: EditorInput }) {
  const path = input.path!;
  const data = input.data as BinaryInputData | undefined;
  const [total, setTotal] = useState(data?.size ?? 0);
  const [error, setError] = useState<string | null>(null);
  const [pages, setPages] = useState<ReadonlyMap<number, Uint8Array>>(() => new Map());
  /** Pages requested or loaded (read in callbacks only). */
  const requested = useRef(new Set<number>());
  const scrollRef = useRef<HTMLDivElement>(null);
  useForwardFocus(scrollRef);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);

  const rows = rowCount(total);
  const vp = hexViewport(scrollTop, viewH, rows, ROW_H);
  const visible = Math.ceil(viewH / ROW_H) + 1;
  const last = Math.min(rows - 1, vp.first + visible);
  const digits = offsetDigits(total);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    setViewH(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const load = useCallback(
    (page: number) => {
      if (requested.current.has(page)) return;
      requested.current.add(page);
      call(commands.fsReadRange(path, page * PAGE_SIZE, PAGE_SIZE))
        .then((r) => {
          const bytes = decodeBase64(r.data);
          setPages((prev) => new Map(prev).set(page, bytes));
          setTotal(r.total);
        })
        .catch((e: unknown) => {
          requested.current.delete(page);
          setError(e instanceof Error ? e.message : String(e));
        });
    },
    [path],
  );

  useEffect(() => {
    // The size known when the tab opened may be stale: the first page reports the current one.
    load(0);
  }, [load]);

  useEffect(() => {
    if (rows) for (const p of pagesForRows(vp.first, last)) load(p);
  }, [rows, vp.first, last, load]);

  const reveal = (offset: number) => {
    const el = scrollRef.current;
    if (!el) return;
    const row = Math.floor(offset / BYTES_PER_ROW);
    const fullRows = Math.max(1, Math.floor(viewH / ROW_H) - 1);
    if (row < vp.first || (row === vp.first && vp.shift > 0)) el.scrollTop = scrollTopForRow(row, viewH, rows, ROW_H);
    else if (row > vp.first + fullRows) el.scrollTop = scrollTopForRow(row - fullRows, viewH, rows, ROW_H);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (!total) return;
    const page = Math.max(1, Math.floor(viewH / ROW_H) - 1) * BYTES_PER_ROW;
    const cur = selected ?? 0;
    const step: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -BYTES_PER_ROW,
      ArrowDown: BYTES_PER_ROW,
      PageUp: -page,
      PageDown: page,
    };
    let next: number | null = null;
    if (e.key in step) next = cur + step[e.key]!;
    else if (e.key === "Home") next = e.metaKey || e.ctrlKey ? 0 : cur - (cur % BYTES_PER_ROW);
    else if (e.key === "End")
      next = e.metaKey || e.ctrlKey ? total - 1 : Math.min(total - 1, cur - (cur % BYTES_PER_ROW) + BYTES_PER_ROW - 1);
    if (next === null) return;
    e.preventDefault();
    next = Math.max(0, Math.min(total - 1, next));
    setSelected(next);
    reveal(next);
  };

  const rowsOut = [];
  for (let r = vp.first; r <= last && r < rows; r++) {
    const bytes = rowBytes(pages, r, total);
    const base = r * BYTES_PER_ROW;
    rowsOut.push(
      <div key={r} className={styles.hexRow} style={{ top: (r - vp.first) * ROW_H - vp.shift, height: ROW_H }}>
        <span className={styles.hexOffset}>{formatOffset(base, digits)}</span>
        <span className={styles.hexBytes}>
          {COLUMNS.map((i) => {
            const b = bytes?.[i];
            return (
              <span
                key={i}
                className={clsx(
                  styles.hexByte,
                  b === 0 && styles.zero,
                  !bytes && styles.pending,
                  selected === base + i && b !== undefined && styles.selectedByte,
                )}
                onMouseDown={() => b !== undefined && setSelected(base + i)}
              >
                {bytes ? (b === undefined ? "  " : hexByte(b)) : "··"}
              </span>
            );
          })}
        </span>
        <span className={styles.hexAscii}>
          {bytes &&
            [...bytes].map((b, i) => {
              const offset = base + i;
              return (
                <span
                  key={offset}
                  className={clsx(styles.hexChar, selected === offset && styles.selectedByte)}
                  onMouseDown={() => setSelected(offset)}
                >
                  {asciiChar(b)}
                </span>
              );
            })}
        </span>
      </div>,
    );
  }

  const selectedByte =
    selected !== null
      ? rowBytes(pages, Math.floor(selected / BYTES_PER_ROW), total)?.[selected % BYTES_PER_ROW]
      : undefined;

  return (
    <div className={styles.root}>
      <div className={styles.toolbar} role="toolbar" aria-label={tx("Hex view")}>
        <Icon name="lock" size={14} />
        <span className={styles.info}>
          {data?.binary === false ? tx("Large file") : tx("Binary file")} · {formatSize(total)} · {tx("read-only")}
        </span>
        <div className={styles.spacer} />
        {selected !== null && (
          <span className={styles.info}>
            {tx`Offset 0x${formatOffset(selected, 1)} (${selected})`}
            {selectedByte !== undefined && ` · 0x${hexByte(selectedByte)} = ${selectedByte}`}
          </span>
        )}
        {data?.binary === false && (
          <button
            type="button"
            className={styles.textButton}
            onClick={() => void editorService().openFile(path, { asText: true })}
          >
            <T>Open as Text</T>
          </button>
        )}
      </div>
      {error ? (
        <div className={styles.message}>{tx`Cannot read the file: ${error}`}</div>
      ) : (
        <>
          <div className={styles.hexHeader} style={{ height: ROW_H }} aria-hidden="true">
            <span className={styles.hexOffset}>{" ".repeat(digits)}</span>
            <span className={styles.hexBytes}>
              {COLUMNS.map((i) => (
                <span key={i} className={styles.hexByte}>
                  {hexByte(i)}
                </span>
              ))}
            </span>
            <span className={styles.hexAscii}>
              <T>Decoded text</T>
            </span>
          </div>
          <div
            ref={scrollRef}
            className={styles.hexScroll}
            tabIndex={0}
            role="region"
            aria-label={`Hex view of ${path}`}
            aria-readonly="true"
            onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
            onKeyDown={onKeyDown}
          >
            <div style={{ height: Math.max(vp.spacer, viewH) }}>
              <div className={styles.hexLayer} style={{ height: viewH }}>
                {rowsOut}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
