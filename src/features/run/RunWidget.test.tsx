import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { executeAction, executeActionFrom, getAction, registerAction } from "@/platform/actions";
import { setContext } from "@/platform/context";
import type { RunConfig } from "@/platform/ipc";
import {
  registerMenuGroup,
  registerRunConfigType,
  useDebugRunSessions,
  type DebugRunSession,
} from "@/workbench/contributions";
import { useContextMenuStore } from "@/ui";
import { applicationConfig } from "./application";
import { activate } from "./index";
import { RunWidget } from "./RunWidget";
import { resetRuns, useRun, type RunSession } from "./store";
import { selectedTarget } from "./sessionTargets";

const config = (id: string): RunConfig => ({
  id,
  name: id,
  kind: "shell",
  command: "sleep",
  args: ["60"],
  cwd: null,
  env: {},
  detected: false,
  isTest: false,
  debugAdapter: null,
});
const app = config("SdCloudOaApplication");
const npm = config("sdcloud-oa-vue3: npm run dev");
const run = (c: RunConfig, startedAt = 1): RunSession => ({
  id: c.id,
  config: c,
  runId: 1,
  status: "running",
  exitCode: null,
  startedAt,
  endedAt: null,
  stdinClosed: false,
});
const debug = (c: RunConfig, startedAt = 2): DebugRunSession => ({
  id: 1,
  configId: c.id,
  name: c.name,
  startedAt,
  paused: false,
  rerun: vi.fn(),
  stop: vi.fn(),
  resume: vi.fn(),
});
let dispose: () => void;
beforeEach(() => {
  resetRuns();
  useRun.setState({ configs: [app, npm], selectedId: app.id, loaded: true });
  useDebugRunSessions.setState({ sessions: [] });
  setContext("projectOpen", true);
  dispose = activate();
});
afterEach(() => {
  cleanup();
  dispose();
  useDebugRunSessions.setState({ sessions: [] });
});

it("reruns and stops the selected configuration among several running sessions", () => {
  useRun.setState({ sessions: [run(app), run(npm, 3)] });
  render(<RunWidget />);
  expect(screen.getByRole("button", { name: `Rerun '${app.name}'` })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: `Stop '${app.name}'` }));
  expect(useRun.getState().sessions.map((s) => !!s.stopped)).toEqual([true, false]);
});

it("offers Run/Debug for an idle selection and Stop for the other process", () => {
  useRun.setState({ sessions: [run(npm)] });
  render(<RunWidget />);
  expect(screen.getByRole("button", { name: `Run '${app.name}'` })).toBeTruthy();
  expect(screen.getByRole("button", { name: `Debug '${app.name}'` })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Rerun/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: `Stop '${npm.name}'` }));
  expect(useRun.getState().sessions[0]?.stopped).toBe(true);
});

it("offers a stop list when the selection is idle and several other sessions run", () => {
  useRun.setState({ sessions: [run(npm), run(config("other"))] });
  render(<RunWidget />);
  expect(screen.getByRole("button", { name: "Stop (2 running)" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Rerun/ })).toBeNull();
});

it("targets the selected debug session while npm runs, through buttons and shortcut actions", async () => {
  const session = debug(app);
  useRun.setState({ sessions: [run(npm, 3)] });
  useDebugRunSessions.setState({ sessions: [session] });
  render(<RunWidget />);
  fireEvent.click(screen.getByRole("button", { name: `Rerun '${app.name}'` }));
  await vi.waitFor(() => expect(session.rerun).toHaveBeenCalledOnce());
  await executeAction("run.run");
  expect(session.rerun).toHaveBeenCalledTimes(2);
  await vi.waitFor(() => expect(screen.getByRole("button", { name: `Stop '${app.name}'` })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: `Stop '${app.name}'` }));
  await vi.waitFor(() => expect(session.stop).toHaveBeenCalledOnce());
  expect(useRun.getState().sessions[0]?.stopped).toBeUndefined();
});

it("turns Stop into Kill process while the process is shutting down", () => {
  useRun.setState({ sessions: [{ ...run(app), status: "stopping" }] });
  render(<RunWidget />);
  expect(screen.getByRole("button", { name: "Kill process" })).toBeTruthy();
});

it("lists every running process with Stop All for the Stop shortcut, like IDEA", async () => {
  const session = debug(app);
  useRun.setState({ sessions: [run(npm, 3)] });
  useDebugRunSessions.setState({ sessions: [session] });
  const unregister = registerMenuGroup({
    id: "test.stopDebug",
    menus: ["stopProcess"],
    items: () => [{ label: app.name, run: () => session.stop() }],
  });
  try {
    render(<RunWidget />);
    await executeAction("run.stop");
    const items = useContextMenuStore.getState().menu!.items;
    expect(items.map((i) => ("label" in i ? i.label : i.kind))).toEqual([
      "Stop Process",
      npm.name,
      app.name,
      "separator",
      "Stop All",
    ]);
    const stopAll = items.at(-1) as { run: () => void };
    stopAll.run();
    expect(session.stop).toHaveBeenCalledOnce();
    expect(useRun.getState().sessions[0]?.stopped).toBe(true);
  } finally {
    unregister();
  }
});

it("ignores an unrelated debug session for an idle selection", () => {
  useDebugRunSessions.setState({ sessions: [debug(npm)] });
  render(<RunWidget />);
  expect(screen.getByRole("button", { name: `Run '${app.name}'` })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Rerun/ })).toBeNull();
});

it.each([1, 3])("prefers the newest Run or Debug session of the same config (run start %s)", (startedAt) => {
  expect(selectedTarget(app.id, [run(app, startedAt)], [debug(app, 2)])?.debug).toBe(startedAt < 2);
});

it("matches a detected Spring configuration after its object and id are regenerated", () => {
  const detect = () =>
    applicationConfig(
      { className: "com.example.SdCloudOaApplication", spring: true },
      "src/main/java/com/example/SdCloudOaApplication.java",
    );
  const original = detect();
  const regenerated = detect();
  expect(regenerated).not.toBe(original);
  expect(regenerated.id).toBe(original.id);
  expect(selectedTarget(regenerated.id, [run(original), run(npm)], [])?.name).toBe(original.name);
});

it("keeps Stop available during startup and restores Rerun immediately when running", () => {
  useRun.setState({ sessions: [{ ...run(app), status: "starting" }] });
  render(<RunWidget />);
  expect(screen.getByRole("status", { name: "Starting…" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: `Rerun '${app.name}'` })).toBeNull();
  expect(screen.getByRole("button", { name: `Stop '${app.name}'` })).toBeEnabled();
  act(() => useRun.setState({ sessions: [run(app)] }));
  expect(screen.queryByRole("status", { name: "Starting…" })).toBeNull();
  expect(screen.getByRole("button", { name: `Stop '${app.name}'` })).toBeEnabled();
  expect(screen.getByRole("button", { name: `Rerun '${app.name}'` })).toBeEnabled();
});

it("stops the selected starting debugger", async () => {
  const session = { ...debug(app), status: "starting" as const };
  useDebugRunSessions.setState({ sessions: [session] });
  render(<RunWidget />);
  expect(screen.getByRole("status", { name: "Starting…" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: `Rerun '${app.name}'` })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: `Stop '${app.name}'` }));
  await vi.waitFor(() => expect(session.stop).toHaveBeenCalledOnce());
});

it("does not replay startup feedback when selecting an already running configuration", () => {
  useRun.setState({ sessions: [run(app), run(npm)] });
  render(<RunWidget />);
  act(() => useRun.setState({ selectedId: npm.id }));
  expect(screen.queryByRole("status", { name: "Starting…" })).toBeNull();
  expect(screen.getByRole("button", { name: `Rerun '${npm.name}'` })).toBeEnabled();
  act(() => useRun.setState({ selectedId: app.id }));
  expect(screen.queryByRole("status", { name: "Starting…" })).toBeNull();
});

it("does not replay startup feedback when selecting an already running debugger", () => {
  useRun.setState({ sessions: [run(app)] });
  useDebugRunSessions.setState({ sessions: [debug(npm)] });
  render(<RunWidget />);
  act(() => useRun.setState({ selectedId: npm.id }));
  expect(screen.queryByRole("status", { name: "Starting…" })).toBeNull();
  expect(screen.getByRole("button", { name: `Rerun '${npm.name}'` })).toBeEnabled();
});

it("stops the selected starting process while other Run and Debug sessions remain live", () => {
  const session = debug(npm);
  useRun.setState({ sessions: [{ ...run(app), status: "starting" }, run(npm)] });
  useDebugRunSessions.setState({ sessions: [session] });
  render(<RunWidget />);
  fireEvent.click(screen.getByRole("button", { name: `Stop '${app.name}'` }));
  expect(useRun.getState().sessions.map((s) => !!s.stopped)).toEqual([true, false]);
  expect(session.stop).not.toHaveBeenCalled();
});

it("stops every child of a starting compound, including its starting debugger", async () => {
  const compound = { ...config("compound"), kind: "compound", compound: [app.id, npm.id] };
  const session = { ...debug(npm), status: "starting" as const };
  useRun.setState({
    configs: [app, npm, compound],
    selectedId: compound.id,
    sessions: [{ ...run(app), status: "starting" }],
  });
  useDebugRunSessions.setState({ sessions: [session] });
  render(<RunWidget />);
  expect(screen.getByRole("status", { name: "Starting…" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: `Stop '${compound.name}'` }));
  await vi.waitFor(() => expect(session.stop).toHaveBeenCalledOnce());
  expect(useRun.getState().sessions[0]?.stopped).toBe(true);
});

it("keeps the selected starting session stoppable after switching configurations", () => {
  useRun.setState({ sessions: [{ ...run(app), status: "starting" }, run(npm)] });
  render(<RunWidget />);
  act(() => useRun.setState({ selectedId: npm.id }));
  expect(screen.queryByRole("status", { name: "Starting…" })).toBeNull();
  expect(screen.getByRole("button", { name: `Rerun '${npm.name}'` })).toBeEnabled();
  act(() => useRun.setState({ selectedId: app.id }));
  expect(screen.getByRole("status", { name: "Starting…" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: `Stop '${app.name}'` }));
  expect(useRun.getState().sessions.map((s) => !!s.stopped)).toEqual([true, false]);
});

it.each(["failed", "finished"] as const)("clears startup feedback when the launch is %s", (status) => {
  useRun.setState({ sessions: [{ ...run(app), status: "starting" }] });
  render(<RunWidget />);
  act(() => useRun.setState({ sessions: [{ ...run(app), status, endedAt: Date.now() }] }));
  expect(screen.queryByRole("status", { name: "Starting…" })).toBeNull();
  expect(screen.getByRole("button", { name: `Run '${app.name}'` })).toBeEnabled();
});

it.each(["keyboard", "menu"] as const)("shows feedback for a %s launch and clears it on failure", async (source) => {
  const original = getAction("run.run")!;
  registerAction({ ...original, run: () => useRun.setState({ sessions: [{ ...run(app), status: "starting" }] }) });
  try {
    render(<RunWidget />);
    await act(() => executeActionFrom(source, "run.run"));
    expect(screen.getByRole("status", { name: "Starting…" })).toBeTruthy();
    expect(screen.getByRole("button", { name: `Stop '${app.name}'` })).toBeEnabled();
    act(() => useRun.setState({ sessions: [] }));
    expect(screen.queryByRole("status", { name: "Starting…" })).toBeNull();
  } finally {
    registerAction(original);
  }
});

it.each(["run.run", "run.debug"] as const)("clears feedback when %s returns without a session", async (action) => {
  const original = getAction(action)!;
  let finish!: () => void;
  registerAction({
    ...original,
    run: () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  });
  try {
    render(<RunWidget />);
    fireEvent.click(screen.getByRole("button", { name: `${action === "run.run" ? "Run" : "Debug"} '${app.name}'` }));
    expect(screen.getByRole("status", { name: "Starting…" })).toBeTruthy();
    await act(async () => finish());
    expect(screen.queryByRole("status", { name: "Starting…" })).toBeNull();
    expect(screen.getByRole("button", { name: `Run '${app.name}'` })).toBeEnabled();
  } finally {
    registerAction(original);
  }
});

it("keeps a debug-only configuration stoppable during attachment", () => {
  const unregister = registerRunConfigType({
    id: "test-remote",
    commandLine: () => null,
    label: "Remote",
    icon: "debug",
    debugOnly: true,
    fields: [],
  });
  const remote = { ...app, kind: "test-remote" };
  try {
    useRun.setState({ configs: [remote], selectedId: remote.id });
    render(<RunWidget />);
    expect(screen.getByRole("button", { name: `'${remote.name}' can only be debugged` })).toBeDisabled();
    act(() => useDebugRunSessions.setState({ sessions: [{ ...debug(remote), status: "starting" }] }));
    expect(screen.getByRole("status", { name: "Starting…" })).toBeTruthy();
    expect(screen.getByRole("button", { name: `Stop '${remote.name}'` })).toBeEnabled();
  } finally {
    unregister();
  }
});

it("allows another configuration to launch while the first launch is pending", async () => {
  const original = getAction("run.run")!;
  const finish: (() => void)[] = [];
  registerAction({ ...original, run: () => new Promise<void>((resolve) => finish.push(resolve)) });
  try {
    render(<RunWidget />);
    fireEvent.click(screen.getByRole("button", { name: `Run '${app.name}'` }));
    act(() => useRun.setState({ selectedId: npm.id }));
    fireEvent.click(screen.getByRole("button", { name: `Run '${npm.name}'` }));
    expect(finish).toHaveLength(2);
    expect(screen.getByRole("status", { name: "Starting…" })).toBeTruthy();
    await act(async () => finish[0]!());
    expect(screen.getByRole("status", { name: "Starting…" })).toBeTruthy();
    await act(async () => finish[1]!());
    expect(screen.queryByRole("status", { name: "Starting…" })).toBeNull();
  } finally {
    await act(async () => finish.forEach((resolve) => resolve()));
    registerAction(original);
  }
});
