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

function notifyLost(host: string, error?: unknown) {
  notifications().notify({
    key: KEY,
    group: "remote",
    level: "error",
    title: tx`Lost the connection to ${host}`,
    body: error === undefined ? undefined : errorText(error),
    actions: [{ label: tx("Reconnect"), run: () => void reconnectNow() }],
  });
}

/** Reconnect to Remote Host: asks first when reopening the project would drop unsaved edits. */
export async function reconnectNow(): Promise<void> {
  const { lost, reconnecting } = useRemote.getState();
  if (!lost || reconnecting) return;
  const count = unsaved();
  if (
    count > 0 &&
    !(await confirm({
      title: tx("Reconnect to Remote Host"),
      message: tx`Reconnecting opens the project again. Unsaved changes in ${count} files can't be saved to ${lost} and will be lost.`,
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
    notifyLost(lost, e);
  }
}

async function retry(host: string, run: number, wait: (ms: number) => Promise<void>) {
  // Reopening the project would drop edits that can no longer be saved: leave that to the user.
  if (unsaved() > 0) return notifyLost(host);
  let last: unknown;
  for (const ms of RETRY_DELAYS_MS) {
    await wait(ms);
    if (run !== generation || useRemote.getState().lost !== host) return;
    // Edited while waiting: the same applies.
    if (unsaved() > 0) return notifyLost(host, last);
    try {
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
    if (!useRemote.getState().session) return;
    useRemote.setState({ lost: e.host });
    void retry(e.host, ++generation, wait);
  });
  const offState = useRemote.subscribe((s, prev) => {
    if (s.lost !== prev.lost) setContext("remoteConnectionLost", s.lost !== null);
  });
  return () => {
    generation++;
    offEvent();
    offState();
  };
}
