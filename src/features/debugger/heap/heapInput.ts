import type { HeapSnapshotInfo } from "@/platform/ipc";
import type { EditorInput } from "@/workbench/contributions";

export const HEAP_KIND = "heap-snapshot";

/** One tab per snapshot; its data is plain JSON, which is all the tab needs to find the snapshot in the store. */
export function heapInput(snapshot: HeapSnapshotInfo): EditorInput {
  return { kind: HEAP_KIND, key: `${HEAP_KIND}:${snapshot.id}`, data: { id: snapshot.id, label: snapshot.label } };
}
