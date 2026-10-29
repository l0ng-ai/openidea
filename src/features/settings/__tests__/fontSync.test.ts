import { afterEach, expect, it, vi } from "vitest";
const { handlers, settingsGet } = vi.hoisted(() => ({ handlers: new Map<string, () => void>(), settingsGet: vi.fn() }));
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return {
    ...real,
    isTauri: () => true,
    commands: { ...real.commands, settingsGet },
    onIdeEvent: (event: string, handler: () => void) => {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
  };
});
import { useProject } from "@/platform/project";
import { trackRuntimeSettings } from "../runtime";
import { DEFAULT_SETTINGS, setAt } from "../model/schema";

afterEach(() => vi.useRealTimers());
it("reloads independent font preferences after standalone settings-window Apply events", async () => {
  vi.useFakeTimers();
  useProject.setState({ settings: structuredClone(DEFAULT_SETTINGS), project: null });
  const stop = trackRuntimeSettings();
  try {
    let next = setAt(structuredClone(DEFAULT_SETTINGS), "editor.fontFamily", "Maple Mono NF");
    next = setAt(next, "appearance.useCustomFont", true);
    next = setAt(next, "appearance.uiFontFamily", "思源黑体");
    next = setAt(next, "terminal.fontFamily", "Independent Terminal");
    settingsGet.mockResolvedValue(next);
    handlers.get("settingsChanged")!();
    handlers.get("settingsChanged")!();
    await vi.advanceTimersByTimeAsync(40);
    expect(settingsGet).toHaveBeenCalledOnce();
    expect(useProject.getState().settings?.editor?.fontFamily).toBe("Maple Mono NF");
    expect(useProject.getState().settings?.terminal?.fontFamily).toBe("Independent Terminal");
    expect(document.documentElement.style.getPropertyValue("--font-ui")).toContain("思源黑体");
  } finally {
    stop();
  }
});
