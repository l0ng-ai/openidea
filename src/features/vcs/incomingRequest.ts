import { Channel } from "@tauri-apps/api/core";
import type { FetchReport, IncomingRefsReport, RequestId } from "@/bindings";
import { call, commands, nextRequestId } from "@/platform/ipc";

let active: { request: RequestId; done: Promise<unknown>; cancelling: boolean } | null = null;

function trackIncoming<T>(invoke: (request: RequestId) => Promise<T>): Promise<T> {
  const request = nextRequestId();
  const done = invoke(request).finally(() => {
    if (active?.request === request) active = null;
  });
  active = { request, done, cancelling: false };
  return done;
}

export function fetchIncomingRemotes(repo: string, skipRemotes: string[]): Promise<FetchReport | null> {
  const channel = new Channel<string>(() => undefined);
  return trackIncoming(async (request) => {
    const report = await call(
      commands.vcsRemote(repo, request, { op: "fetch", background: true, report: true, skipRemotes }, channel, null),
    );
    return report && "remotes" in report ? report : null;
  });
}

export function inspectIncomingRefs(repo: string): Promise<IncomingRefsReport> {
  return trackIncoming((request) => call(commands.vcsCheckIncoming(repo, request)));
}

export function cancelIncomingCheck(): Promise<void> | undefined {
  if (!active) return;
  if (!active.cancelling) {
    active.cancelling = true;
    void commands.cancelRequest(active.request).catch(() => undefined);
  }
  // The foreground may write the same refs and FETCH_HEAD. Wait for Git to exit.
  return active.done.then(
    () => undefined,
    () => undefined,
  );
}
