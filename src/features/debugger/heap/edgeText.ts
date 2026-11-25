import { tx } from "@/platform/i18n";
import type { HeapEdge, HeapRootKind } from "@/platform/ipc";

function rootText(root: HeapRootKind, thread: string | null): string {
  switch (root) {
    case "unknown":
      return tx("Unknown root");
    case "jniGlobal":
      return tx("JNI global");
    case "jniLocal":
      return tx("JNI local");
    case "javaFrame":
      return thread === null ? tx("Local variable") : tx`Local variable in ${thread}`;
    case "nativeStack":
      return tx("Native stack");
    case "stickyClass":
      return tx("System class");
    case "threadBlock":
      return tx("Thread block");
    case "monitorUsed":
      return tx("Monitor");
    case "threadObject":
      return thread === null ? tx("Thread") : tx`Thread ${thread}`;
  }
}

/** How the next step of a path to a GC root holds an object; on the last step, the kind of root. */
export function edgeText(edge: HeapEdge): string {
  switch (edge.kind) {
    case "field":
      // The dump does not always say which field holds the object.
      return `.${edge.name || "?"}`;
    case "element":
      return `[${edge.index}]`;
    case "static": {
      const { name } = edge;
      return tx`static ${name}`;
    }
    case "classOf":
      return tx("class");
    case "superClass":
      return tx("superclass");
    case "classLoader":
      return tx("class loader");
    case "root":
      return rootText(edge.root, edge.thread);
  }
}
