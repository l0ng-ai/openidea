import { useEffect, useState } from "react";
import type { Commit, LogDetails } from "@/bindings";
import { call, commands, nextRequestId, type RequestId } from "@/platform/ipc";
import { commitRepo } from "./multiRoot";
import { currentRepo, useVcs } from "./store";
import { create } from "zustand";

const refVersions = create<Record<string, number>>(() => ({}));
export function invalidateLogDetails(roots: readonly string[]) {
  refVersions.setState((s) => Object.fromEntries(roots.map((root) => [root, (s[root] ?? 0) + 1])));
}

interface Entry {
  key: string;
  repo: string | null;
  id: string;
  promise: Promise<LogDetails>;
  resolve: (details: LogDetails) => void;
  reject: (error: unknown) => void;
  users: number;
  request?: RequestId;
  settled: boolean;
}
const cache = new Map<string, Entry>();
const pending: Entry[] = [];
const batches = new Map<RequestId, Entry[]>();
let scheduled = false;
let running = 0;

function forget(entry: Entry) {
  if (cache.get(entry.key) === entry) cache.delete(entry.key);
}

function flush() {
  scheduled = false;
  while (pending.length && running < 4) {
    const first = pending.shift()!;
    if (!first.users) {
      forget(first);
      first.reject(new Error("Commit details request cancelled"));
      continue;
    }
    const entries = [first];
    for (let i = 0; i < pending.length && entries.length < 64;) {
      if (!pending[i]!.users) {
        const cancelled = pending.splice(i, 1)[0]!;
        forget(cancelled);
        cancelled.reject(new Error("Commit details request cancelled"));
      } else if (pending[i]!.repo === first.repo) entries.push(...pending.splice(i, 1));
      else i++;
    }
    const request = nextRequestId();
    entries.forEach((entry) => {
      entry.request = request;
    });
    batches.set(request, entries);
    running++;
    void call(
      commands.vcsLogDetailsBatch(
        first.repo,
        entries.map((e) => e.id),
        request,
      ),
    )
      .then(
        (details) =>
          entries.forEach((entry, i) => {
            if (details[i]) {
              entry.settled = true;
              entry.resolve(details[i]!);
            } else {
              forget(entry);
              entry.reject(new Error("Commit details were not returned"));
            }
          }),
        (error) =>
          entries.forEach((entry) => {
            forget(entry);
            entry.reject(error);
          }),
      )
      .finally(() => {
        running--;
        batches.delete(request);
        flush();
      });
  }
}

/** Batches visible rows by root. Ref-dependent fields refresh on version changes;
 * the backend caches immutable messages and signatures independently. */
export function loadLogDetails(commit: Commit, signal?: AbortSignal): Promise<LogDetails> {
  const repo = commitRepo(commit) ?? currentRepo();
  const key = `${repo}\0${commit.id}\0${useVcs.getState().version}\0${refVersions.getState()[repo ?? ""] ?? 0}`;
  let entry = cache.get(key);
  if (!entry) {
    let resolve!: Entry["resolve"], reject!: Entry["reject"];
    const promise = new Promise<LogDetails>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    entry = { key, repo, id: commit.id, promise, resolve, reject, users: 0, settled: false };
    if (cache.size >= 10000) cache.delete(cache.keys().next().value!);
    cache.set(key, entry);
    pending.push(entry);
  }
  entry.users++;
  const own = entry;
  const abort = () => {
    own.users = Math.max(0, own.users - 1);
    if (!own.settled && !own.users) forget(own);
    if (own.settled || !own.request) return;
    const batch = batches.get(own.request);
    if (batch?.every((e) => !e.users)) void commands.cancelRequest(own.request).catch(() => undefined);
  };
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  if (!scheduled) {
    scheduled = true;
    queueMicrotask(flush);
  }
  return entry.promise;
}

export function useCommitDetails(commit: Commit, enabled = true) {
  const version = useVcs((s) => s.version);
  const repo = commitRepo(commit) ?? currentRepo();
  const refs = refVersions((s) => s[repo ?? ""] ?? 0);
  const key = `${repo}\0${commit.id}\0${version}\0${refs}`;
  const [result, setResult] = useState<{ key: string; details: LogDetails | null; error: boolean } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void loadLogDetails(commit, controller.signal)
      .then((details) => {
        if (!controller.signal.aborted) setResult({ key, details, error: false });
      })
      .catch(() => {
        if (!controller.signal.aborted) setResult({ key, details: null, error: true });
      });
    return () => controller.abort();
  }, [commit, key, enabled, version]);
  return { details: result?.key === key ? result.details : null, error: result?.key === key && result.error };
}
