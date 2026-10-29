import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

const cancelTaskCommand = vi.fn(async (_id: number) => true);
vi.mock("@/platform/ipc", async (orig) => {
  const actual = await orig<typeof import("@/platform/ipc")>();
  return { ...actual, commands: { ...actual.commands, cancelTask: cancelTaskCommand } };
});

const { emitLocalIdeEvent, isCancelled } = await import("@/platform/ipc");
const { cancelTask, installTaskEvents, queueTask, setIndexing, upsertTask, useTasks } = await import("./tasks");
const { TaskStatus } = await import("./StatusBar");

const task = (id: string) => useTasks.getState().tasks.find((t) => t.id === id);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

afterEach(() => {
  useTasks.setState({ tasks: [], indexing: null });
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("task queues", () => {
  it("runs one task at a time; the others wait, listed as queued", async () => {
    const first = deferred();
    const started: string[] = [];
    const a = queueTask("q1", { id: "a", title: "A" }, async () => {
      started.push("a");
      upsertTask({ id: "a", title: "A", message: null, fraction: null, done: false });
      await first.promise;
      return "a";
    });
    const b = queueTask("q1", { id: "b", title: "B" }, async () => {
      started.push("b");
      return "b";
    });
    expect(started).toEqual(["a"]);
    expect(task("b")).toMatchObject({ queued: true, message: "Waiting for other tasks" });
    first.resolve();
    await expect(a).resolves.toBe("a");
    await expect(b).resolves.toBe("b");
    expect(started).toEqual(["a", "b"]);
  });

  it("cancelling a queued task drops it at once: its work never starts and its caller sees a cancellation", async () => {
    const first = deferred();
    const work = vi.fn(async () => "never");
    const running = queueTask("q2", { id: "run", title: "Running" }, () => first.promise);
    const queued = queueTask("q2", { id: "wait", title: "Waiting" }, work);
    const next = queueTask("q2", { id: "next", title: "Next" }, async () => "next");

    cancelTask("wait");
    await expect(queued).rejects.toSatisfy(isCancelled);
    expect(task("wait")).toBeUndefined();

    first.resolve();
    await running;
    await expect(next).resolves.toBe("next");
    expect(work).not.toHaveBeenCalled();
  });

  it("the queue's Cancel is gone once the work starts (the work brings its own)", async () => {
    const first = deferred();
    const second = deferred();
    void queueTask("q3", { id: "x", title: "X" }, () => first.promise);
    const y = queueTask("q3", { id: "y", title: "Y" }, () => second.promise);
    first.resolve();
    await vi.waitFor(() => expect(task("y")?.queued).toBe(false));
    expect(task("y")?.cancel).toBeUndefined();
    second.resolve();
    await y;
  });
});

describe("cancelling", () => {
  it("shows Cancelling… until the task ends, then removes it without the finished bar", () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    upsertTask({ id: "sync", title: "Syncing", message: "Resolving", fraction: 0.3, done: false, cancel });
    cancelTask("sync");
    cancelTask("sync");
    expect(cancel).toHaveBeenCalledOnce();
    expect(task("sync")).toMatchObject({ cancelling: true, message: "Cancelling…" });
    upsertTask({ id: "sync", title: "Syncing", message: "Downloading", fraction: 0.4, done: false, cancel });
    expect(task("sync")?.message).toBe("Cancelling…");
    upsertTask({ id: "sync", title: "Syncing", message: null, fraction: 1, done: true });
    expect(task("sync")).toBeUndefined();
  });

  it("the popup's cancel buttons: working, Cancelling…, and disabled with the reason", () => {
    const cancel = vi.fn();
    upsertTask({ id: "dl", title: "Downloading JDK 25", message: null, fraction: null, done: false, cancel });
    upsertTask({
      id: "inst",
      title: "Installing update",
      message: null,
      fraction: null,
      done: false,
      uncancellable: "This step can't be cancelled",
    });
    render(<TaskStatus />);
    fireEvent.click(screen.getByRole("button", { name: /Background tasks/ }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel Downloading JDK 25" }));
    expect(cancel).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Cancelling…" })).toBeDisabled();
    const off = screen.getByRole("button", { name: "This step can't be cancelled" });
    expect(off).toBeDisabled();
    expect(off.parentElement).toHaveAttribute("data-tooltip", "This step can't be cancelled");
  });

  it("indexing says why it can't be stopped", () => {
    setIndexing(true, 10, 20);
    expect(task("indexing")).toMatchObject({ uncancellable: expect.any(String) });
    expect(task("indexing")?.cancel).toBeUndefined();
  });

  it("backend tasks: cancellable ones cancel through cancel_task, the others say they can't", () => {
    vi.useFakeTimers();
    const uninstall = installTaskEvents();
    const base = { type: "task" as const, message: null, fraction: null, done: false };
    act(() => {
      emitLocalIdeEvent({ ...base, id: 41, title: "Building workspace", cancellable: true });
      emitLocalIdeEvent({ ...base, id: 42, title: "Loading", cancellable: false });
      vi.advanceTimersByTime(600);
    });
    cancelTask(41);
    expect(cancelTaskCommand).toHaveBeenCalledWith(41);
    expect(useTasks.getState().tasks.find((t) => t.id === 42)).toMatchObject({
      cancel: undefined,
      uncancellable: "This task can't be cancelled",
    });
    uninstall();
  });
});
