/** Fetch rollups only for mounted log rows. Each GraphQL batch is scoped to one Git root. */
import { call, commands } from "@/platform/ipc";
import { graphql, repoVariables } from "../api/client";
import type { GHCommitStatusContextState, GHRepositoryCoordinates } from "../api/types";
import { githubRemotes } from "./repository";

type Target = GHRepositoryCoordinates & { root: string };
export interface LogCommitCheck {
  state: GHCommitStatusContextState;
  target: Target;
}

const BATCH_SIZE = 20;
const CACHE_SIZE = 2_000;
const REMOTE_TTL = 5 * 60_000;
const remoteCache = new Map<string, { targets: Target[]; expires: number }>();

async function targets(root: string): Promise<Target[]> {
  const previous = remoteCache.get(root);
  if (previous && previous.expires > Date.now()) return previous.targets;
  const remotes = githubRemotes(await call(commands.vcsRemotes(root)).catch(() => []), root);
  remotes.sort((a, b) => Number(b.remote === "origin") - Number(a.remote === "origin"));
  const resolved = remotes.map(({ owner, name }) => ({ owner, name, root }));
  if (remoteCache.size >= 128) remoteCache.delete(remoteCache.keys().next().value!);
  remoteCache.set(root, { targets: resolved, expires: Date.now() + REMOTE_TTL });
  return resolved;
}

async function queryBatch(target: Target, revisions: string[]) {
  const fields = revisions
    .map((_, i) => `c${i}: object(oid: $oid${i}) { ... on Commit { statusCheckRollup { state } } }`)
    .join("\n");
  const params = revisions.map((_, i) => `$oid${i}: GitObjectID!`).join(", ");
  const doc = `query($repoOwner: String!, $repoName: String!, ${params}) {
    repository(owner: $repoOwner, name: $repoName) { ${fields} }
  }`;
  const variables = Object.fromEntries(revisions.map((oid, i) => [`oid${i}`, oid]));
  const data = await graphql<{
    repository: Record<string, { statusCheckRollup: { state: GHCommitStatusContextState } | null } | null> | null;
  }>(doc, { ...repoVariables(target), ...variables }, target.root);
  return revisions.map((_, i) => data.repository?.[`c${i}`]?.statusCheckRollup?.state ?? null);
}

interface CachedCheck {
  check: LogCommitCheck | null;
  expires: number;
}

type Listener = (result: CachedCheck) => void;
interface Request {
  key: string;
  root: string;
  revision: string;
  listeners: Set<Listener>;
  started: boolean;
}

const cache = new Map<string, CachedCheck>();
const requests = new Map<string, Request>();
let scheduled: ReturnType<typeof setTimeout> | undefined;
let running = false;

function isPendingCheck(check: LogCommitCheck | null): boolean {
  return check?.state === "PENDING" || check?.state === "EXPECTED";
}

function schedule() {
  if (running || scheduled !== undefined || !requests.size) return;
  scheduled = setTimeout(() => {
    scheduled = undefined;
    void flush();
  }, 40);
}

async function flush() {
  const first = requests.values().next().value;
  if (!first) return;
  const batch = [...requests.values()].filter((r) => r.root === first.root).slice(0, BATCH_SIZE);
  batch.forEach((r) => (r.started = true));
  running = true;
  const results = new Map<string, LogCommitCheck>();
  try {
    // Checks on an upstream can be absent from a fork, even when it contains the same commit.
    for (const target of await targets(first.root)) {
      const remaining = batch.filter((r) => r.listeners.size && !results.has(r.revision));
      if (!remaining.length) break;
      const states = await queryBatch(
        target,
        remaining.map((r) => r.revision),
      ).catch(() => []);
      remaining.forEach(({ revision }, i) => {
        const state = states[i];
        if (state) results.set(revision, { state, target });
      });
    }
  } finally {
    for (const r of batch) {
      requests.delete(r.key);
      const check = results.get(r.revision) ?? null;
      if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value!);
      const ttl = isPendingCheck(check) ? 30_000 : check ? 5 * 60_000 : 60_000;
      const result = { check, expires: Date.now() + ttl };
      cache.set(r.key, result);
      r.listeners.forEach((listener) => listener(result));
    }
    running = false;
    schedule();
  }
}

export function watchLogCommitCheck(root: string, revision: string, listener: Listener): () => void {
  const key = `${root}\0${revision}`;
  const previous = cache.get(key);
  if (previous && previous.expires > Date.now()) {
    listener(previous);
    return () => {};
  }
  cache.delete(key);
  const request = requests.get(key) ?? { key, root, revision, listeners: new Set<Listener>(), started: false };
  request.listeners.add(listener);
  requests.set(key, request);
  schedule();
  return () => {
    request.listeners.delete(listener);
    if (!request.started && !request.listeners.size) requests.delete(key);
  };
}
