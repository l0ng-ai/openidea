import { act, cleanup, render, screen } from "@testing-library/react";
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

import { executeAction, registerActions } from "@/platform/actions";
import { useKeymap } from "@/platform/keymap";
import { usePlatform } from "@/platform/platformInfo";
import { useProject } from "@/platform/project";
import { presentationAssistantAction } from "../appearanceRuntime";
import { validateAppearanceExtras } from "../model/behaviorSchema";
import { PresentationAssistant } from "../presentation/PresentationAssistant";
import { alternatePreset, presentAction } from "../presentation/presentation";

let assistant: Record<string, unknown>;
const disposers: Array<() => void> = [];

function useSettings(patch: Record<string, unknown>) {
  assistant = { ...assistant, ...patch };
  useProject.setState({ settings: { appearance: { presentationAssistant: { ...assistant } } } as unknown as Settings });
}

beforeEach(() => {
  assistant = {};
  useSettings({});
  usePlatform.setState({ os: "macos" });
  useKeymap.setState({ preset: "intellij-macos", overrides: {}, extensions: {} });
  disposers.push(
    registerActions([
      { id: "file.save", title: "Save All", category: "File", run: () => {} },
      { id: "test.unbound", title: "Unbound Action", run: () => {} },
      { id: "test.internal", title: "Internal Step", hidden: true, run: () => {} },
    ]),
  );
  settingsSet.mockReset().mockImplementation(async (_scope: string, key: string, json: string) => {
    useSettings({ [key.replace("appearance.presentationAssistant.", "")]: JSON.parse(json) });
    return { status: "ok", data: useProject.getState().settings };
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  while (disposers.length) disposers.pop()!();
  useProject.setState({ settings: null });
});

describe("Presentation Assistant", () => {
  it("is off by default and keeps its options in range", () => {
    expect(validateAppearanceExtras({}).presentationAssistant).toEqual({
      enabled: false,
      size: "medium",
      durationSeconds: 4,
      position: "bottom",
      alternateKeymap: false,
    });
    expect(
      validateAppearanceExtras({ presentationAssistant: { size: "huge", durationSeconds: 0, position: "middle" } })
        .presentationAssistant,
    ).toMatchObject({ size: "medium", durationSeconds: 1, position: "bottom" });
  });

  it("names the action with its shortcut, and the other platform's on request", () => {
    expect(presentAction("file.save", false)).toEqual({ title: "Save All", shortcut: "⌘S" });
    expect(presentAction("file.save", true)).toEqual({
      title: "Save All",
      shortcut: "⌘S",
      alternate: { keymap: "Windows/Linux", shortcut: "Ctrl+S" },
    });
    expect(presentAction("file.save", true, false)?.alternate).toEqual({ keymap: "macOS", shortcut: "⌘S" });
    expect(presentAction("test.unbound", true)).toEqual({ title: "Unbound Action", shortcut: undefined });
    expect(presentAction("test.internal", false)).toBeNull();
    expect(alternatePreset("vscode-macos", true)).toBe("vscode-windows");
    expect(alternatePreset("my-custom-keymap", false)).toBe("intellij-macos");
  });

  it("shows each action run while enabled and hides it after the duration", async () => {
    vi.useFakeTimers();
    render(<PresentationAssistant />);
    await act(async () => void (await executeAction("file.save")));
    expect(screen.queryByTestId("presentation-assistant")).toBeNull();

    act(() => useSettings({ enabled: true, durationSeconds: 2 }));
    await act(async () => void (await executeAction("file.save")));
    expect(screen.getByTestId("presentation-assistant").textContent).toBe("Save All⌘S");

    act(() => vi.advanceTimersByTime(1500));
    expect(screen.getByTestId("presentation-assistant")).toBeTruthy();
    act(() => vi.advanceTimersByTime(600));
    expect(screen.queryByTestId("presentation-assistant")).toBeNull();
  });

  it("is toggled from View › Appearance", async () => {
    const action = presentationAssistantAction();
    expect(action.toggled?.()).toBe(false);
    await action.run({ ctx: {} } as ActionContext);
    expect(settingsSet).toHaveBeenCalledWith("global", "appearance.presentationAssistant.enabled", "true");
    expect(action.toggled?.()).toBe(true);
  });
});
