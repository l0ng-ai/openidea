/** Recent projects: loading, filtering, opening and removal. */
import { create } from "zustand";
import { executeAction, getAction } from "@/platform/actions";
import { commands, IpcError, isCancelled, isTauri, type RecentProject, type RecentProjectGroup } from "@/platform/ipc";
import { openProject, useProject } from "@/platform/project";
import { connectRemote, forgetRemote, parseRemoteLocation, recentRemotes, remoteLocation } from "@/platform/remote";
import { tx } from "@/platform/i18n";
import { fuzzyMatch } from "@/ui";
import { notifications } from "@/workbench/contributions";
import { openRemoteProject } from "@/workbench/projectWindow";

interface RecentState {
  projects: RecentProject[];
  /** Project groups (New Project Group…), shown above the ungrouped projects. */
  groups: RecentProjectGroup[];
  loaded: boolean;
  home: string | null;
  version: string | null;
  /** Path currently being opened from the list. */
  opening: string | null;
}

export const useRecent = create<RecentState>(() => ({
  projects: [],
  groups: [],
  loaded: false,
  home: null,
  version: null,
  opening: null,
}));

const SAMPLE: RecentProject[] = [
  {
    path: "/Users/dev/dev/acme-api",
    name: "acme-api",
    openedAtMs: Date.now() - 3_600_000,
    branch: "feature/order-paging",
  },
  { path: "/Users/dev/dev/openidea", name: "openidea", openedAtMs: Date.now() - 86_400_000, branch: "main" },
  { path: "/Users/dev/oss/tokio", name: "tokio", openedAtMs: Date.now() - 5 * 86_400_000, branch: "master" },
  { path: "/Users/dev/scratch/py-notes", name: "py-notes", openedAtMs: null, branch: null },
];

export async function loadRecent() {
  if (!isTauri()) {
    useRecent.setState({ projects: SAMPLE, loaded: true, home: "/Users/dev", version: "0.1.0-dev" });
    return;
  }
  const [projects, groups, info, home] = await Promise.all([
    commands.recentProjects().catch(() => [] as RecentProject[]),
    commands.recentProjectGroups().catch(() => [] as RecentProjectGroup[]),
    commands.appInfo().catch(() => null),
    import("@tauri-apps/api/path").then((m) => m.homeDir()).catch(() => null),
  ]);
  useRecent.setState({
    projects: withRemotes(projects),
    groups,
    loaded: true,
    version: info?.version ?? useRecent.getState().version,
    home: home ? home.replace(/\/+$/, "") : useRecent.getState().home,
  });
}

/** The recent remote projects (Remote Development) among the local ones, most recent first. */
function withRemotes(local: RecentProject[]): RecentProject[] {
  const remote: RecentProject[] = recentRemotes().map((r) => ({
    path: remoteLocation(r.sshConfig, r.path),
    name: r.name,
    openedAtMs: r.openedAtMs,
    branch: null,
  }));
  if (remote.length === 0) return local;
  return [...local, ...remote].sort((a, b) => (b.openedAtMs ?? 0) - (a.openedAtMs ?? 0));
}

/** `host:path` of a remote project location, else `null`. */
export function remoteDisplay(location: string): string | null {
  const r = parseRemoteLocation(location);
  if (!r) return null;
  const host = recentRemotes().find((x) => x.sshConfig === r.sshConfig && x.path === r.path)?.host || r.sshConfig;
  return `${host}:${r.path}`;
}

export async function removeRecent(path: string) {
  useRecent.setState((s) => ({
    projects: s.projects.filter((p) => p.path !== path),
    groups: s.groups.map((g) => (g.paths.includes(path) ? { ...g, paths: g.paths.filter((p) => p !== path) } : g)),
  }));
  const remote = parseRemoteLocation(path);
  if (remote) {
    forgetRemote(remote.sshConfig, remote.path);
    return;
  }
  if (!isTauri()) return;
  const r = await commands.removeRecentProject(path);
  if (r.status === "error")
    notifications().notify({ level: "error", title: "Cannot remove recent project", body: r.error.message });
}

/** Opens a project from the recent list; offers to remove entries whose folder is gone. */
export async function openRecent(project: Pick<RecentProject, "path" | "name">): Promise<boolean> {
  if (!isTauri()) {
    notifications().notify({
      level: "warning",
      title: "Opening projects requires the desktop app",
      body: "Run `pnpm tauri dev` to use the file system.",
    });
    return false;
  }
  const remote = parseRemoteLocation(project.path);
  if (remote) return openRemote(project, remote);
  const current = useProject.getState().project;
  if (current?.root === project.path) return true;
  // With a project open, the app feature applies "Open project in" (new / this window / ask).
  if (current && getAction("file.openRecentProject")) {
    await executeAction("file.openRecentProject", project.path);
    return true;
  }
  useRecent.setState({ opening: project.path });
  try {
    await openProject(project.path);
    return true;
  } catch (e) {
    if (isCancelled(e)) return false;
    const message = e instanceof Error ? e.message : String(e);
    const missing = e instanceof IpcError ? e.kind === "notFound" : /not found|no such/i.test(message);
    notifications().notify({
      level: "error",
      title: missing ? `Project folder not found: ${project.name}` : `Cannot open ${project.name}`,
      body: missing ? project.path : message,
      key: `welcome.open:${project.path}`,
      actions: [{ label: "Remove from Recent Projects", run: () => void removeRecent(project.path) }],
    });
    return false;
  } finally {
    useRecent.setState({ opening: null });
  }
}

async function openRemote(
  project: Pick<RecentProject, "path" | "name">,
  remote: { sshConfig: string; path: string },
): Promise<boolean> {
  try {
    return await openRemoteProject(remote.sshConfig, remote.path, async () => {
      useRecent.setState({ opening: project.path });
      await connectRemote(remote.sshConfig, remote.path);
    });
  } catch (e) {
    if (isCancelled(e)) return false;
    notifications().notify({
      level: "error",
      title: tx`Cannot open ${project.name}`,
      body: e instanceof Error ? e.message : String(e),
      key: `welcome.open:${project.path}`,
      actions: [{ label: "Remove from Recent Projects", run: () => void removeRecent(project.path) }],
    });
    return false;
  } finally {
    useRecent.setState({ opening: null });
  }
}

// ---------------------------------------------------------------------------
// Pure helpers

/** Replaces the home directory prefix with `~`. */
export function tildify(path: string, home: string | null | undefined): string {
  if (!home || home === "/") return path;
  const h = home.endsWith("/") ? home.slice(0, -1) : home;
  if (path === h) return "~";
  return path.startsWith(h + "/") ? "~" + path.slice(h.length) : path;
}

export interface RecentMatch {
  project: RecentProject;
  /** Matched indices in the name, if the name matched. */
  nameMatch: number[] | null;
  /** Matched indices in the displayed (tildified) path. */
  pathMatch: number[] | null;
  displayPath: string;
}

/**
 * Filters by name, then by path. Name matches come first; within each group
 * the backend's recency order is kept. Empty query returns everything.
 */
export function filterRecent(projects: readonly RecentProject[], query: string, home?: string | null): RecentMatch[] {
  const q = query.trim();
  const all = projects.map((project) => ({
    project,
    nameMatch: null as number[] | null,
    pathMatch: null as number[] | null,
    displayPath: remoteDisplay(project.path) ?? tildify(project.path, home),
  }));
  if (!q) return all;
  const byName: RecentMatch[] = [];
  const byPath: RecentMatch[] = [];
  for (const m of all) {
    const name = fuzzyMatch(m.project.name, q);
    if (name) {
      byName.push({ ...m, nameMatch: name });
      continue;
    }
    const path = fuzzyMatch(m.displayPath, q);
    if (path && isCompactMatch(path)) byPath.push({ ...m, pathMatch: path });
  }
  return [...byName, ...byPath];
}

/** Rejects very scattered subsequence matches over long paths (noise). */
function isCompactMatch(indices: number[]): boolean {
  if (indices.length < 2) return true;
  return indices[indices.length - 1]! - indices[0]! < indices.length * 6;
}

// ---------------------------------------------------------------------------
// Project groups

/** The group `path` belongs to, if any. */
export function groupOf(path: string, groups: readonly RecentProjectGroup[]): RecentProjectGroup | undefined {
  return groups.find((g) => g.paths.includes(path));
}

/** Saves `next` (shown at once; the backend's normalised copy replaces it). */
async function saveGroups(next: RecentProjectGroup[]) {
  useRecent.setState({ groups: next });
  if (!isTauri()) return;
  const r = await commands.setRecentProjectGroups(next);
  if (r.status === "ok") useRecent.setState({ groups: r.data });
  else notifications().notify({ level: "error", title: "Cannot save project groups", body: r.error.message });
}

const groups = () => useRecent.getState().groups;

/** Why `name` can't name a new group (or group `current` renamed), or null. */
export function groupNameError(value: string, current?: string): string | null {
  const name = value.trim();
  if (!name) return tx("Enter a group name");
  return name !== current && groups().some((g) => g.name === name) ? tx`A group named '${name}' already exists` : null;
}

/** New Project Group…; with `path`, the project moves into it. */
export function createGroup(name: string, path?: string) {
  const n = name.trim();
  if (groupNameError(n)) return Promise.resolve();
  const rest = groups().map((g) => (path ? { ...g, paths: g.paths.filter((p) => p !== path) } : g));
  return saveGroups([...rest, { name: n, paths: path ? [path] : [], expanded: true }]);
}

export function renameGroup(name: string, to: string) {
  const n = to.trim();
  if (n === name || groupNameError(n, name)) return Promise.resolve();
  return saveGroups(groups().map((g) => (g.name === name ? { ...g, name: n } : g)));
}

/** Removes the group; its projects stay in the list, ungrouped. */
export function removeGroup(name: string) {
  return saveGroups(groups().filter((g) => g.name !== name));
}

/** Moves `path` into group `name`, or out of every group with `null`. */
export function moveToGroup(path: string, name: string | null) {
  return saveGroups(
    groups().map((g) => {
      const paths = g.paths.filter((p) => p !== path);
      return { ...g, paths: g.name === name ? [...paths, path] : paths };
    }),
  );
}

export function setGroupExpanded(name: string, expanded: boolean) {
  return saveGroups(groups().map((g) => (g.name === name ? { ...g, expanded } : g)));
}

export type RecentRow =
  | { kind: "group"; group: RecentProjectGroup; count: number }
  | { kind: "project"; m: RecentMatch; group: string | null };

/**
 * The rows of the list: without a query, groups first (their projects under the expanded
 * ones, most recent first), then the ungrouped projects; while searching, the matches only.
 */
export function recentRows(
  projects: readonly RecentProject[],
  groupList: readonly RecentProjectGroup[],
  query: string,
  home?: string | null,
): RecentRow[] {
  const matches = filterRecent(projects, query, home);
  if (query.trim() || groupList.length === 0) return matches.map((m) => ({ kind: "project", m, group: null }));
  const rows: RecentRow[] = [];
  const grouped = new Set<string>();
  for (const group of groupList) {
    const members = matches.filter((m) => group.paths.includes(m.project.path));
    members.forEach((m) => grouped.add(m.project.path));
    rows.push({ kind: "group", group, count: members.length });
    if (group.expanded) rows.push(...members.map((m): RecentRow => ({ kind: "project", m, group: group.name })));
  }
  for (const m of matches) if (!grouped.has(m.project.path)) rows.push({ kind: "project", m, group: null });
  return rows;
}
