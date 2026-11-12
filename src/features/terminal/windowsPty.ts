import type { ITerminalOptions, Terminal } from "@xterm/xterm";
import { usePlatform } from "@/platform/platformInfo";
import { useRemote } from "@/platform/remote";

/** Report the local ConPTY backend even when the OS build is unavailable. */
export function windowsPty(): ITerminalOptions["windowsPty"] {
  const { os, windowsBuildNumber } = usePlatform.getState();
  // Remote PTYs must not inherit the desktop's Windows build or backend.
  if (useRemote.getState().session) return undefined;
  return os === "windows" ? { backend: "conpty", buildNumber: windowsBuildNumber ?? undefined } : undefined;
}

/** Restored terminals can be constructed before appInfo answers. */
export function watchWindowsPty(term: Terminal) {
  const unsubscribe = usePlatform.subscribe((next, previous) => {
    if (next.os !== previous.os || next.windowsBuildNumber !== previous.windowsBuildNumber) {
      term.options.windowsPty = windowsPty() ?? {};
    }
  });
  return { dispose: unsubscribe };
}
