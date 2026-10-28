import { afterEach, describe, expect, it, vi } from "vitest";
import { useTasks } from "./tasks";
import { stopBackgroundProcesses } from "./shellActions";

const task = (id: number, cancel?: () => void, done = false) => ({
  id,
  title: `Task ${id}`,
  message: null,
  fraction: null,
  done,
  startedAt: 0,
  cancel,
});

afterEach(() => useTasks.setState({ tasks: [] }));

describe("stopBackgroundProcesses", () => {
  it("stops the only running cancellable task", () => {
    const cancel = vi.fn();
    const finished = vi.fn();
    useTasks.setState({ tasks: [task(1, cancel), task(2), task(3, finished, true)] });
    stopBackgroundProcesses();
    expect(cancel).toHaveBeenCalledOnce();
    expect(finished).not.toHaveBeenCalled();
  });
});
