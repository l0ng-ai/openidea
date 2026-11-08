import type { JvmObjectRef, JvmValue } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { formatCount } from "./rows";

const shortName = (typeName: string): string => typeName.slice(typeName.lastIndexOf(".") + 1);

/** One-line text of a value, built from what the debugger already sent: nothing is invoked in the debuggee. */
export function formatJvmValue(v: JvmValue): string {
  switch (v.kind) {
    case "null":
      return "null";
    case "primitive":
    case "boxed":
      return v.text;
    case "string": {
      if (v.text != null) return JSON.stringify(v.text);
      const chars = formatCount(v.length);
      return tx`String (${chars} chars)`;
    }
    case "object":
      return `${shortName(v.typeName)}@${v.id}`;
    case "array": {
      const element = v.typeName.endsWith("[]") ? v.typeName.slice(0, -2) : v.typeName;
      return `${shortName(element)}[${v.length}]`;
    }
  }
}

/** The reference to open `v` with, or null for values that are not objects. */
export function objectRef(generation: number, v: JvmValue): JvmObjectRef | null {
  return v.kind === "null" || v.kind === "primitive" ? null : { generation, id: v.id };
}

/** Key of an object in `InstancesEntry.nodes`. */
export function refKey(r: JvmObjectRef): string {
  return `${r.generation}:${r.id}`;
}
