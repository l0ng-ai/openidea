import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const ipc = vi.hoisted(() => ({
  runSaveConfigs: vi.fn(),
  runConfigs: vi.fn(),
  runTemplates: vi.fn(async () => ({ status: "ok", data: [] })),
  runImportSources: vi.fn(),
  runImportConfigs: vi.fn(),
}));
vi.mock("@/platform/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/platform/ipc")>()),
  isTauri: () => true,
  commands: ipc,
}));

import { _resetI18nForTests, setLocale } from "@/platform/i18n";
import type { RunConfig, RunImport } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { provideNotificationService, type NotificationService } from "@/workbench/contributions";
import { EditConfigsOverlay } from "./EditConfigsDialog";
import { importSummary } from "./importConfigs";
import { resetRuns, useRun } from "./store";
import { registerBuiltinTypes } from "./types";

const cfg = (over: Partial<RunConfig>): RunConfig => ({
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
  ...over,
});

const result = (over: Partial<RunImport> = {}): RunImport => ({
  source: "vscode",
  file: ".vscode/launch.json",
  imported: [{ config: cfg({}), ignored: ["justMyCode"] }],
  skipped: [
    { name: "Current file", reason: { kind: "variable", variable: "${file}" } },
    { name: "Chrome", reason: { kind: "unsupportedType", type: "chrome" } },
    { name: "", reason: { kind: "invalid" } },
  ],
  ...over,
});

const ok = <T,>(data: T) => ({ status: "ok", data });
type Note = Parameters<NotificationService["notify"]>[0];
let notes: Note[];

describe("import summary", () => {
  afterEach(() => _resetI18nForTests());

  it("counts the imported configurations and says why the others were left out", () => {
    const s = importSummary(result());
    expect(s.title).toBe("Imported 1 run configuration from .vscode/launch.json");
    expect(s.level).toBe("info");
    expect(s.sticky).toBe(true);
    render(<>{s.body}</>);
    expect(
      screen.getByText("Skipped 'Current file': Uses ${file}, which is known only when VS Code starts it"),
    ).toBeInTheDocument();
    expect(screen.getByText("Skipped 'Chrome': The chrome debugger has no equivalent here")).toBeInTheDocument();
    expect(screen.getByText("Skipped 'Unnamed': Not a configuration with a name")).toBeInTheDocument();
    expect(screen.getByText("Left out of 'Django': justMyCode")).toBeInTheDocument();
    expect(screen.getByText("Click OK or Apply to save them.")).toBeInTheDocument();
    cleanup();
  });

  it("warns when nothing came in, and translates counts and reasons", async () => {
    const none = importSummary(result({ imported: [], skipped: [{ name: "Django", reason: { kind: "nameTaken" } }] }));
    expect(none).toMatchObject({ level: "warning", title: "No run configurations imported from .vscode/launch.json" });
    expect(importSummary(result({ imported: [{ config: cfg({}), ignored: [] }], skipped: [] }))).toMatchObject({
      sticky: false,
    });
    const two = result({
      imported: [
        { config: cfg({}), ignored: [] },
        { config: cfg({ id: "b", name: "B" }), ignored: [] },
      ],
    });
    expect(importSummary(two).title).toBe("Imported 2 run configurations from .vscode/launch.json");
    await setLocale("zh");
    expect(importSummary(two).title).toBe("已从 .vscode/launch.json 导入 2 个运行配置");
    render(<>{importSummary(result({ imported: [] })).body}</>);
    expect(screen.getByText("已跳过 'Chrome'：此处没有与 chrome 调试器对应的配置类型")).toBeInTheDocument();
    cleanup();
  });
});

describe("Run/Debug Configurations › Import from .vscode/launch.json", () => {
  let dispose: () => void;
  const detected = cfg({ id: "django:runserver", name: "manage.py runserver", command: "python3", detected: true });

  beforeEach(() => {
    resetRuns();
    localStorage.clear();
    dispose = registerBuiltinTypes();
    notes = [];
    provideNotificationService({ notify: (n) => void notes.push(n) });
    useProject.setState({ project: { root: "/test-import" } as never });
    ipc.runImportSources.mockImplementation(async () => ok(["vscode"]));
    ipc.runImportConfigs.mockReset();
    ipc.runImportConfigs.mockImplementation(async () => ok(result()));
    ipc.runSaveConfigs.mockReset();
    ipc.runSaveConfigs.mockImplementation(async () => ok(null));
    useRun.setState({ configs: [detected], loaded: true, selectedId: detected.id, editorOpen: true });
  });
  afterEach(() => {
    cleanup();
    dispose();
    useProject.setState({ project: null });
  });

  it("adds the imported configurations to the dialog, saved on Apply", async () => {
    render(<EditConfigsOverlay />);
    fireEvent.click(await screen.findByRole("button", { name: "Import from .vscode/launch.json" }));
    // The backend matches names against everything in the dialog, detected configurations included.
    await waitFor(() => expect(ipc.runImportConfigs).toHaveBeenCalledWith("vscode", [detected]));
    expect(await screen.findByRole("treeitem", { name: /^Django/ })).toHaveAttribute("aria-selected", "true");
    expect(notes.at(-1)).toMatchObject({ title: "Imported 1 run configuration from .vscode/launch.json" });
    expect(ipc.runSaveConfigs).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(ipc.runSaveConfigs).toHaveBeenCalledWith([cfg({})], []));
  });

  it("offers no import without the file, and reports a file it can't read", async () => {
    ipc.runImportSources.mockImplementation(async () => ok([]));
    render(<EditConfigsOverlay />);
    await waitFor(() => expect(ipc.runImportSources).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Import from .vscode/launch.json" })).not.toBeInTheDocument();
    cleanup();

    ipc.runImportSources.mockImplementation(async () => ok(["vscode"]));
    ipc.runImportConfigs.mockImplementation(async () => ({
      status: "error",
      error: { kind: "invalid", message: ".vscode/launch.json: EOF while parsing", data: null },
    }));
    render(<EditConfigsOverlay />);
    fireEvent.click(await screen.findByRole("button", { name: "Import from .vscode/launch.json" }));
    await waitFor(() =>
      expect(notes.at(-1)).toMatchObject({
        level: "error",
        title: "Cannot import run configurations",
        body: ".vscode/launch.json: EOF while parsing",
      }),
    );
    expect(screen.queryByRole("treeitem", { name: /^Django/ })).not.toBeInTheDocument();
  });

  it("imports again when asked while the dialog is open", async () => {
    render(<EditConfigsOverlay />);
    await screen.findByRole("button", { name: "Import from .vscode/launch.json" });
    act(() => useRun.setState({ editImport: "vscode" }));
    expect(await screen.findByRole("treeitem", { name: /^Django/ })).toBeInTheDocument();
    expect(useRun.getState().editImport).toBeNull();
    expect(ipc.runImportConfigs).toHaveBeenCalledTimes(1);
  });

  it("keeps a configuration with this machine's values local, and says so", async () => {
    const local = cfg({ id: "user:token", name: "Token", local: true });
    ipc.runImportConfigs.mockImplementation(async () =>
      ok(result({ imported: [{ config: local, ignored: [] }], skipped: [] })),
    );
    render(<EditConfigsOverlay />);
    fireEvent.click(await screen.findByRole("button", { name: "Import from .vscode/launch.json" }));
    await screen.findByRole("treeitem", { name: /^Token/ });
    render(<>{notes.at(-1)!.body}</>);
    expect(
      screen.getByText("'Token' is saved in run.local.toml because it uses values from this machine"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(ipc.runSaveConfigs).toHaveBeenCalledWith([local], []));
  });
});
