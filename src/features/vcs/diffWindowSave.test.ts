import { afterEach, beforeEach, expect, it, vi } from "vitest";

const bus = vi.hoisted(() => ({
  label: "main",
  listeners: new Map<string, (event: { payload: unknown }) => unknown>(),
}));
vi.mock("@/platform/ipc", () => ({ isTauri: () => true }));
vi.mock("@tauri-apps/api/window", () => ({
  getAllWindows: async () => [{ label: "main" }, { label: "diff-main-1" }, { label: "diff-project-2-1" }],
  getCurrentWindow: () => {
    const label = bus.label;
    return {
      label,
      listen: async (event: string, handler: (event: { payload: unknown }) => unknown) => {
        const key = `${label}:${event}`;
        bus.listeners.set(key, handler);
        return () => bus.listeners.delete(key);
      },
    };
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  emitTo: async (label: string, event: string, payload: unknown) => {
    await bus.listeners.get(`${label}:${event}`)?.({ payload });
  },
}));
import { installDiffWindowSave, saveDiffWindows } from "./diffWindowSave";

beforeEach(() => {
  bus.label = "main";
  bus.listeners.clear();
});

afterEach(() => vi.useRealTimers());

it("保存超时后拒绝继续操作，并清理响应监听", async () => {
  vi.useFakeTimers();
  const saving = saveDiffWindows();
  const rejected = expect(saving).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(15000);
  await rejected;
  expect(bus.listeners.size).toBe(0);
});

it("waits for the diff window to save before allowing Git to read its files", async () => {
  let disk = "before";
  let finish!: () => void;
  const ready = new Promise<void>((resolve) => (finish = resolve));
  bus.label = "diff-main-1";
  const stop = await installDiffWindowSave("main", async () => {
    await ready;
    disk = "edited in diff";
  });
  bus.label = "main";
  const saving = saveDiffWindows();
  expect(disk).toBe("before");
  finish();
  await saving;
  expect(disk).toBe("edited in diff");
  stop();
});

it("rejects Git operations when a diff window cannot save", async () => {
  bus.label = "diff-main-1";
  const stop = await installDiffWindowSave("main", async () => {
    throw new Error("Disk full");
  });
  bus.label = "main";
  await expect(saveDiffWindows()).rejects.toThrow("Disk full");
  stop();
});
