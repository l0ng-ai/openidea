import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RunConfig } from "@/platform/ipc";

const ipc = vi.hoisted(() => ({
  runStart: vi.fn(async (_config: RunConfig) => ({ status: "ok", data: { id: 7, pty: false } })),
  runStop: vi.fn(async () => ({ status: "ok", data: null })),
  fsReadText: vi.fn(async () => ({ status: "ok", data: JSON.stringify({ scripts: { test: "vitest run" } }) })),
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

import { useProject } from "@/platform/project";
import {
  provideNotificationService,
  provideToolWindowService,
  type ToolWindowService,
} from "@/workbench/contributions";
import { resetRuns, startRun, toggleRerunAutomatically, useRun } from "./store";

const config = (over: Partial<RunConfig> = {}): RunConfig =>
  ({
    id: "npm:test",
    name: "npm run test",
    kind: "npm",
    command: "npm",
    args: ["run", "test"],
    cwd: null,
    env: {},
    isTest: true,
    ...over,
  }) as RunConfig;
const launched = () => ipc.runStart.mock.calls.map(([c]) => [c.command, ...c.args].join(" "));

beforeEach(() => {
  vi.clearAllMocks();
  useProject.setState({ settings: null, project: { root: "/p" } as never });
  provideNotificationService({ notify: vi.fn() });
  provideToolWindowService({ show: vi.fn(), hide: vi.fn() } as unknown as ToolWindowService);
});
afterEach(() => resetRuns());

it("runs as configured without Watch for changes", async () => {
  await startRun(config(), undefined, undefined, { prepared: true });
  expect(launched()).toEqual(["npm run test"]);
  expect(ipc.fsReadText).not.toHaveBeenCalled();
});

it("launches the watcher, and Rerun Automatically stops it", async () => {
  const session = await startRun(config({ watch: true }), undefined, undefined, { prepared: true });
  expect(ipc.fsReadText).toHaveBeenCalledWith("/p/package.json");
  expect(launched()).toEqual(["npx --no vitest watch"]);
  expect(useRun.getState().sessions[0]!.status).toBe("running");
  toggleRerunAutomatically(session!.id);
  await vi.waitFor(() => expect(ipc.runStop).toHaveBeenCalledWith(7));
});

it("Rerun Automatically restarts a finished tab in watch mode", async () => {
  const session = await startRun(config(), undefined, undefined, { prepared: true });
  useRun.setState((s) => ({ sessions: s.sessions.map((x) => ({ ...x, status: "finished" as const })) }));
  toggleRerunAutomatically(session!.id);
  await vi.waitFor(() => expect(launched()).toEqual(["npm run test", "npx --no vitest watch"]));
  expect(useRun.getState().sessions).toHaveLength(1);
  expect(useRun.getState().sessions[0]!.config.watch).toBe(true);
});
