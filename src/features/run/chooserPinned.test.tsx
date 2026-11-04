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
