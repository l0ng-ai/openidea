/**
 * Zen Mode (View › Appearance), IDEA's ToggleZenMode: Distraction Free Mode and
 * full screen together. The mode is on while both are on; the action turns both
 * on, or both off when it is on, leaving either alone if it is already right.
 */
import { create } from "zustand";
import { registerAction, type Action } from "@/platform/actions";
import { commands, isTauri, onIdeEvent } from "@/platform/ipc";
import { usePlatform } from "@/platform/platformInfo";
import { setDistractionFree, useDistractionFree } from "./distractionFree";

export const ZEN_MODE_ACTION = "view.toggleZenMode";

/** This window's full-screen state, kept current by `installZenMode`. */
export const useFullscreen = create<{ on: boolean }>(() => ({ on: false }));

export function isZenMode(): boolean {
  return useDistractionFree.getState().active && useFullscreen.getState().on;
}

function zenModeTitle(active: boolean): string {
  return active ? "Exit Zen Mode" : "Enter Zen Mode";
}

async function readFullscreen(): Promise<boolean> {
  return isTauri() ? commands.windowIsFullscreen() : document.fullscreenElement === document.documentElement;
}

async function syncFullscreen() {
  const on = await readFullscreen().catch(() => useFullscreen.getState().on);
  if (on !== useFullscreen.getState().on) useFullscreen.setState({ on });
}

async function setFullscreen(on: boolean) {
  if ((await readFullscreen()) === on) return;
  if (isTauri()) await commands.windowToggleFullscreen();
  else if (on) await document.documentElement.requestFullscreen?.();
  else await document.exitFullscreen();
  await syncFullscreen();
}

/** The toggle in progress: full screen only flips, so a second run must not read the state before it lands. */
let pending: Promise<void> | null = null;

export function toggleZenMode(): Promise<void> {
  pending ??= (async () => {
    await syncFullscreen();
    const on = !isZenMode();
    setDistractionFree(on);
    await setFullscreen(on);
  })().finally(() => (pending = null));
  return pending;
}

function action(active: boolean): Action {
  return {
    id: ZEN_MODE_ACTION,
    title: zenModeTitle(active),
    category: "View",
    keywords: ["zen", "distraction free", "full screen", "toggle zen mode"],
    run: toggleZenMode,
  };
}

/** Registers the action; its title follows the mode, like IDEA's Enter / Exit Zen Mode. */
export function installZenMode(): () => void {
  let active = isZenMode();
  let dispose = registerAction(action(active));
  const update = () => {
    if (isZenMode() === active) return;
    active = !active;
    const previous = dispose;
    dispose = registerAction(action(active));
    previous();
  };
  const unsubs = [useDistractionFree.subscribe(update), useFullscreen.subscribe(update)];
  const onFullscreen = () => void syncFullscreen();
  if (isTauri()) unsubs.push(onIdeEvent("windowFullscreenChanged", onFullscreen));
  else {
    document.addEventListener("fullscreenchange", onFullscreen);
    unsubs.push(() => document.removeEventListener("fullscreenchange", onFullscreen));
  }
  // Only macOS reports full-screen changes; elsewhere (F11 on Windows) the window resizes.
  if (isTauri() && usePlatform.getState().os !== "macos") {
    window.addEventListener("resize", onFullscreen);
    unsubs.push(() => window.removeEventListener("resize", onFullscreen));
  }
  void syncFullscreen();
  return () => {
    unsubs.forEach((u) => u());
    dispose();
  };
}
