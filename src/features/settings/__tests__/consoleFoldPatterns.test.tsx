import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { type Settings } from "@/platform/ipc";

const settingsSet = vi.fn();
const settingsGet = vi.fn();
const settingsGetGlobal = vi.fn();

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    isTauri: () => true,
    commands: {
      ...real.commands,
      settingsSet: (...a: unknown[]) => settingsSet(...a),
      settingsGet: () => settingsGet(),
      settingsGetGlobal: () => settingsGetGlobal(),
    },
  };
});

import { executeAction } from "@/platform/actions";
import { useProject } from "@/platform/project";
import { DEFAULT_SETTINGS, setAt } from "../model/schema";
import { useSettingsDialog } from "../model/staging";
import { SettingsDialog } from "../dialog/SettingsDialog";
import { activate } from "..";

let current: Settings;
let dispose: () => void = () => {};

beforeEach(() => {
  current = setAt(structuredClone(DEFAULT_SETTINGS) as Settings, "console.foldPatterns", ["at org.junit."]);
  settingsSet.mockReset().mockImplementation(async (_scope: string, key: string, json: string) => {
    current = setAt(current, key, JSON.parse(json));
    return { status: "ok", data: current };
  });
  settingsGet.mockReset().mockImplementation(async () => current);
  settingsGetGlobal.mockReset().mockImplementation(async () => current);
  useProject.setState({ settings: current, project: null });
  dispose = activate();
});

afterEach(() => {
  act(() => useSettingsDialog.setState({ open: false }));
  dispose();
});

/** Settings › Console as the console's Fold Lines Like This opens it. */
async function openWith(text: string) {
  render(<SettingsDialog />);
  await act(async () => {
    await executeAction("file.settings", `build.console#${text}`);
  });
  const dialog = screen.getByRole("dialog", { name: "Settings" });
  const list = await within(dialog).findByRole("listbox", { name: "Fold console lines that contain" });
  return {
    dialog,
    patterns: () =>
      within(list)
        .getAllByRole("option")
        .map((o) => o.textContent),
  };
}

it("adds the console's line to the fold patterns, written on OK", async () => {
  const { dialog, patterns } = await openWith("at com.example.Retry#call");
  expect(patterns()).toEqual(["at org.junit.", "at com.example.Retry#call"]);
  expect(settingsSet).not.toHaveBeenCalled();
  await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "OK" })));
  expect(settingsSet).toHaveBeenCalledWith(
    "global",
    "console.foldPatterns",
    JSON.stringify(["at org.junit.", "at com.example.Retry#call"]),
  );
});

it("writes nothing when the dialog is cancelled", async () => {
  const { dialog } = await openWith("DEBUG");
  await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" })));
  expect(settingsSet).not.toHaveBeenCalled();
});

it("does not add a pattern the list already has", async () => {
  const { dialog, patterns } = await openWith("at org.junit.");
  expect(patterns()).toEqual(["at org.junit."]);
  await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "OK" })));
  expect(settingsSet).not.toHaveBeenCalled();
});

it("adds to the global list, not the project's own, while the global settings load", async () => {
  const global = current;
  settingsGetGlobal.mockImplementation(async () => global);
  useProject.setState({
    settings: setAt(global, "console.foldPatterns", ["at com.acme.internal."]),
    project: { root: "/p", name: "p" } as never,
  });
  const { dialog, patterns } = await openWith("DEBUG");
  expect(patterns()).toEqual(["at org.junit.", "DEBUG"]);
  await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "OK" })));
  expect(settingsSet).toHaveBeenCalledWith(
    "global",
    "console.foldPatterns",
    JSON.stringify(["at org.junit.", "DEBUG"]),
  );
});
