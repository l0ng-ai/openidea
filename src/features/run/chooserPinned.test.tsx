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
  rows.map((r) =>
    r.type === "section"
      ? r.label
        ? `[${r.label}]`
        : "---"
      : r.type === "config"
        ? r.config.name
        : r.type === "all"
          ? `all ${r.count}${r.expanded ? " v" : " >"}`
          : r.type,
  );

it("lists pinned configurations first, in pin order, and not again in their group", () => {
  expect(names(buildRows(configs, "", null, [], ["serve", "App", "gone"]))).toEqual([
    "[Pinned]",
    "serve",
    "App",
    "[npm]",
    "build",
    "---",
    "current",
    "---",
    "edit",
  ]);
  // A search keeps the pinned matches on top.
  expect(names(buildRows(configs, "s", null, [], ["serve"]))).toEqual(["[Pinned]", "serve", "---", "edit"]);
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

it("pins and unpins from the row's actions menu", async () => {
  await loadConfigs();
  useRun.setState({ chooserOpen: true });
  render(<ConfigChooserOverlay />);
  fireEvent.pointerMove(screen.getByRole("option", { name: /^build/ }));
  fireEvent.click(screen.getByRole("button", { name: "More Actions" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Pin" }));
  expect(useRun.getState().pinned).toEqual(["build"]);
  expect(useRun.getState().chooserOpen).toBe(true);
  expect(screen.getByText("Pinned")).toBeInTheDocument();
  fireEvent.pointerMove(screen.getByRole("option", { name: /^build/ }));
  fireEvent.click(screen.getByRole("button", { name: "More Actions" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Unpin" }));
  expect(useRun.getState().pinned).toEqual([]);
});

it("offers the configuration's executors, Edit and Delete in its actions menu, also on →", async () => {
  await loadConfigs();
  useRun.setState({ chooserOpen: true });
  render(<ConfigChooserOverlay />);
  fireEvent.pointerMove(screen.getByRole("option", { name: /^serve/ }));
  fireEvent.keyDown(screen.getByLabelText("Search configurations"), { key: "ArrowRight" });
  const items = screen.getAllByRole("menuitem").map((el) => el.textContent);
  expect(items).toEqual(["Run", "Debug", "Edit…", "Pin", "Delete"]);
  fireEvent.click(screen.getByRole("menuitem", { name: "Edit…" }));
  expect(useRun.getState().chooserOpen).toBe(false);
  expect(useRun.getState().selectedId).toBe("serve");
});

const many = ["a", "b", "c", "d", "e", "f"].map((id) => config(id));

it("folds the other configurations under All Configurations once some are pinned or recent", () => {
  // Fewer than five configurations: no folding.
  expect(names(buildRows(configs, "", null, [], [], ["serve"]))).toEqual([
    "[Recent]",
    "serve",
    "[npm]",
    "build",
    "[Application]",
    "App",
    "---",
    "current",
    "---",
    "edit",
  ]);
  // Nothing pinned or recent: everything stays listed.
  expect(names(buildRows(many, ""))[0]).toBe("[npm]");
  expect(names(buildRows(many, "", null, [], ["b"], ["d"]))).toEqual([
    "[Pinned]",
    "b",
    "[Recent]",
    "d",
    "all 6 >",
    "---",
    "current",
    "---",
    "edit",
  ]);
  // Expanded, it lists every configuration by type, the pinned and recent ones included.
  expect(names(buildRows(many, "", null, [], ["b"], ["d"], true))).toEqual([
    "[Pinned]",
    "b",
    "[Recent]",
    "d",
    "all 6 v",
    "[npm]",
    "a",
    "b",
    "c",
    "d",
    "e",
    "f",
    "---",
    "current",
    "---",
    "edit",
  ]);
  // A search finds the folded ones, once each.
  expect(names(buildRows(many, "e", null, [], ["b"], ["d"]))).toEqual(["[npm]", "e", "---", "current", "---", "edit"]);
});

it("expands All Configurations in place and remembers it per project", async () => {
  ipc.runConfigs.mockImplementation(async () => ({ status: "ok", data: many }));
  await loadConfigs();
  togglePinned("a");
  useRun.setState({ chooserOpen: true });
  render(<ConfigChooserOverlay />);
  expect(screen.queryByRole("option", { name: /^c/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("option", { name: /^All Configurations/ }));
  expect(useRun.getState().chooserOpen).toBe(true);
  expect(screen.getByRole("option", { name: /^c/ })).toBeInTheDocument();
  cleanup();
  resetRuns();
  await loadConfigs();
  expect(useRun.getState().allExpanded).toBe(true);
  useProject.setState({ project: { root: "/other" } as never });
  resetRuns();
  await loadConfigs();
  expect(useRun.getState().allExpanded).toBe(false);
});

it("lists the configurations started last after the pinned ones, newest first", () => {
  expect(names(buildRows(configs, "", null, [], ["serve"], ["App", "serve", "build"]))).toEqual([
    "[Pinned]",
    "serve",
    "[Recent]",
    "App",
    "build",
    "---",
    "current",
    "---",
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
