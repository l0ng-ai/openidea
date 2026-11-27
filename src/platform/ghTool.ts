/**
 * Optional GitHub CLI (`gh`) installer shared by GitHub Pull Requests,
 * Clone Repository › GitHub, and Settings › Agents › GitHub Copilot.
 * Uses the `tools.install` action when available (workbench window, for
 * status-bar progress and notifications) and falls back to `commands.toolsInstall`
 * directly in standalone windows such as Settings.
 */
import { Channel } from "@tauri-apps/api/core";
import { executeAction, getAction } from "./actions";
import { call, commands, isTauri, nextRequestId, type InstallEvent, type ToolInfo } from "./ipc";

const GH_TOOL_NAME = "gh";
export const GH_MANUAL_INSTALL_URL = "https://cli.github.com";

interface GhInstallHandle {
  promise: Promise<boolean>;
  /** Cancels a direct install; null when delegated to the `tools.install` task queue. */
  cancel: (() => void) | null;
}

/** Returns the `ide-tools` entry for `gh`, or null outside the desktop app or on lookup error. */
async function getGhToolInfo(): Promise<ToolInfo | null> {
  if (!isTauri()) return null;
  try {
    const tools = await call(commands.toolsList());
    return tools.find((tool) => tool.name === GH_TOOL_NAME) ?? null;
  } catch {
    return null;
  }
}

/**
 * Installs `gh` into OpenIDEA's managed tools directory. Resolves to `true` when
 * `gh` is available afterwards, or `false` if cancelled or not installed.
 * Propagates errors when running directly (the `tools.install` action reports
 * its own errors via notifications).
 */
export function installGhTool(onEvent?: (event: InstallEvent) => void): GhInstallHandle {
  if (getAction("tools.install")) {
    const promise = (async () => {
      await executeAction("tools.install", GH_TOOL_NAME);
      const info = await getGhToolInfo();
      return info ? info.status !== "missing" : true;
    })();
    return { promise, cancel: null };
  }
  const request = nextRequestId();
  const channel = new Channel<InstallEvent>();
  channel.onmessage = (event) => onEvent?.(event);
  const promise = call(commands.toolsInstall(GH_TOOL_NAME, request, channel)).then((info) => info.status !== "missing");
  return {
    promise,
    cancel: () => void commands.cancelRequest(request).catch(() => {}),
  };
}
