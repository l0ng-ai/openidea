import { fireEvent, render, screen } from "@testing-library/react";
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

it("sends the complete nested model id through ConfigPickers", () => {
  const onChange = vi.fn();
  render(<ConfigPickers config={[config([value("9router/cmc/Beam")])]} onChange={onChange} />);
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  fireEvent.click(screen.getByRole("option", { name: "Beamcmc/Beam" }));
  expect(onChange).toHaveBeenCalledExactlyOnceWith("model", "9router/cmc/Beam");
});
