import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { AgentConfigOption } from "@/bindings";
import { ConfigPickers } from "./ConfigPickers";

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
