import { lazyComponent } from "@/ui";
import { tx } from "@/platform/i18n";
import type { EditorKindContribution } from "@/workbench/contributions";
import { HEAP_KIND, heapLabelOf, heapSnapshotOf } from "./heapInput";
import { closeHeapSnapshot } from "./heapState";

/** Not `restorable`: the host keeps no snapshot across a restart. Closing the tab is what closes the snapshot. */
export const heapEditorKind: EditorKindContribution = {
  kind: HEAP_KIND,
  component: lazyComponent(() => import("./HeapSnapshotEditor").then((m) => m.HeapSnapshotEditor)),
  title: (input) => {
    const label = heapLabelOf(input);
    return tx`Heap: ${label}`;
  },
  icon: () => "heap-snapshot",
  onClose: (input) => {
    const id = heapSnapshotOf(input);
    if (id !== null) void closeHeapSnapshot(id);
  },
};
