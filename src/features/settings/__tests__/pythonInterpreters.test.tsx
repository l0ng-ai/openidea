import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectInfo, Sdk } from "@/bindings";
import { useProject } from "@/platform/project";

const mocks = vi.hoisted(() => ({
  detect: vi.fn(),
  projects: vi.fn(),
  interpreter: vi.fn(),
  createVenv: vi.fn(),
  confirm: vi.fn(),
  globalSettings: vi.fn(),
}));
vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    isTauri: () => true,
    commands: {
      ...real.commands,
      sdkDetect: mocks.detect,
      sdkPythonProjectInterpreters: mocks.projects,
      sdkPythonInterpreter: mocks.interpreter,
      sdkPythonCreateVenv: mocks.createVenv,
      settingsGetGlobal: mocks.globalSettings,
      cancelRequest: vi.fn(),
    },
  };
});
vi.mock("@/workbench/messages", () => ({ confirm: mocks.confirm, ask: vi.fn(), showError: vi.fn() }));

const { PythonInterpretersPage } = await import("../languages/PythonInterpretersPage");
const { useSdks } = await import("../languages/api");
const { PageContext } = await import("../components/context");
const { DEFAULT_SETTINGS } = await import("../model/schema");
const { openSettings, useSettingsDialog } = await import("../model/staging");

const ok = <T,>(data: T) => Promise.resolve({ status: "ok" as const, data });

const sdk = (path: string, name: string, home: string | null): Sdk => ({
  path,
  name,
  version: "3.12.0",
  source: path.includes(".venv") ? "venv" : "system",
  home,
  extra: null,
});
const SYSTEM = sdk("/usr/bin/python3", "Python 3.12", "/usr");
const OLD = sdk("/usr/bin/python3.9", "Python 3.9", "/usr");
const PROJECT = sdk("/project/.venv/bin/python", "Python 3.12 (.venv)", "/project/.venv");
const OTHER = sdk("/apps/shop/.venv/bin/python", "Python 3.11 (shop)", "/apps/shop/.venv");
const EXTRA = sdk("/envs/tools/bin/python", "Python 3.13 (tools)", "/envs/tools");

function settings(python: Record<string, unknown> = {}) {
  const base = structuredClone(DEFAULT_SETTINGS);
  Object.assign(base.languages.python, {
    interpreter: PROJECT.path,
    interpreters: [],
    hiddenInterpreters: [],
    hideOtherProjectInterpreters: false,
    showInterpreterPaths: true,
    ...python,
  });
  return base;
}

function page(python: Record<string, unknown> = {}) {
  const base = settings(python);
  mocks.globalSettings.mockResolvedValue(base);
  useProject.setState({ settings: base, project: { root: "/project", name: "backend" } as ProjectInfo });
  openSettings("python.interpreters");
  return render(
    <PageContext.Provider value={{ pageId: "python.interpreters", scope: "global" }}>
      <PythonInterpretersPage />
    </PageContext.Provider>,
  );
}

const stageOf = (key: string) => useSettingsDialog.getState().staged[key]?.value;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.detect.mockResolvedValue(ok([SYSTEM, OLD, PROJECT]));
  mocks.projects.mockResolvedValue(ok([{ project: "/apps/shop", sdk: OTHER }]));
  mocks.interpreter.mockImplementation((path: string) =>
    ok(path === PROJECT.path ? PROJECT : path === EXTRA.path ? EXTRA : null),
  );
  mocks.confirm.mockResolvedValue(true);
  mocks.globalSettings.mockResolvedValue(settings());
  useSdks.setState({ byKind: {}, loading: {}, errors: {} });
});
afterEach(() => {
  cleanup();
});

describe("Python interpreters page", () => {
  it("lists detected, other-project and added interpreters, minus the removed ones", async () => {
    page({ interpreters: [EXTRA.path], hiddenInterpreters: [OLD.path] });
    expect(await screen.findByText("Python 3.12 (.venv)")).toBeInTheDocument();
    expect(screen.getByText("Python 3.11 (shop)")).toBeInTheDocument();
    expect(await screen.findByText("Python 3.13 (tools)")).toBeInTheDocument();
    expect(screen.queryByText("Python 3.9")).not.toBeInTheDocument();
    // The other project's folder labels the row; the path is shown by default.
    expect(screen.getByText("shop")).toBeInTheDocument();
    expect(screen.getByText("/apps/shop/.venv/bin/python")).toBeInTheDocument();
    // The open project's interpreter is marked, and is not filed under "other projects".
    expect(screen.getByText("Project interpreter")).toBeInTheDocument();
    expect(screen.getAllByText("Python 3.12 (.venv)")).toHaveLength(1);
  });

  it("toggles interpreter paths and hides interpreters of other projects", async () => {
    page();
    await screen.findByText("Python 3.11 (shop)");
    fireEvent.click(screen.getByRole("button", { name: "Show Interpreter Paths" }));
    expect(screen.queryByText("/apps/shop/.venv/bin/python")).not.toBeInTheDocument();
    expect(stageOf("global|languages.python.showInterpreterPaths")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Hide Interpreters from Other Projects" }));
    await waitFor(() => expect(screen.queryByText("Python 3.11 (shop)")).not.toBeInTheDocument());
    expect(screen.getByText("Python 3.12 (.venv)")).toBeInTheDocument();
    expect(stageOf("global|languages.python.hideOtherProjectInterpreters")).toBe(true);
  });

  it("removes an interpreter from the list without touching its files", async () => {
    page({ interpreters: [EXTRA.path] });
    const row = await screen.findByRole("option", { name: /Python 3\.11 \(shop\)/ });
    fireEvent.mouseDown(row);
    fireEvent.click(screen.getByRole("button", { name: "Remove Interpreter" }));
    await waitFor(() => expect(screen.queryByText("Python 3.11 (shop)")).not.toBeInTheDocument());
    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: "Remove Interpreter", ok: "Remove" }));
    expect(stageOf("global|languages.python.hiddenInterpreters")).toEqual([OTHER.path]);
    // Not the project interpreter: the selection is untouched.
    expect(stageOf("project|languages.python.interpreter")).toBeUndefined();
  });

  it("clears the project interpreter when the removed one is in use", async () => {
    page();
    const row = await screen.findByRole("option", { name: /Python 3\.12 \(\.venv\)/ });
    fireEvent.mouseDown(row);
    fireEvent.click(screen.getByRole("button", { name: "Remove Interpreter" }));
    await waitFor(() => expect(stageOf("project|languages.python.interpreter")).toBe(""));
    expect(stageOf("global|languages.python.hiddenInterpreters")).toEqual([PROJECT.path]);
  });

  it("adds an interpreter to the list and uses it for the project", async () => {
    page({ interpreter: "" });
    await screen.findByText("Python 3.12 (.venv)");
    fireEvent.click(screen.getByRole("button", { name: "Add Interpreter…" }));
    expect(await screen.findByRole("dialog", { name: "Add Python Interpreter" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Existing environment" }));
    fireEvent.click(screen.getByRole("button", { name: "Interpreter" }));
    const choices = await screen.findByRole("listbox", { name: "Interpreter" });
    fireEvent.click(within(choices).getByRole("option", { name: /Python 3\.12 \(\.venv\)/ }));
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    await waitFor(() => expect(stageOf("global|languages.python.interpreters")).toEqual([PROJECT.path]));
    expect(stageOf("project|languages.python.interpreter")).toBe(PROJECT.path);
  });

  it("sets the project interpreter from a row", async () => {
    page({ interpreter: "" });
    const row = await screen.findByRole("option", { name: /Python 3\.11 \(shop\)/ });
    fireEvent.doubleClick(row);
    expect(stageOf("project|languages.python.interpreter")).toBe(OTHER.path);
  });

  it("finds an interpreter by a path that is not shown", async () => {
    page({ showInterpreterPaths: false });
    await screen.findByText("Python 3.11 (shop)");
    fireEvent.change(screen.getByRole("textbox", { name: "Search interpreters" }), {
      target: { value: "apps/shop" },
    });
    expect(screen.getByText("Python 3.11 (shop)")).toBeInTheDocument();
    expect(screen.queryByText("Python 3.12 (.venv)")).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Search interpreters" }), { target: { value: "nothing" } });
    expect(screen.getByText("No interpreters match the search")).toBeInTheDocument();
  });
});
