import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AgentConfigOption } from "@/bindings";
import { ConfigPickers, configPickerOptions } from "./ConfigPickers";

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
      { value: "9router/cmc/Beam", label: "Beam", detail: "cmc/Beam · Fast", keywords: "9router" },
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

it("sends the complete nested model id through ConfigPickers", () => {
  const onChange = vi.fn();
  render(<ConfigPickers config={[config([value("9router/cmc/Beam")])]} onChange={onChange} />);
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  fireEvent.click(screen.getByRole("option", { name: "Beamcmc/Beam" }));
  expect(onChange).toHaveBeenCalledExactlyOnceWith("model", "9router/cmc/Beam");
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

describe("IntelliJ AIR Model & Effort + Mode UX", () => {
  const copilotConfig = (
    currentModel = "claude-sonnet-5.5",
    currentEffort: string | null = "medium",
    effortLevels: string[] | null = ["low", "medium", "high", "xhigh", "max"],
  ): AgentConfigOption[] => [
    {
      id: "model",
      name: "Model",
      category: "model",
      description: null,
      current: currentModel,
      via: "option",
      values: [
        value("claude-sonnet-5.5", "Claude Sonnet 5.5", "1x"),
        value("claude-haiku-4.5", "Claude Haiku 4.5", "0.33x"),
        value("gemini-4-argon", "Gemini 4 Argon", "1x"),
        value("gpt-5.3-codex", "GPT-5.3-Codex", "1x"),
        value("gpt-6-sol", "GPT-6 Sol", "1x"),
      ],
    },
    ...(effortLevels
      ? [
          {
            id: "reasoning_effort",
            name: "Reasoning Effort",
            category: "thought_level",
            description: null,
            current: currentEffort,
            via: "option" as const,
            values: effortLevels.map((lvl) => value(lvl, lvl)),
          },
        ]
      : []),
    {
      id: "mode",
      name: "Mode",
      category: "mode",
      description: null,
      current: "https://agentclientprotocol.com/ns/modes#agent",
      via: "option",
      values: [
        value("https://agentclientprotocol.com/ns/modes#agent", "Agent"),
        value("https://agentclientprotocol.com/ns/modes#plan", "Plan"),
        value("https://agentclientprotocol.com/ns/modes#autopilot", "Autopilot"),
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

  it("renders exactly 2 AIR pills (Model+Effort and Mode+Allow All) with no duplicate overflow button", () => {
    const onChange = vi.fn();
    render(<ConfigPickers config={copilotConfig()} onChange={onChange} />);

    const modelBtn = screen.getByRole("button", { name: "Model" });
    expect(within(modelBtn).getByText("Claude Sonnet 5.5")).toBeInTheDocument();
    expect(within(modelBtn).getByText("Medium")).toBeInTheDocument();

    const modeBtn = screen.getByRole("button", { name: "Mode" });
    expect(within(modeBtn).getByText("Agent")).toBeInTheDocument();
    expect(within(modeBtn).getByText("Allow All")).toBeInTheDocument();

    expect(screen.queryByRole("button", { name: "Agent settings" })).not.toBeInTheDocument();
  });

  it("adjusts discrete effort slider steps from the advertised thought_level option (0, 3, 4, 5, and 6 steps)", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <ConfigPickers
        config={copilotConfig("claude-sonnet-5.5", "xhigh", ["low", "medium", "high", "xhigh", "max"])}
        values={{ model: "claude-sonnet-5.5", reasoning_effort: "xhigh" }}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    const dialog = screen.getByRole("dialog", { name: "Model & effort settings" });
    expect(within(dialog).getAllByRole("radio")).toHaveLength(5);
    expect(within(dialog).getByText("Extra High")).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("radio", { name: "Max" }));
    expect(onChange).toHaveBeenCalledWith("reasoning_effort", "max");

    // 6-step model advertised by agent (Off, Low, Medium, High, Extra High, Max)
    rerender(
      <ConfigPickers
        config={copilotConfig("gpt-6-sol", "none", ["none", "low", "medium", "high", "xhigh", "max"])}
        values={{ model: "gpt-6-sol", reasoning_effort: "none" }}
        onChange={onChange}
      />,
    );
    expect(within(dialog).getAllByRole("radio")).toHaveLength(6);
    expect(within(dialog).getByRole("radio", { name: "Off" })).toHaveAttribute("aria-checked", "true");

    // 4-step model advertised by agent (Low, Medium, High, Extra High)
    rerender(
      <ConfigPickers
        config={copilotConfig("gpt-5.3-codex", "high", ["low", "medium", "high", "xhigh"])}
        values={{ model: "gpt-5.3-codex", reasoning_effort: "high" }}
        onChange={onChange}
      />,
    );
    expect(within(dialog).getAllByRole("radio")).toHaveLength(4);

    // 3-step model advertised by agent (Low, Medium, High)
    rerender(
      <ConfigPickers
        config={copilotConfig("gemini-4-argon", "medium", ["low", "medium", "high"])}
        values={{ model: "gemini-4-argon", reasoning_effort: "medium" }}
        onChange={onChange}
      />,
    );
    expect(within(dialog).getAllByRole("radio")).toHaveLength(3);

    // 0-step model when agent omits thought_level (Not supported)
    rerender(
      <ConfigPickers
        config={copilotConfig("claude-haiku-4.5", null, null)}
        values={{ model: "claude-haiku-4.5" }}
        onChange={onChange}
      />,
    );
    expect(within(dialog).queryAllByRole("radio")).toHaveLength(0);
    expect(within(dialog).getByText("Not supported")).toBeInTheDocument();
  });
});
