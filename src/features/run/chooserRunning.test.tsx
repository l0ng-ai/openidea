import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/platform/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/platform/ipc")>()),
  isTauri: () => false,
}));

import type { RunConfig } from "@/platform/ipc";
import { useDebugRunSessions } from "@/workbench/contributions";
import { ConfigChooserOverlay } from "./ConfigChooser";
import { resetRuns, useRun, type RunSession } from "./store";

const config = (id: string, name: string): RunConfig => ({
  id,
  name,
  kind: "npm",
  command: "run",
  args: [],
  cwd: null,
  env: {},
  detected: true,
  isTest: false,
  debugAdapter: null,
});
const server = config("npm:server", "server");
const worker = config("npm:worker", "worker");
const idle = config("npm:idle", "idle");

const rerun = vi.fn();
const stop = vi.fn();
beforeEach(() => {
  resetRuns();
  const session = { id: "s1", config: server, runId: null, status: "running", startedAt: 1 } as RunSession;
  useRun.setState({
    configs: [server, worker, idle],
    loaded: true,
    selectedId: server.id,
    sessions: [session],
    chooserOpen: true,
  });
  useDebugRunSessions.setState({
    sessions: [
      { id: 7, configId: worker.id, name: "worker", startedAt: 2, paused: false, rerun, stop, resume: () => {} },
    ],
  });
});
afterEach(() => {
  cleanup();
  useDebugRunSessions.setState({ sessions: [] });
  rerun.mockReset();
  stop.mockReset();
});

const row = (name: string) => screen.getByRole("option", { name: new RegExp(`^${name}`) });

it("marks running and debugged configurations", () => {
  render(<ConfigChooserOverlay />);
  const marked = (name: string) => !!row(name).querySelector("[class*='chooserRunning']");
  expect([marked("server"), marked("worker"), marked("idle")]).toEqual([true, true, false]);
});

it("offers Rerun and Stop for a running configuration instead of Run and Debug", () => {
  render(<ConfigChooserOverlay />);
  fireEvent.pointerMove(row("worker"));
  expect(screen.queryByRole("button", { name: "Run 'worker'" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Stop 'worker'" }));
  expect(stop).toHaveBeenCalledOnce();
  expect(useRun.getState().chooserOpen).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Rerun 'worker'" }));
  expect(rerun).toHaveBeenCalledOnce();
  expect(useRun.getState().chooserOpen).toBe(false);
});

it("keeps Run and Debug for a configuration that isn't running", () => {
  render(<ConfigChooserOverlay />);
  fireEvent.pointerMove(row("idle"));
  expect(screen.getByRole("button", { name: "Run 'idle'" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Stop 'idle'" })).not.toBeInTheDocument();
});
