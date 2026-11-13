/** The Run tool window's agent tabs: starting them, and archiving finished ones. */
import type { IpcPath } from "@/bindings";
import { agentRunSettings } from "@/platform/workflowSettings";
import { agentConfig, agentName } from "./agentConfig";
import { closeSession, isLive, startRun, useRun, type RunSession } from "./store";

export interface AgentRunRequest {
  name: string;
  command: string;
  cwd: IpcPath;
  env: Record<string, string>;
}

/** Starts an agent's command in its tab (reused once its last command finished). */
export async function startAgentRun(request: AgentRunRequest): Promise<void> {
  const config = agentConfig(request.name, request.command, request.cwd, request.env);
  const existing = useRun.getState().sessions.find((s) => s.config.id === config.id);
  // The backend refuses a running name first; nothing here stops a run on the agent's behalf.
  if (existing && isLive(existing)) throw new Error(`${request.name} is still running`);
  const session = await startRun(config, existing?.id);
  if (!session || session.status === "failed") throw new Error("The command did not start");
}

const endedAt = (s: RunSession) => s.endedAt ?? s.startedAt;

/** Finished agent tabs beyond the newest `limit`: the archive, newest first. Running ones never are. */
export function archivedAgentSessions(sessions: readonly RunSession[], limit: number): RunSession[] {
  return sessions
    .filter((s) => agentName(s.config) !== null && !isLive(s))
    .sort((a, b) => endedAt(b) - endedAt(a))
    .slice(Math.max(0, limit));
}

/** Closes the oldest archived agent tabs beyond the archive limit. */
export function trimAgentArchive() {
  const { tabLimit, archiveLimit } = agentRunSettings();
  const archived = archivedAgentSessions(useRun.getState().sessions, tabLimit);
  for (const s of archived.slice(archiveLimit)) closeSession(s.id, { agentTabClosed: false });
}

/** Closes every archived agent tab. */
export function closeAgentArchive() {
  const archived = archivedAgentSessions(useRun.getState().sessions, agentRunSettings().tabLimit);
  for (const s of archived) closeSession(s.id);
}
