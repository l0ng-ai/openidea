/**
 * How the Agents tool window arranges the project's tasks: the user's own groups and the
 * tasks pinned above them. Kept per project in `localStorage`, like the other panel
 * preferences; the tasks themselves stay the backend's.
 */
import type { AgentTask } from "@/bindings";
import { tx } from "@/platform/i18n";
import { parseRemoteLocation } from "@/platform/remote";
import { attentionRank, groupStatus, groupTasks, type TaskGroup } from "./model";

/** Section key of the pinned group, above every other group. */
export const PINNED_SECTION = "pinned";
/** Section key of a user-created group. */
export const customSection = (group: string) => `ug:${group}`;
/** Section key of a status group. */
export const statusSection = (status: TaskGroup["status"]) => `g:${status}`;

const STATUS_SECTIONS = new Set<string>([
  "g:needsInput",
  "g:failed",
  "g:limited",
  "g:running",
  "g:ready",
  "g:archived",
]);

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
  /** Manual task order per section (`pinned`, `ug:<id>`, `g:<status>`). Absent means default sort. */
  order?: Record<string, string[]>;
}

export const EMPTY_ORGANIZE: TaskOrganize = { groups: [], groupOf: {}, pinned: [] };

/** Section key where `task` is currently shown. */
export function sectionOfTask(task: AgentTask, organize: TaskOrganize): string {
  if (organize.pinned.includes(task.id)) return PINNED_SECTION;
  const group = organize.groupOf[task.id];
  if (group && organize.groups.some((g) => g.id === group)) return customSection(group);
  return statusSection(groupStatus(task.status));
}

function isKnownSection(section: string, knownGroups: ReadonlySet<string>): boolean {
  return (
    section === PINNED_SECTION ||
    STATUS_SECTIONS.has(section) ||
    (section.startsWith("ug:") && knownGroups.has(section.slice(3)))
  );
}

/** Drops empty section entries so `order` is omitted when no section has a manual order. */
export function compactOrder(order: Record<string, string[]> | undefined): Record<string, string[]> | undefined {
  if (!order) return undefined;
  const out: Record<string, string[]> = {};
  for (const [section, list] of Object.entries(order)) {
    if (list.length) out[section] = list;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Removes `removed` task ids from the listed `sections` of `order`. */
export function removeFromOrder(
  order: Record<string, string[]> | undefined,
  sections: Iterable<string>,
  removed: ReadonlySet<string>,
): Record<string, string[]> | undefined {
  if (!order || !removed.size) return order;
  let changed = false;
  const next = { ...order };
  for (const section of sections) {
    const list = next[section];
    if (!list) continue;
    const kept = list.filter((id) => !removed.has(id));
    if (kept.length !== list.length) {
      changed = true;
      if (kept.length) next[section] = kept;
      else delete next[section];
    }
  }
  return changed ? compactOrder(next) : order;
}

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
  const order: Record<string, string[]> = {};
  if (record.order && typeof record.order === "object" && !Array.isArray(record.order)) {
    for (const [section, list] of Object.entries(record.order)) {
      if (!isKnownSection(section, known) || !Array.isArray(list)) continue;
      const seen = new Set<string>();
      const ids = list.filter((id): id is string => typeof id === "string" && !seen.has(id) && (seen.add(id), true));
      if (ids.length) order[section] = ids;
    }
  }
  return Object.keys(order).length ? { groups, groupOf, pinned, order } : { groups, groupOf, pinned };
}

export function loadOrganize(root: string | null | undefined): TaskOrganize {
  if (!root) return EMPTY_ORGANIZE;
  try {
    const legacy = parseRemoteLocation(root)?.path;
    const raw =
      globalThis.localStorage?.getItem(key(root)) ?? (legacy ? globalThis.localStorage?.getItem(key(legacy)) : null);
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
  let orderChanged = false;
  let nextOrder: Record<string, string[]> | undefined;
  if (organize.order) {
    const cleaned: Record<string, string[]> = {};
    for (const [section, list] of Object.entries(organize.order)) {
      if (!isKnownSection(section, known)) {
        orderChanged = true;
        continue;
      }
      const kept = list.filter((id) => ids.has(id));
      if (kept.length !== list.length || kept.length === 0) orderChanged = true;
      if (kept.length) cleaned[section] = kept;
    }
    nextOrder = Object.keys(cleaned).length ? cleaned : undefined;
    if (!nextOrder) orderChanged = true;
  }
  const same =
    !orderChanged &&
    pinned.length === organize.pinned.length &&
    Object.keys(groupOf).length === Object.keys(organize.groupOf).length;
  if (same) return organize;
  return nextOrder
    ? { groups: organize.groups, groupOf, pinned, order: nextOrder }
    : { groups: organize.groups, groupOf, pinned };
}

/**
 * Applies a saved manual order on top of `defaultSorted`: manually ordered tasks keep their
 * saved relative order even when activity changes, while new tasks appear above them.
 */
export function applyOrder(defaultSorted: AgentTask[], manual: readonly string[] | undefined): AgentTask[] {
  if (!manual?.length) return defaultSorted;
  const rank = new Map<string, number>();
  for (const id of manual) if (!rank.has(id)) rank.set(id, rank.size);
  const fresh: AgentTask[] = [];
  const ordered: AgentTask[] = [];
  for (const task of defaultSorted) {
    if (rank.has(task.id)) ordered.push(task);
    else fresh.push(task);
  }
  ordered.sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  return [...fresh, ...ordered];
}

/** The tasks of `group`, what waits for the user first, then the most recently active (or manual order). */
export function groupMembers(tasks: Iterable<AgentTask>, organize: TaskOrganize, group: string): AgentTask[] {
  const pinned = new Set(organize.pinned);
  const sorted = [...tasks]
    .filter((t) => organize.groupOf[t.id] === group && !pinned.has(t.id))
    .sort((a, b) => attentionRank(a.status) - attentionRank(b.status) || (b.updatedMs ?? 0) - (a.updatedMs ?? 0));
  return applyOrder(sorted, organize.order?.[customSection(group)]);
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

/** Status groups of the ungrouped tasks, with each group's saved manual order applied. */
export function statusGroups(tasks: Iterable<AgentTask>, organize: TaskOrganize): TaskGroup[] {
  return groupTasks(ungroupedMembers(tasks, organize)).map((group) => ({
    ...group,
    tasks: applyOrder(group.tasks, organize.order?.[statusSection(group.status)]),
  }));
}

/** The pinned tasks, most recently active first (or manual order). */
export function pinnedMembers(tasks: Iterable<AgentTask>, organize: TaskOrganize): AgentTask[] {
  const pinned = new Set(organize.pinned);
  const sorted = [...tasks].filter((t) => pinned.has(t.id)).sort((a, b) => (b.updatedMs ?? 0) - (a.updatedMs ?? 0));
  return applyOrder(sorted, organize.order?.[PINNED_SECTION]);
}

function placeId(
  ids: readonly string[],
  source: string,
  target: string,
  position: "before" | "after",
): string[] | null {
  const rest = ids.filter((id) => id !== source);
  const at = rest.indexOf(target);
  if (at < 0) return null;
  const insert = position === "before" ? at : at + 1;
  return [...rest.slice(0, insert), source, ...rest.slice(insert)];
}

/** Whether `source` can be placed beside `target` (same status required when landing in a status group). */
export function canReorderTask(source: AgentTask, target: AgentTask, organize: TaskOrganize): boolean {
  if (source.id === target.id) return false;
  const targetSection = sectionOfTask(target, organize);
  if (targetSection.startsWith("g:")) return statusSection(groupStatus(source.status)) === targetSection;
  return true;
}

/**
 * Places `sourceId` before or after `targetId`, moving it into the target's section when needed
 * and persisting that section's display order.
 */
export function reorderTaskInOrganize(
  organize: TaskOrganize,
  tasks: Iterable<AgentTask>,
  sourceId: string,
  targetId: string,
  position: "before" | "after",
): TaskOrganize {
  const all = [...tasks];
  const byId = new Map(all.map((t) => [t.id, t]));
  const source = byId.get(sourceId);
  const target = byId.get(targetId);
  if (!source || !target || !canReorderTask(source, target, organize)) return organize;

  const sourceSection = sectionOfTask(source, organize);
  const targetSection = sectionOfTask(target, organize);

  let visibleIds: string[];
  if (targetSection === PINNED_SECTION) {
    visibleIds = pinnedMembers(all, organize).map((t) => t.id);
  } else if (targetSection.startsWith("ug:")) {
    visibleIds = groupMembers(all, organize, targetSection.slice(3)).map((t) => t.id);
  } else {
    const status = targetSection.slice(2) as TaskGroup["status"];
    visibleIds =
      statusGroups(all, organize)
        .find((g) => g.status === status)
        ?.tasks.map((t) => t.id) ?? [];
  }

  const nextList = placeId(visibleIds, sourceId, targetId, position);
  if (!nextList) return organize;

  if (
    sourceSection === targetSection &&
    nextList.length === visibleIds.length &&
    nextList.every((id, i) => id === visibleIds[i])
  )
    return organize;

  let pinned = organize.pinned;
  let groupOf = organize.groupOf;
  if (sourceSection !== targetSection) {
    if (targetSection === PINNED_SECTION) {
      pinned = pinned.includes(sourceId) ? pinned : [...pinned, sourceId];
    } else if (targetSection.startsWith("ug:")) {
      const groupId = targetSection.slice(3);
      groupOf = { ...groupOf, [sourceId]: groupId };
      pinned = pinned.filter((id) => id !== sourceId);
    } else {
      pinned = pinned.filter((id) => id !== sourceId);
      if (sourceId in groupOf) {
        groupOf = { ...groupOf };
        delete groupOf[sourceId];
      }
    }
  }

  const baseOrder =
    sourceSection !== targetSection
      ? removeFromOrder(organize.order, [sourceSection], new Set([sourceId]))
      : organize.order;
  const order = compactOrder({ ...(baseOrder ?? {}), [targetSection]: nextList });
  return order ? { groups: organize.groups, groupOf, pinned, order } : { groups: organize.groups, groupOf, pinned };
}

/** Moves a custom group before or after another custom group. */
export function reorderGroupsInOrganize(
  organize: TaskOrganize,
  sourceId: string,
  targetId: string,
  position: "before" | "after",
): TaskOrganize {
  if (sourceId === targetId) return organize;
  const nextIds = placeId(
    organize.groups.map((g) => g.id),
    sourceId,
    targetId,
    position,
  );
  if (!nextIds || nextIds.every((id, i) => id === organize.groups[i]?.id)) return organize;
  const byId = new Map(organize.groups.map((g) => [g.id, g]));
  const groups = nextIds.flatMap((id) => {
    const g = byId.get(id);
    return g ? [g] : [];
  });
  return { ...organize, groups };
}
