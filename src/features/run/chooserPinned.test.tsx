import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const ipc = vi.hoisted(() => ({ runConfigs: vi.fn() }));
vi.mock("@/platform/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/platform/ipc")>()),
  isTauri: () => true,
  commands: ipc,
}));

import type { RunConfig } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { buildRows, ConfigChooserOverlay } from "./ConfigChooser";
import { loadConfigs, resetRuns, togglePinned, useRun } from "./store";

const config = (id: string, kind = "npm"): RunConfig => ({
  id,
  name: id,
  kind,
  command: "run",
  args: [],
  cwd: null,
  env: {},
  detected: true,
  isTest: false,
  debugAdapter: null,
});
const configs = [config("build"), config("serve"), config("App", "application")];

beforeEach(() => {
  resetRuns();
  localStorage.clear();
  useProject.setState({ project: { root: "/pinned" } as never });
  ipc.runConfigs.mockImplementation(async () => ({ status: "ok", data: configs }));
});
afterEach(() => {
  cleanup();
  useProject.setState({ project: null });
});

const names = (rows: ReturnType<typeof buildRows>) =>
  rows.map((r) => (r.type === "section" ? `[${r.label}]` : r.type === "config" ? r.config.name : r.type));

it("lists pinned configurations first, in pin order, and not again in their group", () => {
  expect(names(buildRows(configs, "", null, [], ["serve", "App", "gone"]))).toEqual([
    "current",
    "[Pinned]",
    "serve",
    "App",
    "[npm]",
    "build",
    "edit",
  ]);
  // A search keeps the pinned matches on top.
  expect(names(buildRows(configs, "s", null, [], ["serve"]))).toEqual(["[Pinned]", "serve", "edit"]);
});

it("keeps pins per project across reloads", async () => {
  await loadConfigs();
  togglePinned("serve");
  togglePinned("build");
  resetRuns();
  await loadConfigs();
  expect(useRun.getState().pinned).toEqual(["serve", "build"]);
  togglePinned("serve");
  expect(useRun.getState().pinned).toEqual(["build"]);
  useProject.setState({ project: { root: "/other" } as never });
  resetRuns();
  await loadConfigs();
  expect(useRun.getState().pinned).toEqual([]);
});

it("pins and unpins from the row's button", async () => {
  await loadConfigs();
  useRun.setState({ chooserOpen: true });
  render(<ConfigChooserOverlay />);
  fireEvent.pointerMove(screen.getByRole("option", { name: /^build/ }));
  fireEvent.click(screen.getByRole("button", { name: "Pin" }));
  expect(useRun.getState().pinned).toEqual(["build"]);
  expect(screen.getByText("Pinned")).toBeInTheDocument();
  fireEvent.pointerMove(screen.getByRole("option", { name: /^build/ }));
  fireEvent.click(screen.getByRole("button", { name: "Unpin" }));
  expect(useRun.getState().pinned).toEqual([]);
});

it("lists the configurations started last after the pinned ones, newest first", () => {
  expect(names(buildRows(configs, "", null, [], ["serve"], ["App", "serve", "build"]))).toEqual([
    "current",
    "[Pinned]",
    "serve",
    "[Recent]",
    "App",
    "build",
    "edit",
  ]);
});

it("marks a configuration recent when a run or debug session starts", async () => {
  const { markRecent, trackRecentConfigurations, MAX_RECENT } = await import("./store");
  const { useDebugRunSessions } = await import("@/workbench/contributions");
  await loadConfigs();
  const off = trackRecentConfigurations();
  const session = (id: string, startedAt: number) =>
    ({ id: `s-${id}`, config: config(id), runId: null, status: "running", startedAt }) as never;
  useRun.setState({ sessions: [session("build", 1)] });
  useDebugRunSessions.setState({
    sessions: [
      {
        id: 1,
        configId: "App",
        name: "App",
        startedAt: 2,
        paused: false,
        rerun: null,
        stop: () => {},
        resume: () => {},
      },
    ],
  });
  expect(useRun.getState().recent).toEqual(["App", "build"]);
  // A rerun reuses the session with a new start time.
  useRun.setState({ sessions: [session("build", 3)] });
  expect(useRun.getState().recent).toEqual(["build", "App"]);
  off();
  useDebugRunSessions.setState({ sessions: [] });
  for (let i = 0; i < MAX_RECENT + 2; i++) markRecent(`c${i}`);
  expect(useRun.getState().recent).toHaveLength(MAX_RECENT);
  resetRuns();
  await loadConfigs();
  expect(useRun.getState().recent[0]).toBe(`c${MAX_RECENT + 1}`);
});
