import { expect, it, vi } from "vitest";
import { registerRunningProcessesProvider, runningProcesses, stopRunningProcesses } from "./contributions";

it("collects live processes from every provider, one entry per name", async () => {
  const first = vi.fn(async () => [{ name: "app" }, { name: "worker" }]);
  const second = vi.fn(() => [{ name: "app" }, { name: "docs" }]);
  const disposers = [
    registerRunningProcessesProvider({ id: "test.first", running: first }),
    registerRunningProcessesProvider({ id: "test.second", running: second }),
  ];
  try {
    expect(await runningProcesses()).toEqual([{ name: "app" }, { name: "worker" }, { name: "docs" }]);
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  } finally {
    disposers.forEach((dispose) => dispose());
  }
  expect(await runningProcesses()).toEqual([]);
});

it("keeps a replacement provider registered when its predecessor is disposed", async () => {
  const disposeOld = registerRunningProcessesProvider({ id: "test.replaced", running: async () => [] });
  const disposeNew = registerRunningProcessesProvider({
    id: "test.replaced",
    running: async () => [{ name: "app" }],
  });
  try {
    disposeOld();
    expect(await runningProcesses()).toEqual([{ name: "app" }]);
  } finally {
    disposeOld();
    disposeNew();
  }
  expect(await runningProcesses()).toEqual([]);
});

it("asks every provider to stop, gracefully and then killed", async () => {
  const stop = vi.fn(async () => {});
  const dispose = registerRunningProcessesProvider({ id: "test.stop", running: () => [{ name: "app" }], stop });
  try {
    await stopRunningProcesses(false);
    expect(stop).toHaveBeenLastCalledWith(false);
    await stopRunningProcesses(true);
    expect(stop).toHaveBeenLastCalledWith(true);
    expect(stop).toHaveBeenCalledTimes(2);
  } finally {
    dispose();
  }
});
