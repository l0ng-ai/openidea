import React from "react";
import ReactDOM from "react-dom/client";
import "./styles/global.css";
import { Workbench } from "./workbench/Workbench";
import { activateSecondaryWindow, activateWorkbench } from "./workbench/activate";
import {
  activateComparisonWindowFeatures,
  activateDeploymentWindowFeatures,
  activateDiffWindowFeatures,
  activateFeatures,
  activateSettingsWindowFeatures,
  ComparisonWindow,
  DeploymentWindow,
  DiffWindow,
  SettingsWindow,
} from "./features";
import { auxiliaryWindow } from "./platform/auxWindow";
import { installRepeatedDoubleClick } from "./platform/doubleClick";
import { installErrorLogging } from "./platform/errorLog";
import { guessOs } from "./platform/platformInfo";
import { installReorderedTapClick } from "./platform/reordered-tap-click";
import { installKeyboardDispatcher } from "./platform/keymap";
import { installPointerFocus } from "./platform/pointerFocus";
import { isTauri } from "./platform/ipc";
import { hideSplash } from "./platform/splash";
import { prefetchLazyComponents } from "./ui";
import { installWindowDrag } from "./workbench/window-drag";

if (import.meta.env.DEV && isTauri()) {
  // The Tauri MCP bridge returns eval results via `window.__TAURI__` on Windows/Linux
  // (macOS evaluates natively). Dev only, so release builds keep withGlobalTauri off.
  const [{ invoke }, { emit }] = await Promise.all([import("@tauri-apps/api/core"), import("@tauri-apps/api/event")]);
  (window as unknown as { __TAURI__?: unknown }).__TAURI__ ??= { core: { invoke }, event: { emit } };
}

installRepeatedDoubleClick();
// WebKit only (bug 219670). In Chromium (the e2e browser) a scripted double-click stamps its
// second press like the release before it, which the shim would take for a reordered tap and
// click twice.
if (guessOs() === "macos" && !/Chrome|Firefox/.test(navigator.userAgent)) installReorderedTapClick();
installWindowDrag();
installPointerFocus();
installErrorLogging();

// Auxiliary windows (Settings `settings-<parent>`, comparisons `comparison-<parent>-<n>`, Sync with
// Deployed `deployment-<parent>`) load this page too.
const aux = auxiliaryWindow();

if (aux?.kind === "settings") {
  activateSecondaryWindow();
  activateSettingsWindowFeatures(aux.parent);
} else if (aux?.kind === "comparison") {
  activateSecondaryWindow();
  activateComparisonWindowFeatures(aux.parent);
  installKeyboardDispatcher();
} else if (aux?.kind === "diff") {
  activateSecondaryWindow();
  activateDiffWindowFeatures(aux.parent);
  installKeyboardDispatcher();
} else if (aux?.kind === "deployment") {
  activateSecondaryWindow();
  activateDeploymentWindowFeatures(aux.parent);
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
    {aux?.kind === "settings" ? (
      <SettingsWindow />
    ) : aux?.kind === "comparison" ? (
      <ComparisonWindow />
    ) : aux?.kind === "diff" ? (
      <DiffWindow />
    ) : aux?.kind === "deployment" ? (
      <DeploymentWindow />
    ) : (
      <Workbench />
    )}
  </React.StrictMode>,
);
hideSplash();
// Views split out of the start-up bundle load in the background once the UI is up.
if (!aux) prefetchLazyComponents();
