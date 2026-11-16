/** Run configurations of commands agents run through the IDE's MCP server (`run_command`). */
import type { IpcPath, RunConfig } from "@/bindings";
import { workflowSettings } from "@/platform/workflowSettings";

/** Names the agent tab a run belongs to; the backend logs it for the agent. */
export const AGENT_PARAM = "mcp.agentRun";
/** Settings › Tools › Terminal › Shell path, which the backend runs the command line with. */
const SHELL_PARAM = "mcp.agentShell";

/** The agent tab name of a configuration, or `null` for any other run. */
export function agentName(config: Pick<RunConfig, "params">): string | null {
  return config.params?.[AGENT_PARAM] ?? null;
}

/**
 * The command line of agent tab `name`, with the shell of the IDE's terminal but on pipes (as
 * JetBrains' `execute_terminal_command`): programs print plain lines, the console shows them and
 * sends the user's input lines.
 */
export function agentConfig(name: string, command: string, cwd: IpcPath, env: Record<string, string>): RunConfig {
  const terminal = workflowSettings().terminal;
  return {
    id: `mcp-agent:${name}`,
    name,
    kind: "shell",
    command,
    args: [],
    cwd,
    env: { ...terminal.env, ...env },
    detected: false,
    isTest: false,
    debugAdapter: null,
    allowParallel: true,
    params: { [AGENT_PARAM]: name, [SHELL_PARAM]: terminal.shellPath },
    // This machine: an agent's command never goes to a default run target.
    target: "",
  };
}
