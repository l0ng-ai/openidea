import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useProject } from "@/platform/project";
import { Dialog } from "@/ui";
import { ColorSwatches } from "../components/Form";
import { useSetting } from "../components/context";
import { ACCENT_PRESETS, validateSettings } from "../model/schema";
import { applySettings, closeSettings, useSettingsDialog } from "../model/staging";

const saved = useSettingsDialog.getState();
const savedSettings = useProject.getState().settings;
afterEach(() => {
  useSettingsDialog.setState(saved);
  useProject.setState({ settings: savedSettings });
  localStorage.removeItem("openidea.colorPicker.recent.v1");
});

function Accent() {
  const [value, setValue] = useSetting<string>("appearance.accent");
  return <ColorSwatches value={value} onChange={setValue} presets={ACCENT_PRESETS} useColorPicker />;
}

it("stages opaque accent colors and persists them only through Settings Apply", async () => {
  const base = validateSettings({ appearance: { accent: "#abc" } });
  useSettingsDialog.setState({ base, globalBase: base, staged: {}, open: true });
  const dismissSettings = vi.fn();
  render(
    <Dialog open title="Settings" onClose={dismissSettings}>
      <Accent />
    </Dialog>,
  );
  const staged = () => useSettingsDialog.getState().staged["global|appearance.accent"]?.value;
  const trigger = screen.getByRole("button", { name: "Custom colour #abc" });
  expect(trigger).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(trigger);
  const picker = within(screen.getByRole("dialog", { name: "Color picker" }));
  const hex = picker.getByRole("textbox", { name: "Hexadecimal" });
  expect(hex).toHaveValue("AABBCC");
  expect(picker.queryByRole("textbox", { name: "Alpha percent" })).toBeNull();
  fireEvent.change(hex, { target: { value: "1234567" } });
  fireEvent.blur(hex);
  fireEvent.submit(hex.closest("form")!);
  expect(hex).toHaveAttribute("aria-invalid", "true");
  expect(staged()).toBeUndefined();
  fireEvent.change(picker.getByRole("textbox", { name: "Red" }), { target: { value: "12" } });
  fireEvent.change(hex, { target: { value: "#DeF" } });
  fireEvent.keyDown(hex, { key: "Escape" });
  expect(staged()).toBeUndefined();
  expect(dismissSettings).not.toHaveBeenCalled();
  expect(trigger).toHaveFocus();
  fireEvent.click(trigger);
  fireEvent.change(pickerFor("Hexadecimal"), { target: { value: "#DeF" } });
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  expect(staged()).toBe("#ddeeff");
  expect(trigger).toHaveAccessibleName("Custom colour #ddeeff");
  const set = vi.fn(async () => validateSettings({ appearance: { accent: "#ddeeff" } }));
  expect(set).not.toHaveBeenCalled();
  await act(async () => {
    expect(await applySettings({ backend: true, set, setSecret: async () => {}, reload: async () => {} })).toBe(true);
  });
  expect(set).toHaveBeenCalledWith("global", "appearance.accent", JSON.stringify("#ddeeff"));
  fireEvent.click(trigger);
  expect(pickerFor("Hexadecimal")).toHaveValue("DDEEFF");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("radio", { name: "Teal" }));
  expect(staged()).toBe("#24a394");
  act(closeSettings);
  expect(staged()).toBeUndefined();
});

function pickerFor(name: string) {
  return within(screen.getByRole("dialog", { name: "Color picker" })).getByRole("textbox", { name });
}
