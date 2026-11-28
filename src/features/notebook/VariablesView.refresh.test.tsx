import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { NotebookViewState } from "./session";

const variables = vi.hoisted(() => vi.fn());
vi.mock("@/platform/ipc", async (orig) => {
  const actual = await orig<typeof import("@/platform/ipc")>();
  return {
    ...actual,
    call: (p: Promise<unknown>) => p,
    commands: { ...actual.commands, notebookVariables: variables },
  };
});

// One notebook, with a state the test changes as the session would.
const notebook = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let state = {
    snapshot: { id: "nb-1" },
    running: false,
    frozen: false,
    kernel: "idle",
  } as unknown as NotebookViewState;
  return {
    path: "/p/a.ipynb",
    subscribe: (fn: () => void) => (listeners.add(fn), () => listeners.delete(fn)),
    getState: () => state,
    set(patch: Partial<NotebookViewState>) {
      state = { ...state, ...patch };
      listeners.forEach((fn) => fn());
    },
  };
});
vi.mock("./session", () => ({
  existingNotebookSession: (path: string) => (path === notebook.path ? notebook : undefined),
  notebookSessions: () => [notebook],
  onNotebookSessionsChange: () => () => {},
}));
// A .py tab is active: the window has not seen the notebook's tab yet.
vi.mock("@/workbench/contributions", () => ({
  maybeEditorService: () => ({ activeInput: () => ({ path: "/p/main.py" }), onActiveInputChange: () => () => {} }),
}));

const { VariablesView } = await import("./VariablesView");
const row = (name: string, value: string) => ({ name, type: "int", value });

describe("Jupyter Variables", () => {
  it("shows the open notebook's variables and reads them again after each run", async () => {
    variables.mockResolvedValueOnce([row("x", "1")]);
    render(<VariablesView />);
    expect(await screen.findByText("x")).toBeTruthy();
    expect(variables).toHaveBeenCalledTimes(1);

    variables.mockResolvedValueOnce([row("x", "1"), row("y", "2")]);
    act(() => notebook.set({ running: true, kernel: "busy" }));
    act(() => notebook.set({ kernel: "idle" }));
    // Not while the run lasts, even when the kernel is idle between cells.
    expect(variables).toHaveBeenCalledTimes(1);
    act(() => notebook.set({ running: false }));
    expect(await screen.findByText("y")).toBeTruthy();
    expect(variables).toHaveBeenCalledTimes(2);
  });

  it("keeps the list when the kernel is busy and shows other failures", async () => {
    const { IpcError } = await import("@/platform/ipc");
    const run = () => {
      act(() => notebook.set({ running: true }));
      act(() => notebook.set({ running: false }));
    };
    variables.mockResolvedValueOnce([row("x", "1")]);
    render(<VariablesView />);
    expect(await screen.findByText("x")).toBeTruthy();

    variables.mockRejectedValueOnce(new IpcError({ kind: "unavailable", message: "notebook kernel is busy" }));
    run();
    await waitFor(() => expect(variables).toHaveBeenCalledTimes(2));
    expect(screen.getByText("x")).toBeTruthy();

    variables.mockRejectedValueOnce(
      new IpcError({ kind: "protocol", message: "could not read the kernel's variables: boom" }),
    );
    run();
    expect(await screen.findByText("could not read the kernel's variables: boom")).toBeTruthy();
  });
});
