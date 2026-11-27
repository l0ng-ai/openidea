import type { ITerminalOptions, Terminal } from "@xterm/xterm";
import { usePlatform } from "@/platform/platformInfo";
import { useRemote } from "@/platform/remote";

export function windowsPtyOptions(): Pick<ITerminalOptions, "windowsPty" | "reflowCursorLine"> {
  const { os, windowsBuildNumber } = usePlatform.getState();
  // Remote PTYs must not inherit the desktop's Windows build or backend.
  if (os !== "windows" || useRemote.getState().session) return { reflowCursorLine: false };
  return {
    windowsPty: { backend: "conpty", buildNumber: windowsBuildNumber ?? undefined },
    // Modern ConPTY can leave the prompt untouched on resize and echo input with absolute cursor moves.
    reflowCursorLine: windowsBuildNumber !== null && windowsBuildNumber >= 21376,
  };
}

/** Restored terminals can be constructed before appInfo answers. */
export function watchWindowsPty(term: Terminal) {
  const unsubscribe = usePlatform.subscribe((next, previous) => {
    if (next.os !== previous.os || next.windowsBuildNumber !== previous.windowsBuildNumber) {
      const { windowsPty, reflowCursorLine } = windowsPtyOptions();
      term.options.windowsPty = windowsPty ?? {};
      term.options.reflowCursorLine = reflowCursorLine;
    }
  });
  return { dispose: unsubscribe };
}
