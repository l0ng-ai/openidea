import { describe, expect, it } from "vitest";
import type { NotebookOutputEvent, NotebookSnapshot } from "@/bindings";
import { OutputReducer } from "./outputs";

function notebook(): NotebookSnapshot {
  return {
    id: "document-a",
    path: "/p/example.ipynb",
    version: 1,
    dirty: false,
    nbformat: 4,
    nbformatMinor: 5,
    metadata: {},
    canUndo: false,
    canRedo: false,
    cells: [
      {
        id: "cell-a",
        cellType: "code",
        source: "print('old')",
        metadata: {},
        attachments: {},
        executionCount: 1,
        outputs: [{ output_type: "stream", name: "stdout", text: "old\n" }],
      },
    ],
  };
}
function event(
  kind: string,
  version: number,
  content: NotebookOutputEvent["content"],
  patch: Partial<NotebookOutputEvent> = {},
): NotebookOutputEvent {
  return {
    id: "document-a",
    path: "/p/example.ipynb",
    cell: "cell-a",
    msgId: "request-a",
    kind,
    version,
    dirty: true,
    changedCells: ["cell-a"],
    content,
    ...patch,
  };
}

describe("notebook output transitions", () => {
  it("defers wait-clear without changing bytes and reconciles its consuming output exactly once", () => {
    const reducer = new OutputReducer();
    const original = notebook();
    const waiting = reducer.reduce(original, event("clear_output", 1, { wait: true })).snapshot;
    expect(waiting.cells[0]!.outputs).toEqual(original.cells[0]!.outputs);
    const consumed = reducer.reduce(waiting, event("stream", 2, { name: "stdout", text: "new" }));
    expect(consumed.refresh).toBe(true);
    expect(consumed.snapshot.cells[0]!.outputs).toEqual(original.cells[0]!.outputs);
    const recovered = {
      ...original,
      version: 2,
      dirty: true,
      cells: [
        {
          ...original.cells[0]!,
          outputs: [{ output_type: "stream", name: "stdout", text: "new" }],
        },
      ],
    };
    const second = reducer.reduce(recovered, event("stream", 3, { name: "stdout", text: " output\n" })).snapshot;
    expect(second.cells[0]!.outputs).toEqual([{ output_type: "stream", name: "stdout", text: "new output\n" }]);
    expect(second.dirty).toBe(true);
  });

  it("coalesces only adjacent streams of the same name, preserving stderr order", () => {
    const reducer = new OutputReducer();
    let state = notebook();
    state = reducer.reduce(state, event("clear_output", 2, { wait: false })).snapshot;
    state = reducer.reduce(state, event("stream", 3, { name: "stderr", text: "warning\n" })).snapshot;
    state = reducer.reduce(state, event("stream", 4, { name: "stdout", text: "result\n" })).snapshot;
    expect(state.cells[0]!.outputs).toEqual([
      { output_type: "stream", name: "stderr", text: "warning\n" },
      { output_type: "stream", name: "stdout", text: "result\n" },
    ]);
  });

  it("requires authoritative reconciliation for cross-cell displays without duplicating an output", () => {
    const reducer = new OutputReducer();
    const state = notebook();
    const result = reducer.reduce(
      state,
      event(
        "update_display_data",
        2,
        { data: { "text/plain": "updated" }, transient: { display_id: "display-a" } },
        { changedCells: ["cell-a", "earlier-cell"] },
      ),
    );
    expect(result.refresh).toBe(true);
    expect(result.snapshot.cells[0]!.outputs).toEqual(state.cells[0]!.outputs);
    expect(result.snapshot.version).toBe(1);
  });

  it("does not clear twice after recovering a stream revision gap", () => {
    const reducer = new OutputReducer();
    let state = notebook();
    reducer.reduce(state, event("clear_output", 1, { wait: true }));
    expect(reducer.reduce(state, event("stream", 4, { name: "stdout", text: "recovered" })).refresh).toBe(true);
    state = {
      ...state,
      version: 4,
      cells: [{ ...state.cells[0]!, outputs: [{ output_type: "stream", name: "stdout", text: "recovered" }] }],
    };
    state = reducer.reduce(state, event("stream", 5, { name: "stdout", text: "+next" })).snapshot;
    expect(state.cells[0]!.outputs).toEqual([{ output_type: "stream", name: "stdout", text: "recovered+next" }]);
  });

  it("does not erase already-reconciled output when a snapshot overtakes a deferred clear", () => {
    const reducer = new OutputReducer();
    const original = notebook();
    reducer.reduce(original, event("clear_output", 1, { wait: true }));
    const recovered = {
      ...original,
      version: 2,
      cells: [
        {
          ...original.cells[0]!,
          outputs: [{ output_type: "stream", name: "stdout", text: "new" }],
        },
      ],
    };
    const next = reducer.reduce(recovered, event("stream", 3, { name: "stdout", text: "+next" }));
    expect(next.refresh).toBe(true);
    expect(next.snapshot.cells[0]!.outputs).toEqual([{ output_type: "stream", name: "stdout", text: "new" }]);
  });

  it("repairs an overtaken clear and a lost transient clear rather than appending to old output", () => {
    const reducer = new OutputReducer();
    const acknowledged = { ...notebook(), version: 2 };
    reducer.reduce(acknowledged, event("clear_output", 1, { wait: true }));
    expect(reducer.reduce(acknowledged, event("stream", 3, { name: "stdout", text: "replacement" })).refresh).toBe(
      true,
    );
    reducer.reset();
    reducer.recover();
    expect(reducer.reduce(acknowledged, event("stream", 3, { name: "stdout", text: "replacement" })).refresh).toBe(
      true,
    );
  });

  it("changes only the execution count on execute_input, matching the backend commit", () => {
    const original = notebook();
    const next = new OutputReducer().reduce(original, event("execute_input", 2, { execution_count: 2 })).snapshot;
    expect(next.cells[0]!.executionCount).toBe(2);
    expect(next.cells[0]!.outputs).toEqual(original.cells[0]!.outputs);
  });

  it("drops old incarnations and duplicate revisions, and removes transient display ids", () => {
    const reducer = new OutputReducer();
    const state = notebook();
    const wrong = reducer.reduce(state, event("stream", 2, { text: "stale" }, { id: "old-document" }));
    expect(wrong.snapshot).toBe(state);
    const display = event("display_data", 2, {
      data: { "text/plain": "hello" },
      metadata: {},
      transient: { display_id: "temporary" },
    });
    const result = reducer.reduce(state, display).snapshot;
    expect(result.cells[0]!.outputs.at(-1)).toEqual({
      output_type: "display_data",
      data: { "text/plain": "hello" },
      metadata: {},
    });
    expect(reducer.reduce(result, display).snapshot).toBe(result);
  });
});
