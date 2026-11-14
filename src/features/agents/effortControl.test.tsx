import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentConfigOption } from "@/bindings";
import { useEffortControl } from "./effortControl";

const notify = vi.hoisted(() => vi.fn());
vi.mock("@/workbench/contributions", () => ({ notifications: () => ({ notify }) }));

function config(current: string | null = "low", model = "first"): AgentConfigOption[] {
  return [
    {
      id: "model",
      name: "Model",
      category: "model",
      description: null,
      current: model,
      via: "option",
      values: ["first", "second", "third"].map((value) => ({ value, name: value, description: null })),
    },
    {
      id: "reasoning",
      name: "Effort",
      category: "thought_level",
      description: null,
      current,
      via: "option",
      values: [
        { value: "low", name: "Light", description: null },
        { value: "medium", name: "Balanced", description: null },
        { value: "high", name: "Thorough", description: null },
      ],
    },
  ];
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const effort = (options: readonly AgentConfigOption[]) => options.find((option) => option.category === "thought_level");
beforeEach(() => notify.mockReset());
afterEach(cleanup);

it("cycles provider levels with wrap and coalesces rapid choices until the actual write completes", async () => {
  const first = deferred();
  const second = deferred();
  const write = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const { result, rerender } = renderHook(({ options }) => useEffortControl(options, write, "task"), {
    initialProps: { options: config() },
  });

  act(() => result.current.cycle!());
  expect(effort(result.current.config)?.current).toBe("medium");
  expect(result.current.announcement).toBe("Balanced");
  act(() => {
    result.current.cycle!();
    result.current.cycle!();
  });
  expect(effort(result.current.config)?.current).toBe("low");
  expect(result.current.announcement).toBe("Light");
  expect(write.mock.calls).toEqual([["reasoning", "medium"]]);

  // The backend's optimistic event is not an acknowledgement of the provider request.
  rerender({ options: config("medium") });
  expect(effort(result.current.config)?.current).toBe("low");
  expect(write).toHaveBeenCalledTimes(1);
  await act(async () => first.resolve());
  expect(write.mock.calls).toEqual([
    ["reasoning", "medium"],
    ["reasoning", "low"],
  ]);
  rerender({ options: config("low") });
  await act(async () => second.resolve());
  expect(effort(result.current.config)?.current).toBe("low");
});

it("shares slider and hotkey intent without concurrent requests or resetting on callback churn", async () => {
  const first = deferred();
  const second = deferred();
  const write = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const { result, rerender } = renderHook(
    ({ options }) => useEffortControl(options, (id, value) => write(id, value), "task"),
    { initialProps: { options: config() } },
  );

  act(() => result.current.onChange("reasoning", "medium"));
  rerender({ options: config("medium") });
  act(() => {
    result.current.cycle!();
    result.current.onChange("reasoning", "low");
    result.current.cycle!();
  });
  expect(effort(result.current.config)?.current).toBe("medium");
  expect(write.mock.calls).toEqual([["reasoning", "medium"]]);
  expect(result.current.pending).toBe(true);
  await act(async () => first.resolve());
  expect(write).toHaveBeenCalledTimes(1);
  expect(result.current.pending).toBe(false);

  act(() => result.current.cycle!());
  expect(write.mock.calls).toEqual([
    ["reasoning", "medium"],
    ["reasoning", "high"],
  ]);
  expect(result.current.pending).toBe(true);
  rerender({ options: config("high") });
  expect(result.current.pending).toBe(true);
  await act(async () => second.resolve());
  expect(result.current.pending).toBe(false);
});

it("drops old effort intent and waits for an outstanding request before changing model", async () => {
  const first = deferred();
  const model = deferred();
  const write = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(model.promise);
  const { result, rerender } = renderHook(({ options }) => useEffortControl(options, write, "task"), {
    initialProps: { options: config() },
  });
  const oldCycle = result.current.cycle!;

  act(() => {
    oldCycle();
    oldCycle();
    result.current.onChange("model", "second");
  });
  expect(result.current.cycle).toBeUndefined();
  expect(result.current.announcement).toBeNull();
  expect(effort(result.current.config)?.current).toBe("low");
  act(() => {
    oldCycle();
    result.current.onChange("reasoning", "high");
  });
  expect(write.mock.calls).toEqual([["reasoning", "medium"]]);
  await act(async () => first.resolve());
  expect(write.mock.calls).toEqual([
    ["reasoning", "medium"],
    ["model", "second"],
  ]);
  expect(result.current.cycle).toBeUndefined();

  // The new model may be advertised optimistically with the old effort list.
  rerender({ options: config("low", "second") });
  expect(result.current.cycle).toBeUndefined();
  expect(result.current.pending).toBe(true);
  await act(async () => model.resolve());
  expect(result.current.cycle).toBeDefined();
  expect(result.current.pending).toBe(false);
});

it("does not cycle the old model when completion precedes the updated config", async () => {
  const model = deferred();
  const write = vi.fn().mockReturnValueOnce(model.promise);
  const { result, rerender } = renderHook(({ options }) => useEffortControl(options, write, "task"), {
    initialProps: { options: config() },
  });

  act(() => result.current.onChange("model", "second"));
  await act(async () => model.resolve());
  expect(result.current.cycle).toBeUndefined();
  expect(result.current.pending).toBe(true);
  rerender({ options: config("high", "second") });
  expect(result.current.cycle).toBeDefined();
  expect(result.current.pending).toBe(false);
  act(() => result.current.cycle!());
  expect(write.mock.calls).toEqual([
    ["model", "second"],
    ["reasoning", "low"],
  ]);
});

it("clears failed effort intent after rollback, notifies once, and permits a fresh choice", async () => {
  const first = deferred();
  const second = deferred();
  const write = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const { result, rerender } = renderHook(({ options }) => useEffortControl(options, write, "task"), {
    initialProps: { options: config() },
  });

  act(() => result.current.cycle!());
  rerender({ options: config("medium") });
  act(() => result.current.cycle!());
  rerender({ options: config("low") });
  await act(async () => first.reject(new Error("provider refused")));
  expect(notify).toHaveBeenCalledExactlyOnceWith({
    level: "error",
    title: "Couldn't change the setting",
    body: "Error: provider refused",
  });
  expect(write).toHaveBeenCalledTimes(1);
  expect(effort(result.current.config)?.current).toBe("low");
  expect(result.current.announcement).toBeNull();
  expect(result.current.pending).toBe(false);

  act(() => result.current.cycle!());
  expect(write.mock.calls).toEqual([
    ["reasoning", "medium"],
    ["reasoning", "medium"],
  ]);
  rerender({ options: config("medium") });
  await act(async () => second.resolve());
  expect(result.current.pending).toBe(false);
});

it("isolates a new identity from an old failure while retaining the host's single writer", async () => {
  const first = deferred();
  const second = deferred();
  const oldWrite = vi.fn().mockReturnValue(first.promise);
  const newWrite = vi.fn().mockReturnValue(second.promise);
  const { result, rerender } = renderHook(
    ({ options, write, identity }) => useEffortControl(options, write, identity),
    { initialProps: { options: config(), write: oldWrite, identity: "old" } },
  );

  act(() => {
    result.current.cycle!();
    result.current.cycle!();
  });
  rerender({ options: config("high"), write: newWrite, identity: "new" });
  expect(effort(result.current.config)?.current).toBe("high");
  expect(result.current.announcement).toBeNull();
  act(() => result.current.cycle!());
  expect(effort(result.current.config)?.current).toBe("low");
  expect(newWrite).not.toHaveBeenCalled();

  await act(async () => first.reject("old task failed"));
  expect(notify).not.toHaveBeenCalled();
  expect(oldWrite.mock.calls).toEqual([["reasoning", "medium"]]);
  expect(newWrite.mock.calls).toEqual([["reasoning", "low"]]);
  expect(effort(result.current.config)?.current).toBe("low");
  expect(result.current.announcement).toBe("Light");
  expect(result.current.pending).toBe(true);
  rerender({ options: config("low"), write: newWrite, identity: "new" });
  await act(async () => second.resolve());
  expect(result.current.pending).toBe(false);
});

it("invalidates queued effort when the provider changes the supported levels", async () => {
  const first = deferred();
  const second = deferred();
  const write = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const { result, rerender } = renderHook(({ options }) => useEffortControl(options, write, "task"), {
    initialProps: { options: config() },
  });
  act(() => {
    result.current.cycle!();
    result.current.cycle!();
  });
  const updated = config("light");
  updated[1] = {
    ...updated[1]!,
    values: [
      { value: "light", name: "Quick", description: null },
      { value: "maximum", name: "Maximum", description: null },
    ],
  };
  rerender({ options: updated });
  expect(effort(result.current.config)?.current).toBe("light");
  expect(result.current.announcement).toBeNull();
  act(() => result.current.cycle!());
  await act(async () => first.resolve());
  expect(write.mock.calls).toEqual([
    ["reasoning", "medium"],
    ["reasoning", "maximum"],
  ]);
  expect(effort(result.current.config)?.current).toBe("maximum");
  rerender({
    options: updated.map((option) => (option.id === "reasoning" ? { ...option, current: "maximum" } : option)),
  });
  await act(async () => second.resolve());
  expect(result.current.pending).toBe(false);
});

it("discards old effort intent after an external model change", async () => {
  const first = deferred();
  const write = vi.fn().mockReturnValueOnce(first.promise);
  const { result, rerender } = renderHook(({ options }) => useEffortControl(options, write, "task"), {
    initialProps: { options: config() },
  });
  act(() => {
    result.current.cycle!();
    result.current.cycle!();
  });
  rerender({ options: config("low", "second") });
  await act(async () => first.resolve());
  expect(write.mock.calls).toEqual([["reasoning", "medium"]]);
  expect(result.current.announcement).toBeNull();
  expect(effort(result.current.config)?.current).toBe("low");
  expect(result.current.pending).toBe(false);
});

it("uses the first provider level when the current value is missing", () => {
  const write = vi.fn();
  const { result } = renderHook(() => useEffortControl(config("unknown"), write, "draft"));
  act(() => result.current.cycle!());
  expect(write).toHaveBeenCalledExactlyOnceWith("reasoning", "low");
  expect(result.current.announcement).toBe("Light");
  expect(result.current.pending).toBe(false);
});

it.each([0, 1])("does not offer cycling for %i advertised effort levels", (count) => {
  const write = vi.fn();
  const options = config();
  options[1] = { ...options[1]!, values: options[1]!.values.slice(0, count) };
  const { result } = renderHook(() => useEffortControl(options, write, "draft"));
  expect(result.current.config).toBe(options);
  expect(result.current.cycle).toBeUndefined();
  expect(result.current.pending).toBe(false);
  expect(write).not.toHaveBeenCalled();
});

it("finishes synchronous draft writes immediately and preserves rapid cycling before props catch up", () => {
  const write = vi.fn();
  const { result } = renderHook(() => useEffortControl(config(), write, "draft"));
  act(() => {
    result.current.cycle!();
    result.current.cycle!();
    result.current.cycle!();
  });
  expect(write.mock.calls).toEqual([
    ["reasoning", "medium"],
    ["reasoning", "high"],
    ["reasoning", "low"],
  ]);
  expect(result.current.pending).toBe(false);
  expect(effort(result.current.config)?.current).toBe("low");
});

it("keeps the latest model choice when a superseded request emits optimistic config or rolls back", async () => {
  const first = deferred();
  const second = deferred();
  const write = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const { result, rerender } = renderHook(({ options }) => useEffortControl(options, write, "task"), {
    initialProps: { options: config() },
  });
  act(() => result.current.onChange("model", "second"));
  act(() => result.current.onChange("model", "third"));
  rerender({ options: config("low", "second") });
  expect(result.current.cycle).toBeUndefined();
  rerender({ options: config("low", "first") });
  await act(async () => first.reject("superseded model failed"));
  expect(notify).not.toHaveBeenCalled();
  expect(write.mock.calls).toEqual([
    ["model", "second"],
    ["model", "third"],
  ]);
  expect(result.current.cycle).toBeUndefined();
  expect(result.current.pending).toBe(true);
  rerender({ options: config("high", "third") });
  await act(async () => second.resolve());
  expect(result.current.cycle).toBeDefined();
  expect(result.current.pending).toBe(false);
});

it("serializes other config changes with effort instead of bypassing a pending write", async () => {
  const first = deferred();
  const second = deferred();
  const write = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const { result, rerender } = renderHook(({ options }) => useEffortControl(options, write, "task"), {
    initialProps: { options: config() },
  });
  act(() => {
    result.current.onChange("mode", "plan");
    result.current.cycle!();
  });
  expect(write.mock.calls).toEqual([["mode", "plan"]]);
  await act(async () => first.resolve());
  expect(write.mock.calls).toEqual([
    ["mode", "plan"],
    ["reasoning", "medium"],
  ]);
  rerender({ options: config("medium") });
  await act(async () => second.resolve());
  expect(result.current.pending).toBe(false);
});

it("recovers from a synchronous writer failure without leaving an optimistic effort", () => {
  const write = vi.fn().mockImplementationOnce(() => {
    throw new Error("draft failed");
  });
  const { result } = renderHook(() => useEffortControl(config(), write, "draft"));
  act(() => result.current.cycle!());
  expect(result.current.pending).toBe(false);
  expect(effort(result.current.config)?.current).toBe("low");
  expect(result.current.announcement).toBeNull();
  expect(notify).toHaveBeenCalledExactlyOnceWith({
    level: "error",
    title: "Couldn't change the setting",
    body: "Error: draft failed",
  });
  act(() => result.current.cycle!());
  expect(write).toHaveBeenCalledTimes(2);
  expect(effort(result.current.config)?.current).toBe("medium");
});
