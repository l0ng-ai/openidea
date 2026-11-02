import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { RunConfig } from "@/platform/ipc";
import { adoptSession, useDebug } from "@/features/debugger/state";
import { registerDebugActions } from "@/features/debugger/actions";
import { useDebugRunSessions, type DebugServiceSession } from "@/workbench/contributions";
import { useRun, type RunSession } from "./store";
import { ServiceSessionPanel } from "./ServiceSessionPanel";
import type { ServiceSession } from "./serviceSessions";

const actions = vi.hoisted(() => ({ executeAction: vi.fn() }));
vi.mock("@/platform/actions", async (orig) => ({ ...(await orig<object>()), executeAction: actions.executeAction }));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 18,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ index, key: index, start: index * 18, size: 18 })),
    measureElement: () => {},
    measure: () => {},
    scrollToIndex: () => {},
  }),
}));

const config: RunConfig = {
  id: "gateway",
  name: "Gateway",
  kind: "spring-boot",
  command: "java",
  args: [],
  cwd: null,
  env: {},
  detected: true,
  isTest: false,
  debugAdapter: "java-debug",
};

const debugger_ = (id: number, status: DebugServiceSession["status"]): DebugServiceSession => ({
  id,
  config,
  startedAt: id,
  status,
  processId: null,
  rerun: vi.fn(),
  stop: vi.fn(async () => {}),
  show: vi.fn(),
});

const runSession = (extra: Partial<RunSession> = {}): RunSession => ({
  id: "run1",
  config,
  runId: null,
  status: "running",
  exitCode: null,
  startedAt: 1,
  endedAt: null,
  stdinClosed: false,
  ...extra,
});

const execution = (extra: Partial<ServiceSession> = {}): ServiceSession => ({
  config,
  startedAt: 1,
  debug: [],
  ...extra,
});

let dispose: () => void;
beforeEach(() => {
  dispose = registerDebugActions();
  actions.executeAction.mockClear();
  useDebug.setState({ sessions: {}, console: {}, active: null });
  useDebugRunSessions.setState({ sessions: [], serviceSessions: [] });
  useRun.setState({ configs: [config], sessions: [], versions: {} });
});
afterEach(() => {
  dispose();
});

const toolbar = () => within(screen.getByRole("toolbar", { name: "Run actions" }));

it("shows Run, Debug and a disabled Stop for a config that never ran, console area blank", () => {
  render(<ServiceSessionPanel config={config} execution={undefined} />);
  const t = toolbar();
  expect(t.getByRole("button", { name: /Run/ })).toBeEnabled();
  expect(t.getByRole("button", { name: /Debug/ })).toBeEnabled();
  expect(t.getByRole("button", { name: "Stop" })).toBeDisabled();
  expect(screen.queryByRole("log")).toBeNull();
});

it("shows Rerun, the Debug switch and an enabled Stop for a running session", () => {
  const s = runSession();
  useRun.setState({ sessions: [s] });
  render(<ServiceSessionPanel config={config} execution={execution({ run: s })} />);
  const t = toolbar();
  expect(t.getByRole("button", { name: /Rerun/ })).toBeEnabled();
  expect(t.getByRole("button", { name: /Debug/ })).toBeEnabled();
  expect(t.getByRole("button", { name: "Stop" })).toBeEnabled();
  expect(screen.queryByRole("tab")).toBeNull();
});

it("embeds the debugger controls and targets the session, not the active debugger", () => {
  const d = debugger_(1, "running");
  adoptSession(2, { runConfig: { ...config, id: "other" } });
  adoptSession(1, { runConfig: config });
  useDebug.setState({ active: 2 });
  useDebugRunSessions.setState({ serviceSessions: [d] });
  render(<ServiceSessionPanel config={config} execution={execution({ debug: [d] })} />);
  const t = toolbar();
  expect(t.getByRole("button", { name: /Rerun/ })).toBeEnabled();
  expect(t.getByRole("button", { name: /Pause/ })).toBeEnabled();
  for (const step of ["Step Over", "Step Into", "Step Out"])
    expect(t.getByRole("button", { name: step })).toBeDisabled();
  expect(t.getByRole("button", { name: /Resume/ })).toBeDisabled();
  fireEvent.click(t.getByRole("button", { name: /Pause/ }));
  expect(useDebug.getState().active).toBe(1);
  expect(actions.executeAction).toHaveBeenCalledWith("debug.pause");
  expect(screen.getByRole("tab", { name: "Threads & Variables" })).toBeTruthy();
  expect(screen.getByRole("tab", { name: "Console" })).toBeTruthy();
});

it("enables stepping and selects Threads & Variables when the debugger pauses", () => {
  const d = debugger_(1, "paused");
  adoptSession(1, { runConfig: config, status: "paused", stoppedThread: 1 });
  useDebugRunSessions.setState({ serviceSessions: [d] });
  render(<ServiceSessionPanel config={config} execution={execution({ debug: [d] })} />);
  const t = toolbar();
  expect(t.getByRole("button", { name: /Resume/ })).toBeEnabled();
  expect(t.getByRole("button", { name: /Pause/ })).toBeDisabled();
  for (const step of ["Step Over", "Step Into", "Step Out"])
    expect(t.getByRole("button", { name: step })).toBeEnabled();
  // Pausing auto-selects the Threads & Variables view, as in the Debug window.
  expect(screen.getByRole("tab", { name: "Threads & Variables" }).getAttribute("aria-selected")).toBe("true");
});

it("keeps the run console for a debugged process and stops both on Stop", async () => {
  const stop = vi.fn(async () => {});
  const d = debugger_(1, "running");
  d.stop = stop;
  const s = runSession();
  useRun.setState({ sessions: [s] });
  adoptSession(1, { runConfig: config, process: null });
  useDebugRunSessions.setState({ serviceSessions: [d] });
  render(<ServiceSessionPanel config={config} execution={execution({ run: s, debug: [d] })} />);
  // The Console tab shows the run output (SessionConsole), not the debugger's.
  expect(screen.getByRole("tab", { name: "Console" })).toBeTruthy();
  fireEvent.click(toolbar().getByRole("button", { name: "Stop" }));
  expect(stop).toHaveBeenCalled();
});
