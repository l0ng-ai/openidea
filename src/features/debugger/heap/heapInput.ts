import type { HeapSnapshotInfo } from "@/platform/ipc";
import type { EditorInput } from "@/workbench/contributions";

export const HEAP_KIND = "heap-snapshot";

/** One tab per snapshot; its data is plain JSON, which is all the tab needs to find the snapshot in the store. */
export function heapInput(snapshot: HeapSnapshotInfo): EditorInput {
  return { kind: HEAP_KIND, key: `${HEAP_KIND}:${snapshot.id}`, data: { id: snapshot.id, label: snapshot.label } };
}

/** The snapshot a heap tab shows, or `null` for any other tab. */
export function heapSnapshotOf(input: EditorInput | null): number | null {
  if (input?.kind !== HEAP_KIND) return null;
  const id = (input.data as { id?: unknown } | undefined)?.id;
  return typeof id === "number" ? id : null;
}

export function heapLabelOf(input: EditorInput): string {
  const label = (input.data as { label?: unknown } | undefined)?.label;
  return typeof label === "string" ? label : "";
}
