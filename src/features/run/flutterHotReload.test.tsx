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
import { useFlutterRunApps } from "@/workbench/flutterRunApps";
import { hotReloadSession, supportsHotReload, syncFlutterRunApps } from "./flutterHotReload";
import { machineLine } from "./flutterMachine";
import { SessionPanel } from "./RunView";
import { resetRuns, runtime, startRun, useRun } from "./store";

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
const event = (name: string, params: object) => JSON.stringify([{ event: name, params }]);
const WS = "ws://127.0.0.1:50300/abc=/ws";

/** Starts `flutter run --machine` and has it print `lines`, up to `app.started`. */
async function startedApp(...lines: string[]) {
  const session = (await startRun(flutter(["--machine"])))!;
  const channel = ipc.runStart.mock.calls.at(-1)![1] as { onmessage: (c: unknown) => void };
  const out = [
    event("daemon.connected", { version: "0.6.1", pid: 1 }),
    event("app.start", { appId: "A1", deviceId: "sim-1", supportsRestart: true, mode: "debug" }),
    "Launching lib/main.dart on iPhone in debug mode...",
    event("app.debugPort", { appId: "A1", port: 50300, wsUri: WS }),
    event("app.started", { appId: "A1" }),
    ...lines,
  ];
  channel.onmessage({ kind: "stdout", text: out.map((l) => `${l}\n`).join("") });
  await vi.waitFor(() => expect(useFlutterRunApps.getState()[session.id]?.started).toBe(true));
  return session;
}

const consoleText = (id: string) =>
  runtime(id)!
    .console.textChunks()
    .map((c) => c.text)
    .join("");
const button = (name: string) => screen.queryByRole("button", { name: new RegExp(`^${name}`) });

beforeEach(() => {
  resetRuns();
  ipc.runStart.mockClear();
  ipc.runStdin.mockClear();
  useFlutterRunApps.setState({}, true);
  provideToolWindowService({ show: vi.fn(), isVisible: () => true } as unknown as ToolWindowService);
  provideNotificationService({ notify: () => undefined });
});

describe("Flutter hot reload in the Run tool window", () => {
  it("applies only to flutter run in a mode with hot reload", () => {
    expect(supportsHotReload(flutter())).toBe(true);
    expect(supportsHotReload(flutter(["-d", "macos", "--flavor", "dev"]))).toBe(true);
    expect(supportsHotReload(flutter(["--machine"]))).toBe(true);
    for (const flag of ["--release", "--profile", "--jit-release", "--no-hot", "--trace-startup"])
      expect(supportsHotReload(flutter([flag]))).toBe(false);
    expect(supportsHotReload(flutter([], { args: ["test"] }))).toBe(false);
    expect(supportsHotReload(flutter([], { kind: "shell" }))).toBe(false);
  });

  it("follows the app from the --machine events and shows its output as plain lines", async () => {
    const session = await startedApp(
      event("app.log", { appId: "A1", log: "flutter: hello" }),
      event("app.progress", { appId: "A1", id: "1", progressId: "hot.reload", message: "Performing hot reload..." }),
      event("app.progress", { appId: "A1", id: "1", progressId: "hot.reload", finished: true }),
      "Reloaded 1 of 700 libraries in 250ms.",
      JSON.stringify([{ id: 1, result: { code: 0, message: "Reloaded 1 of 700 libraries" } }]),
      event("daemon.logMessage", { level: "error", message: "Lost connection to device." }),
      JSON.stringify([{ id: 2, result: { code: 1, message: "Reload rejected" } }]),
    );
    expect(useFlutterRunApps.getState()[session.id]).toMatchObject({
      appId: "A1",
      device: "sim-1",
      vmServiceUri: WS,
      supportsRestart: true,
      live: true,
    });
    await vi.waitFor(() =>
      expect(consoleText(session.id)).toBe(
        [
          "Launching lib/main.dart on iPhone in debug mode...",
          "flutter: hello",
          "Performing hot reload...",
          "Reloaded 1 of 700 libraries in 250ms.",
          "Lost connection to device.",
          "Reload rejected",
          "",
        ].join("\n"),
      ),
    );
    expect(machineLine(session.id, "[{not json")).toBe("[{not json\n");
  });

  it("puts both buttons after Stop and sends app.restart requests", async () => {
    const session = await startedApp();
    render(<SessionPanel session={current(session.id)} />);
    const names = screen.getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? "");
    const stop = names.findIndex((n) => n.startsWith("Stop"));
    expect(names[stop + 1]).toMatch(/^Hot Reload/);
    expect(names[stop + 2]).toMatch(/^Hot Restart/);
    expect(hotReloadSession()?.id).toBe(session.id);

    fireEvent.click(button("Hot Reload")!);
    fireEvent.click(button("Hot Restart")!);
    const sent = ipc.runStdin.mock.calls.map(([id, data]) => {
      expect(id).toBe(9);
      expect(data).toMatch(/\n$/);
      return JSON.parse(data as string)[0].params;
    });
    expect(sent).toEqual([
      { appId: "A1", fullRestart: false, pause: false, reason: "manual" },
      { appId: "A1", fullRestart: true, pause: false, reason: "manual" },
    ]);
  });

  it("disables the buttons until the app started", async () => {
    const session = (await startRun(flutter(["--machine"])))!;
    render(<SessionPanel session={current(session.id)} />);
    expect(button("Hot Reload")).toHaveProperty("disabled", true);
    expect(hotReloadSession()).toBeUndefined();
  });

  it("disables the buttons once the process ended, and ends the app", async () => {
    const session = await startedApp();
    useRun.setState((s) => ({
      sessions: s.sessions.map((x) => (x.id === session.id ? { ...x, status: "finished" as const } : x)),
    }));
    syncFlutterRunApps(useRun.getState().sessions);
    render(<SessionPanel session={current(session.id)} />);
    expect(button("Hot Reload")).toHaveProperty("disabled", true);
    expect(button("Hot Restart")).toHaveProperty("disabled", true);
    expect(hotReloadSession()).toBeUndefined();
    // DevTools pages stay on an ended app's address until another starts.
    expect(useFlutterRunApps.getState()[session.id]).toMatchObject({ live: false, vmServiceUri: WS });
    syncFlutterRunApps([]);
    expect(useFlutterRunApps.getState()[session.id]).toBeUndefined();
  });

  it("shows no buttons for other configurations", async () => {
    const session = (await startRun(flutter([], { id: "app", kind: "shell", command: "top", args: [] })))!;
    render(<SessionPanel session={current(session.id)} />);
    expect(button("Stop")).not.toBeNull();
    expect(button("Hot Reload")).toBeNull();
    expect(button("Hot Restart")).toBeNull();
  });
});
