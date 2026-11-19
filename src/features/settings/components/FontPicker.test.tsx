import { beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { FontPicker } from "./FontPicker";
import * as systemFonts from "@/platform/systemFonts";
import { bundledFonts, useSystemFontStore } from "@/platform/systemFonts";

beforeEach(() =>
  useSystemFontStore.setState({
    status: "ready",
    source: "native",
    fonts: [...bundledFonts, { name: "Maple Mono NF", monospaced: true }, { name: "思源宋体", monospaced: false }],
  }),
);
function Harness({ monoOnly = false, initial = "Saved Missing Font" }) {
  const [value, setValue] = useState(initial);
  return <FontPicker label="Font" value={value} onChange={setValue} monoOnly={monoOnly} allowEmpty />;
}
it("keeps missing saved names, searches outside the old list, and accepts manual names", () => {
  render(<Harness />);
  const input = screen.getByRole("combobox");
  expect(input).toHaveValue("Saved Missing Font");
  expect(screen.getByRole("status")).toHaveTextContent("not found");
  fireEvent.focus(input);
  expect(screen.getByRole("option", { name: /JetBrains Mono/ })).toBeInTheDocument();
  fireEvent.change(input, { target: { value: "maple" } });
  expect(screen.getAllByRole("option")).toHaveLength(1);
  fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(input).toHaveValue("Maple Mono NF");
  fireEvent.change(input, { target: { value: "My Custom Typeface" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(input).toHaveValue("My Custom Typeface");
});
it("filters only suggestions, permits CJK proportional fallback and empty fallback", () => {
  const view = render(<Harness monoOnly />);
  fireEvent.focus(screen.getByRole("combobox"));
  expect(screen.queryByRole("option", { name: /思源宋体/ })).toBeNull();
  view.rerender(<Harness monoOnly={false} />);
  fireEvent.click(screen.getByRole("option", { name: /思源宋体/ }));
  expect(screen.getByRole("combobox")).toHaveValue("思源宋体");
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "" } });
  fireEvent.blur(screen.getByRole("combobox"));
  expect(screen.getByRole("combobox")).toHaveValue("");
});
it("reflects external scope/saved-value changes and disables inherited selection", () => {
  const change = vi.fn();
  const view = render(<FontPicker label="Font" value="Global" onChange={change} />);
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "" } });
  view.rerender(<FontPicker label="Font" value="Project" onChange={change} disabled />);
  expect(screen.getByRole("combobox")).toHaveValue("Project");
  expect(screen.getByRole("combobox")).toBeDisabled();
  expect(change).not.toHaveBeenCalled();
});
it.each([
  ["loading", "Loading system fonts"],
  ["error", "Type a family name"],
  ["empty", "No system fonts"],
  ["browser", "Type a family name"],
] as const)("explains %s without declaring saved fonts missing", (status, message) => {
  useSystemFontStore.setState({ status });
  render(<Harness />);
  expect(screen.getByRole("status")).toHaveTextContent(message);
  expect(screen.getByRole("combobox")).toHaveValue("Saved Missing Font");
});

it("quietly keeps selections and manual input through fallback and native retry", () => {
  useSystemFontStore.setState({ status: "error", source: "limited", fonts: bundledFonts });
  render(<Harness />);
  const input = screen.getByRole("combobox");
  expect(input).toHaveValue("Saved Missing Font");
  expect(screen.getByRole("status")).toHaveTextContent("Type a family name");
  expect(screen.getByRole("button", { name: "Refresh system fonts" })).toBeEnabled();
  fireEvent.change(input, { target: { value: "Manual CJK Family" } });
  fireEvent.keyDown(input, { key: "Enter" });
  act(() => useSystemFontStore.setState({ status: "loading" }));
  expect(input).toHaveValue("Manual CJK Family");
  act(() =>
    useSystemFontStore.setState({
      status: "ready",
      source: "native",
      fonts: [...bundledFonts, { name: "New Native Family", monospaced: false }],
    }),
  );
  expect(input).toHaveValue("Manual CJK Family");
  fireEvent.focus(input);
  expect(screen.getByRole("option", { name: /New Native Family/ })).toBeInTheDocument();
});

it("skips font enumeration while disabled, defers on mount when enabled, and loads immediately on focus", () => {
  vi.useFakeTimers();
  const spy = vi.spyOn(systemFonts, "loadSystemFonts").mockResolvedValue();
  useSystemFontStore.setState({ status: "idle", source: "bundled", fonts: bundledFonts });
  try {
    const view = render(<FontPicker label="UI font" value="Inter" onChange={() => {}} disabled />);
    vi.advanceTimersByTime(2000);
    expect(spy).not.toHaveBeenCalled();

    view.rerender(<FontPicker label="UI font" value="Inter" onChange={() => {}} />);
    // Not called synchronously during initial render/mount commit.
    expect(spy).not.toHaveBeenCalled();

    // Focusing before the idle timer fires triggers enumeration immediately.
    fireEvent.focus(screen.getByRole("combobox"));
    expect(spy).toHaveBeenCalledTimes(1);
  } finally {
    spy.mockRestore();
    vi.useRealTimers();
  }
});
