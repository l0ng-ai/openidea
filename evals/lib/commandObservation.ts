/** Command capture shared by the Session relay and rename's measured operation. */
export interface RenameTarget {
  doc: number;
  pos: { line: number; col: number };
  newName: string;
}

interface Operation {
  scope: number;
  target: RenameTarget;
  request: number;
  result: { ok: true; value: unknown } | { ok: false; error: unknown } | null;
  listeners: Array<{ resolve(value: unknown): void; reject(error: unknown): void }>;
}

export class RenameObservations {
  private generation = 0;
  private operation: Operation | null = null;

  begin(target: RenameTarget): number {
    this.reset();
    this.operation = { scope: this.generation, target, request: 0, result: null, listeners: [] };
    return this.generation;
  }

  reset() {
    this.generation++;
    for (const listener of this.operation?.listeners ?? []) listener.reject(new Error("rename operation expired"));
    this.operation = null;
  }

  /** Captures the invocation, not just its answer: old requests retain their original scope. */
  async invoke<T>(cmd: string, args: unknown, send: () => Promise<T>): Promise<T> {
    const op = this.operation;
    const actual = args as Partial<RenameTarget> | null;
    const matching =
      cmd === "lsp_rename" &&
      op &&
      actual &&
      actual.doc === op.target.doc &&
      actual.newName === op.target.newName &&
      actual.pos?.line === op.target.pos.line &&
      actual.pos?.col === op.target.pos.col;
    const request = matching ? ++op.request : 0;
    if (matching) op.result = null;
    try {
      const value = await send();
      if (matching && this.operation === op && op.request === request) {
        op.result = { ok: true, value };
        for (const listener of op.listeners.splice(0)) listener.resolve(value);
      }
      return value;
    } catch (error) {
      if (matching && this.operation === op && op.request === request) {
        op.result = { ok: false, error };
        for (const listener of op.listeners.splice(0)) listener.reject(error);
      }
      throw error;
    }
  }

  completed(scope: number): unknown | null {
    const op = this.operation;
    return op?.scope === scope && op.result?.ok ? op.result.value : null;
  }

  wait(scope: number): Promise<unknown> {
    const op = this.operation;
    if (!op || op.scope !== scope) return Promise.reject(new Error("rename operation expired"));
    if (op.result) return op.result.ok ? Promise.resolve(op.result.value) : Promise.reject(op.result.error);
    // ES2023 harnesses cannot use Promise.withResolvers().
    return new Promise((resolve, reject) => op.listeners.push({ resolve, reject }));
  }
}
