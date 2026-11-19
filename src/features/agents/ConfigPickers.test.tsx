import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfigOption } from "@/bindings";
import { ConfigPickers, configPickerOptions } from "./ConfigPickers";
import { useAgents } from "./store";

beforeEach(() => {
  useAgents.setState({ pinnedModels: [] });
});

const config = (values: AgentConfigOption["values"], category = "model"): AgentConfigOption => ({
  id: "model",
  name: "Model",
  category,
  description: null,
  current: null,
  via: "option",
  values,
});
const value = (id: string, name = id, description: string | null = null) => ({ value: id, name, description });

describe("configPickerOptions", () => {
  it("groups nested paths by their first provider and preserves the full value and description", () => {
    expect(configPickerOptions(config([value("9router/cmc/Beam", "Beam display", "Fast")]))).toEqual([
      { value: "9router", label: "9router", section: true },
      { value: "9router/cmc/Beam", label: "Beam display", detail: "cmc/Beam · Fast", keywords: "9router" },
    ]);
  });
  it("shows the agent-reported model name without the repeated provider prefix and keeps the id as the detail", () => {
    expect(
      configPickerOptions(
        config([
          { value: "opencode/beam-free", name: "opencode/Beam Free", description: null },
          { value: "opencode/big-pickle", name: "opencode/Big Pickle", description: null },
          { value: "opencode/hy4-flash-free", name: "opencode/hy4 flash Free", description: null },
        ]),
      ),
    ).toEqual([
      { value: "opencode", label: "opencode", section: true },
      { value: "opencode/beam-free", label: "Beam Free", detail: "beam-free", keywords: "opencode" },
      { value: "opencode/big-pickle", label: "Big Pickle", detail: "big-pickle", keywords: "opencode" },
      { value: "opencode/hy4-flash-free", label: "hy4 flash Free", detail: "hy4-flash-free", keywords: "opencode" },
    ]);
  });
  it("falls back to the compact id tail when the agent echoes the id as its name", () => {
    expect(configPickerOptions(config([value("acme/ctx/big")]))).toEqual([
      { value: "acme", label: "acme", section: true },
      { value: "acme/ctx/big", label: "big", detail: "ctx/big", keywords: "acme" },
    ]);
  });
  it("keeps plain ids ungrouped even when the display name contains a slash", () => {
    expect(configPickerOptions(config([value("plain", "Local / Beam", "Offline")]))).toEqual([
      { value: "plain", label: "Local / Beam", detail: "Offline", keywords: "" },
    ]);
  });
  it("collects several providers in encounter order and preserves order inside each group", () => {
    const options = configPickerOptions(
      config([value("a/One"), value("b/Two"), value("a/Three"), value("plain"), value("__section__:a")]),
    );
    expect(options.map((o) => [o.value, !!o.section])).toEqual([
      ["plain", false],
      ["__section__:a", false],
      ["a", true],
      ["a/One", false],
      ["a/Three", false],
      ["b", true],
      ["b/Two", false],
    ]);
    expect(options[3]?.detail).toBe("One");
  });
  it("leaves non-model option labels and descriptions intact", () => {
    expect(configPickerOptions(config([value("a/One", "Custom", "Description")], "mode"))).toEqual([
      { value: "a/One", label: "Custom", detail: "Description" },
    ]);
  });
  it("places pinned models in a top Pinned section and prepends usageMultiplier to detail", () => {
    const options = configPickerOptions(
      config([
        { value: "gpt-6-sol", name: "GPT-6 Sol", description: "Medium cost", usageMultiplier: "1x" },
        {
          value: "gemini-4-carbon",
          name: "Gemini 4 Carbon",
          description: "Powerful · Medium cost",
          usageMultiplier: "1x",
        },
      ]),
      ["gemini-4-carbon"],
    );
    expect(options).toEqual([
      { value: "__pinned__", label: "Pinned", section: true },
      { value: "gemini-4-carbon", label: "Gemini 4 Carbon", detail: "1x · Powerful · Medium cost", keywords: "" },
      { value: "__models__", label: "Models", section: true },
      { value: "gpt-6-sol", label: "GPT-6 Sol", detail: "1x · Medium cost", keywords: "" },
    ]);
  });
});

it("shows Cursor approvals separately from its execution mode and sends the choice", () => {
  const option = (id: string, category: string, values: string[]): AgentConfigOption => ({
    id,
    category,
    name: category === "approval" ? "Approvals" : "Mode",
    description: null,
    via: "option",
    current: values[0]!,
    values: values.map((value) => ({
      value,
      name: value === "bypass" ? "Bypass approvals" : value,
      description: null,
    })),
  });
  const onChange = vi.fn();
  render(
    <ConfigPickers
      config={[
        option("mode", "mode", ["Agent", "Plan", "Ask"]),
        option("openidea.cursor.approval", "approval", ["ask", "bypass"]),
      ]}
      onChange={onChange}
    />,
  );
  expect(screen.getByText("Agent")).toBeVisible();
  fireEvent.click(screen.getByLabelText("Approvals"));
  fireEvent.click(screen.getByRole("option", { name: "Bypass approvals" }));
  expect(onChange).toHaveBeenCalledWith("openidea.cursor.approval", "bypass");
});

it("shows Allow All as a switch and sends on/off values", () => {
  const onChange = vi.fn();
  render(
    <ConfigPickers
      config={[
        {
          id: "allow_all",
          name: "Allow All",
          category: "permissions",
          description: null,
          current: "off",
          via: "option",
          values: [value("on", "On"), value("off", "Off")],
        },
      ]}
      onChange={onChange}
    />,
  );
  fireEvent.click(screen.getByRole("switch", { name: "Allow All" }));
  expect(onChange).toHaveBeenCalledExactlyOnceWith("allow_all", "on");
});

it("shows Allow All inside the mode popup when both options exist", () => {
  const onChange = vi.fn();
  render(
    <ConfigPickers
      config={[
        {
          id: "mode",
          name: "Mode",
          category: "mode",
          description: null,
          current: "agent",
          via: "option",
          values: [value("agent", "Agent"), value("plan", "Plan"), value("autopilot", "Autopilot")],
        },
        {
          id: "allow_all",
          name: "Allow All",
          category: "permissions",
          description: null,
          current: "off",
          via: "option",
          values: [value("on", "On"), value("off", "Off")],
        },
      ]}
      onChange={onChange}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Mode" }));
  fireEvent.click(screen.getByRole("option", { name: "Plan" }));
  expect(onChange).toHaveBeenNthCalledWith(1, "mode", "plan");
  fireEvent.click(screen.getByRole("button", { name: "Mode" }));
  fireEvent.click(screen.getByRole("switch", { name: "Allow All" }));
  expect(onChange).toHaveBeenNthCalledWith(2, "allow_all", "on");
});

it("shows Codex's collaboration mode next to its approval mode and sends Plan", () => {
  const onChange = vi.fn();
  render(
    <ConfigPickers
      config={[
        {
          id: "mode",
          name: "Mode",
          category: "mode",
          description: null,
          current: "workspace-write",
          via: "option",
          values: [value("read-only", "Read-only"), value("workspace-write", "Workspace access")],
        },
        {
          id: "collaboration_mode",
          name: "Collaboration mode",
          category: "collaboration_mode",
          description: null,
          current: "default",
          via: "option",
          values: [value("default", "Default"), value("plan", "Plan")],
        },
      ]}
      onChange={onChange}
    />,
  );
  expect(screen.getByRole("button", { name: "Collaboration mode" })).toHaveTextContent("Default");
  fireEvent.click(screen.getByRole("button", { name: "Collaboration mode" }));
  fireEvent.click(screen.getByRole("option", { name: "Plan" }));
  expect(onChange).toHaveBeenCalledExactlyOnceWith("collaboration_mode", "plan");
});

it("sends the complete nested model id through ConfigPickers", () => {
  const onChange = vi.fn();
  render(<ConfigPickers config={[config([value("9router/cmc/Beam")])]} onChange={onChange} />);
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  fireEvent.click(screen.getByRole("option", { name: "Beamcmc/Beam" }));
  expect(onChange).toHaveBeenCalledExactlyOnceWith("model", "9router/cmc/Beam");
});

it("lists ACP models by their reported names and sends the complete id", () => {
  const onChange = vi.fn();
  render(
    <ConfigPickers
      config={[
        config([
          { value: "opencode/beam-free", name: "opencode/Beam Free", description: null },
          { value: "opencode/big-pickle", name: "opencode/Big Pickle", description: null },
        ]),
      ]}
      onChange={onChange}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  expect(screen.getByRole("option", { name: /Beam Free/ })).toHaveTextContent("beam-free");
  fireEvent.click(screen.getByRole("option", { name: /Beam Free/ }));
  expect(onChange).toHaveBeenCalledExactlyOnceWith("model", "opencode/beam-free");
});

it("edits secondary settings from the compact popup and restores focus when dismissed", () => {
  const approval: AgentConfigOption = {
    id: "approvals",
    name: "Approvals",
    category: "approval",
    description: null,
    current: "ask",
    via: "option",
    values: [value("ask", "Ask first"), value("bypass", "Bypass approvals")],
  };
  const onChange = vi.fn();
  render(<ConfigPickers config={[approval]} values={{ approvals: "bypass" }} onChange={onChange} />);
  const trigger = screen.getByRole("button", { name: "Agent settings" });
  trigger.focus();
  fireEvent.click(trigger);
  const dialog = screen.getByRole("dialog", { name: "Agent settings" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Approvals" }));
  fireEvent.click(screen.getByRole("option", { name: "Ask first" }));
  expect(onChange).toHaveBeenCalledExactlyOnceWith("approvals", "ask");
  expect(dialog).toBeInTheDocument();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "Agent settings" })).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});

describe("model settings", () => {
  const copilotConfig = (effortLevels: string[] | null = ["low", "medium", "high", "xhigh"]): AgentConfigOption[] => [
    {
      id: "model",
      name: "Model",
      category: "model",
      description: null,
      current: "claude-sonnet-5.5",
      via: "option",
      values: [value("claude-sonnet-5.5", "Claude Sonnet 5.5", "1x"), value("gpt-6-sol", "GPT-6 Sol", "1x")],
    },
    ...(effortLevels
      ? [
          {
            id: "reasoning_effort",
            name: "Reasoning Effort",
            category: "thought_level",
            description: null,
            current: "medium",
            via: "option" as const,
            values: effortLevels.map((lvl) => value(lvl, lvl === "xhigh" ? "XHigh" : lvl)),
          },
        ]
      : []),
    {
      id: "mode",
      name: "Mode",
      category: "mode",
      description: null,
      current: "https://agentclientprotocol.com/protocol/session-modes#agent",
      via: "option",
      values: [
        value("https://agentclientprotocol.com/protocol/session-modes#agent", "Agent"),
        value("https://agentclientprotocol.com/protocol/session-modes#plan", "Plan"),
      ],
    },
    {
      id: "allow_all",
      name: "Allow All",
      category: "permissions",
      description: null,
      current: "on",
      via: "option",
      values: [value("on", "On"), value("off", "Off")],
    },
  ];

  it("keeps effort as a standalone setting when no model is available", () => {
    render(
      <ConfigPickers
        config={[
          {
            id: "reasoning_effort",
            name: "Reasoning Effort",
            category: "thought_level",
            description: null,
            current: "medium",
            via: "option",
            values: [value("low"), value("medium")],
          },
        ]}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Reasoning Effort" })).toHaveTextContent("medium");
    expect(screen.queryByRole("button", { name: "Agent settings" })).not.toBeInTheDocument();
  });

  it("keeps effort with model settings and the mode with Allow All", () => {
    const onChange = vi.fn();
    render(<ConfigPickers config={copilotConfig()} onChange={onChange} />);
    const model = screen.getByRole("button", { name: "Model" });
    expect(model).toHaveTextContent("Claude Sonnet 5.5");
    expect(model).toHaveTextContent("medium");
    expect(screen.getByRole("button", { name: "Mode" })).toHaveTextContent("AgentAllow All");
    fireEvent.click(model);
    const dialog = screen.getByRole("dialog", { name: "Model" });
    const effort = within(dialog).getByRole("radiogroup", { name: "Effort Level" });
    expect(within(effort).getByRole("radio", { name: "medium" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(within(effort).getByRole("radio", { name: "XHigh" }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith("reasoning_effort", "xhigh");
  });

  it("offers more effort levels than fit the segmented control as a dropdown", () => {
    const onChange = vi.fn();
    const config = copilotConfig().map((o) =>
      o.category === "thought_level"
        ? {
            ...o,
            values: ["Low", "Medium", "High", "Extra high", "Max", "Ultra"].map((name) =>
              value(name.toLowerCase().replace(" ", "-"), name),
            ),
            current: "max",
          }
        : o,
    );
    render(<ConfigPickers config={config} onChange={onChange} />);
    const model = screen.getByRole("button", { name: "Model" });
    expect(model).toHaveTextContent("Max");
    fireEvent.click(model);
    const dialog = screen.getByRole("dialog", { name: "Model" });
    expect(within(dialog).queryByRole("radiogroup", { name: "Effort Level" })).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: /Reasoning Effort/ }));
    fireEvent.click(screen.getByRole("option", { name: /Extra high/ }));
    expect(onChange).toHaveBeenCalledWith("reasoning_effort", "extra-high");
  });

  it("tucks Fast into the model popup", () => {
    const config = [
      ...copilotConfig().filter((o) => o.category !== "thought_level"),
      {
        id: "fast",
        name: "Fast",
        category: "model_config",
        description: null,
        current: "false",
        via: "option" as const,
        values: [value("false", "Off"), value("true", "On")],
      },
    ];
    render(<ConfigPickers config={config} onChange={vi.fn()} />);
    expect(screen.queryByRole("switch", { name: "Fast" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    const dialog = screen.getByRole("dialog", { name: "Model" });
    expect(within(dialog).getByRole("switch", { name: "Fast" })).toHaveAttribute("aria-checked", "false");
  });

  it("lists models by name in one page, with context size, cost and pinning", () => {
    const onChange = vi.fn();
    const cfg = copilotConfig().map((o) =>
      o.id === "model"
        ? {
            ...o,
            values: o.values.map((v) =>
              v.value === "claude-sonnet-5.5" ? { ...v, costCategory: "medium", description: "Balanced" } : v,
            ),
          }
        : o,
    );
    cfg.push({
      id: "contextTier",
      name: "Context Size",
      category: "model_config",
      description: null,
      current: "long_context",
      defaultValue: "default",
      via: "option",
      values: [value("default", "200K"), value("long_context", "1M")],
    });
    render(<ConfigPickers config={cfg} onChange={onChange} />);
    const model = screen.getByRole("button", { name: "Model" });
    expect(model).toHaveTextContent("Claude Sonnet 5.5");
    expect(model).toHaveTextContent("medium");
    expect(model).toHaveTextContent("1M");
    expect(model).toHaveAttribute("title", expect.stringContaining("Effort Level: medium · Context Size: 1M"));

    fireEvent.click(model);
    const dialog = screen.getByRole("dialog", { name: "Model" });
    expect(within(dialog).queryByText("Balanced")).not.toBeInTheDocument();
    expect(within(dialog).getByText("Medium cost")).toBeVisible();

    const effortGroup = within(dialog).getByRole("radiogroup", { name: "Effort Level" });
    expect(within(effortGroup).getByRole("radio", { name: "medium" })).toHaveAttribute("aria-checked", "true");
    const contextGroup = within(dialog).getByRole("radiogroup", { name: "Context Size" });
    expect(within(contextGroup).getByRole("radio", { name: "1M" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(within(contextGroup).getByRole("radio", { name: "200K" }));
    expect(onChange).toHaveBeenCalledWith("contextTier", "default");

    fireEvent.click(within(dialog).getAllByRole("button", { name: "Pin model" })[0]!);
    const listbox = within(dialog).getByRole("listbox", { name: "Model" });
    expect(within(listbox).getByText("Pinned")).toBeVisible();
    expect(within(listbox).getByText("Models")).toBeVisible();

    fireEvent.click(within(dialog).getByRole("option", { name: /GPT-6 Sol/ }));
    expect(onChange).toHaveBeenCalledWith("model", "gpt-6-sol");
    expect(screen.queryByRole("dialog", { name: "Model" })).not.toBeInTheDocument();
  });

  it("filters the model list and picks the highlighted model with the keyboard", () => {
    const onChange = vi.fn();
    render(<ConfigPickers config={copilotConfig()} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    const search = screen.getByPlaceholderText("Search…");
    expect(search).toHaveFocus();
    fireEvent.change(search, { target: { value: "sol" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onChange).toHaveBeenLastCalledWith("model", "gpt-6-sol");
  });

  it("keeps a plain model picker when the agent has no effort option", () => {
    render(<ConfigPickers config={copilotConfig(null)} onChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Model" })).toHaveAttribute("aria-haspopup", "listbox");
  });
});
