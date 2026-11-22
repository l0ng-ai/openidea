/**
 * Change lists: the default "Changes" list plus user lists in the Commit tool
 * window. Every changed file belongs to exactly one list (new changes go to the
 * active one); the state is persisted per project in `.openidea/changelists.json`.
 */
import { create } from "zustand";
import type { Changelist, ChangelistState, CommitApplySource, FileStatus, PendingCommitApply } from "@/bindings";
import { call, commands, isTauri } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { setLocalChanges, type LocalChangelist } from "@/workbench/contributions";
import type { CheckState } from "./changes";
import { checkOf, groupOf } from "./changes";
import { effectiveKind, relTo, stripSlash } from "./model";
import { localChangesMayBeAside, useVcs } from "./store";

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
 * are no longer changed, unless `keepGone`: while a merge, rebase or update has the
 * local changes put aside, their files keep their lists for when they come back.
 * Returns null when nothing changed.
 */
export function syncAssignments(
  state: ChangelistState,
  changed: readonly string[],
  keepGone = false,
): ChangelistState | null {
  const live = new Set(changed);
  const files: Record<string, string> = {};
  let dirty = false;
  for (const [rel, id] of Object.entries(state.files ?? {})) {
    if ((keepGone || live.has(rel)) && state.lists.some((l) => l.id === id)) files[rel] = id;
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

export function appliedCommitList(state: ChangelistState, source: CommitApplySource): Changelist | undefined {
  return state.lists.find(
    (list) =>
      list.appliedCommit?.repo === source.repo &&
      list.appliedCommit.kind === source.kind &&
      list.appliedCommit.commit === source.commit &&
      list.appliedCommit.base === source.base,
  );
}

/** Only the paths in Git's stopped index are assigned to the generated list. */
export function addAppliedCommitList(
  state: ChangelistState,
  root: string,
  status: readonly FileStatus[],
  pending: PendingCommitApply,
  message: string,
): ChangelistState {
  if (appliedCommitList(state, pending.source)) return state;
  const paths = pending.paths.map((path) => relTo(root, path));
  const live = new Set(changedRels(status, root));
  if (!paths.some((path) => live.has(path))) return state;
  const subject = message.split("\n", 1)[0]!.trim().replace(/ {2,}/g, " ");
  if (!subject) return state;
  let name = subject;
  for (let n = 1; validateListName(state, name); n++) name = `${subject}-${n}`;
  const id = newId(state);
  const list: Changelist = { id, name, comment: message, appliedCommit: pending.source };
  return moveFiles({ ...state, lists: [...state.lists, list] }, paths, id);
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

/** The first included tracked change supplies the message context. */
export function changelistForCommit(
  status: readonly FileStatus[],
  root: string,
  state: ChangelistState,
  overrides: ReadonlyMap<string, CheckState>,
  includeByDefault: boolean,
): string {
  if (state.lists.length < 2) return state.active;
  const checks = withListDefaults(status, root, state, overrides);
  const first = status.find((file) => {
    if (groupOf(file) !== "changes") return false;
    const check = checkOf(file, checks, includeByDefault);
    return check !== "none" && (check !== "staged" || file.staged !== null);
  });
  return first ? listOf(state, relTo(root, stripSlash(first.path))) : state.active;
}

// ---------------------------------------------------------------------------
// Store (loaded per project, saved on change)

interface ChangelistStore {
  state: ChangelistState;
  loaded: boolean;
  root: string | null;
}

export const useChangelists = create<ChangelistStore>(() => ({
  state: initialChangelists(),
  loaded: false,
  root: null,
}));

let saveTimer: ReturnType<typeof setTimeout> | undefined;
let saving = Promise.resolve();

/** Waits for the on-disk assignments used by automatic Shelf saves. */
export function flushChangelists(): Promise<void> {
  if (saveTimer === undefined) return saving;
  clearTimeout(saveTimer);
  saveTimer = undefined;
  const { loaded, state } = useChangelists.getState();
  const root = useProject.getState().project?.root;
  if (loaded && root && isTauri()) {
    saving = saving
      .then(async () => {
        if (root === useProject.getState().project?.root) await call(commands.vcsChangelistsSave(state));
      })
      .catch(() => undefined);
  }
  return saving;
}

export function updateChangelists(fn: (s: ChangelistState) => ChangelistState) {
  const cur = useChangelists.getState().state;
  const next = fn(cur);
  if (next === cur) return;
  useChangelists.setState({ state: next });
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void flushChangelists(), 250);
}

/** Project-relative paths of the changed files that belong to change lists. */
export function changedRels(status: readonly FileStatus[], root: string): string[] {
  return status
    .filter((f) => {
      const group = groupOf(f);
      return group === "changes" || group === "conflicts";
    })
    .map((f) => relTo(root, stripSlash(f.path)));
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
  let loadRequest = 0;
  const sync = () => {
    const { status, root, available, statusLoaded, operations, heads } = useVcs.getState();
    if (!available || !root || !statusLoaded || !useChangelists.getState().loaded) return;
    const { state } = useChangelists.getState();
    const keepGone = localChangesMayBeAside();
    const next = syncAssignments(state, changedRels(status, root), keepGone) ?? state;
    const used = new Set(Object.values(next.files ?? {}));
    const lists = next.lists.filter(
      (list) =>
        !list.appliedCommit ||
        list.id === next.active ||
        used.has(list.id) ||
        !heads[list.appliedCommit.repo] ||
        operations[list.appliedCommit.repo] === (list.appliedCommit.kind ?? "cherry-pick"),
    );
    updateChangelists(() => (lists.length === next.lists.length ? next : { ...next, lists }));
  };
  const load = () => {
    const root = useProject.getState().project?.root ?? null;
    if (root === loadedFor) return;
    loadedFor = root;
    const request = ++loadRequest;
    clearTimeout(saveTimer);
    saveTimer = undefined;
    useChangelists.setState({ state: initialChangelists(), loaded: false, root });
    if (!root || !isTauri()) return;
    void call(commands.vcsChangelistsLoad())
      .then((state) => {
        if (loadRequest !== request) return;
        useChangelists.setState({ state, loaded: true });
        sync();
      })
      .catch(() => {
        if (loadRequest === request) useChangelists.setState({ loaded: true });
      });
  };
  load();
  const offProject = useProject.subscribe((s, p) => {
    if (s.project !== p.project) load();
  });
  const offVcs = useVcs.subscribe((s, p) => {
    if (s.status !== p.status) sync();
  });
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
    loadRequest++;
    offProject();
    offVcs();
    offPublishVcs();
    offPublishLists();
    clearPublished?.();
    clearTimeout(saveTimer);
    saveTimer = undefined;
  };
}
