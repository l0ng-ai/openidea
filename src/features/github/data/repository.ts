/**
 * The project's GitHub connection and repository data, like IntelliJ's `GHPRProjectViewModel`
 * (repository selection, auto-connect) plus `GHPRRepositoryDataService` and
 * `GHPRSecurityService`: gh availability, the GitHub remotes, the connected repository
 * (permission, merge settings, default branch), the current user, and the cached,
 * incrementally loaded collaborators, contributors, assignees, labels, teams and
 * mentionable users.
 *
 * Auto-connect: a project with one GitHub remote connects at once; with several, the
 * repository chosen last (saved per project) is used, else the selector is shown. The
 * remotes come from every git repository of the project (a folder holding several
 * repositories offers each one's), and gh runs in the repository of the connected remote.
 */
import { useEffect } from "react";
import { create } from "zustand";
import type { GhAvailability, Remote } from "@/platform/ipc";
import { call, commands, isTauri } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { errorMessage, setCurrentRepository } from "../api/client";
import * as api from "../api/requests";
import type {
  GHCollaborator,
  GHLabel,
  GHPullRequestRequestedReviewer,
  GHRepository,
  GHRepositoryCoordinates,
  GHRepositoryPermissionLevel,
  GHTeam,
  GHUser,
} from "../api/types";
import { createBatchesLoader, mergeBatches, type BatchesLoader, type BatchesState } from "./batches";
import { hasPermission, parseGitHubRemote, remoteOfRepository } from "./model";

/** A GitHub remote of the project. */
export interface GHRemote extends GHRepositoryCoordinates {
  /** Git remote name (`origin`). */
  remote: string;
  url: string;
  /** Root of the project's git repository the remote belongs to (null or absent: the primary one). */
  root?: string | null;
}

export interface GHConnection {
  coordinates: GHRepositoryCoordinates;
  repository: GHRepository;
  currentUser: GHUser;
  /** The local repository checkouts, diffs and new pull requests use (null: the primary one). */
  root: string | null;
  /** That repository's GitHub remotes. */
  remotes: GHRemote[];
}

interface RepositoryState {
  /** gh's state; null until checked. */
  availability: GhAvailability | null;
  checking: boolean;
  /** GitHub remotes of the project, deduplicated by repository. */
  remotes: GHRemote[];
  /** gh's own choice among them (`gh repo view`), preselected in the selector. */
  defaultRemote: GHRepositoryCoordinates | null;
  connection: GHConnection | null;
  connecting: boolean;
  /** "Could not connect to repository …" */
  connectionError: string | null;
  /** Bumped whenever the repository data is reloaded (IntelliJ's `dataReloadSignal`). */
  revision: number;
}

export const useGhRepository = create<RepositoryState>(() => ({
  availability: null,
  checking: false,
  remotes: [],
  defaultRemote: null,
  connection: null,
  connecting: false,
  connectionError: null,
  revision: 0,
}));

const projectRoot = () => useProject.getState().project?.root ?? null;
const selectionKey = (root: string) => `openidea.github.repository.v1:${root}`;

function loadSelection(root: string | null): string | null {
  if (!root) return null;
  try {
    return globalThis.localStorage?.getItem(selectionKey(root)) ?? null;
  } catch {
    return null;
  }
}

function saveSelection(root: string | null, nameWithOwner: string | null) {
  if (!root) return;
  try {
    if (nameWithOwner) globalThis.localStorage?.setItem(selectionKey(root), nameWithOwner);
    else globalThis.localStorage?.removeItem(selectionKey(root));
  } catch {
    /* storage unavailable */
  }
}

export const sameRepository = (a: GHRepositoryCoordinates | null | undefined, b: GHRepositoryCoordinates | null) =>
  !!a && !!b && a.owner.toLowerCase() === b.owner.toLowerCase() && a.name.toLowerCase() === b.name.toLowerCase();

export const nameWithOwner = (r: GHRepositoryCoordinates) => `${r.owner}/${r.name}`;

/** The GitHub remotes among `remotes` of the repository at `root`, one per GitHub repository. */
export function githubRemotes(
  remotes: ReadonlyArray<{ name: string; url: string }>,
  root: string | null = null,
): GHRemote[] {
  const out: GHRemote[] = [];
  for (const r of remotes) {
    const c = parseGitHubRemote(r.url);
    if (c && !out.some((o) => sameRepository(o, c))) out.push({ ...c, remote: r.name, url: r.url, root });
  }
  return out;
}

/** The GitHub repositories of several local repositories' remotes, each once (the first local repository's). */
function uniqueRepositories(remotes: readonly GHRemote[]): GHRemote[] {
  return remotes.filter((r, i) => remotes.findIndex((o) => sameRepository(o, r)) === i);
}

/** The connected local repository's GitHub remotes (none while disconnected). */
export const NO_REMOTES: readonly GHRemote[] = [];
export const connectedRemotes = (): readonly GHRemote[] => useGhRepository.getState().connection?.remotes ?? NO_REMOTES;

/** The local repository of the connection, for gh and git commands (null: the primary one). */
export const connectedRoot = (): string | null => useGhRepository.getState().connection?.root ?? null;

function parseNameWithOwner(s: string | null | undefined): GHRepositoryCoordinates | null {
  const m = s ? /^([^/\s]+)\/([^/\s]+)$/.exec(s) : null;
  return m ? { owner: m[1]!, name: m[2]! } : null;
}

let checkSeq = 0;
/** GitHub remotes of every local repository (a GitHub repository can be a remote of several). */
let localRemotes: GHRemote[] = [];

async function projectGitHubRemotes(): Promise<{ remotes: GHRemote[]; all: Map<string | null, Remote[]> }> {
  const roots = await call(commands.vcsRoots()).catch(() => []);
  const dirs: Array<string | null> = roots.length ? roots.map((r) => String(r.root)) : [null];
  const lists = await Promise.all(
    dirs.map(async (root) => ({ root, remotes: await call(commands.vcsRemotes(root)).catch(() => [] as Remote[]) })),
  );
  return {
    remotes: lists.flatMap((l) => githubRemotes(l.remotes, l.root)),
    all: new Map(lists.map((l) => [l.root, l.remotes])),
  };
}

/**
 * Checks gh and the remotes, then connects as IntelliJ does on start: the only GitHub
 * repository, else the saved choice. Keeps the current connection when it still applies.
 */
export async function refreshConnection(): Promise<void> {
  if (!isTauri()) return;
  const seq = ++checkSeq;
  useGhRepository.setState({ checking: true });
  let availability: GhAvailability;
  const found = await projectGitHubRemotes();
  if (seq !== checkSeq) return;
  const current = useGhRepository.getState().connection?.coordinates ?? null;
  const saved = parseNameWithOwner(loadSelection(projectRoot()));
  // gh resolves its repository in a local one; ask in the one likely to be connected.
  const probe =
    (
      found.remotes.find((r) => sameRepository(r, current)) ??
      found.remotes.find((r) => sameRepository(r, saved)) ??
      found.remotes[0]
    )?.root ?? null;
  try {
    availability = await call(commands.ghAvailability(probe));
  } catch (e) {
    availability = { kind: "error", message: errorMessage(e) };
  }
  if (seq !== checkSeq) return;
  localRemotes = found.remotes;
  const remotes = uniqueRepositories(localRemotes);
  const defaultRemote = availability.kind === "ready" ? parseNameWithOwner(availability.repo.nameWithOwner) : null;
  if (defaultRemote && !remotes.some((r) => sameRepository(r, defaultRemote))) {
    const own = remoteOfRepository(found.all.get(probe) ?? [], defaultRemote);
    const remote = {
      ...defaultRemote,
      remote: own?.name ?? "",
      url: own?.url ?? (availability.kind === "ready" ? availability.repo.url : ""),
      root: probe,
    };
    remotes.unshift(remote);
    localRemotes = [remote, ...localRemotes];
  }
  useGhRepository.setState({ availability, remotes, defaultRemote, checking: false });
  if (availability.kind !== "ready") {
    disconnect({ forget: false });
    return;
  }
  const target =
    remotes.length === 1
      ? remotes[0]!
      : (remotes.find((r) => sameRepository(r, current)) ?? remotes.find((r) => sameRepository(r, saved)) ?? null);
  // Only a choice among several repositories is remembered.
  if (target) await connect(target, { remember: remotes.length > 1 });
  else disconnect({ forget: false });
}

let connectSeq = 0;

/**
 * Connects to `repo` (the selector's "View Pull Requests"), remembering the choice; gh and git
 * then run in `repo.root`, else in the first local repository with it as a remote.
 */
export async function connect(
  repo: GHRepositoryCoordinates & { root?: string | null },
  opts: { remember?: boolean } = {},
): Promise<boolean> {
  const seq = ++connectSeq;
  const coordinates = { owner: repo.owner, name: repo.name };
  const root = repo.root !== undefined ? repo.root : (localRemotes.find((r) => sameRepository(r, repo))?.root ?? null);
  const remotes = localRemotes.filter((r) => (r.root ?? null) === root);
  useGhRepository.setState({ connecting: true, connectionError: null });
  try {
    const [repository, currentUser] = await Promise.all([api.findRepository(coordinates), api.currentUser()]);
    if (seq !== connectSeq) return false;
    if (!repository) throw new Error(`Repository ${nameWithOwner(coordinates)} not found`);
    const previous = useGhRepository.getState().connection;
    if (!sameRepository(previous?.coordinates, coordinates) || previous?.root !== root) resetRepositoryData();
    setCurrentRepository({ ...coordinates, id: repository.id, root });
    useGhRepository.setState((s) => ({
      connection: { coordinates, repository, currentUser, root, remotes },
      connecting: false,
      revision: s.revision + 1,
    }));
    if (opts.remember ?? true) saveSelection(projectRoot(), nameWithOwner(coordinates));
    return true;
  } catch (e) {
    if (seq !== connectSeq) return false;
    useGhRepository.setState({
      connecting: false,
      connectionError: `Could not connect to repository ${nameWithOwner(coordinates)}: ${errorMessage(e)}`,
    });
    return false;
  }
}

/** Drops the connection; `forget` also clears the saved choice ("Change Repository or Account…"). */
export function disconnect({ forget }: { forget: boolean }) {
  connectSeq++;
  if (forget) saveSelection(projectRoot(), null);
  if (!useGhRepository.getState().connection && !useGhRepository.getState().connecting) return;
  setCurrentRepository(null);
  resetRepositoryData();
  useGhRepository.setState({ connection: null, connecting: false });
}

/** Another project: start over (the next `refreshConnection` checks again). */
export function resetConnection() {
  checkSeq++;
  disconnect({ forget: false });
  useGhRepository.setState({ availability: null, remotes: [], defaultRemote: null, connectionError: null });
}

/** The connection, or throws (for operations that only run while connected). */
export function requireConnection(): GHConnection {
  const c = useGhRepository.getState().connection;
  if (!c) throw new Error("Not connected to a GitHub repository");
  return c;
}

/** `GHPRSecurityService.currentUserHasPermissionLevel`. */
export function currentUserHasPermission(level: GHRepositoryPermissionLevel): boolean {
  return hasPermission(useGhRepository.getState().connection?.repository.viewerPermission, level);
}

/**
 * Whether `user` is the signed-in user (by node id, else login).
 * @public
 */
export function isCurrentUser(user: { id?: string; login?: string } | null | undefined): boolean {
  const me = useGhRepository.getState().connection?.currentUser;
  return !!me && !!user && (user.id ? user.id === me.id : user.login === me.login);
}

/**
 * Reloads the repository (permission, merge settings) and drops the cached lists.
 * @public
 */
export async function reloadRepositoryData(): Promise<void> {
  const c = useGhRepository.getState().connection;
  resetRepositoryData();
  if (c) await connect({ ...c.coordinates, root: c.root });
}

// ---------------------------------------------------------------------------
// Cached lists

type Cursor = { after: string | null };
const FIRST: Cursor = { after: null };

function gqlPage<T>(fetch: (cursor: string | null) => ReturnType<typeof api.mentionableUsersPage>) {
  return async (c: Cursor) => {
    const page = (await fetch(c.after)) as {
      nodes: T[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    } | null;
    if (!page) return { items: [] as T[], next: null };
    return {
      items: page.nodes,
      next: page.pageInfo.hasNextPage && page.pageInfo.endCursor ? { after: page.pageInfo.endCursor } : null,
    };
  };
}

const loaders = {
  collaborators: createBatchesLoader<GHCollaborator, number>(1, (p) => api.collaboratorsPage(p)),
  contributors: createBatchesLoader<GHUser, number>(1, (p) => api.contributorsPage(p)),
  assignees: createBatchesLoader<GHUser, number>(1, (p) => api.assigneesPage(p)),
  labels: createBatchesLoader<GHLabel, number>(1, (p) => api.labelsPage(p)),
  mentionableUsers: createBatchesLoader<GHUser, Cursor>(FIRST, gqlPage<GHUser>(api.mentionableUsersPage)),
  teams: createBatchesLoader<GHTeam, Cursor>(FIRST, async (c) => {
    const repo = useGhRepository.getState().connection?.repository;
    // Teams exist for organizations only; listing them needs `read:org`, which gh may lack.
    if (repo?.owner.__typename !== "Organization") return { items: [], next: null };
    const page = await api.organizationTeamsPage(repo.owner.login, c.after).catch(() => null);
    if (!page) return { items: [], next: null };
    return {
      items: page.nodes,
      next: page.pageInfo.hasNextPage && page.pageInfo.endCursor ? { after: page.pageInfo.endCursor } : null,
    };
  }),
} satisfies Record<string, BatchesLoader<unknown>>;

export type RepositoryListName = keyof typeof loaders;
type ItemOf<K extends RepositoryListName> = (typeof loaders)[K] extends BatchesLoader<infer T> ? T : never;

let template: Promise<string | null> | null = null;

function resetRepositoryData() {
  for (const l of Object.values(loaders)) l.reset();
  template = null;
}

/**
 * Loads (once) one of the repository lists; resolves with all its items.
 * @public
 */
export function loadRepositoryList<K extends RepositoryListName>(name: K): Promise<ItemOf<K>[]> {
  return (loaders[name] as BatchesLoader<ItemOf<K>>).load();
}

/** React hook: a repository list, loading it on first use (incremental: items grow while `loading`). */
export function useRepositoryList<K extends RepositoryListName>(name: K): BatchesState<ItemOf<K>> {
  const loader = loaders[name] as BatchesLoader<ItemOf<K>>;
  const connected = useGhRepository((s) => !!s.connection);
  useEffect(() => {
    if (connected) void loader.load().catch(() => undefined);
  }, [loader, connected]);
  return loader.store();
}

/**
 * Users that can be chosen as authors in the list filter: collaborators with write
 * access, else contributors (users without push access cannot list collaborators).
 */
export function useAuthorCandidates(): BatchesState<GHUser> {
  const write = useGhRepository((s) => hasPermission(s.connection?.repository.viewerPermission, "WRITE"));
  const collaborators = useRepositoryList(write ? "collaborators" : "contributors");
  return collaborators;
}

/**
 * Potential reviewers (`getBatchedPotentialReviewers`): teams, then collaborators with push (else contributors).
 */
export function usePotentialReviewers(): BatchesState<GHPullRequestRequestedReviewer> {
  const write = useGhRepository((s) => hasPermission(s.connection?.repository.viewerPermission, "WRITE"));
  const teams = useRepositoryList("teams");
  const users = useRepositoryList(write ? "collaborators" : "contributors");
  const pushers = write
    ? { ...users, items: (users.items as GHCollaborator[]).filter((u) => u.permissions.push) }
    : users;
  return mergeBatches<GHPullRequestRequestedReviewer>([teams, pushers]);
}

/**
 * The first non-blank pull request template of the repository (cached).
 */
export function loadPullRequestTemplate(): Promise<string | null> {
  template ??= api
    .pullRequestTemplates()
    .then((ts) => ts.find((t) => t.body?.trim())?.body ?? null)
    .catch(() => null);
  return template;
}
