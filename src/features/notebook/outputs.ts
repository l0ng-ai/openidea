import type { NotebookSnapshot, NotebookOutputEvent } from "@/bindings";

export type JsonObject = Record<string, unknown>;
export function object(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}
/** Notebook keys such as `__proto__` or `constructor` name data, never inherited members. */
export function own(value: unknown, key: string): unknown {
  const record = object(value);
  return Object.hasOwn(record, key) ? record[key] : undefined;
}
export function mimeText(value: unknown): string {
  return typeof value === "string"
    ? value
    : Array.isArray(value)
      ? value.filter((v) => typeof v === "string").join("")
      : "";
}

/** Transient protocol state belongs to an execution, never to persisted MIME bundles. */
export class OutputReducer {
  private waiting = new Set<string>();
  private recovering = false;
  reset() {
    this.waiting.clear();
    this.recovering = false;
  }
  /** A lost Channel event can hide a transient wait-clear, not just a byte revision. */
  recover() {
    this.recovering = true;
  }

  reduce(snapshot: NotebookSnapshot, event: NotebookOutputEvent): { snapshot: NotebookSnapshot; refresh: boolean } {
    if (event.id !== snapshot.id) return { snapshot, refresh: false };
    const content = object(event.content);
    // A source acknowledgement may overtake a transient backend wait-clear.
    if (event.kind === "clear_output" && content.wait === true) this.waiting.add(event.cell);
    if (event.version <= snapshot.version) return { snapshot, refresh: false };
    const producesOutput = ["stream", "display_data", "execute_result", "error", "update_display_data"].includes(
      event.kind,
    );
    // A full snapshot may already include the output that consumed this clear.
    // Reconcile instead of clearing locally a second time after that snapshot.
    const deferredClear = producesOutput && this.waiting.delete(event.cell);
    const refresh =
      this.recovering ||
      deferredClear ||
      event.kind === "update_display_data" ||
      event.version > snapshot.version + 1 ||
      event.changedCells.some((id) => id !== event.cell);
    // A gap or cross-cell display update needs backend display-id knowledge. Do not
    // advance the local revision until get() has repaired the authoritative state.
    if (refresh) {
      if (event.kind === "clear_output" && content.wait === true) this.waiting.add(event.cell);
      else if (producesOutput || (event.kind === "clear_output" && content.wait !== true))
        this.waiting.delete(event.cell);
      return { snapshot, refresh: true };
    }
    const cells = snapshot.cells.map((cell) => {
      if (cell.id !== event.cell) return cell;
      let outputs: unknown[] = cell.outputs;
      let executionCount = cell.executionCount;
      if (event.kind === "clear_output") {
        if (content.wait === true) this.waiting.add(cell.id);
        else {
          this.waiting.delete(cell.id);
          outputs = [];
        }
      } else if (event.kind === "execute_input") {
        executionCount = typeof content.execution_count === "number" ? content.execution_count : null;
      } else if (["stream", "display_data", "execute_result", "error"].includes(event.kind)) {
        // Strip transient from the UI copy too; authoritative persistence is backend-owned.
        const { transient: _transient, ...body } = content;
        const last = object(outputs.at(-1));
        if (event.kind === "stream" && last.output_type === "stream" && last.name === body.name) {
          outputs = [...outputs.slice(0, -1), { ...last, text: mimeText(last.text) + mimeText(body.text) }];
        } else {
          outputs = [...outputs, { ...body, output_type: event.kind }];
        }
      }
      return { ...cell, outputs: outputs as typeof cell.outputs, executionCount };
    });
    return { snapshot: { ...snapshot, cells, version: event.version, dirty: event.dirty }, refresh: false };
  }
}
