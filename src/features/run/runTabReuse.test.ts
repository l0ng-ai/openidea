import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RunConfig } from "@/platform/ipc";

const ipc = vi.hoisted(() => ({
  runStart: vi.fn(async () => ({ status: "ok", data: 1 })),
  runStop: vi.fn(async () => ({ status: "ok", data: null })),
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
import { resetRuns, startRun, useRun, type RunSession } from "./store";

const config = (id: string): RunConfig =>
  ({ id, name: id, kind: "shell", command: "true", args: [], cwd: null, env: {} }) as unknown as RunConfig;
const finished = (id: string, extra: Partial<RunSession> = {}): RunSession =>
  ({
    id,
    config: config(id),
    runId: null,
    status: "finished",
    exitCode: 0,
    startedAt: 0,
    endedAt: 1,
    ...extra,
  }) as RunSession;
const tabs = () => useRun.getState().sessions.map((s) => `${s.id}:${s.config.id}${s.pinned ? "*" : ""}`);

beforeEach(() => {
  vi.clearAllMocks();
  useProject.setState({ settings: null });
  provideNotificationService({ notify: vi.fn() });
  provideToolWindowService({ show: vi.fn(), hide: vi.fn() } as unknown as ToolWindowService);
});
afterEach(() => resetRuns());

it("takes the place of the same configuration's finished tab, then the selected one, never a pinned one", async () => {
  useRun.setState({ sessions: [finished("a"), finished("b"), finished("c", { pinned: true })], activeSession: "b" });
  await startRun(config("a"), undefined, undefined, { prepared: true });
  expect(tabs()).toEqual(["a:a", "b:b", "c:c*"]);
  useRun.setState({ activeSession: "b" });
  await startRun(config("x"), undefined, undefined, { prepared: true });
  expect(tabs()).toEqual(["a:a", "b:x", "c:c*"]);
});

it("opens a new tab when every finished tab is pinned, pinned when the setting asks", async () => {
  useProject.setState({ settings: { run: { pinTabs: true } } as never });
  useRun.setState({ sessions: [finished("a", { pinned: true })], activeSession: "a" });
  await startRun(config("a"), undefined, undefined, { prepared: true });
  expect(tabs()).toEqual(["a:a*", expect.stringMatching(/^run\d+:a\*$/)]);
});

it("keeps an agent's commands out of other tabs", async () => {
  const agent = { ...config("agent:build"), params: { "mcp.agentRun": "build" } } as RunConfig;
  useRun.setState({ sessions: [finished("a")], activeSession: "a" });
  await startRun(agent, undefined, undefined, { prepared: true });
  expect(useRun.getState().sessions).toHaveLength(2);
});

it("gives runs started together their own tabs", async () => {
  useRun.setState({ sessions: [finished("a"), finished("b")], activeSession: "a" });
  await Promise.all([
    startRun(config("x"), "a", undefined, { prepared: true }),
    startRun(config("y"), undefined, undefined, { prepared: true }),
    startRun(config("z"), undefined, undefined, { prepared: true }),
  ]);
  expect(tabs()).toEqual(["a:x", "b:y", expect.stringMatching(/^run\d+:z$/)]);
  expect(ipc.runStart).toHaveBeenCalledTimes(3);
});
