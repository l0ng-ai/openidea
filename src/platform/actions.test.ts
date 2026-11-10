import { expect, it, vi } from "vitest";
import { executeAction, executeActionOrThrow, registerAction, useRunningActions } from "./actions";

const running = (id: string) => useRunningActions.getState().running.get(id) ?? 0;

it("counts a run of an `indicatesRunning` action until it settles, on success and on failure", async () => {
  const finishers: (() => void)[] = [];
  const dispose = registerAction({
    id: "test.slow",
    title: "Slow",
    indicatesRunning: true,
    run: () => new Promise<void>((resolve) => finishers.push(resolve)),
  });
  const failing = registerAction({
    id: "test.failing",
    title: "Failing",
    indicatesRunning: true,
    run: async () => {
      throw new Error("nope");
    },
  });
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const first = executeAction("test.slow");
    const second = executeAction("test.slow");
    expect(running("test.slow")).toBe(2);
    finishers[0]!();
    await first;
    expect(running("test.slow")).toBe(1);
    finishers[1]!();
    await second;
    expect(running("test.slow")).toBe(0);
    expect(useRunningActions.getState().running.has("test.slow")).toBe(false);

    await executeAction("test.failing");
    expect(running("test.failing")).toBe(0);
  } finally {
    dispose();
    failing();
    log.mockRestore();
  }
});

it("does not track actions that did not ask for it", async () => {
  let finish!: () => void;
  const dispose = registerAction({
    id: "test.plain",
    title: "Plain",
    run: () => new Promise<void>((resolve) => (finish = resolve)),
  });
  const run = executeAction("test.plain");
  expect(running("test.plain")).toBe(0);
  finish();
  await run;
  dispose();
});

it("propagates host launch errors while retaining ordinary action error handling", async () => {
  const dispose = registerAction({
    id: "test.hostLaunch",
    title: "Test",
    run: async () => {
      throw new Error("spawn failed");
    },
  });
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await expect(executeActionOrThrow("test.hostLaunch")).rejects.toThrow("spawn failed");
    await expect(executeAction("test.hostLaunch")).resolves.toBe(true);
    expect(log).toHaveBeenCalledOnce();
  } finally {
    dispose();
    log.mockRestore();
  }
});

it("checks argument-specific enablement before dispatch", async () => {
  const run = vi.fn();
  const dispose = registerAction({
    id: "test.fileAction",
    title: "Test",
    enabled: ({ arg }) => arg === "/tracked.txt",
    run,
  });
  try {
    expect(await executeAction("test.fileAction", "/untracked.txt")).toBe(false);
    expect(await executeAction("test.fileAction", "/tracked.txt")).toBe(true);
    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ arg: "/tracked.txt" }));
  } finally {
    dispose();
  }
});
