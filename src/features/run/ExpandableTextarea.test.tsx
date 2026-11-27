import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ExpandableTextarea } from "./ExpandableTextarea";

afterEach(cleanup);

const LONG = "-Ddemo.endpoint=https://example.com/demo/environments/local/feature-flags/configuration/versions/current";
const VALUE = `-Xmx512m\n${LONG}\n-Ddemo.mode=local`;

function editors() {
  return screen.getAllByRole("textbox", { name: "VM options" }) as HTMLTextAreaElement[];
}

it("edits in an expanded editor that keeps each line on one visual line", () => {
  const onChange = vi.fn();
  render(<ExpandableTextarea label="VM options" value={VALUE} onChange={onChange} />);
  fireEvent.click(screen.getByRole("button", { name: "Expand (⇧⏎)" }));
  const expanded = editors()[1]!;
  expect(expanded.value).toBe(VALUE);
  expect(expanded.getAttribute("wrap")).toBe("off");
  fireEvent.change(expanded, { target: { value: `${VALUE}\n-Dextra=1` } });
  fireEvent.click(screen.getByRole("button", { name: "OK" }));
  expect(onChange).toHaveBeenCalledWith(`${VALUE}\n-Dextra=1`);
  expect(editors()).toHaveLength(1);
});

it("leaves the value alone on Cancel or OK without edits, and opens with Shift+Enter", () => {
  const onChange = vi.fn();
  render(<ExpandableTextarea label="VM options" value={VALUE} onChange={onChange} />);
  fireEvent.keyDown(editors()[0]!, { key: "Enter", shiftKey: true });
  fireEvent.change(editors()[1]!, { target: { value: "-Xmx1g" } });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(editors()).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Expand (⇧⏎)" }));
  fireEvent.click(screen.getByRole("button", { name: "OK" }));
  expect(onChange).not.toHaveBeenCalled();
});
