import { useEffect, useMemo, useState } from "react";
import type { DiffEntry, DiffEntryRequest } from "@/bindings";
import { tx } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import { diffSideSource, sideLabel, type DiffData, type DiffSide } from "./diffInput";
import { stagingVersions } from "./stagingVersions";
import { statusOf, useVcs } from "./store";

export const GITLINK_MODE = "160000";

export async function loadDiffEntries(entries: DiffEntryRequest[]): Promise<(DiffEntry | null)[] | null> {
  try {
    const result = await call(commands.vcsDiffEntries(entries));
    return Array.isArray(result) && result.length === entries.length ? result : null;
  } catch {
    return null;
  }
}

function request(path: string, side: DiffSide | undefined): DiffEntryRequest | null {
  if (side?.type === "rev") return { path: side.path ?? path, rev: side.rev };
  if (side?.type === "worktree") return { path, rev: "WT" };
  return null;
}

function resolveSide(side: DiffSide, entry: DiffEntry | null | undefined): DiffSide {
  if (entry?.mode !== GITLINK_MODE || (side.type !== "rev" && side.type !== "worktree")) return side;
  return {
    type: "text",
    text: entry.gitlink ?? "",
    label: sideLabel(side),
    labelDetail: entry.gitlink === null ? tx("Submodule checkout unavailable") : undefined,
    absent: entry.gitlink === null,
    gitlinkSource: side,
  };
}

async function entriesFor(requests: (DiffEntryRequest | null)[]) {
  const requested = requests.filter((entry) => entry !== null);
  if (!requested.length) return null;
  const result = await loadDiffEntries(requested);
  let index = 0;
  return result && requests.map((entry) => (entry ? result[index++]! : null));
}

export async function gitlinkDiffSides(data: DiffData): Promise<[DiffSide, DiffSide]> {
  const sides = [diffSideSource(data.left), diffSideSource(data.right)] as const;
  const entries = await entriesFor(sides.map((side) => request(data.path, side)));
  return entries ? [resolveSide(sides[0], entries[0]), resolveSide(sides[1], entries[1])] : [data.left, data.right];
}

/** Loaded entries by query, for a host that mounts the same diffs again (the all-in-one diff's blocks). */
export type DiffEntriesCache = Map<string, { version: number; entries: (DiffEntry | null)[] }>;

export function useGitDiffEntries(data: DiffData, cache?: DiffEntriesCache) {
  const version = useVcs((s) => s.version);
  const status = data.middle && statusOf(data.path);
  const versions = useMemo(() => (status ? stagingVersions(status) : undefined), [status]);
  const current = versions ?? data;
  const left = diffSideSource(current.left);
  const middle = current.middle && diffSideSource(current.middle);
  const right = diffSideSource(current.right);
  const requests = [request(data.path, left), request(data.path, middle), request(data.path, right)];
  const query = requests.some(Boolean) ? JSON.stringify(requests) : "";
  const hit = query ? cache?.get(query) : undefined;
  const cached = hit?.version === version ? hit.entries : undefined;
  const [loaded, setLoaded] = useState<{ query: string; entries: (DiffEntry | null)[] | null }>();
  useEffect(() => {
    if (!query || cache?.get(query)?.version === version) return;
    let alive = true;
    const requests = JSON.parse(query) as (DiffEntryRequest | null)[];
    void entriesFor(requests).then((entries) => {
      if (entries && cache && useVcs.getState().version === version) cache.set(query, { version, entries });
      if (alive) setLoaded({ query, entries });
    });
    return () => {
      alive = false;
    };
  }, [query, version, cache]);
  // While a repository change reloads them, the entries of the last version stay shown.
  const entries = cached ?? (loaded?.query === query ? loaded.entries : (hit?.entries ?? null));
  const resolved = useMemo(() => {
    if (!entries?.some((entry) => entry?.mode === GITLINK_MODE)) return data;
    return {
      ...data,
      left: resolveSide(left, entries[0]),
      middle: middle && resolveSide(middle, entries[1]),
      right: resolveSide(right, entries[2]),
    };
  }, [data, entries, left, middle, right]);
  return { data: resolved, entries, loading: !!query && !hit && loaded?.query !== query };
}
