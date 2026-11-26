import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeAction, getAction } from "@/platform/actions";
import { isDistractionFree, resetDistractionFree, setDistractionFree } from "./distractionFree";
import { usePlatform } from "@/platform/platformInfo";
import { ZEN_MODE_ACTION, installZenMode, isZenMode, toggleZenMode, useFullscreen } from "./zenMode";

const win = vi.hoisted(() => ({ fullscreen: false, onChange: null as null | (() => void) }));

const { windowIsFullscreen, windowToggleFullscreen } = vi.hoisted(() => ({
  windowIsFullscreen: vi.fn(async () => win.fullscreen),
  windowToggleFullscreen: vi.fn(async () => {
    win.fullscreen = !win.fullscreen;
    win.onChange?.();
    return { status: "ok", data: win.fullscreen };
  }),
}));

vi.mock("@/platform/ipc", async (orig) => {
  const actual = await orig<typeof import("@/platform/ipc")>();
  return {
    ...actual,
    isTauri: () => true,
    commands: { ...actual.commands, windowIsFullscreen, windowToggleFullscreen },
    onIdeEvent: (type: string, handler: () => void) => {
      if (type !== "windowFullscreenChanged") return () => {};
      win.onChange = handler;
      return () => (win.onChange = null);
    },
  };
});

let dispose: () => void = () => {};
const os = usePlatform.getState().os;
const settle = () => new Promise((r) => setTimeout(r, 0));
const title = () => getAction(ZEN_MODE_ACTION)?.title;

beforeEach(async () => {
  localStorage.clear();
  resetDistractionFree();
  win.fullscreen = false;
  useFullscreen.setState({ on: false });
  windowToggleFullscreen.mockClear();
  dispose = installZenMode();
  await settle();
});

afterEach(() => {
  dispose();
  usePlatform.setState({ os });
  resetDistractionFree();
});

describe("zen mode", () => {
  it("turns on Distraction Free Mode and full screen together, and both off again", async () => {
    expect(title()).toBe("Enter Zen Mode");
    await executeAction(ZEN_MODE_ACTION);
    expect(isDistractionFree()).toBe(true);
    expect(win.fullscreen).toBe(true);
    expect(isZenMode()).toBe(true);
    expect(title()).toBe("Exit Zen Mode");
    await executeAction(ZEN_MODE_ACTION);
    expect(isDistractionFree()).toBe(false);
    expect(win.fullscreen).toBe(false);
    expect(title()).toBe("Enter Zen Mode");
    expect(windowToggleFullscreen).toHaveBeenCalledTimes(2);
  });

  it("enters from full screen alone without leaving full screen", async () => {
    win.fullscreen = true;
    await executeAction(ZEN_MODE_ACTION);
    expect(windowToggleFullscreen).not.toHaveBeenCalled();
    expect(win.fullscreen).toBe(true);
    expect(isDistractionFree()).toBe(true);
    expect(title()).toBe("Exit Zen Mode");
  });

  it("enters from Distraction Free Mode alone by adding full screen", async () => {
    setDistractionFree(true);
    expect(title()).toBe("Enter Zen Mode");
    await executeAction(ZEN_MODE_ACTION);
    expect(isDistractionFree()).toBe(true);
    expect(win.fullscreen).toBe(true);
    expect(title()).toBe("Exit Zen Mode");
  });

  it("is off once full screen is left another way, and the action enters it again", async () => {
    await executeAction(ZEN_MODE_ACTION);
    // View › Appearance › Toggle Full Screen or the window's green button.
    win.fullscreen = false;
    win.onChange?.();
    await settle();
    expect(isZenMode()).toBe(false);
    expect(title()).toBe("Enter Zen Mode");
    await executeAction(ZEN_MODE_ACTION);
    expect(isDistractionFree()).toBe(true);
    expect(win.fullscreen).toBe(true);
  });

  it("enters once when run again before full screen has switched", async () => {
    await Promise.all([toggleZenMode(), toggleZenMode()]);
    expect(windowToggleFullscreen).toHaveBeenCalledTimes(1);
    expect(isDistractionFree()).toBe(true);
    expect(win.fullscreen).toBe(true);
  });

  it("notices full screen left without an event once the window resizes (Windows, Linux)", async () => {
    dispose();
    usePlatform.setState({ os: "windows" });
    dispose = installZenMode();
    await executeAction(ZEN_MODE_ACTION);
    win.fullscreen = false;
    window.dispatchEvent(new Event("resize"));
    await settle();
    expect(title()).toBe("Enter Zen Mode");
  });

  it("is off once Distraction Free Mode is left, and leaves full screen alone then", async () => {
    await executeAction(ZEN_MODE_ACTION);
    setDistractionFree(false);
    expect(title()).toBe("Enter Zen Mode");
    expect(win.fullscreen).toBe(true);
  });
});
