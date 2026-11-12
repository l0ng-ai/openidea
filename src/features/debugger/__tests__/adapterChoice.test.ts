import { beforeEach, expect, it, vi } from "vitest";
import { useProject } from "@/platform/project";
import type { LaunchConfig } from "@/platform/ipc";
import {
  provideNotificationService,
  provideToolWindowService,
  type ToolWindowService,
} from "@/workbench/contributions";
import { handleDebugEvent, startSession, useDebug } from "../state";

const ipc = vi.hoisted(() => ({ debugStart: vi.fn() }));
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return { ...real, isTauri: () => true, commands: { ...real.commands, ...ipc } };
});

const kotlin: LaunchConfig = {
  name: "AppKt",
  adapter: "kotlin-debug-adapter",
  request: "launch",
  program: null,
  args: [],
  cwd: "/p",
  env: {},
  extraJson: null,
};

beforeEach(() => {
  useDebug.setState({ sessions: {}, active: null, console: {} });
  useProject.setState({ project: { root: "/p" } as never });
  provideNotificationService({ notify: vi.fn() });
  provideToolWindowService({ show: vi.fn() } as unknown as ToolWindowService);
  vi.clearAllMocks();
});

it("keeps the adapter the backend chose, and the one asked for to start again", async () => {
  ipc.debugStart.mockImplementation(async () => {
    handleDebugEvent(7, { kind: "started", name: "AppKt", adapter: "kotlin-lsp", parent: null });
    return { status: "ok", data: 7 };
  });
  expect(await startSession(kotlin)).toBe(7);
  const session = useDebug.getState().sessions[7]!;
  expect(session.adapter).toBe("kotlin-lsp");
  expect(session.launch?.adapter).toBe("kotlin-debug-adapter");
});

it("takes the requested adapter when the backend reported none", async () => {
  ipc.debugStart.mockResolvedValue({ status: "ok", data: 8 });
  expect(await startSession(kotlin)).toBe(8);
  expect(useDebug.getState().sessions[8]!.adapter).toBe("kotlin-debug-adapter");
});
