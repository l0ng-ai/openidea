import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const ipc = vi.hoisted(() => ({
  runSaveConfigs: vi.fn(),
  runConfigs: vi.fn(),
  runTemplates: vi.fn(async () => ({ status: "ok", data: [] })),
}));
vi.mock("@/platform/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/platform/ipc")>()),
  isTauri: () => true,
  commands: ipc,
}));

import type { RunConfig } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { EditConfigsOverlay } from "./EditConfigsDialog";
import { ConfigChooserOverlay } from "./ConfigChooser";
import { canDeleteConfig, deleteConfig, loadConfigs, resetRuns, useRun } from "./store";
import { registerBuiltinTypes } from "./types";

const config = (kind = "npm"): RunConfig => ({
  id: `${kind}:app`,
  name: "Detected app",
  kind,
  command: "run",
  args: [],
  cwd: null,
  env: {},
  detected: true,
  isTest: false,
  debugAdapter: null,
});
let dispose: () => void;
let backend: RunConfig[];
beforeEach(() => {
  resetRuns();
  localStorage.clear();
  dispose = registerBuiltinTypes();
  backend = [config()];
  useProject.setState({ project: { root: "/test-removal" } as never });
  ipc.runConfigs.mockImplementation(async () => ({ status: "ok", data: backend }));
  ipc.runSaveConfigs.mockReset();
  ipc.runSaveConfigs.mockImplementation(async (saved: RunConfig[], removed: string[]) => {
    backend = [...backend.filter((c) => c.detected && !removed.includes(c.id)), ...saved];
    return { status: "ok", data: null };
  });
  useRun.setState({ configs: backend, loaded: true, selectedId: backend[0]!.id, editorOpen: true });
});
afterEach(() => {
  cleanup();
  dispose();
  useProject.setState({ project: null });
});

it("enables minus for detections and stays removed after Apply and backend reload", async () => {
  render(<EditConfigsOverlay />);
  const minus = screen.getByRole("button", { name: "Remove Configuration" });
  expect(minus).toBeEnabled();
  fireEvent.click(minus);
  expect(ipc.runSaveConfigs).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  await waitFor(() => expect(ipc.runSaveConfigs).toHaveBeenCalledWith([], ["npm:app"]));
  await act(() => loadConfigs());
  expect(useRun.getState().configs).toEqual([]);
  cleanup();
  render(<EditConfigsOverlay />);
  expect(screen.queryByRole("treeitem", { name: "Detected app" })).not.toBeInTheDocument();
});

it("handles Delete only inside the tree", async () => {
  render(<EditConfigsOverlay />);
  fireEvent.keyDown(screen.getByRole("textbox", { name: "Name" }), { key: "Delete" });
  expect(screen.getByRole("treeitem", { name: "Detected app" })).toBeInTheDocument();
  const tree = screen.getByRole("tree");
  tree.focus();
  fireEvent.keyDown(tree, { key: "Delete" });
  expect(screen.queryByRole("treeitem", { name: "Detected app" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "OK" }));
  await waitFor(() => expect(useRun.getState().editorOpen).toBe(false));
  expect(ipc.runSaveConfigs).toHaveBeenCalledWith([], ["npm:app"]);
});

it("keeps the override label and removes overrides without suppression", async () => {
  useRun.setState({ configs: [{ ...config(), detected: false }] });
  render(<EditConfigsOverlay />);
  fireEvent.click(screen.getByRole("button", { name: "Remove Override (restore detected)" }));
  fireEvent.click(screen.getByRole("button", { name: "OK" }));
  await waitFor(() => expect(ipc.runSaveConfigs).toHaveBeenCalledWith([], []));
});

it.each(["spring-boot", "application", "maven", "gradle", "npm", "pytest", "cargo", "go"])(
  "chooser deletion suppresses detected %s configurations",
  async (kind) => {
    const c = config(kind);
    backend = [c];
    useRun.setState({ configs: backend, selectedId: c.id });
    expect(canDeleteConfig(c.id)).toBe(true);
    await deleteConfig(c.id);
    expect(ipc.runSaveConfigs).toHaveBeenCalledWith([], [c.id]);
    expect(useRun.getState().configs).toEqual([]);
  },
);

it("temporary deletion does not persist suppression", async () => {
  useRun.setState({ temporary: ["npm:app"] });
  await deleteConfig("npm:app");
  expect(ipc.runSaveConfigs).not.toHaveBeenCalled();
  expect(useRun.getState().configs).toEqual([]);
});

it("chooser popup Delete removes the selected detection", async () => {
  useRun.setState({ chooserOpen: true, editorOpen: false });
  render(<ConfigChooserOverlay />);
  fireEvent.keyDown(document.querySelector("input[data-autofocus]")!, { key: "Delete" });
  await waitFor(() => expect(ipc.runSaveConfigs).toHaveBeenCalledWith([], ["npm:app"]));
  await waitFor(() => expect(useRun.getState().configs).toEqual([]));
});

it("Cancel discards a pending detected removal", () => {
  render(<EditConfigsOverlay />);
  fireEvent.click(screen.getByRole("button", { name: "Remove Configuration" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(ipc.runSaveConfigs).not.toHaveBeenCalled();
  expect(useRun.getState().configs).toEqual([config()]);
});
