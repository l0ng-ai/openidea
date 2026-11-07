/** Text for "Copy Value": a structured value (array, object, map) is copied with its contents, not its summary. */
import type { Variable } from "@/platform/ipc";

export interface ValueTextRoot {
  value: string;
  reference: number;
}

export interface ValueTextLimits {
  depth: number;
  entries: number;
}

export const VALUE_TEXT_LIMITS: ValueTextLimits = { depth: 8, entries: 2000 };

/**
 * `value` alone for a scalar; for an expandable value the summary line followed by its children,
 * one per line and indented by depth. Cycles and anything past the limits end in an ellipsis line.
 */
export async function valueText(
  root: ValueTextRoot,
  fetchChildren: (reference: number) => Promise<Variable[]>,
  limits: ValueTextLimits = VALUE_TEXT_LIMITS,
): Promise<string> {
  if (root.reference <= 0) return root.value;
  const lines = [root.value];
  let budget = limits.entries;
  const path = new Set<number>([root.reference]);

  const walk = async (reference: number, depth: number): Promise<void> => {
    const pad = "  ".repeat(depth);
    if (depth > limits.depth) {
      lines.push(`${pad}…`);
      return;
    }
    for (const child of await fetchChildren(reference)) {
      if (budget-- <= 0) {
        lines.push(`${pad}…`);
        return;
      }
      lines.push(`${pad}${child.name}: ${child.value}`);
      const ref = child.variablesReference;
      if (ref > 0 && !path.has(ref)) {
        path.add(ref);
        await walk(ref, depth + 1);
        path.delete(ref);
      }
    }
  };

  await walk(root.reference, 1);
  return lines.join("\n");
}
