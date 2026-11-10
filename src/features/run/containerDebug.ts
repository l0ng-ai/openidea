/**
 * Debugging Python on Docker / Compose run targets: the run starts the program in a new
 * container under debugpy (the bootstrap of `ide_remote::docker`), which prints its port
 * once it listens; the debugger then attaches like a Python Remote Debug configuration,
 * with the project folder mapped. Output stays in the Run tab; stopping the debugger
 * stops the container.
 */
import { executeAction } from "@/platform/actions";
import type { RunConfig } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { notifications } from "@/workbench/contributions";
import { isLive, startRun, stopSession, useRun } from "./store";

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
  let ready: Ready | null = null;
  let done = false;
  const pending: { timer?: ReturnType<typeof setTimeout>; unsubscribe?: () => void } = {};
  const finish = () => {
    done = true;
    clearTimeout(pending.timer);
    pending.unsubscribe?.();
  };
  const fail = (body: string) => {
    finish();
    notifications().notify({ group: "run", level: "error", title: tx("Cannot start container debugging"), body });
  };
  const attach = ({ port, remoteRoot }: Ready) => {
    if (done) return;
    finish();
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
      if (done) return;
      const parsed = debugpyReady(line);
      if (!parsed) return;
      ready = parsed;
      if (sessionId) attach(ready);
    },
  });
  if (!session) return;
  sessionId = session.id;
  const check = () => {
    const current = useRun.getState().sessions.find((s) => s.id === sessionId);
    if (!current || current.stopped || current.status === "failed") finish();
    else if (!isLive(current))
      fail(tx("The container exited before debugpy was ready. Check the Run console for errors."));
  };
  pending.unsubscribe = useRun.subscribe(check);
  check();
  if (done) return;
  pending.timer = setTimeout(() => {
    fail(
      tx(
        "debugpy did not become ready within 120 seconds. Check the Run console and the container's Python interpreter.",
      ),
    );
    void stopSession(session.id);
  }, 120_000);
  if (ready) attach(ready);
}
