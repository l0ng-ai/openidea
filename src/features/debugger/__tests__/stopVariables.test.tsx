import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

// CodeLLDB's shape: the frame keeps its id across stops while every variable reference is new.
const adapter = vi.hoisted(() => ({
  stop: 1,
  debugScopes: vi.fn(),
  debugVariables: vi.fn(),
}));

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  const ok = <T,>(data: T) => Promise.resolve({ status: "ok" as const, data });
  adapter.debugScopes.mockImplementation(() =>
    ok([{ name: "Local", variablesReference: adapter.stop * 100 + 1, expensive: false }]),
  );
  adapter.debugVariables.mockImplementation((_s: number, ref: number) => {
    const stop = Math.floor(ref / 100);
    // A reference from an earlier stop is gone.
    if (stop !== adapter.stop) return ok([]);
    return ok(
      ref % 100 === 1
        ? [
            {
              name: "res",
              value: "results_t",
              typeName: "results_t",
              variablesReference: stop * 100 + 2,
              evaluateName: "res",
            },
          ]
        : [
            {
              name: "count",
              value: `count-${stop}`,
              typeName: "int",
              variablesReference: 0,
              evaluateName: "res.count",
            },
          ],
    );
  });
  return {
    ...real,
    isTauri: () => true,
    commands: {
      ...real.commands,
      debugScopes: adapter.debugScopes,
      debugVariables: adapter.debugVariables,
      debugEvaluateIn: () => ok({ name: "n", value: "1", typeName: "int", variablesReference: 0, evaluateName: "n" }),
      debugThreads: () => ok([{ id: 1, name: "main" }]),
      debugStackTrace: () =>
        ok([{ id: 1000, name: "work", path: "/p/big.c", line: 9 + adapter.stop, column: 1, presentationHint: null }]),
    },
  };
});

import { handleDebugEvent, useDebug, type DebugSession } from "../state";
import { DebugToolWindow } from "../ui/DebugToolWindow";

const session: DebugSession = {
  id: 1,
  name: "big",
  adapter: "codelldb",
  parent: null,
  launch: null,
  process: null,
  status: "paused",
  stoppedThread: 1,
  stopReason: "breakpoint",
  stopDescription: null,
  threads: [{ id: 1, name: "main" }],
  selectedThread: 1,
  frames: [{ id: 1000, name: "work", path: "/p/big.c", line: 10, column: 1, presentationHint: null }],
  selectedFrame: 1000,
  hits: 1,
  stops: 1,
  exitCode: null,
  caps: null,
};

const requested = () => adapter.debugVariables.mock.calls.map((c) => c[1] as number);

afterEach(() => {
  cleanup();
  adapter.debugScopes.mockClear();
  adapter.debugVariables.mockClear();
  useDebug.setState({ watches: [] });
});

describe("variables after a stop (#6170)", () => {
  it("expands a node again by this stop's reference, once, and asks for the frame's scope once", async () => {
    adapter.stop = 1;
    // A watch keeps the tree mounted while the program runs, so its expansion survives the step.
    useDebug.setState({ sessions: { 1: session }, active: 1, stopSeq: 1, variablesEpoch: 0, watches: ["n"] });
    render(<DebugToolWindow />);
    fireEvent.click(screen.getByRole("tab", { name: "Threads & Variables" }));
    const tree = screen.getByRole("tree", { name: "Variables" });
    const res = await within(tree).findByText("res");
    expect(res).toBeTruthy();
    tree.focus();
    fireEvent.keyDown(tree, { key: "End" });
    fireEvent.keyDown(tree, { key: "ArrowRight" });
    await within(tree).findByText("count-1");
    expect(requested()).toEqual([101, 102]);

    adapter.debugVariables.mockClear();
    adapter.debugScopes.mockClear();
    adapter.stop = 2;
    act(() => handleDebugEvent(1, { kind: "continued", threadId: 1, allThreadsContinued: true }));
    act(() =>
      handleDebugEvent(1, {
        kind: "stopped",
        reason: "step",
        description: null,
        threadId: 1,
        allThreadsStopped: true,
      }),
    );
    await within(tree).findByText("count-2");
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    // Not the last stop's 102, which the adapter no longer knows (or formats again).
    expect(requested()).toEqual([201, 202]);
    expect(adapter.debugScopes).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(within(tree).queryByText("No variables")).toBeNull());
  });
});
