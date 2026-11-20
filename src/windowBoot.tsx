import React, { useEffect, type ComponentType } from "react";
import ReactDOM from "react-dom/client";
import "./styles/global.css";
import { installRepeatedDoubleClick } from "./platform/doubleClick";
import { installErrorLogging, logError } from "./platform/errorLog";
import { installImeKeyGuard } from "./platform/ime";
import { call, commands, isTauri } from "./platform/ipc";
import { installPageSwipeTracking } from "./platform/pageSwipe";
import { guessOs } from "./platform/platformInfo";
import { installPointerFocus } from "./platform/pointerFocus";
import { installReorderedTapClick } from "./platform/reordered-tap-click";
import { hideSplash } from "./platform/splash";
import { installWebKitClipboardGuard } from "./platform/webkitClipboard";
import { prefetchLazyComponents } from "./ui";
import { installWindowDrag } from "./workbench/window-drag";

export type Activate = () => void | (() => void);

export function activateList(what: string, list: ReadonlyArray<readonly [string, Activate]>): () => void {
  const disposers: Array<() => void> = [];
  for (const [name, activate] of list) {
    try {
      const d = activate();
      if (d) disposers.push(d);
    } catch (e) {
      console.error(`${what} of ${name} failed to activate`, e);
    }
  }
  return () => disposers.reverse().forEach((d) => d());
}

export async function installCommonWindowBoot(): Promise<void> {
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
}

export function mountWindowRoot(View: ComponentType, { prefetchLazy = false }: { prefetchLazy?: boolean } = {}): void {
  function App() {
    useEffect(() => {
      hideSplash();
      if (!prefetchLazy) return;
      // The first file opened would otherwise also build the editor setup cold.
      const warm = () => {
        if (!document.querySelector(".cm-editor"))
          void import("./editor/core/cm/prewarm").then((m) => m.prewarmEditor());
      };
      const idle =
        typeof requestIdleCallback === "function"
          ? requestIdleCallback(warm, { timeout: 2000 })
          : window.setTimeout(warm, 500);
      // Views split out of the start-up bundle load in the background once the UI is up.
      const stopPrefetch = prefetchLazyComponents();
      return () => {
        if (typeof cancelIdleCallback === "function") cancelIdleCallback(idle);
        else window.clearTimeout(idle);
        stopPrefetch();
      };
    }, []);
    return <View />;
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
}
