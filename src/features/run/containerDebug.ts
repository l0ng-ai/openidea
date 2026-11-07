/**
 * Debugging Python on Docker / Compose run targets: the run starts the program in a new
 * container under debugpy (the bootstrap of `ide_remote::docker`), which prints its port
 * once it listens; the debugger then attaches like a Python Remote Debug configuration,
 * with the project folder mapped. Output stays in the Run tab; stopping the debugger
 * stops the container.
 */
import { executeAction } from "@/platform/actions";
import type { RunConfig } from "@/platform/ipc";
import { startRun, useRun } from "./store";

/** The bootstrap's line (`ide_remote::docker::DEBUG_READY`). */
const READY = /^debugpy is waiting for the debugger on port (\d+), project folder (.+)$/;

interface Ready {
  port: number;
  remoteRoot: string;
}

/** Where the debugger attaches, from an output line of a container debug run. */
export function debugpyReady(line: string): Ready | null {
  const m = READY.exec(line.trim());
  return m ? { port: Number(m[1]), remoteRoot: m[2]! } : null;
}

/** `config` as the backend runs it for debugging: under debugpy, waiting for the debugger. */
export function containerDebugLaunch(config: RunConfig): RunConfig {
  return { ...config, params: { ...config.params, containerDebug: "true" } };
}

/** Runs `config` in its container under debugpy and attaches the debugger. */
export async function debugInContainer(config: RunConfig): Promise<void> {
  let sessionId: string | null = null;
  const waiting: Ready[] = [];
  const attach = ({ port, remoteRoot }: Ready) => {
    const runId = useRun.getState().sessions.find((s) => s.id === sessionId)?.runId ?? null;
    void executeAction("debug.attach", {
      name: config.name,
      adapter: "debugpy",
      hostName: "127.0.0.1",
      port,
      remoteRoot,
      process: runId,
      runConfig: config,
    });
  };
  const session = await startRun(config, undefined, undefined, {
    launch: containerDebugLaunch(config),
    onLine: (line) => {
      const ready = debugpyReady(line);
      if (!ready) return;
      if (sessionId) attach(ready);
      else waiting.push(ready);
    },
  });
  if (!session) return;
  sessionId = session.id;
  waiting.splice(0).forEach(attach);
}
