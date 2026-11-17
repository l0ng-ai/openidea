import { IconButton, Select, T, type SelectOption } from "@/ui";
import { tx, useTx } from "@/platform/i18n";
import type { HeapSnapshotInfo, SizeSource } from "@/platform/ipc";
import { isRemoteWindow } from "@/platform/remote";
import { formatBytes, formatCount } from "../../memory/rows";
import { saveHeapDump } from "../heapDumpFiles";
import { useHeap } from "../heapState";
import styles from "../HeapSnapshotEditor.module.css";

const NO_COMPARISON = "";

function sourceText({ origin }: HeapSnapshotInfo): string {
  if (origin.kind === "file") return origin.path;
  const parts = [`pid ${origin.pid}`, `JDK ${origin.javaVersion}`];
  if (origin.takenWhileSuspended) parts.push(tx("taken while suspended"));
  return parts.join(" · ");
}

function sizeText(source: SizeSource): string {
  switch (source) {
    case "jvm":
      return tx("Sizes from the JVM.");
    case "addressGaps":
      return tx("Sizes estimated from the dump.");
    case "layout":
      return tx("Sizes computed from the default layout.");
  }
}

/** The other snapshots open in this window, oldest first. */
function useComparable(id: number): SelectOption[] {
  const snapshots = useHeap((s) => s.snapshots);
  const others = Object.values(snapshots)
    .map((e) => e.info)
    .filter((info) => info.id !== id)
    .sort((a, b) => a.createdMs - b.createdMs || a.id - b.id);
  return [
    { value: NO_COMPARISON, label: "No comparison" },
    ...others.map((info) => ({ value: String(info.id), label: info.label })),
  ];
}

export function HeapHeader({
  info,
  compareWith,
  onCompare,
}: {
  info: HeapSnapshotInfo;
  compareWith: number | null;
  onCompare: (id: number | null) => void;
}) {
  // Also re-renders the source and size texts, which read the catalog when called.
  const tx = useTx();
  const { summary } = info;
  const n = formatCount(summary.objects);
  const size = formatBytes(summary.reachableBytes);
  const u = formatBytes(summary.unreachableBytes);
  const options = useComparable(info.id);
  // The dialog is local while the dump is on the host, so a remote window cannot pick where it goes.
  const canSave = info.origin.kind === "captured" && !isRemoteWindow();
  return (
    <div className={styles.header}>
      <div className={styles.headerText}>
        <div className={styles.title}>
          <span className={styles.label}>{info.label}</span>
          <span className={styles.source}>{sourceText(info)}</span>
        </div>
        <div className={styles.totals}>
          <span>{tx`${n} objects · ${size} reachable · ${u} unreachable`}</span>
          <span className={styles.muted}>{sizeText(summary.sizeSource)}</span>
        </div>
      </div>
      <div className={styles.headerTools}>
        {canSave && (
          <IconButton
            icon="export"
            title="Save Heap Dump As…"
            size="small"
            iconSize={16}
            onClick={() => void saveHeapDump(info.id)}
          />
        )}
        <Select
          className={styles.compare}
          aria-label="Compare with…"
          options={options}
          value={compareWith === null ? NO_COMPARISON : String(compareWith)}
          onChange={(v) => onCompare(v === NO_COMPARISON ? null : Number(v))}
          disabled={options.length < 2}
          renderValue={(o) => (o && o.value !== NO_COMPARISON ? <span>{o.label}</span> : <T>Compare with…</T>)}
        />
      </div>
    </div>
  );
}
