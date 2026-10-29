import React from "react";
import ReactDOM from "react-dom/client";
import { MotionConfig } from "motion/react";
import "./styles/global.css";
import { Workbench } from "./workbench/Workbench";
import { activateSecondaryWindow, activateWorkbench } from "./workbench/activate";
import { activateFeatures, activateSettingsWindowFeatures, SettingsWindow, settingsWindowParent } from "./features";
import { installKeyboardDispatcher } from "./platform/keymap";
import { isTauri } from "./platform/ipc";
import { hideSplash } from "./platform/splash";
import { prefetchLazyComponents } from "./ui";

if (import.meta.env.DEV && isTauri()) {
  // The Tauri MCP bridge returns eval results via `window.__TAURI__` on Windows/Linux
  // (macOS evaluates natively). Dev only, so release builds keep withGlobalTauri off.
  const [{ invoke }, { emit }] = await Promise.all([import("@tauri-apps/api/core"), import("@tauri-apps/api/event")]);
  (window as unknown as { __TAURI__?: unknown }).__TAURI__ ??= { core: { invoke }, event: { emit } };
}

// The native Settings window (`settings-<parent>`) loads this page too.
const settingsParent = settingsWindowParent();

if (settingsParent !== null) {
  activateSecondaryWindow();
  activateSettingsWindowFeatures(settingsParent);
} else {
  activateWorkbench();
  // `vite build --mode perf` is a production bundle for the performance harness (`perf/`).
  const perfBuild = import.meta.env.MODE === "perf";
  if ((import.meta.env.DEV || perfBuild) && !isTauri()) {
    const { registerDevSamples } = await import("./workbench/devSamples");
    registerDevSamples();
  }
  if (import.meta.env.DEV || perfBuild) {
    const { installPerfProbe } = await import("./workbench/perfProbe");
    installPerfProbe();
  }
  // Order matters: features (e.g. the terminal) install capture-phase key handlers
  // that must run before the global dispatcher.
  activateFeatures();
  installKeyboardDispatcher();
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {/* Honour the OS "reduce motion" setting: no movement, only fades. */}
    <MotionConfig reducedMotion="user">{settingsParent !== null ? <SettingsWindow /> : <Workbench />}</MotionConfig>
  </React.StrictMode>,
);
hideSplash();
// Views split out of the start-up bundle load in the background once the UI is up.
if (settingsParent === null) prefetchLazyComponents();
