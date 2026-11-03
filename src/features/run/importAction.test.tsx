import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";

const ipc = vi.hoisted(() => ({ runImportSources: vi.fn(), runImportConfigs: vi.fn() }));
vi.mock("@/platform/ipc", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/platform/ipc")>();
  return { ...original, commands: { ...original.commands, ...ipc } };
});

import { executeAction } from "@/platform/actions";
import { setContext } from "@/platform/context";
import type { RunConfig } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { provideNotificationService, type NotificationService } from "@/workbench/contributions";
import { EditConfigsOverlay } from "./EditConfigsDialog";
import { activate } from "./index";
import { resetRuns, useRun } from "./store";

const django: RunConfig = {
  id: "user:django",
  name: "Django",
  kind: "python",
  command: ".venv/bin/python",
  args: ["manage.py", "runserver"],
  cwd: null,
  env: {},
  detected: false,
  isTest: false,
  debugAdapter: "debugpy",
};
const ok = <T,>(data: T) => ({ status: "ok", data });
const result = () =>
  ok({ source: "vscode", file: ".vscode/launch.json", imported: [{ config: django, ignored: [] }], skipped: [] });
let notes: Array<Parameters<NotificationService["notify"]>[0]>;

describe("Find Action › Import Run Configurations from .vscode/launch.json", () => {
  let dispose: () => void;
  beforeEach(() => {
    resetRuns();
    notes = [];
    provideNotificationService({ notify: (n) => void notes.push(n) });
    useProject.setState({ project: { root: "/test-import" } as never });
    ipc.runImportConfigs.mockReset();
    ipc.runImportConfigs.mockImplementation(async () => result());
    useRun.setState({ configs: [], loaded: true });
    setContext("projectOpen", true);
    dispose = activate();
  });
  afterEach(() => {
    cleanup();
    dispose();
    useProject.setState({ project: null });
  });

  it("opens the dialog and imports once", async () => {
    ipc.runImportSources.mockImplementation(async () => ok(["vscode"]));
    // As in the app (main.tsx): StrictMode runs the dialog's effects twice on mount.
    render(
      <StrictMode>
        <EditConfigsOverlay />
      </StrictMode>,
    );
    await act(() => executeAction("run.importVscodeLaunch"));
    expect(useRun.getState().editorOpen).toBe(true);
    expect(await screen.findByRole("treeitem", { name: /^Django/ })).toBeInTheDocument();
    expect(ipc.runImportConfigs).toHaveBeenCalledTimes(1);
    expect(useRun.getState().editImport).toBeNull();
    // No duplicate ids in the draft.
    expect(screen.getAllByRole("treeitem", { name: /^Django/ })).toHaveLength(1);
  });

  it("says so without opening the dialog when the project has no launch.json", async () => {
    ipc.runImportSources.mockImplementation(async () => ok([]));
    await act(() => executeAction("run.importVscodeLaunch"));
    expect(useRun.getState().editorOpen).toBe(false);
    expect(ipc.runImportConfigs).not.toHaveBeenCalled();
    expect(notes.at(-1)).toMatchObject({ level: "info", title: "This project has no .vscode/launch.json" });
  });

  it("imports JetBrains run configurations the same way", async () => {
    ipc.runImportSources.mockImplementation(async () => ok(["vscode"]));
    await act(() => executeAction("run.importJetbrains"));
    expect(useRun.getState().editorOpen).toBe(false);
    expect(notes.at(-1)).toMatchObject({ title: "This project has no JetBrains run configurations (.run, .idea)" });

    ipc.runImportSources.mockImplementation(async () => ok(["jetbrains"]));
    render(<EditConfigsOverlay />);
    await act(() => executeAction("run.importJetbrains"));
    expect(await screen.findByRole("treeitem", { name: /^Django/ })).toBeInTheDocument();
    expect(ipc.runImportConfigs).toHaveBeenCalledWith("jetbrains", []);
  });
});
