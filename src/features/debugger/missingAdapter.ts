/**
 * A debug adapter that is not installed, or an installed one that refuses the Go
 * toolchain: name it and offer the one-click install / reinstall (ide-tools) followed
 * by the same launch again, instead of a bare error.
 */
import { IpcError } from "@/platform/ipc";
import { tx } from "@/platform/i18n";

/** Adapters the tools installer can provide (adapter id → tool name). */
const INSTALLABLE: Record<string, { tool: string; title: string }> = {
  "kotlin-debug-adapter": { tool: "kotlin-debug-adapter", title: "The Kotlin debugger is not installed" },
  netcoredbg: { tool: "netcoredbg", title: "netcoredbg is not installed" },
  debugpy: { tool: "debugpy", title: "debugpy is not installed" },
  "js-debug": { tool: "js-debug", title: "The JavaScript debugger (vscode-js-debug) is not installed" },
  delve: { tool: "delve", title: "Delve is not installed" },
  codelldb: { tool: "codelldb", title: "CodeLLDB is not installed" },
  "php-debug": { tool: "php-debug", title: "PHP Debug (Xdebug) is not installed" },
  "bash-debug": { tool: "bash-debug", title: "Bash Debug is not installed" },
};

/**
 * Delve refuses a Go toolchain newer than it supports: the adapter starts, but its
 * `launch` request fails with "Version of Delve is too old for Go version go1.27.0
 * (maximum supported version 1.26, …)". The managed install is
 * `go install github.com/go-delve/delve/cmd/dlv@latest`, so reinstalling updates it.
 */
const DELVE_TOO_OLD = /Version of Delve is too old for Go version go([\d.]+)/;

export interface MissingAdapter {
  tool: string;
  title: string;
  body: string;
  /** The action's label when "Install and Debug" doesn't fit (a stale adapter's reinstall). */
  action?: string;
}

/** The install offer for a failed start, or null when the failure is something else. */
export function missingAdapter(adapter: string, e: unknown): MissingAdapter | null {
  if (!(e instanceof IpcError)) return null;
  if (adapter === "delve") {
    const go = DELVE_TOO_OLD.exec(e.message)?.[1];
    if (go)
      return {
        tool: "delve",
        title: tx`Delve is too old for Go ${go}`,
        body: `${e.message}. Reinstalling Delve runs go install github.com/go-delve/delve/cmd/dlv@latest.`,
        action: "Reinstall and Debug",
      };
  }
  const entry = INSTALLABLE[adapter];
  if (!entry || e.kind !== "unavailable") return null;
  if (adapter === "debugpy" && e.message.startsWith("debugpy is not installed")) {
    return {
      tool: entry.tool,
      title: entry.title,
      body: `${e.message}. OpenIDEA can install a private copy that every Python interpreter uses for debugging.`,
    };
  }
  if (!e.message.startsWith(`debug adapter \`${adapter}\` not found`)) return null;
  return {
    tool: entry.tool,
    title: entry.title,
    body: e.message,
  };
}
