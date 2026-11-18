import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import type {
  AgentConfigOption,
  AgentEntry,
  AgentEvent,
  AgentModelCatalog,
  AgentProvider,
  AgentTask,
  NewAgentTask,
  ProjectInfo,
} from "@/bindings";
import { executeAction } from "@/platform/actions";
import { setContext } from "@/platform/context";
import { useProject } from "@/platform/project";
import type { EditorInput } from "@/workbench/contributions";
import { HomeEditor } from "./HomeEditor";
import { activate } from "./index";
import { SESSION_KIND, sessionKey } from "./model";
import { SessionEditor } from "./SessionEditor";
import { HOME, connect, savedDraft, updateComposer, useAgents } from "./store";

const backend = vi.hoisted(() => ({
  activeInput: null as EditorInput | null,
  tasks: [] as AgentTask[],
  providers: [] as AgentProvider[],
  channel: null as { onmessage: (event: AgentEvent) => void } | null,
  refresh: vi.fn(),
  create: vi.fn(),
  setConfig: vi.fn(),
  prompt: vi.fn(),
  notify: vi.fn(),
}));
const ok = <T,>(data: T) => ({ status: "ok" as const, data });
vi.mock("@tauri-apps/api/core", async (original) => ({
  ...(await original<typeof import("@tauri-apps/api/core")>()),
  Channel: class {
    onmessage = () => {};
  },
}));
vi.mock("@/platform/ipc", async (original) => ({
  ...(await original<typeof import("@/platform/ipc")>()),
  isTauri: () => true,
  commands: {
    agentSubscribe: async (channel: typeof backend.channel) => {
      backend.channel = channel;
      return ok(backend.tasks);
    },
    agentProviders: async () => ok(backend.providers),
    agentRefreshModels: (provider: string, force: boolean, model: string | null) =>
      backend.refresh(provider, force, model),
    agentProbe: async () => ok(null),
    agentCommands: async () => ok([]),
    vcsBranchInfo: async () => ok({ head: "main" }),
    vcsConfigGet: async () => ok(null),
    vcsBranches: async () => ok([]),
    agentCreate: (request: NewAgentTask) => backend.create(request),
    agentEntries: async () => ok([{ type: "user", text: "Earlier message", attachments: [] }] satisfies AgentEntry[]),
    agentChanges: async () => ok([]),
    agentSetConfig: (task: string, id: string, value: string) => backend.setConfig(task, id, value),
    agentPrompt: backend.prompt,
  },
}));
vi.mock("@/workbench/contributions", async (original) => ({
  ...(await original<typeof import("@/workbench/contributions")>()),
  maybeEditorService: () => ({ activePath: () => null, activeInput: () => backend.activeInput }),
  editorService: () => ({
    activePath: () => null,
    activeInput: () => backend.activeInput,
    openTabs: () => [],
    closeInput: () => false,
  }),
  notifications: () => ({ notify: backend.notify }),
}));

const option = (id: string, category: string, values: string[], current = values[0] ?? null): AgentConfigOption => ({
  id,
  name: id === "model" ? "Model" : "Reasoning",
  description: null,
  category,
  current,
  via: "option",
  values: values.map((value) => ({ value, name: value, description: null })),
});
const provider = (id: string): AgentProvider => ({
  id,
  name: id,
  command: id,
  program: id,
  args: [],
  defaultProgram: null,
  defaultArgs: [],
  loginHint: null,
  commandOverridden: false,
  commandEditable: true,
  commandReadOnlyReason: null,
  installed: true,
  env: {},
  commands: [],
  source: { kind: "custom" },
  config: [option("model", "model", ["big", "small"])],
  thoughtLevels: { big: [option("effort", "thought_level", ["low", "high"], "high")], small: [] },
});
function catalog(id = "first", patch: Partial<AgentModelCatalog> = {}): AgentModelCatalog {
  const offered = backend.providers.find((p) => p.id === id)!;
  return {
    provider: id,
    config: offered.config,
    thoughtLevels: offered.thoughtLevels ?? {},
    refreshing: false,
    refreshedAtMs: Date.now(),
    retryAtMs: null,
    error: null,
    ...patch,
  };
}
type CatalogReply = { status: "ok"; data: AgentModelCatalog };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const emit = (snapshot: AgentModelCatalog) =>
  act(() => backend.channel!.onmessage({ type: "modelCatalog", catalog: snapshot }));
let dispose: () => void;
let previousProject: ProjectInfo | null;

beforeEach(async () => {
  vi.clearAllMocks();
  mockWindows("main");
  mockIPC(() => undefined, { shouldMockEvents: true });
  previousProject = useProject.getState().project;
  useProject.setState({ project: { root: "/models", trusted: true } as ProjectInfo });
  setContext("projectOpen", true);
  backend.activeInput = null;
  backend.tasks = [];
  backend.setConfig.mockReset().mockResolvedValue(ok(null));
  backend.providers = [provider("first"), provider("second")];
  backend.refresh.mockReset().mockImplementation(async (id: string) => ok(catalog(id)));
  backend.create
    .mockReset()
    .mockImplementation(async (request: NewAgentTask) => ok({ id: "new", config: request.config }));
  dispose = activate();
  await connect();
  useAgents.setState({ draft: savedDraft({ provider: "first", config: {} }) });
  updateComposer(HOME, { text: "Check the project" });
});
afterEach(async () => {
  await vi.dynamicImportSettled();
  cleanup();
  dispose();
  useProject.setState({ project: previousProject });
  setContext("projectOpen", false);
  vi.useRealTimers();
  await vi.dynamicImportSettled();
  clearMocks();
});

it("refreshes an existing chat's searchable model choices and switches through its own option", async () => {
  const task: AgentTask = {
    id: "old-task",
    title: "Old chat",
    provider: "second",
    status: "ready",
    isolation: "local",
    model: "old",
    cwd: "/models",
    branch: null,
    base: null,
    baseCommit: null,
    error: null,
    createdMs: 0,
    updatedMs: 0,
    config: [
      { ...option("session-model", "model", ["old", "session-only"]), name: "Model" },
      option("effort", "thought_level", ["low", "high"], "low"),
      { ...option("mode", "mode", ["plan", "act"]), name: "Mode" },
    ],
    commands: [],
    usage: null,
    queue: [],
  };
  const input = { kind: SESSION_KIND, key: sessionKey(task.id), data: { task: task.id } };
  backend.providers[1]!.config = [option("catalog-model", "model", ["second-cached"])];
  backend.tasks = [task];
  backend.activeInput = input;
  await connect();
  const draft = useAgents.getState().draft;
  const fresh = catalog("second", {
    config: [option("catalog-model", "model", ["fresh"]), option("catalog-only", "context_tier", ["large"])],
    thoughtLevels: { old: [option("catalog-effort", "thought_level", ["max"])] },
  });
  backend.refresh.mockRejectedValueOnce(new Error("discovery offline"));

  render(<SessionEditor input={input} />);
  expect(await screen.findByText("Earlier message")).toBeVisible();
  const modelButton = screen.getByRole("button", { name: "Model" });
  fireEvent.click(modelButton);
  expect(await screen.findByRole("alert")).toHaveTextContent("discovery offline");
  expect(screen.getByRole("option", { name: "session-only" })).toBeVisible();
  expect(screen.getByRole("option", { name: "second-cached" })).toBeVisible();
  expect(backend.refresh.mock.calls).toEqual([["second", false, null]]);
  expect(screen.queryByRole("option", { name: "big" })).not.toBeInTheDocument();

  const pending = deferred<CatalogReply>();
  backend.refresh.mockReturnValueOnce(pending.promise);
  fireEvent.click(screen.getByRole("button", { name: "Refresh models" }));
  expect(screen.getByRole("button", { name: "Refreshing…" })).toBeDisabled();
  await act(async () => executeAction("agents.refreshModels"));
  expect(backend.refresh.mock.calls).toEqual([
    ["second", false, null],
    ["second", true, null],
  ]);
  await act(async () => pending.resolve(ok(fresh)));

  expect(modelButton).toHaveTextContent("old");
  expect(screen.getByRole("option", { name: "session-only" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Reasoning" })).toHaveTextContent("low");
  expect(screen.getByRole("button", { name: "Mode" })).toHaveTextContent("plan");
  expect(screen.getByText("Earlier message")).toBeVisible();
  expect(screen.queryByText("catalog-only")).not.toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(backend.setConfig).not.toHaveBeenCalled();
  expect(backend.create).not.toHaveBeenCalled();
  expect(backend.prompt).not.toHaveBeenCalled();
  expect(useAgents.getState().draft).toBe(draft);

  fireEvent.change(screen.getByPlaceholderText("Search…"), { target: { value: "fresh" } });
  fireEvent.click(screen.getByRole("option", { name: "fresh" }));
  expect(backend.setConfig).toHaveBeenCalledExactlyOnceWith("old-task", "session-model", "fresh");
  expect(modelButton).toHaveTextContent("old");
  act(() =>
    backend.channel!.onmessage({
      type: "task",
      task: { ...task, config: [{ ...task.config[0]!, current: "fresh" }, task.config[2]!] },
    }),
  );
  expect(modelButton).toHaveTextContent("fresh");
  expect(screen.queryByRole("button", { name: "Reasoning" })).not.toBeInTheDocument();
  expect(screen.getByText("Earlier message")).toBeVisible();
  expect(backend.prompt).not.toHaveBeenCalled();

  await act(async () => executeAction("agents.refreshModels"));
  expect(backend.refresh).toHaveBeenLastCalledWith("second", true, null);
  expect(backend.refresh).toHaveBeenCalledTimes(3);
  expect(useAgents.getState().draft).toBe(draft);
});

it("keeps cached choices usable while refreshing and shares the completion/cooldown from another window", async () => {
  backend.refresh.mockImplementation(async (id: string) => ok(catalog(id, { refreshing: true })));
  render(<HomeEditor />);
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  expect(screen.getByRole("button", { name: "Refreshing…" })).toBeDisabled();
  fireEvent.click(screen.getByRole("option", { name: "small" }));
  expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent("small");
  expect(screen.getByRole("button", { name: "Start" })).toBeEnabled();
  await waitFor(() => expect(useAgents.getState().modelRequests.size).toBe(0));
  emit(catalog("first", { retryAtMs: Date.now() + 30_000 }));
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  expect(screen.getByRole("button", { name: /Refresh in \d+s/ })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent("small");
  await act(async () => executeAction("agents.refreshModels"));
  expect(backend.refresh).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Start" }));
  await waitFor(() => expect(backend.create).toHaveBeenCalled());
  expect(backend.create.mock.calls[0]![0].config).toEqual([{ id: "model", value: "small" }]);
});

it("uses the same popup for model-only agents and coalesces repeated manual action invocations", async () => {
  backend.providers[0]!.thoughtLevels = {};
  await connect();
  render(<HomeEditor />);
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  await screen.findByRole("button", { name: "Refresh models" });
  expect(backend.refresh).toHaveBeenCalledExactlyOnceWith("first", false, "big");
  const pending = deferred<CatalogReply>();
  backend.refresh.mockReturnValueOnce(pending.promise);
  fireEvent.click(screen.getByRole("button", { name: "Refresh models" }));
  expect(screen.getByRole("button", { name: "Refreshing…" })).toBeDisabled();
  await act(async () => {
    await executeAction("agents.refreshModels");
    await executeAction("agents.refreshModels");
  });
  expect(backend.refresh).toHaveBeenCalledTimes(2);
  expect(backend.refresh).toHaveBeenLastCalledWith("first", true, "big");
  await act(async () => pending.resolve(ok(catalog("first", { refreshing: true }))));
  await act(async () => executeAction("agents.refreshModels"));
  expect(backend.refresh).toHaveBeenCalledTimes(2);
  emit(catalog("first", { retryAtMs: Date.now() + 30_000 }));
  await act(async () => executeAction("agents.refreshModels"));
  expect(backend.refresh).toHaveBeenCalledTimes(2);
  expect(screen.getByRole("button", { name: /Refresh in \d+s/ })).toBeDisabled();
});

it("shows initial loading and inline discovery failure/retry without blocking a model-less agent", async () => {
  backend.providers[0]!.config = [];
  backend.providers[0]!.thoughtLevels = {};
  await connect();
  backend.refresh.mockImplementation(async (id: string) => ok(catalog(id, { refreshing: true })));
  render(<HomeEditor />);
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  expect(screen.getByText("Loading models…")).toBeVisible();
  expect(screen.getByRole("button", { name: "Start" })).toBeEnabled();
  await waitFor(() => expect(useAgents.getState().modelRequests.size).toBe(0));
  emit(catalog("first", { error: "offline" }));
  expect(screen.getByRole("alert")).toHaveTextContent("Could not refresh models: offline");
  expect(screen.getByText("No models reported by this agent.")).toBeVisible();
  expect(screen.getByRole("button", { name: "Refresh models" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Refresh models" }));
  expect(backend.refresh).toHaveBeenLastCalledWith("first", true, null);
  expect(screen.getByRole("button", { name: "Refreshing…" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Start" }));
  await waitFor(() => expect(backend.create).toHaveBeenCalled());
  expect(backend.notify).not.toHaveBeenCalled();
});

it("retains cached model and effort choices after a command failure and retries inline", async () => {
  backend.refresh.mockRejectedValueOnce(new Error("connection lost"));
  useAgents.setState({
    draft: savedDraft({ provider: "first", config: { model: "big" }, thoughtLevels: { big: { effort: "low" } } }),
  });
  render(<HomeEditor />);
  expect(screen.getByRole("button", { name: "Reasoning" })).toHaveTextContent("low");
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("connection lost");
  fireEvent.click(screen.getByRole("option", { name: "small" }));
  expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent("small");
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  fireEvent.click(screen.getByRole("button", { name: "Refresh models" }));
  await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent("small");
  expect(backend.notify).not.toHaveBeenCalled();
});

it("preserves a valid remembered model and effort when discovery changes the defaults", async () => {
  useAgents.setState({
    draft: savedDraft({ provider: "first", config: { model: "big" }, thoughtLevels: { big: { effort: "low" } } }),
  });
  backend.refresh.mockResolvedValueOnce(
    ok(
      catalog("first", {
        config: [option("model", "model", ["small", "big", "new"])],
        thoughtLevels: { big: [option("effort", "thought_level", ["low", "high", "max"], "max")] },
      }),
    ),
  );
  render(<HomeEditor />);
  await waitFor(() => expect(useAgents.getState().modelRequests.size).toBe(0));
  expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent("big");
  expect(screen.getByRole("button", { name: "Reasoning" })).toHaveTextContent("low");
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  expect(screen.getByRole("option", { name: "new" })).toBeVisible();
  fireEvent.keyDown(document, { key: "Escape" });
  fireEvent.click(screen.getByRole("button", { name: "Start" }));
  await waitFor(() => expect(backend.create).toHaveBeenCalled());
  expect(backend.create.mock.calls[0]![0].config).toEqual([
    { id: "model", value: "big" },
    { id: "effort", value: "low" },
  ]);
});

it("keeps a removed explicit model visibly unavailable until another model is chosen", async () => {
  useAgents.setState({ draft: savedDraft({ provider: "first", config: { model: "big" } }) });
  render(<HomeEditor />);
  await waitFor(() => expect(useAgents.getState().modelRequests.size).toBe(0));
  emit(catalog("first", { config: [option("model", "model", ["small"])], thoughtLevels: {} }));
  expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent("big (unavailable)");
  expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
  expect(screen.getByRole("alert")).toHaveTextContent("Choose another model before starting.");
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  fireEvent.click(screen.getByRole("option", { name: "small" }));
  expect(screen.getByRole("button", { name: "Start" })).toBeEnabled();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Start" }));
  await waitFor(() => expect(backend.create).toHaveBeenCalled());
  expect(backend.create.mock.calls[0]![0].config).toEqual([{ id: "model", value: "small" }]);
});

it("keeps the unavailable selection when the agent stops advertising models altogether", async () => {
  useAgents.setState({ draft: savedDraft({ provider: "first", config: { model: "big" } }) });
  render(<HomeEditor />);
  await waitFor(() => expect(useAgents.getState().modelRequests.size).toBe(0));
  emit(catalog("first", { config: [], thoughtLevels: {} }));
  backend.providers[0]!.config = [];
  await act(async () => backend.channel!.onmessage({ type: "providers" }));
  expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent("big (unavailable)");
  expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  expect(screen.getByText("No models reported by this agent.")).toBeVisible();
  expect(screen.getByRole("button", { name: "Refresh models" })).toBeEnabled();
});

it("ignores a delayed refresh after switching agents and preserves the new draft", async () => {
  const pending = deferred<CatalogReply>();
  backend.refresh.mockReturnValueOnce(pending.promise);
  render(<HomeEditor />);
  fireEvent.click(screen.getByRole("button", { name: "Agent" }));
  fireEvent.click(screen.getByRole("option", { name: "second" }));
  await waitFor(() => expect(backend.refresh).toHaveBeenLastCalledWith("second", false, "big"));
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  fireEvent.click(screen.getByRole("option", { name: "small" }));
  await act(async () => pending.resolve(ok(catalog("first", { config: [option("model", "model", ["obsolete"])] }))));
  expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent("small");
  expect(screen.queryByRole("option", { name: "obsolete" })).not.toBeInTheDocument();
  expect(useAgents.getState().modelCatalogs.has("first")).toBe(false);
  expect(screen.getByRole("button", { name: "Start" })).toBeEnabled();
});

it("ignores old project responses and events when the project connection changes", async () => {
  const pending = deferred<CatalogReply>();
  backend.refresh.mockReturnValueOnce(pending.promise);
  render(<HomeEditor />);
  const oldChannel = backend.channel!;
  await act(async () => {
    useProject.setState({ project: { root: "/another", trusted: true } as ProjectInfo });
    await connect();
    pending.resolve(ok(catalog("first", { config: [option("model", "model", ["old-project"])] })));
  });
  act(() => oldChannel.onmessage({ type: "modelCatalog", catalog: catalog("first", { error: "old error" }) }));
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  expect(screen.queryByRole("option", { name: "old-project" })).not.toBeInTheDocument();
  expect(screen.queryByText(/old error/)).not.toBeInTheDocument();
  expect(screen.getByRole("option", { name: "small" })).toBeVisible();
});

it("does not let a delayed command snapshot replace a newer catalog event", async () => {
  const pending = deferred<CatalogReply>();
  backend.refresh.mockReturnValueOnce(pending.promise);
  render(<HomeEditor />);
  emit(catalog("first", { config: [option("model", "model", ["latest"])], thoughtLevels: { latest: [] } }));
  await act(async () => pending.resolve(ok(catalog("first", { refreshing: true }))));
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  expect(screen.getByRole("option", { name: "latest" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Refresh models" })).toBeEnabled();
  backend.providers[0]!.config = [option("model", "model", ["older-session"])];
  await act(async () => backend.channel!.onmessage({ type: "providers" }));
  expect(screen.getByRole("option", { name: "latest" })).toBeVisible();
  expect(screen.queryByRole("option", { name: "older-session" })).not.toBeInTheDocument();
});

it("requests freshness on focus without a retry timer, and counts down only the displayed cooldown", async () => {
  render(<HomeEditor />);
  await waitFor(() => expect(useAgents.getState().modelRequests.size).toBe(0));
  fireEvent.focus(window);
  await waitFor(() => expect(backend.refresh).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(useAgents.getState().modelRequests.size).toBe(0));
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  vi.useFakeTimers();
  emit(catalog("first", { retryAtMs: Date.now() + 2_000, error: "offline" }));
  expect(screen.getByRole("button", { name: "Refresh in 2s" })).toBeDisabled();
  act(() => vi.advanceTimersByTime(1_000));
  expect(screen.getByRole("button", { name: "Refresh in 1s" })).toBeDisabled();
  act(() => vi.advanceTimersByTime(1_000));
  expect(screen.getByRole("button", { name: "Refresh models" })).toBeEnabled();
  act(() => vi.advanceTimersByTime(60_000));
  expect(backend.refresh).toHaveBeenCalledTimes(2);
});

it("discovers an uncached model's own settings before its first task and restores its draft choices", async () => {
  delete backend.providers[0]!.thoughtLevels!.small;
  await connect();
  render(<HomeEditor />);
  await waitFor(() => expect(useAgents.getState().modelRequests.size).toBe(0));
  const pending = deferred<CatalogReply>();
  backend.refresh.mockReturnValueOnce(pending.promise);
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  fireEvent.click(screen.getByRole("option", { name: "small" }));
  await waitFor(() => expect(backend.refresh).toHaveBeenLastCalledWith("first", false, "small"));
  expect(screen.getByText("Loading model settings…")).toHaveAttribute("role", "status");
  expect(screen.queryByRole("button", { name: "Reasoning" })).not.toBeInTheDocument();
  expect(backend.create).not.toHaveBeenCalled();
  await act(async () =>
    pending.resolve(
      ok(
        catalog("first", {
          thoughtLevels: {
            ...catalog().thoughtLevels,
            small: [
              option("effort", "thought_level", ["minimal", "medium", "max"], "medium"),
              option("context_tier", "model_config", ["default", "long_context"]),
            ],
          },
        }),
      ),
    ),
  );
  expect(screen.queryByText("Loading model settings…")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Reasoning" })).toHaveTextContent("medium");
  fireEvent.click(screen.getByRole("button", { name: "Reasoning" }));
  fireEvent.click(screen.getByRole("option", { name: "max" }));
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  expect(screen.getByRole("radio", { name: "long_context" })).toBeVisible();
  fireEvent.click(screen.getByRole("radio", { name: "long_context" }));
  fireEvent.click(screen.getByRole("option", { name: "big" }));
  expect(screen.getByRole("button", { name: "Reasoning" })).toHaveTextContent("high");
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  fireEvent.click(screen.getByRole("option", { name: "small" }));
  expect(screen.getByRole("button", { name: "Reasoning" })).toHaveTextContent("max");
  expect(backend.refresh).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole("button", { name: "Start" }));
  await waitFor(() => expect(backend.create).toHaveBeenCalled());
  expect(backend.create.mock.calls[0]![0].config).toEqual([
    { id: "model", value: "small" },
    { id: "effort", value: "max" },
    { id: "context_tier", value: "long_context" },
  ]);
});

it("does not rediscover a model that explicitly reports no per-model controls", async () => {
  backend.providers[0]!.thoughtLevels!.small = [];
  await connect();
  render(<HomeEditor />);
  await waitFor(() => expect(useAgents.getState().modelRequests.size).toBe(0));
  for (const model of ["small", "big", "small"]) {
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    fireEvent.click(screen.getByRole("option", { name: model }));
  }
  expect(backend.refresh).toHaveBeenCalledExactlyOnceWith("first", false, "big");
  expect(screen.queryByText("Loading model settings…")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Reasoning" })).not.toBeInTheDocument();
});

it("waits for an unrelated lookup and discovers only the latest selected model", async () => {
  backend.providers[0]!.config = [option("model", "model", ["big", "small", "latest"])];
  await connect();
  const pending = deferred<CatalogReply>();
  backend.refresh.mockReturnValueOnce(pending.promise);
  render(<HomeEditor />);
  for (const model of ["small", "latest"]) {
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    fireEvent.click(screen.getByRole("option", { name: model }));
  }
  expect(backend.refresh).toHaveBeenCalledTimes(1);
  const latest = deferred<CatalogReply>();
  backend.refresh.mockReturnValueOnce(latest.promise);
  await act(async () =>
    pending.resolve(ok(catalog("first", { retryAtMs: Date.now() + 30_000, error: "previous model failed" }))),
  );
  await waitFor(() => expect(backend.refresh).toHaveBeenLastCalledWith("first", false, "latest"));
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  fireEvent.keyDown(document, { key: "Escape" });
  await act(async () =>
    latest.resolve(
      ok(catalog("first", { thoughtLevels: { latest: [option("effort", "thought_level", ["medium", "max"])] } })),
    ),
  );
  expect(screen.getByRole("button", { name: "Reasoning" })).toHaveTextContent("medium");
  expect(backend.refresh).toHaveBeenCalledTimes(2);
  expect(backend.create).not.toHaveBeenCalled();
});

it("does not loop after an unknown-model failure and permits a manual retry after cooldown", async () => {
  delete backend.providers[0]!.thoughtLevels!.small;
  await connect();
  render(<HomeEditor />);
  await waitFor(() => expect(useAgents.getState().modelRequests.size).toBe(0));
  backend.refresh.mockResolvedValueOnce(
    ok(catalog("first", { retryAtMs: Date.now() + 30_000, error: "settings unavailable" })),
  );
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  fireEvent.click(screen.getByRole("option", { name: "small" }));
  await waitFor(() => expect(useAgents.getState().modelRequests.size).toBe(0));
  expect(backend.refresh).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  expect(screen.getByRole("alert")).toHaveTextContent("settings unavailable");
  expect(screen.getByRole("button", { name: /Refresh in \d+s/ })).toBeDisabled();
  emit(catalog("first", { retryAtMs: Date.now() - 1, error: "settings unavailable" }));
  expect(backend.refresh).toHaveBeenCalledTimes(2);
  backend.refresh.mockResolvedValueOnce(ok(catalog("first", { thoughtLevels: { small: [] } })));
  fireEvent.click(screen.getByRole("button", { name: "Refresh models" }));
  await waitFor(() => expect(backend.refresh).toHaveBeenLastCalledWith("first", true, "small"));
  await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  expect(backend.refresh).toHaveBeenCalledTimes(3);
});

it("does not leak a delayed model's levels or failure into a newer selection", async () => {
  delete backend.providers[0]!.thoughtLevels!.small;
  await connect();
  useAgents.setState({
    draft: savedDraft({ provider: "first", config: { model: "big" }, thoughtLevels: { big: { effort: "low" } } }),
  });
  render(<HomeEditor />);
  await waitFor(() => expect(useAgents.getState().modelRequests.size).toBe(0));
  const pending = deferred<CatalogReply>();
  backend.refresh.mockReturnValueOnce(pending.promise);
  for (const model of ["small", "big"]) {
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    fireEvent.click(screen.getByRole("option", { name: model }));
  }
  await act(async () =>
    pending.resolve(
      ok(
        catalog("first", {
          thoughtLevels: {
            ...catalog().thoughtLevels,
            small: [option("effort", "thought_level", ["minimal", "max"], "max")],
          },
          retryAtMs: Date.now() + 30_000,
          error: "small lookup failed",
        }),
      ),
    ),
  );
  expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent("big");
  expect(screen.getByRole("button", { name: "Reasoning" })).toHaveTextContent("low");
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Refresh models" })).toBeEnabled();
  expect(backend.refresh).toHaveBeenCalledTimes(2);
});
