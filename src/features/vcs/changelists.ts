/**
 * Change lists: the default "Changes" list plus user lists in the Commit tool
 * window. Every changed file belongs to exactly one list (new changes go to the
 * active one); the state is persisted per project in `.openidea/changelists.json`.
 */
import { create } from "zustand";
import type { Changelist, ChangelistState, FileStatus } from "@/bindings";
import { call, commands, isTauri, onIdeEvent } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { setLocalChanges, type LocalChangelist } from "@/workbench/contributions";
import type { CheckState } from "./changes";
import { groupOf } from "./changes";
import { effectiveKind, relTo, stripSlash } from "./model";
import { useVcs } from "./store";

export const DEFAULT_LIST_ID = "default";
export const DEFAULT_LIST_NAME = "Changes";

export function initialChangelists(): ChangelistState {
  return { lists: [{ id: DEFAULT_LIST_ID, name: DEFAULT_LIST_NAME, comment: "" }], active: DEFAULT_LIST_ID, files: {} };
}

/** The list a (project-relative) file belongs to. */
export function listOf(state: ChangelistState, rel: string): string {
  const id = state.files?.[rel];
  return id && state.lists.some((l) => l.id === id) ? id : state.active;
}

export function activeList(state: ChangelistState): Changelist {
  return state.lists.find((l) => l.id === state.active) ?? state.lists[0]!;
}

/**
 * Pins files that just became changed to the active list and forgets files that
 * are no longer changed. Returns null when nothing changed.
 */
export function syncAssignments(state: ChangelistState, changed: readonly string[]): ChangelistState | null {
  const live = new Set(changed);
  const files: Record<string, string> = {};
  let dirty = false;
  for (const [rel, id] of Object.entries(state.files ?? {})) {
    if (live.has(rel) && state.lists.some((l) => l.id === id)) files[rel] = id;
    else dirty = true;
  }
  for (const rel of changed) {
    if (!(rel in files)) {
      files[rel] = state.active;
      dirty = true;
    }
  }
  return dirty ? { ...state, files } : null;
}

export function validateListName(state: ChangelistState, name: string, exceptId?: string): string | null {
  const n = name.trim();
  if (!n) return "Name must not be empty";
  if (state.lists.some((l) => l.id !== exceptId && l.name.toLowerCase() === n.toLowerCase()))
    return `A changelist named '${n}' already exists`;
  return null;
}

function newId(state: ChangelistState): string {
  let id: string;
  do id = `cl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  while (state.lists.some((l) => l.id === id));
  return id;
}

export function addList(
  state: ChangelistState,
  name: string,
  opts: { comment?: string; makeActive?: boolean } = {},
): { state: ChangelistState; id: string } {
  const id = newId(state);
  const list: Changelist = { id, name: name.trim(), comment: opts.comment ?? "" };
  return { id, state: { ...state, lists: [...state.lists, list], active: opts.makeActive ? id : state.active } };
}

export function editList(state: ChangelistState, id: string, name: string, comment: string): ChangelistState {
  return { ...state, lists: state.lists.map((l) => (l.id === id ? { ...l, name: name.trim(), comment } : l)) };
}

export function setActiveList(state: ChangelistState, id: string): ChangelistState {
  return state.lists.some((l) => l.id === id) ? { ...state, active: id } : state;
}

/** Deletes a list (never the active one); its files move to the active list. */
export function removeList(state: ChangelistState, id: string): ChangelistState {
  if (id === state.active || !state.lists.some((l) => l.id === id)) return state;
  const files = Object.fromEntries(
    Object.entries(state.files ?? {}).map(([rel, l]) => [rel, l === id ? state.active : l]),
  );
  return { ...state, lists: state.lists.filter((l) => l.id !== id), files };
}

export function moveFiles(state: ChangelistState, rels: readonly string[], id: string): ChangelistState {
  if (!state.lists.some((l) => l.id === id)) return state;
  const files = { ...state.files };
  for (const rel of rels) files[rel] = id;
  return { ...state, files };
}

/**
 * Like IDEA, only the active list's changes are included in a commit by default:
 * files of other lists without an explicit checkbox state start excluded.
 */
export function withListDefaults(
  status: readonly FileStatus[],
  root: string,
  state: ChangelistState,
  checks: ReadonlyMap<string, CheckState>,
): Map<string, CheckState> {
  const out = new Map(checks);
  if (state.lists.length < 2) return out;
  for (const f of status) {
    if (out.has(f.path) || groupOf(f) !== "changes") continue;
    if (listOf(state, relTo(root, stripSlash(f.path))) !== state.active) out.set(f.path, "none");
  }
  return out;
}

/** Checkbox states that include exactly the changes of list `id`. */
export function checksForList(
  status: readonly FileStatus[],
  root: string,
  state: ChangelistState,
  id: string,
): Map<string, CheckState> {
  const out = new Map<string, CheckState>();
  for (const f of status) {
    if (groupOf(f) !== "changes") continue;
    out.set(f.path, listOf(state, relTo(root, stripSlash(f.path))) === id ? "all" : "none");
  }
  return out;
}

// ---------------------------------------------------------------------------
// Store (loaded per project, saved on change)

interface ChangelistStore {
  state: ChangelistState;
  loaded: boolean;
}

export const useChangelists = create<ChangelistStore>(() => ({ state: initialChangelists(), loaded: false }));

let saveTimer: ReturnType<typeof setTimeout> | undefined;

export function updateChangelists(fn: (s: ChangelistState) => ChangelistState) {
  const cur = useChangelists.getState().state;
  const next = fn(cur);
  if (next === cur) return;
  useChangelists.setState({ state: next });
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = undefined;
    if (useChangelists.getState().loaded && isTauri())
      void call(commands.vcsChangelistsSave(useChangelists.getState().state)).catch(() => undefined);
  }, 250);
}

/** Project-relative paths of the changed files that belong to change lists. */
export function changedRels(status: readonly FileStatus[], root: string): string[] {
  return status.filter((f) => groupOf(f) === "changes").map((f) => relTo(root, stripSlash(f.path)));
}

/** The lists with their files, for the `useLocalChanges` service (conflicted files stay in their list). */
export function localChangelists(
  status: readonly FileStatus[],
  root: string,
  state: ChangelistState,
): LocalChangelist[] {
  const lists = state.lists.map((l): LocalChangelist => ({
    id: l.id,
    name: l.name,
    active: l.id === state.active,
    files: [],
  }));
  const byId = new Map(lists.map((l) => [l.id, l]));
  for (const f of status) {
    const group = groupOf(f);
    if (group !== "changes" && group !== "conflicts") continue;
    const path = stripSlash(f.path);
    const list = byId.get(listOf(state, relTo(root, path))) ?? lists[0];
    list?.files.push(effectiveKind(f) === "deleted" ? { path, deleted: true } : { path });
  }
  return lists;
}

export function relOf(path: string): string {
  return relTo(useVcs.getState().root ?? "", stripSlash(path));
}

export function installChangelists(): () => void {
  let loadedFor: string | null = null;
  const sync = () => {
    const { status, root, available, statusLoaded } = useVcs.getState();
    if (!available || !root || !statusLoaded || !useChangelists.getState().loaded) return;
    const next = syncAssignments(useChangelists.getState().state, changedRels(status, root));
    if (next) updateChangelists(() => next);
  };
  const load = () => {
    const root = useProject.getState().project?.root ?? null;
    if (root === loadedFor) return;
    loadedFor = root;
    clearTimeout(saveTimer);
    saveTimer = undefined;
    useChangelists.setState({ state: initialChangelists(), loaded: false });
    if (!root || !isTauri()) return;
    void call(commands.vcsChangelistsLoad())
      .then((state) => {
        if (loadedFor !== root) return;
        useChangelists.setState({ state, loaded: true });
        sync();
      })
      .catch(() => {
        if (loadedFor === root) useChangelists.setState({ loaded: true });
      });
  };
  load();
  const offProject = useProject.subscribe((s, p) => {
    if (s.project !== p.project) load();
  });
  const offVcs = useVcs.subscribe((s, p) => {
    if (s.status !== p.status) sync();
  });
  // The MCP changelist tools write the file and then emit `vcsChanged`: pick their state up
  // unless an edit of ours is still to be saved.
  const offReload = isTauri()
    ? onIdeEvent("vcsChanged", () => {
        const root = loadedFor;
        if (!root || saveTimer !== undefined || !useChangelists.getState().loaded) return;
        void call(commands.vcsChangelistsLoad())
          .then((state) => {
            if (loadedFor !== root || saveTimer !== undefined) return;
            if (JSON.stringify(state) !== JSON.stringify(useChangelists.getState().state))
              useChangelists.setState({ state });
          })
          .catch(() => undefined);
      })
    : () => undefined;
  let clearPublished: (() => void) | null = null;
  const publish = () => {
    const { status, root, available } = useVcs.getState();
    if (!available || !root) {
      clearPublished?.();
      clearPublished = null;
      return;
    }
    clearPublished = setLocalChanges("vcs", localChangelists(status, root, useChangelists.getState().state));
  };
  publish();
  const offPublishVcs = useVcs.subscribe((s, p) => {
    if (s.status !== p.status || s.root !== p.root || s.available !== p.available) publish();
  });
  const offPublishLists = useChangelists.subscribe((s, p) => {
    if (s.state !== p.state) publish();
  });
  return () => {
    offProject();
    offVcs();
    offReload();
    offPublishVcs();
    offPublishLists();
    clearPublished?.();
    clearTimeout(saveTimer);
    saveTimer = undefined;
  };
}
