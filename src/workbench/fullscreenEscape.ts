/**
 * macOS: an Escape key press the page leaves unhandled (not default-prevented) goes back from
 * WebKit to AppKit as the web view's `cancelOperation:`, and AppKit answers it in a full-screen
 * window by leaving full screen, so pressing Escape once more after closing a popup dropped the
 * IDE out of full screen. While this window is in full screen, Escape is marked handled after
 * everything else has seen it; View › Appearance › Toggle Full Screen (⌃⌘F) leaves full screen.
 */
import { commands, isTauri, onIdeEvent } from "@/platform/ipc";
import { usePlatform } from "@/platform/platformInfo";

/** Installs the guard on `target`; `isFullscreen` is this window's state (tests pass their own). */
export function installFullscreenEscapeGuard(
  target: Window = window,
  isFullscreen: () => boolean = trackFullscreen(),
): () => void {
  const onCapture = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || e.isComposing || usePlatform.getState().os !== "macos" || !isFullscreen()) return;
    // Runs last in the bubble phase: handlers that check `defaultPrevented` see the event as it was.
    const handled = () => e.preventDefault();
    target.addEventListener("keydown", handled, { once: true });
    // A handler that stops the event has handled it; the bubble listener above won't run then.
    for (const name of ["stopPropagation", "stopImmediatePropagation"] as const) {
      const stop = e[name].bind(e);
      e[name] = () => {
        target.removeEventListener("keydown", handled);
        e.preventDefault();
        stop();
      };
    }
  };
  // Capture on the window before anything else is installed: it runs first.
  target.addEventListener("keydown", onCapture, true);
  return () => target.removeEventListener("keydown", onCapture, true);
}

function trackFullscreen(): () => boolean {
  let fullscreen = false;
  if (!isTauri()) return () => fullscreen;
  const sync = () =>
    void commands
      .windowIsFullscreen()
      .then((on) => (fullscreen = on))
      .catch(() => {});
  sync();
  onIdeEvent("windowFullscreenChanged", sync);
  return () => fullscreen;
}
