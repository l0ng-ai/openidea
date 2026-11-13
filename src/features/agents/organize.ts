/**
 * How the Agents tool window arranges the project's tasks: the user's own groups and the
 * tasks pinned above them. Kept per project in `localStorage`, like the other panel
 * preferences; the tasks themselves stay the backend's.
 */
import type { AgentTask } from "@/bindings";
import { tx } from "@/platform/i18n";
import { attentionRank } from "./model";

/** A group the user made ("Frontend", "Docs"…). */
export interface OrganizeGroup {
  id: string;
  name: string;
}

export interface TaskOrganize {
  /** The user's groups, in the order they are shown. */
  groups: OrganizeGroup[];
  /** Group of each task, by task id. */
  groupOf: Record<string, string>;
  /** Pinned tasks, by task id: they are shown above every group. */
  pinned: string[];
}

export const EMPTY_ORGANIZE: TaskOrganize = { groups: [], groupOf: {}, pinned: [] };

/** Why `value` cannot name a group (trimmed, and not one already there), or null when it can. */
export function groupNameError(value: string, groups: readonly OrganizeGroup[], current?: string): string | null {
  const name = value.trim();
  if (!name) return tx("Enter a group name");
  return name !== current && groups.some((g) => g.name === name) ? tx`A group named '${name}' already exists` : null;
}

const KEY_PREFIX = "openidea.agents.organize.v1:";

const key = (root: string) => `${KEY_PREFIX}${root}`;

/** A saved copy, with anything unrecognised dropped (it is user-editable storage). */
export function parseOrganize(saved: unknown): TaskOrganize {
  const record = (saved ?? {}) as Partial<Record<keyof TaskOrganize, unknown>>;
  const groups = Array.isArray(record.groups)
    ? record.groups.flatMap((g): OrganizeGroup[] => {
        const group = (g ?? {}) as Partial<OrganizeGroup>;
        return typeof group.id === "string" && typeof group.name === "string"
          ? [{ id: group.id, name: group.name }]
          : [];
      })
    : [];
  const known = new Set(groups.map((g) => g.id));
  const groupOf: Record<string, string> = {};
  if (record.groupOf && typeof record.groupOf === "object")
    for (const [task, group] of Object.entries(record.groupOf))
      if (typeof group === "string" && known.has(group)) groupOf[task] = group;
  const pinned = Array.isArray(record.pinned) ? record.pinned.filter((id): id is string => typeof id === "string") : [];
  return { groups, groupOf, pinned };
}

export function loadOrganize(root: string | null | undefined): TaskOrganize {
  if (!root) return EMPTY_ORGANIZE;
  try {
    const raw = globalThis.localStorage?.getItem(key(root));
    return raw == null ? EMPTY_ORGANIZE : parseOrganize(JSON.parse(raw));
  } catch {
    return EMPTY_ORGANIZE;
  }
}

export function saveOrganize(root: string | null | undefined, organize: TaskOrganize): void {
  if (!root) return;
  try {
    globalThis.localStorage?.setItem(key(root), JSON.stringify(organize));
  } catch {
    /* storage unavailable */
  }
}

/**
 * `organize` without the tasks that no longer exist; the same object when it is already
 * clean. Groups stay even when empty: a just-created one is where tasks are about to go.
 */
export function pruneOrganize(organize: TaskOrganize, tasks: Iterable<AgentTask>): TaskOrganize {
  const ids = new Set([...tasks].map((t) => t.id));
  const known = new Set(organize.groups.map((g) => g.id));
  const groupOf: Record<string, string> = {};
  for (const [task, group] of Object.entries(organize.groupOf))
    if (ids.has(task) && known.has(group)) groupOf[task] = group;
  const pinned = organize.pinned.filter((id) => ids.has(id));
  const same =
    pinned.length === organize.pinned.length && Object.keys(groupOf).length === Object.keys(organize.groupOf).length;
  return same ? organize : { groups: organize.groups, groupOf, pinned };
}

/** The tasks of `group`, what waits for the user first, then the most recently active. */
export function groupMembers(tasks: Iterable<AgentTask>, organize: TaskOrganize, group: string): AgentTask[] {
  const pinned = new Set(organize.pinned);
  return [...tasks]
    .filter((t) => organize.groupOf[t.id] === group && !pinned.has(t.id))
    .sort((a, b) => attentionRank(a.status) - attentionRank(b.status) || (b.updatedMs ?? 0) - (a.updatedMs ?? 0));
}

/** The tasks the status groups show: not pinned, and in no group of the user's. */
export function ungroupedMembers(tasks: Iterable<AgentTask>, organize: TaskOrganize): AgentTask[] {
  const pinned = new Set(organize.pinned);
  const known = new Set(organize.groups.map((g) => g.id));
  return [...tasks].filter((t) => {
    if (pinned.has(t.id)) return false;
    const group = organize.groupOf[t.id];
    return group === undefined || !known.has(group);
  });
}

/** The pinned tasks, most recently active first. */
export function pinnedMembers(tasks: Iterable<AgentTask>, organize: TaskOrganize): AgentTask[] {
  const pinned = new Set(organize.pinned);
  return [...tasks].filter((t) => pinned.has(t.id)).sort((a, b) => (b.updatedMs ?? 0) - (a.updatedMs ?? 0));
}
