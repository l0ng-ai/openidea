import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { executeAction } from "@/platform/actions";
import { setContext } from "@/platform/context";
import type { RunConfig } from "@/platform/ipc";
import { useDebugRunSessions, type DebugRunSession } from "@/workbench/contributions";
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
  fireEvent.click(screen.getByRole("button", { name: `Stop '${app.name}'` }));
  await executeAction("run.stop");
  expect(session.stop).toHaveBeenCalledTimes(2);
  expect(useRun.getState().sessions[0]?.stopped).toBeUndefined();
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
