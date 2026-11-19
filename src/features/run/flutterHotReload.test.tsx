import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

const ipc = vi.hoisted(() => ({
  runStart: vi.fn((_config: unknown, _channel: unknown) =>
    Promise.resolve({
      status: "ok" as const,
      data: { id: 9, configId: "c", name: "c", pid: 1, running: true, pty: false },
    }),
  ),
  runStdin: vi.fn((_id: unknown, _data: unknown) => Promise.resolve({ status: "ok" as const, data: null })),
}));

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return { ...real, isTauri: () => true, commands: { ...real.commands, ...ipc } };
});
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  Channel: class {
    onmessage: ((m: unknown) => void) | null = null;
  },
}));

import type { RunConfig } from "@/platform/ipc";
import {
  provideNotificationService,
  provideToolWindowService,
  type ToolWindowService,
} from "@/workbench/contributions";
import { hotReloadSession, supportsHotReload } from "./flutterHotReload";
import { SessionPanel } from "./RunView";
import { resetRuns, startRun, useRun } from "./store";

const flutter = (args: string[] = [], extra: Partial<RunConfig> = {}): RunConfig => ({
  id: "flutter:run",
  name: "flutter run",
  kind: "flutter",
  command: "flutter",
  args: ["run", "-t", "lib/main.dart", ...args],
  cwd: null,
  env: {},
  detected: true,
  isTest: false,
  debugAdapter: "dart",
  ...extra,
});

const current = (id: string) => useRun.getState().sessions.find((s) => s.id === id)!;
const button = (name: string) => screen.queryByRole("button", { name: new RegExp(`^${name}`) });

beforeEach(() => {
  resetRuns();
  ipc.runStart.mockClear();
  ipc.runStdin.mockClear();
  provideToolWindowService({ show: vi.fn(), isVisible: () => true } as unknown as ToolWindowService);
  provideNotificationService({ notify: () => undefined });
});

describe("Flutter hot reload in the Run tool window", () => {
  it("applies only to flutter run in a mode with hot reload", () => {
    expect(supportsHotReload(flutter())).toBe(true);
    expect(supportsHotReload(flutter(["-d", "macos", "--flavor", "dev"]))).toBe(true);
    for (const flag of ["--release", "--profile", "--jit-release", "--no-hot", "--trace-startup", "--machine"])
      expect(supportsHotReload(flutter([flag]))).toBe(false);
    expect(supportsHotReload(flutter([], { args: ["test"] }))).toBe(false);
    expect(supportsHotReload(flutter([], { kind: "shell" }))).toBe(false);
  });

  it("puts both buttons after Stop and sends their keys to the process", async () => {
    const session = (await startRun(flutter()))!;
    render(<SessionPanel session={current(session.id)} />);
    const names = screen.getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? "");
    const stop = names.findIndex((n) => n.startsWith("Stop"));
    expect(names[stop + 1]).toMatch(/^Hot Reload/);
    expect(names[stop + 2]).toMatch(/^Hot Restart/);

    fireEvent.click(button("Hot Reload")!);
    fireEvent.click(button("Hot Restart")!);
    expect(ipc.runStdin.mock.calls).toEqual([
      [9, "r"],
      [9, "R"],
    ]);
  });

  it("disables the buttons once the process ended", async () => {
    const session = (await startRun(flutter()))!;
    useRun.setState((s) => ({
      sessions: s.sessions.map((x) => (x.id === session.id ? { ...x, status: "finished" as const } : x)),
    }));
    render(<SessionPanel session={current(session.id)} />);
    expect(button("Hot Reload")).toHaveProperty("disabled", true);
    expect(button("Hot Restart")).toHaveProperty("disabled", true);
    expect(hotReloadSession()).toBeUndefined();
  });

  it("shows no buttons for other configurations", async () => {
    const session = (await startRun(flutter([], { id: "app", kind: "shell", command: "top", args: [] })))!;
    render(<SessionPanel session={current(session.id)} />);
    expect(button("Stop")).not.toBeNull();
    expect(button("Hot Reload")).toBeNull();
    expect(button("Hot Restart")).toBeNull();
  });
});
