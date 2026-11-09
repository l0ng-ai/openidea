import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionContext } from "@/platform/actions";
import type { Settings } from "@/platform/ipc";

const settingsSet = vi.fn();

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    isTauri: () => true,
    commands: { ...real.commands, settingsSet: (...a: unknown[]) => settingsSet(...a) },
  };
});

import { useProject } from "@/platform/project";
import { appearanceToggleActions, navigationBarActions } from "../appearanceRuntime";
import { validateAppearanceExtras } from "../model/behaviorSchema";

let appearance: Record<string, unknown>;

beforeEach(() => {
  appearance = {};
  const settings = () => ({ appearance: { ...appearance } }) as unknown as Settings;
  useProject.setState({ settings: settings() });
  settingsSet.mockReset().mockImplementation(async (_scope: string, key: string, json: string) => {
    appearance[key.replace("appearance.", "")] = JSON.parse(json);
    return { status: "ok", data: settings() };
  });
});

afterEach(() => useProject.setState({ settings: null }));

describe("View › Appearance toggles", () => {
  it("shows the toolbar and the status bar unless settings hide them", () => {
    expect(validateAppearanceExtras({})).toMatchObject({ showMainToolbar: true, showStatusBar: true });
    expect(validateAppearanceExtras({ showMainToolbar: false, showStatusBar: "no" })).toMatchObject({
      showMainToolbar: false,
      showStatusBar: true,
    });
  });

  it.each([
    ["view.toggleCompactMode", "compactMode", false],
    ["view.toggleToolbar", "showMainToolbar", true],
    ["view.toggleToolWindowBars", "showToolWindowBars", true],
    ["view.toggleStatusBar", "showStatusBar", true],
  ])("%s flips appearance.%s in the global settings", async (id, key, initial) => {
    const action = appearanceToggleActions().find((a) => a.id === id)!;
    expect(action.toggled?.()).toBe(initial);
    await action.run({ ctx: {} } as ActionContext);
    expect(settingsSet).toHaveBeenCalledWith("global", `appearance.${key}`, JSON.stringify(!initial));
    expect(action.toggled?.()).toBe(!initial);
  });
});

describe("View › Appearance › Navigation Bar", () => {
  it("marks only the chosen position and stores it", async () => {
    // Nothing stored yet: the default is the status bar.
    const [top, statusBar, hidden] = navigationBarActions();
    expect(top.toggled?.()).toBe(false);
    expect(statusBar.toggled?.()).toBe(true);
    expect(hidden.toggled?.()).toBe(false);

    await statusBar.run({ ctx: {} } as ActionContext);
    expect(settingsSet).toHaveBeenCalledWith("global", "appearance.navigationBar", JSON.stringify("statusBar"));
    expect(top.toggled?.()).toBe(false);
    expect(statusBar.toggled?.()).toBe(true);

    await hidden.run({ ctx: {} } as ActionContext);
    expect(settingsSet).toHaveBeenCalledWith("global", "appearance.navigationBar", JSON.stringify("hidden"));
    expect(statusBar.toggled?.()).toBe(false);
    expect(hidden.toggled?.()).toBe(true);
  });
});
