import React, { useEffect, type ComponentType } from "react";
import ReactDOM from "react-dom/client";
import "./styles/global.css";
import { auxiliaryWindow } from "./platform/auxWindow";
import { installRepeatedDoubleClick } from "./platform/doubleClick";
import { installErrorLogging, logError } from "./platform/errorLog";
import { guessOs } from "./platform/platformInfo";
import { installReorderedTapClick } from "./platform/reordered-tap-click";
import { installWebKitClipboardGuard } from "./platform/webkitClipboard";
import { installPageSwipeTracking } from "./platform/pageSwipe";
import { installImeKeyGuard } from "./platform/ime";
import { installKeyboardDispatcher } from "./platform/keymap";
import { installPointerFocus } from "./platform/pointerFocus";
import { call, commands, isTauri } from "./platform/ipc";
import { hideSplash } from "./platform/splash";
import { prefetchLazyComponents } from "./ui/lazy";
import { installWindowDrag } from "./workbench/window-drag";
import { installFullscreenEscapeGuard } from "./workbench/fullscreenEscape";

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
if (guessOs() === "linux" && isTauri()) installWebKitClipboardGuard();
// A double click on the title bar fills the work area; the backend steps the frame once per
// presented webview frame, because AppKit's own zoom hides the page until the resize ends.
installWindowDrag({
  toggleMaximize: () => call(commands.windowToggleZoom()).catch((e) => console.warn("cannot zoom the window", e)),
});
installPointerFocus();
installImeKeyGuard();
installErrorLogging();
installPageSwipeTracking(window);

// Choose the entry before importing features: auxiliary windows have their own module graphs.
const aux = auxiliaryWindow();
let Window: ComponentType;

if (aux?.kind === "editor" || aux?.kind === "diff") {
  const entry = await (aux.kind === "editor" ? import("./windows/editor") : import("./windows/diff"));
  entry.activate(aux.parent);
  Window = entry.Window;
} else {
  const features = await import("./features");
  if (aux) {
    const { activateSecondaryWindow } = await import("./workbench/activateSecondary");
    activateSecondaryWindow();
    if (aux.kind === "settings") {
      features.activateSettingsWindowFeatures(aux.parent);
      Window = features.SettingsWindow;
    } else if (aux.kind === "comparison") {
      features.activateComparisonWindowFeatures(aux.parent);
      Window = features.ComparisonWindow;
    } else {
      features.activateDeploymentWindowFeatures(aux.parent);
      Window = features.DeploymentWindow;
    }
  } else {
    const { activateWorkbench } = await import("./workbench/activate");
    const { Workbench } = await import("./workbench/Workbench");
    // Before the features' and the dispatcher's key handlers: it wraps the Escape they see.
    installFullscreenEscapeGuard();
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
    features.activateFeatures();
    Window = Workbench;
  }
}
// Feature capture-phase key handlers must be installed before the global dispatcher.
if (!aux || aux.kind === "comparison") {
  installKeyboardDispatcher();
}

function App() {
  useEffect(() => {
    hideSplash();
    // Views split out of the start-up bundle load in the background once the UI is up.
    if (!aux) return prefetchLazyComponents();
  }, []);
  return <Window />;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement, {
  onUncaughtError: (error) => {
    logError("Uncaught render error", error);
    window.dispatchEvent(new CustomEvent("openidea:boot-error", { detail: error }));
  },
}).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
