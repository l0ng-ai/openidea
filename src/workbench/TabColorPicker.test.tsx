import { beforeEach, expect, it } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { setTabColorOverride, tabColorOverride } from "./tabColors";
import { TabColorPicker, openTabColorPicker, useTabColorPicker } from "./TabColorPicker";

beforeEach(() => {
  localStorage.clear();
  useTabColorPicker.setState({ target: null });
});

const open = () => openTabColorPicker({ root: "/back", name: "Backend", x: 10, y: 40 });

it("stays hidden until a tab colour target is opened", () => {
  render(<TabColorPicker />);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  act(() => open());
  expect(screen.getByRole("dialog")).toBeInTheDocument();
});

it("applies a preset slot and closes", () => {
  open();
  render(<TabColorPicker />);
  fireEvent.click(screen.getByRole("radio", { name: "Blue" }));
  expect(tabColorOverride("/back")).toBe("5");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("marks the current override as checked", () => {
  setTabColorOverride("/back", "5");
  open();
  render(<TabColorPicker />);
  expect(screen.getByRole("radio", { name: "Blue" })).toHaveAttribute("aria-checked", "true");
  expect(screen.getByRole("radio", { name: "Green" })).toHaveAttribute("aria-checked", "false");
});

it("applies a custom hex colour without closing", () => {
  open();
  render(<TabColorPicker />);
  fireEvent.change(screen.getByLabelText("Custom colour hex"), { target: { value: "#a1b2c3" } });
  expect(tabColorOverride("/back")).toBe("#a1b2c3");
  expect(screen.getByRole("dialog")).toBeInTheDocument();
});

it("resets to the default colour and closes", () => {
  setTabColorOverride("/back", "5");
  open();
  render(<TabColorPicker />);
  fireEvent.click(screen.getByRole("button", { name: "Reset to Default" }));
  expect(tabColorOverride("/back")).toBeNull();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("closes on Escape", () => {
  open();
  render(<TabColorPicker />);
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
