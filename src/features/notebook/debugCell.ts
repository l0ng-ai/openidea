/** Debug Cell: runs a code cell on the notebook's kernel under the kernel's own debugger. */
import { isLive, startSession, stopSession, useDebug } from "@/features/debugger/state";
import { call, commands, type LaunchConfig } from "@/platform/ipc";
import { basename } from "@/platform/project";
import { workflowSettings } from "@/platform/workflowSettings";
import type { NotebookSession } from "./session";

/** The adapter name the backend gives a notebook kernel's debug session. */
const ADAPTER = "jupyter-kernel";

export async function debugCell(session: NotebookSession, cell: string): Promise<void> {
  await session.flush();
  const snapshot = session.getState().snapshot;
  if (!snapshot) return;
  const number = snapshot.cells.filter((c) => c.cellType === "code").findIndex((c) => c.id === cell) + 1;
  const name = `${basename(session.path)} [${number}]`;
  const launch: LaunchConfig = {
    name,
    adapter: ADAPTER,
    request: "attach",
    program: null,
    args: [],
    cwd: null,
    env: {},
    extraJson: null,
  };
  const justMyCode = workflowSettings().debugger.skipLibraryCode;
  const id = await startSession(launch, {
    rerunnable: false,
    start: () => call(commands.notebookDebugStart(snapshot.id, session.getState().python ?? null, name, justMyCode)),
  });
  if (id == null) return;
  // Stop in the Debug window ends the session: the cell is interrupted, the kernel keeps running.
  const stopped = useDebug.subscribe((state) => {
    if (isLive(state.sessions[id])) return;
    stopped();
    if (session.getState().running) void session.interrupt();
  });
  try {
    await session.execute([cell]);
  } finally {
    stopped();
    if (isLive(useDebug.getState().sessions[id])) await stopSession(id);
  }
}
