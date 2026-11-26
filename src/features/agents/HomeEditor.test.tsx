import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { AgentConfigOption, AgentProvider, CustomAgentInput, NewAgentTask, ProjectInfo } from "@/bindings";
import { useProject } from "@/platform/project";
import { HomeEditor } from "./HomeEditor";
import homeStyles from "./Home.module.css";
import { HOME, disconnect, savedDraft, updateComposer, useAgents } from "./store";

const backend = vi.hoisted(() => ({
  providers: [] as AgentProvider[],
  create: vi.fn(),
  probe: vi.fn(),
  saveCustom: vi.fn(),
  hermesProfiles: [] as { name: string; label: string }[],
  branches: [] as { name: string; remote: boolean }[],
}));
const ok = <T,>(data: T) => Promise.resolve({ status: "ok", data });
vi.mock("@/platform/ipc", async (original) => ({
  ...(await original<typeof import("@/platform/ipc")>()),
  commands: {
    agentProviders: () => ok(backend.providers),
    agentRefreshModels: (provider: string) =>
      ok({
        provider,
        config: backend.providers.find((p) => p.id === provider)?.config ?? [],
        thoughtLevels: backend.providers.find((p) => p.id === provider)?.thoughtLevels ?? {},
        refreshing: false,
        refreshedAtMs: Date.now(),
        retryAtMs: null,
        error: null,
      }),
    agentProbe: (provider: string, refresh: boolean) => backend.probe(provider, refresh),
    vcsBranchInfo: () => ok({ head: "main" }),
    vcsBranches: () => ok(backend.branches),
    agentCreate: (req: NewAgentTask) => backend.create(req),
    agentHermesProfiles: () => ok(backend.hermesProfiles),
    agentCustomSave: (input: CustomAgentInput) => {
      backend.saveCustom(input);
      backend.providers = [...backend.providers, { ...backend.providers[0]!, id: input.id, args: input.args ?? [] }];
      return ok(null);
    },
  },
}));
vi.mock("@/workbench/contributions", async (original) => ({
  ...(await original<typeof import("@/workbench/contributions")>()),
  maybeEditorService: () => ({ activePath: () => null }),
  editorService: () => ({ closeInput: () => false }),
}));

const option = (id: string, category: string, values: string[], current: string): AgentConfigOption => ({
  id,
  category,
  name: id === "model" ? "Model" : "Reasoning",
  description: null,
  current,
  via: "option",
  values: values.map((value) => ({ value, name: value, description: null })),
});

beforeEach(() => {
  disconnect();
  backend.branches = [];
  backend.create.mockReset().mockImplementation((req: NewAgentTask) => ok({ id: "new", config: req.config }));
  backend.probe.mockReset().mockImplementation(() => ok(null));
  backend.providers = [
    {
      id: "fake",
      name: "Fake",
      command: "fake",
      program: "fake",
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
      config: [option("model", "model", ["big", "small", "plain", "unknown"], "big")],
      thoughtLevels: {
        big: [option("effort", "thought_level", ["low", "high"], "high")],
        small: [option("effort", "thought_level", ["minimal", "medium", "max"], "minimal")],
        plain: [],
      },
    },
  ];
  useAgents.setState({ providers: backend.providers, draft: savedDraft({ provider: "fake", config: {} }) });
  updateComposer(HOME, { text: "Check the project" });
});

const modelButton = () => screen.getByRole("button", { name: "Model" });
const settingsButton = () => screen.getByRole("button", { name: /^Model settings:/ });

async function chooseModel(model: string) {
  if (!screen.queryByRole("dialog", { name: "Model" })) fireEvent.click(modelButton());
  fireEvent.click(screen.getByTitle(model));
  fireEvent.pointerDown(document.body);
}

async function chooseEffort(effort: string) {
  fireEvent.click(settingsButton());
  const list = screen.getByRole("listbox", { name: "Effort Level" });
  fireEvent.click(within(list).getByRole("option", { name: effort }));
}

function codexWithFast(current = "false") {
  const fast = { ...option("service_tier", "model_config", ["false", "true"], current), name: "Fast" };
  const codex = {
    ...backend.providers[0]!,
    id: "codex",
    name: "Codex",
    config: [option("model", "model", ["big", "small", "plain"], "big"), fast],
    thoughtLevels: { big: [fast], small: [{ ...fast, current: "false" }], plain: [] },
  };
  backend.providers = [codex];
  useAgents.setState({ providers: [codex], draft: savedDraft({ provider: "codex", config: {} }) });
}

it.each(["false", "true"])("leaves an untouched Codex Fast default (%s) to the runtime", async (current) => {
  codexWithFast(current);
  render(<HomeEditor />);
  fireEvent.click(settingsButton());
  expect(screen.getByRole("switch", { name: "Fast" })).toHaveAttribute("aria-checked", current);
  fireEvent.keyDown(document, { key: "Escape" });
  fireEvent.click(screen.getByRole("button", { name: "Start" }));
  await waitFor(() => expect(backend.create).toHaveBeenCalled());
  expect(backend.create.mock.calls[0]![0].config).toEqual([{ id: "model", value: "big" }]);
});

it.each(["true", "false"])("sends an explicit Codex Fast selection (%s) before the first prompt", async (value) => {
  codexWithFast();
  render(<HomeEditor />);
  fireEvent.click(settingsButton());
  fireEvent.click(screen.getByRole("switch", { name: "Fast" }));
  if (value === "false") fireEvent.click(screen.getByRole("switch", { name: "Fast" }));
  expect(useAgents.getState().draft.thoughtLevels?.big?.service_tier).toBe(value);
  fireEvent.keyDown(document, { key: "Escape" });
  fireEvent.click(screen.getByRole("button", { name: "Start" }));
  await waitFor(() => expect(backend.create).toHaveBeenCalled());
  expect(backend.create.mock.calls[0]![0].config).toEqual([
    { id: "model", value: "big" },
    { id: "service_tier", value },
  ]);
});

it("keeps Codex Fast choices per model and omits them for models without Fast", async () => {
  codexWithFast();
  render(<HomeEditor />);
  fireEvent.click(settingsButton());
  fireEvent.click(screen.getByRole("switch", { name: "Fast" }));
  fireEvent.keyDown(document, { key: "Escape" });
  await chooseModel("small");
  fireEvent.click(settingsButton());
  expect(screen.getByRole("switch", { name: "Fast" })).toHaveAttribute("aria-checked", "false");
  fireEvent.keyDown(document, { key: "Escape" });
  await chooseModel("big");
  fireEvent.click(settingsButton());
  expect(screen.getByRole("switch", { name: "Fast" })).toHaveAttribute("aria-checked", "true");
  fireEvent.keyDown(document, { key: "Escape" });
  await chooseModel("plain");
  expect(screen.queryByRole("button", { name: /^Model settings:/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Start" }));
  await waitFor(() => expect(backend.create).toHaveBeenCalled());
  expect(backend.create.mock.calls[0]![0].config).toEqual([{ id: "model", value: "plain" }]);
});

it("switches model-specific levels and restores each draft effort before starting", async () => {
  render(<HomeEditor />);
  expect(modelButton()).toHaveTextContent("big");
  expect(settingsButton()).toHaveTextContent("high");
  await chooseModel("small");
  expect(settingsButton()).toHaveTextContent("minimal");
  await chooseEffort("medium");
  await chooseModel("big");
  expect(settingsButton()).toHaveTextContent("high");
  await chooseModel("small");
  expect(settingsButton()).toHaveTextContent("medium");
  fireEvent.click(screen.getByRole("button", { name: "Start" }));
  await waitFor(() => expect(backend.create).toHaveBeenCalled());
  expect(backend.create.mock.calls[0]![0].config).toEqual([
    { id: "model", value: "small" },
    { id: "effort", value: "medium" },
  ]);
});

it("uses GitHub Copilot's own defaults and preserves per-model context tier and effort choices", async () => {
  const copilot = {
    ...backend.providers[0]!,
    id: "copilot",
    name: "GitHub Copilot",
    config: [option("model", "model", ["gemini-4-carbon", "gpt-5.6-sol"], "gemini-4-carbon")],
    thoughtLevels: {
      "gemini-4-carbon": [
        option("reasoning_effort", "thought_level", ["low", "medium", "high"], "medium"),
        option("context_tier", "model_config", ["default", "long_context"], "default"),
      ],
      "gpt-5.6-sol": [
        option("reasoning_effort", "thought_level", ["low", "medium", "high", "xhigh", "max"], "medium"),
        option("context_tier", "model_config", ["default", "long_context"], "default"),
      ],
    },
  };
  useAgents.setState({ providers: [copilot], draft: savedDraft({ provider: "copilot", config: {} }) });
  render(<HomeEditor />);
  expect(modelButton()).toHaveTextContent("gemini-4-carbon");
  expect(settingsButton()).toHaveTextContent("medium · default");
  await chooseModel("gpt-5.6-sol");
  expect(modelButton()).toHaveTextContent("gpt-5.6-sol");
  expect(settingsButton()).toHaveTextContent("medium · default");
  fireEvent.click(screen.getByRole("button", { name: "Start" }));
  await waitFor(() => expect(backend.create).toHaveBeenCalled());
  expect(backend.create.mock.calls[0]![0].config).toEqual([
    { id: "model", value: "gpt-5.6-sol" },
    { id: "reasoning_effort", value: "medium" },
    { id: "context_tier", value: "default" },
  ]);
});

it.each(["plain", "unknown"])("hides effort for %s models and sends no stale effort", async (model) => {
  render(<HomeEditor />);
  await chooseModel(model);
  expect(modelButton()).toHaveAttribute("aria-haspopup", "dialog");
  fireEvent.click(screen.getByRole("button", { name: "Start" }));
  await waitFor(() => expect(backend.create).toHaveBeenCalled());
  expect(backend.create.mock.calls[0]![0].config).toEqual([{ id: "model", value: model }]);
});

it("sends the displayed remembered model and effort even when neither is changed", async () => {
  render(<HomeEditor />);
  fireEvent.click(screen.getByRole("button", { name: "Start" }));
  await waitFor(() => expect(backend.create).toHaveBeenCalled());
  expect(backend.create.mock.calls[0]![0].config).toEqual([
    { id: "model", value: "big" },
    { id: "effort", value: "high" },
  ]);
});

it("ignores old provider-wide effort choices and refreshes unsupported per-model choices", async () => {
  useAgents.setState({
    draft: savedDraft({ provider: "fake", config: { effort: "low" }, thoughtLevels: { big: { effort: "removed" } } }),
  });
  render(<HomeEditor />);
  expect(settingsButton()).toHaveTextContent("high");
  fireEvent.click(screen.getByRole("button", { name: "Start" }));
  await waitFor(() => expect(backend.create).toHaveBeenCalled());
  expect(backend.create.mock.calls[0]![0].config).toContainEqual({ id: "effort", value: "high" });
});

it.each([
  [undefined, "ask", "full-access"],
  ["ask", "ask", "ask"],
  ["ask", "full-access", "ask"],
] as const)(
  "with new-task approvals %s and agent default %s, sends mode %s",
  async (newTaskApprovals, agentDefault, mode) => {
    const provider = {
      ...backend.providers[0]!,
      config: [option("mode", "mode", ["ask", "full-access"], agentDefault)],
    };
    useAgents.setState({ providers: [provider] });
    const settings = useProject.getState().settings;
    useProject.setState({ settings: { ...settings, agents: { ...settings?.agents, newTaskApprovals } } as never });
    try {
      render(<HomeEditor />);
      fireEvent.click(screen.getByRole("button", { name: "Start" }));
      await waitFor(() => expect(backend.create).toHaveBeenCalled());
      expect(backend.create.mock.calls[0]![0].config.find((c: { id: string }) => c.id === "mode")?.value).toBe(mode);
    } finally {
      useProject.setState({ settings });
    }
  },
);

it("switches Cursor per-model context and fast options cleanly without sending stale model params", async () => {
  const cursor: AgentProvider = {
    ...backend.providers[0]!,
    id: "cursor",
    name: "Cursor",
    config: [
      option("mode", "mode", ["agent", "plan", "ask"], "agent"),
      option("model", "model", ["grok-4.7", "gemini-4-neon"], "grok-4.7"),
      option("openidea.cursor.approval", "approval", ["ask", "bypass"], "ask"),
    ],
    thoughtLevels: {
      "grok-4.7": [
        option("reasoning_effort", "thought_level", ["low", "high"], "high"),
        option("context", "model_config", ["256k", "500k"], "256k"),
        {
          id: "fast",
          category: "model_config",
          name: "Fast",
          description: null,
          current: "true",
          defaultValue: "true",
          via: "option",
          values: [
            { value: "false", name: "Off", description: null },
            { value: "true", name: "Fast", description: null },
          ],
        },
      ],
      "gemini-4-neon": [
        option("reasoning_effort", "thought_level", ["low", "high"], "high"),
        option("context", "model_config", ["300k", "1m"], "300k"),
      ],
    },
  };
  useAgents.setState({ providers: [cursor], draft: savedDraft({ provider: "cursor", config: {} }) });
  render(<HomeEditor />);
  // Cursor defaults fast off even though the agent reported true, and omits off switches from multi-setting summaries.
  expect(settingsButton()).toHaveTextContent("high · 256k");
  await chooseModel("gemini-4-neon");
  expect(settingsButton()).toHaveTextContent("high · 300k");
  fireEvent.click(screen.getByRole("button", { name: "Start" }));
  await waitFor(() => expect(backend.create).toHaveBeenCalled());
  expect(backend.create.mock.calls[0]![0].config).toEqual([
    { id: "mode", value: "agent" },
    { id: "model", value: "gemini-4-neon" },
    { id: "openidea.cursor.approval", value: "bypass" },
    { id: "reasoning_effort", value: "high" },
    { id: "context", value: "300k" },
  ]);
});

it("applies fitWidth on the New Task page only when fitWindowWidth is enabled", () => {
  const settings = useProject.getState().settings;
  try {
    useProject.setState({ settings: { ...settings, agents: { ...settings?.agents, fitWindowWidth: false } } as never });
    const { container, rerender } = render(<HomeEditor />);
    const root = container.querySelector(`.${homeStyles.home}`)!;
    expect(root).not.toHaveClass(homeStyles.fitWidth!);
    useProject.setState({ settings: { ...settings, agents: { ...settings?.agents, fitWindowWidth: true } } as never });
    rerender(<HomeEditor />);
    expect(root).toHaveClass(homeStyles.fitWidth!);
  } finally {
    useProject.setState({ settings });
  }
});

it("refreshes the displayed agent version after a CLI upgrade when the window regains focus", async () => {
  let installed = "18.20.0";
  let cached = installed;
  backend.probe.mockImplementation((provider: string, refresh: boolean) => {
    if (refresh) cached = installed;
    return ok({ provider, name: "omp", version: cached, protocol: "ACP v1", error: null });
  });
  render(<HomeEditor />);
  await waitFor(() => expect(agentTooltip()).toMatch(/ 18\.20\.0$/));
  installed = "18.20.2";
  fireEvent(window, new Event("focus"));
  await waitFor(() => expect(agentTooltip()).toMatch(/ 18\.20\.2$/));
});

it("does not reuse a previous page's cached agent version when opened again", async () => {
  backend.probe.mockImplementation((provider: string, refresh: boolean) =>
    ok({ provider, name: "omp", version: refresh ? "18.20.2" : "18.20.0", protocol: "ACP v1", error: null }),
  );
  render(<HomeEditor />);
  await waitFor(() => expect(agentTooltip()).toMatch(/ 18\.20\.2$/));
});

/** The agent picker shows its icon; the name and version are in its tooltip. */
function agentTooltip() {
  return screen.getByRole("button", { name: "Agent" }).parentElement?.getAttribute("data-tooltip");
}

it("offers Hermes profiles next to the model and starts the chosen one with -p", async () => {
  backend.saveCustom.mockReset();
  backend.hermesProfiles = [
    { name: "default", label: "qb" },
    { name: "Dom 2", label: "Dom 2" },
  ];
  const { unmount } = render(<HomeEditor />);
  await screen.findByRole("button", { name: "Model" });
  expect(screen.queryByRole("button", { name: "Hermes profile" })).toBeNull();
  unmount();

  const hermes = { ...backend.providers[0]!, id: "hermes", name: "Hermes Agent", args: ["acp"] };
  backend.providers = [hermes];
  useAgents.setState({ providers: [hermes], draft: savedDraft({ provider: "hermes", config: {} }) });
  render(<HomeEditor />);
  const picker = await screen.findByRole("button", { name: "Hermes profile" });
  expect(picker).toHaveTextContent("qb");
  fireEvent.click(picker);
  fireEvent.click(screen.getByRole("option", { name: "Dom 2" }));
  await waitFor(() => expect(useAgents.getState().draft.provider).toBe("hermes-dom-2"));
  expect(backend.saveCustom).toHaveBeenCalledWith({
    id: "hermes-dom-2",
    name: "Hermes (Dom 2)",
    command: "hermes",
    args: ["-p", "Dom 2", "acp"],
  });
  await waitFor(() => expect(screen.getByRole("button", { name: "Hermes profile" })).toHaveTextContent("Dom 2"));
});

it("shows workspace folder and branch names as written in Chinese", async () => {
  const { _resetI18nForTests, setLocale, tx } = await import("@/platform/i18n");
  await setLocale("zh");
  try {
    // Precondition: the zh catalog translates these words, so a translated label would differ.
    expect(tx("dev")).not.toBe("dev");
    expect(tx("test")).not.toBe("test");
    backend.branches = [
      { name: "dev", remote: false },
      { name: "test", remote: false },
    ];
    useProject.setState({
      project: {
        root: "/ws",
        name: "Workspace",
        trusted: true,
        isGit: true,
        workspace: { version: 1, name: "Workspace", projects: ["/ws/dev", "/ws/test"] },
      } as ProjectInfo,
    });
    useAgents.setState({ draft: { ...useAgents.getState().draft, isolation: "worktree" } });
    render(<HomeEditor />);
    const projectPicker = screen.getByRole("button", { name: tx("Project") });
    expect(projectPicker).toHaveTextContent(/^dev$/);
    fireEvent.click(projectPicker);
    expect(
      within(screen.getByRole("listbox"))
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["dev/ws/dev", "test/ws/test"]);
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
    fireEvent.click(await screen.findByRole("button", { name: tx("Base branch") }));
    expect(
      within(screen.getByRole("listbox"))
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["dev", "test"]);
  } finally {
    _resetI18nForTests();
    useProject.setState({ project: null });
  }
});
