import { afterEach, describe, expect, it, vi } from "vitest";
const host = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
  listeners: new Set<(e: { run: number; code: number | null }) => void>(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage = (_chunk: unknown) => {};
  },
}));
vi.mock("./ipc", () => ({
  commands: { runStart: host.start, runStop: host.stop },
  call: <T>(promise: Promise<T>) => promise,
  ideEventsReady: () => Promise.resolve(),
  onIdeEvent: (_kind: string, fn: (e: { run: number; code: number | null }) => void) => {
    host.listeners.add(fn);
    return () => host.listeners.delete(fn);
  },
}));
vi.mock("./project", () => ({
  dirname: (p: string) => p.slice(0, p.lastIndexOf("/")),
  useProject: { getState: () => ({ project: null }) },
}));
import { dotnet } from "./dotnet";
const exit = (run: number, code: number | null) => host.listeners.forEach((fn) => fn({ run, code }));
afterEach(() => {
  host.start.mockReset();
  host.stop.mockReset();
  expect(host.listeners.size).toBe(0);
});
describe(".NET query lifecycle", () => {
  it("captures a fast exit before runStart resolves, ignoring another run", async () => {
    host.start.mockImplementation(async (_config, channel) => {
      channel.onmessage({ text: '{"ok":true}' });
      exit(99, 1);
      exit(7, 0);
      return { id: 7 };
    });
    expect(await dotnet(["msbuild"], "/repo")).toBe('{"ok":true}');
  });
  it("reports process failures and releases its event subscription", async () => {
    host.start.mockImplementation(async () => {
      exit(7, 1);
      return { id: 7 };
    });
    await expect(dotnet(["msbuild"], "/repo")).rejects.toThrow("dotnet exited with code 1");
  });
  it("stops a process cancelled while runStart is pending", async () => {
    const abort = new AbortController();
    host.start.mockImplementation(async () => {
      abort.abort();
      return { id: 7 };
    });
    host.stop.mockImplementation(async (id) => exit(id, null));
    await expect(dotnet(["msbuild"], "/repo", abort.signal)).rejects.toThrow();
    expect(host.stop).toHaveBeenCalledWith(7);
  });
  it("releases its subscription if starting the process fails", async () => {
    host.start.mockRejectedValue(new Error("SDK missing"));
    await expect(dotnet(["msbuild"], "/repo")).rejects.toThrow("SDK missing");
  });
});
