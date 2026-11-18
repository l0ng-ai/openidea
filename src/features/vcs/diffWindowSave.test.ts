import { afterEach, beforeEach, expect, it, vi } from "vitest";

type Listener = (event: { payload: unknown }) => unknown;

const bus = vi.hoisted(() => ({
  label: "main",
  windows: ["main", "diff-main-1", "diff-project-2-1"],
  listeners: new Map<string, Set<Listener>>(),
}));
vi.mock("@/platform/ipc", () => ({ isTauri: () => true }));
vi.mock("@tauri-apps/api/window", () => ({
  getAllWindows: async () => bus.windows.map((label) => ({ label })),
  getCurrentWindow: () => {
    const label = bus.label;
    return {
      label,
      listen: async (event: string, handler: Listener) => {
        const key = `${label}:${event}`;
        const listeners = bus.listeners.get(key) ?? new Set<Listener>();
        bus.listeners.set(key, listeners);
        listeners.add(handler);
        return () => {
          listeners.delete(handler);
          if (!listeners.size) bus.listeners.delete(key);
        };
      },
    };
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  emitTo: async (label: string, event: string, payload: unknown) => {
    const listeners = bus.listeners.get(`${label}:${event}`);
    if (listeners) await Promise.all([...listeners].map((listener) => listener({ payload })));
  },
}));
import { installDiffWindowSave, saveDiffWindows } from "./diffWindowSave";

beforeEach(() => {
  bus.label = "main";
  bus.windows = ["main", "diff-main-1", "diff-project-2-1"];
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

it("saves both diff and editor peers without saving another project's windows", async () => {
  bus.windows.push("editor-main-2", "editor-project-2-2", "settings-main");
  const diff = vi.fn(async () => {});
  const editor = vi.fn(async () => {});
  bus.label = "diff-main-1";
  const stopDiff = await installDiffWindowSave("main", diff);
  bus.label = "editor-main-2";
  const stopEditor = await installDiffWindowSave("main", editor);
  bus.label = "main";
  try {
    await saveDiffWindows();
    expect(diff).toHaveBeenCalledOnce();
    expect(editor).toHaveBeenCalledOnce();
  } finally {
    stopDiff();
    stopEditor();
  }
});
