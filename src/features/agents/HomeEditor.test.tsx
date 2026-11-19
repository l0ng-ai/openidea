import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { AgentConfigOption, AgentProvider, CustomAgentInput, NewAgentTask } from "@/bindings";
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
    vcsBranches: () => ok([]),
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

async function chooseModel(model: string) {
  if (!screen.queryByRole("dialog", { name: "Model" })) fireEvent.click(modelButton());
  fireEvent.click(screen.getByRole("option", { name: model }));
  fireEvent.pointerDown(document.body);
}

async function chooseEffort(effort: string) {
  if (!screen.queryByRole("dialog", { name: "Model" })) fireEvent.click(modelButton());
  const group = screen.getByRole("radiogroup", { name: "Effort Level" });
  fireEvent.click(within(group).getByRole("radio", { name: effort }));
  fireEvent.keyDown(document, { key: "Escape" });
}

it("switches model-specific levels and restores each draft effort before starting", async () => {
  render(<HomeEditor />);
  expect(modelButton()).toHaveTextContent("big");
  expect(modelButton()).toHaveTextContent("high");
  await chooseModel("small");
  expect(modelButton()).toHaveTextContent("minimal");
  await chooseEffort("medium");
  await chooseModel("big");
  expect(modelButton()).toHaveTextContent("high");
  await chooseModel("small");
  expect(modelButton()).toHaveTextContent("medium");
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
  expect(modelButton()).toHaveTextContent("medium");
  expect(modelButton()).toHaveTextContent("default");
  await chooseModel("gpt-5.6-sol");
  expect(modelButton()).toHaveTextContent("gpt-5.6-sol");
  expect(modelButton()).toHaveTextContent("medium");
  expect(modelButton()).toHaveTextContent("default");
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
  expect(modelButton()).toHaveTextContent("high");
  fireEvent.click(screen.getByRole("button", { name: "Start" }));
  await waitFor(() => expect(backend.create).toHaveBeenCalled());
  expect(backend.create.mock.calls[0]![0].config).toContainEqual({ id: "effort", value: "high" });
});

it.each([
  [undefined, "full-access"],
  ["ask", undefined],
] as const)("with new-task approvals %s, sends mode %s", async (newTaskApprovals, mode) => {
  const provider = { ...backend.providers[0]!, config: [option("mode", "mode", ["ask", "full-access"], "ask")] };
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
