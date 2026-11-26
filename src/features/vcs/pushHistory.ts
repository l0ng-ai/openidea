import { remoteLocation, useRemote } from "@/platform/remote";

const KEY = "openidea.vcs.recentPushTargets:";
const MAX_ENTRIES = 10;

interface Entry {
  source: string;
  remote: string;
  target: string;
}

export function pushHistoryRepo(root: string): string {
  const session = useRemote.getState().session;
  return session ? remoteLocation(session.target, root) : root;
}

function read(repo: string): Entry[] {
  try {
    const entries: unknown = JSON.parse(localStorage.getItem(KEY + repo) ?? "[]");
    if (Array.isArray(entries)) {
      return entries.filter(
        (entry): entry is Entry =>
          typeof entry?.source === "string" && typeof entry.remote === "string" && typeof entry.target === "string",
      );
    }
  } catch {
    // An unavailable or malformed preference does not affect pushing.
  }
  return [];
}

export function recentPushTargets(root: string | null, source: string | null, remote: string | null): string[] {
  if (!root || !source || !remote) return [];
  return read(pushHistoryRepo(root))
    .filter((entry) => entry.source === source && entry.remote === remote)
    .map((entry) => entry.target);
}

export function rememberPushTarget(repo: string, entry: Entry): void {
  const entries = read(repo).filter(
    (old) => old.source !== entry.source || old.remote !== entry.remote || old.target !== entry.target,
  );
  try {
    localStorage.setItem(KEY + repo, JSON.stringify([entry, ...entries].slice(0, MAX_ENTRIES)));
  } catch {
    // Preference storage may be unavailable.
  }
}
