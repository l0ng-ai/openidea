/**
 * A remote window whose connection ends on its own (network loss, sleep, the host or its server
 * went away): marks it lost, reconnects a few times in the background, then offers Reconnect.
 */
import { onIdeEvent } from "@/platform/ipc";
import { setContext } from "@/platform/context";
import { tx } from "@/platform/i18n";
import { reconnectRemote, useRemote } from "@/platform/remote";
import { maybeEditorService, notifications } from "@/workbench/contributions";
import { confirm } from "@/workbench/messages";

/** Waits before each automatic attempt, as VS Code Remote and Gateway retry with back-off. */
export const RETRY_DELAYS_MS = [2_000, 5_000, 15_000];
const KEY = "remote.connection";

let generation = 0;

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const unsaved = () => maybeEditorService()?.dirtyDocumentIds?.().length ?? 0;

function notifyLost(host: string, error?: unknown, takenOver = false) {
  notifications().notify({
    key: KEY,
    group: "remote",
    level: takenOver ? "warning" : "error",
    title: takenOver ? tx("Another window took over this remote session") : tx`Lost the connection to ${host}`,
    body:
      error !== undefined
        ? errorText(error)
        : takenOver
          ? tx`Your project is still running on ${host}. This window will not reconnect automatically.`
          : undefined,
    actions: [{ label: tx("Reconnect"), run: () => void reconnectNow() }],
  });
}

/** Reconnect to Remote Host: asks first when reopening the project would drop unsaved edits. */
export async function reconnectNow(): Promise<void> {
  const { lost, reconnecting, takenOver } = useRemote.getState();
  if (!lost || reconnecting) return;
  const count = unsaved();
  if (
    (takenOver || count > 0) &&
    !(await confirm({
      title: tx("Reconnect to Remote Host"),
      message: takenOver
        ? count > 0
          ? tx`Reconnecting disconnects the other window. Unsaved edits in ${count} files in this window may be lost.`
          : tx("Reconnecting takes over the remote session and disconnects the other window.")
        : tx`Reconnecting opens the project again. Unsaved changes in ${count} files can't be saved to ${lost} and will be lost.`,
      ok: tx("Reconnect"),
      icon: "warning",
    }))
  )
    return;
  generation++;
  notifications().expire?.(KEY);
  try {
    await reconnectRemote();
  } catch (e) {
    notifyLost(lost, e, takenOver);
  }
}

async function retry(host: string, run: number, wait: (ms: number) => Promise<void>) {
  // Reopening the project would drop edits that can no longer be saved: leave that to the user.
  if (unsaved() > 0) return notifyLost(host);
  let last: unknown;
  for (const ms of RETRY_DELAYS_MS) {
    // oxlint-disable-next-line no-await-in-loop -- each delay precedes its attempt; generation and unsaved state are rechecked only after the wait.
    await wait(ms);
    if (run !== generation || useRemote.getState().lost !== host) return;
    // Edited while waiting: the same applies.
    if (unsaved() > 0) return notifyLost(host, last);
    try {
      // oxlint-disable-next-line no-await-in-loop -- an attempt must finish and fail before the next delayed retry; success returns immediately.
      await reconnectRemote();
      return;
    } catch (e) {
      last = e;
    }
  }
  if (run === generation) notifyLost(host, last);
}

export function installReconnect(
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): () => void {
  const offEvent = onIdeEvent("remoteConnectionLost", (e) => {
    const state = useRemote.getState();
    if (state.session?.host !== e.host || state.takenOver) return;
    const takenOver = e.takenOver === true;
    ++generation;
    useRemote.setState({ lost: e.host, takenOver });
    if (!takenOver) void retry(e.host, generation, wait);
  });
  const sync = (s: ReturnType<typeof useRemote.getState>, prev?: ReturnType<typeof useRemote.getState>) => {
    if (s.lost !== prev?.lost) setContext("remoteConnectionLost", s.lost !== null);
    if (s.lost && s.takenOver && (!prev?.takenOver || s.lost !== prev.lost)) notifyLost(s.lost, undefined, true);
  };
  sync(useRemote.getState());
  const offState = useRemote.subscribe(sync);
  return () => {
    generation++;
    offEvent();
    offState();
  };
}
