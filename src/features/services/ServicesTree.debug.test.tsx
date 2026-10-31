import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { RunConfig } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { validateSettings } from "@/features/settings/model/schema";
import { adoptSession, appendConsole, useDebug } from "@/features/debugger/state";
import { DebugServiceConsole } from "@/features/debugger/ui/DebugConsole";
import { runServiceProvider } from "@/features/run/services";
import { runtime, startRun, useRun } from "@/features/run/store";
import { registerServiceProvider, useDebugRunSessions, type DebugServiceSession } from "@/workbench/contributions";
import { ServicesTreeView } from "./ServicesTree";
import { useServicesTree } from "./tree";

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
const summary = (id: number, extra: Partial<DebugServiceSession> = {}): DebugServiceSession => ({
  id,
  config,
  startedAt: id,
  status: "running",
  processId: null,
  stop: vi.fn(async () => {}),
  rerun: vi.fn(),
  show: vi.fn(),
  ...extra,
});
let dispose: () => void;
beforeEach(() => {
  localStorage.clear();
  useProject.setState({
    project: { root: "/services-debug", name: "app", isGit: false, settings: validateSettings({}) },
  });
  useRun.setState({ configs: [config], sessions: [], loaded: true });
  useDebug.setState({ sessions: {}, console: {}, active: null });
  useDebugRunSessions.setState({ sessions: [], serviceSessions: [], Console: DebugServiceConsole });
  useServicesTree.setState({
    roots: {},
    selectedKey: null,
    selectedKeys: new Set(),
    expanded: new Set(["run:type:spring-boot"]),
  });
  dispose = registerServiceProvider(runServiceProvider);
});
afterEach(() => {
  dispose();
  useDebugRunSessions.setState({ sessions: [], serviceSessions: [], Console: null });
});
const select = () =>
  fireEvent.mouseDown(
    within(screen.getByRole("tree", { name: "Services" }))
      .getByText("Gateway")
      .closest('[role="treeitem"]')!,
  );
const toolbar = () => within(screen.getByRole("toolbar", { name: "Services actions" }));

it("shows debug output/state, pins actions, and does not rebuild the tree for stdout", async () => {
  adoptSession(1, { runConfig: config });
  adoptSession(2, { runConfig: { ...config, id: "other" } });
  appendConsole(1, "stdout", "gateway log\n");
  appendConsole(2, "stdout", "other log\n");
  const d = summary(1);
  useDebugRunSessions.setState({ serviceSessions: [d] });
  useDebug.setState({ active: 2 });
  render(<ServicesTreeView />);
  select();
  expect(screen.getByRole("log")).toHaveTextContent("gateway log");
  expect(screen.getByRole("log")).not.toHaveTextContent("other log");
  expect(toolbar().getByRole("button", { name: "Stop" })).toBeEnabled();
  fireEvent.click(toolbar().getByRole("button", { name: "Rerun" }));
  expect(d.rerun).toHaveBeenCalledOnce();
  expect(useDebug.getState().active).toBe(2);
  const roots = useServicesTree.getState().roots;
  act(() => appendConsole(1, "stdout", "next log\n"));
  expect(screen.getByRole("log")).toHaveTextContent("next log");
  expect(useServicesTree.getState().roots).toBe(roots);
  act(() => useDebugRunSessions.setState({ serviceSessions: [{ ...d, status: "paused" }] }));
  expect(within(screen.getByRole("tree")).getByText("Suspended")).toBeTruthy();
  fireEvent.click(toolbar().getByRole("button", { name: "Stop" }));
  expect(d.stop).toHaveBeenCalledOnce();
});

it("keeps the other parallel instance alive and then displays it", async () => {
  adoptSession(1);
  adoptSession(2);
  appendConsole(1, "stdout", "first instance\n");
  appendConsole(2, "stdout", "second instance\n");
  const first = summary(1),
    second = summary(2);
  useDebugRunSessions.setState({ serviceSessions: [first, second] });
  render(<ServicesTreeView />);
  select();
  expect(screen.getByRole("log")).toHaveTextContent("second instance");
  fireEvent.click(toolbar().getByRole("button", { name: "Stop" }));
  expect(second.stop).toHaveBeenCalledOnce();
  expect(first.stop).not.toHaveBeenCalled();
  act(() => useDebugRunSessions.setState({ serviceSessions: [first, { ...second, status: "terminated" }] }));
  expect(screen.getByRole("log")).toHaveTextContent("first instance");
});

it("shows the owning Run output for attached debugging and overrides both sets of controls", async () => {
  const c = { ...config, kind: "shell", command: "echo", debugAdapter: null };
  const s = await startRun(c);
  expect(s).not.toBeNull();
  const active = { ...s!, config, status: "running" as const, runId: 7 };
  runtime(s!.id)!.console.append({ kind: "stdout", text: "Maven application log\n" });
  useRun.setState({ configs: [config], sessions: [active] });
  const d = summary(1, { processId: 7 });
  useDebugRunSessions.setState({ serviceSessions: [d] });
  render(<ServicesTreeView />);
  select();
  expect(screen.getByRole("log")).toHaveTextContent("Maven application log");
  const actions = within(screen.getByRole("toolbar", { name: "Run actions" }));
  fireEvent.click(actions.getByRole("button", { name: "Rerun" }));
  expect(d.rerun).toHaveBeenCalledOnce();
  fireEvent.click(actions.getByRole("button", { name: "Stop" }));
  expect(d.stop).toHaveBeenCalledOnce();
  act(() => useRun.setState({ sessions: [{ ...active, status: "finished" }] }));
  expect(actions.getByRole("button", { name: "Stop" })).toBeEnabled();
});

it("group Stop stops all roots but terminates a shared Maven process only once", async () => {
  const first = summary(1, { processId: 7 }),
    second = summary(2, { processId: 7 });
  useDebugRunSessions.setState({ serviceSessions: [first, second] });
  render(<ServicesTreeView />);
  fireEvent.mouseDown(within(screen.getByRole("tree")).getByText("Spring Boot").closest('[role="treeitem"]')!);
  fireEvent.click(toolbar().getByRole("button", { name: "Stop" }));
  await vi.waitFor(() => expect(second.stop).toHaveBeenCalledOnce());
  expect(first.stop).toHaveBeenCalledExactlyOnceWith({ stopProcess: false });
  expect(second.stop).toHaveBeenCalledExactlyOnceWith();
});
