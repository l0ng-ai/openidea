/**
 * Change lists: the default "Changes" list plus user lists in the Commit tool
 * window. Every changed file belongs to exactly one list (new changes go to the
 * active one); the state is persisted per project in `.openidea/changelists.json`.
 */
import { create } from "zustand";
import type {
  Changelist,
  ChangelistState,
  CommitApplySource,
  FileStatus,
  PendingChangelist,
  PendingCommitApply,
} from "@/bindings";
import { call, commands, isTauri } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { notifications, setLocalChanges, type LocalChangelist } from "@/workbench/contributions";
import type { CheckState } from "./changes";
import { checkOf, groupOf } from "./changes";
import { effectiveKind, relTo, stripSlash } from "./model";
import { localChangesMayBeAside, refreshNow, useVcs } from "./store";

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
  // Perforce changelists are told apart by number: two may share a description.
  if (perforceRoot()) return null;
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

// ---------------------------------------------------------------------------
// Perforce: the lists are the workspace's pending changelists. The server holds
// them, so they are read from it after every status change and an edit made in
// the UI is sent to it instead of being saved in the project.

/** The project's Perforce workspace root, when its primary VCS root is one. */
export function perforceRoot(): string | null {
  const { roots, kinds } = useVcs.getState();
  const root = roots[0];
  return root && kinds[root] === "perforce" ? root : null;
}

/** The changelist number behind a list id (0 = the default changelist). */
export function perforceChange(id: string): number {
  return id === DEFAULT_LIST_ID ? 0 : Number(id);
}

function describe(list: Changelist): string {
  const comment = list.comment?.trim();
  return comment ? `${list.name.trim()}\n${comment}` : list.name.trim();
}

/** Pending changelists as the lists of the Commit window; `active` is kept when it still exists. */
export function perforceState(pending: readonly PendingChangelist[], root: string, active: string): ChangelistState {
  const lists: Changelist[] = [];
  const files: Record<string, string> = {};
  for (const change of pending) {
    const id = change.number === 0 ? DEFAULT_LIST_ID : String(change.number);
    const [first = "", ...rest] = change.description.split("\n");
    lists.push({
      id,
      name: change.number === 0 ? "Default" : first.trim() || `Changelist ${change.number}`,
      comment: rest.join("\n").trim(),
    });
    for (const file of change.files) files[relTo(root, stripSlash(file.path))] = id;
  }
  if (!lists.length) lists.push({ id: DEFAULT_LIST_ID, name: "Default", comment: "" });
  return { lists, files, active: lists.some((l) => l.id === active) ? active : DEFAULT_LIST_ID };
}

let perforceLoad = 0;

async function loadPerforceChangelists(root: string): Promise<void> {
  const token = ++perforceLoad;
  try {
    const pending = await call(commands.p4Changelists(root));
    if (token !== perforceLoad || perforceRoot() !== root) return;
    useChangelists.setState({
      state: perforceState(pending, useVcs.getState().root ?? root, useChangelists.getState().state.active),
      loaded: true,
    });
  } catch (e) {
    if (token === perforceLoad) notifyPerforce("Cannot read Perforce changelists", e);
  }
}

function notifyPerforce(title: string, e: unknown) {
  notifications().notify({ group: "vcs", level: "error", title, body: e instanceof Error ? e.message : String(e) });
}

/** Sends the difference between two list states to the server, then reads its answer back. */
async function applyPerforce(root: string, cur: ChangelistState, next: ChangelistState): Promise<void> {
  const projectRoot = useVcs.getState().root ?? root;
  const abs = (rel: string) => (rel.startsWith("/") ? rel : `${projectRoot}/${rel}`);
  // The active list is the IDE's own notion; show it at once.
  useChangelists.setState({ state: { ...cur, active: next.active } });
  try {
    const created = new Map<string, number>();
    for (const list of next.lists) {
      if (cur.lists.some((l) => l.id === list.id)) continue;
      // oxlint-disable-next-line no-await-in-loop -- one p4 command at a time: each changes the same workspace
      created.set(list.id, await call(commands.p4ChangelistCreate(root, describe(list), [])));
    }
    const number = (id: string) => created.get(id) ?? perforceChange(id);
    for (const list of next.lists) {
      const before = cur.lists.find((l) => l.id === list.id);
      if (!before || list.id === DEFAULT_LIST_ID) continue;
      if (before.name !== list.name || before.comment !== list.comment)
        // oxlint-disable-next-line no-await-in-loop -- one p4 command at a time: each changes the same workspace
        await call(commands.p4ChangelistUpdate(root, perforceChange(list.id), describe(list)));
    }
    const moves = new Map<number, string[]>();
    for (const [rel, id] of Object.entries(next.files ?? {})) {
      const from = cur.files?.[rel];
      if (from === undefined || from === id) continue;
      const target = number(id);
      moves.set(target, [...(moves.get(target) ?? []), abs(rel)]);
    }
    // oxlint-disable-next-line no-await-in-loop -- files must reach their lists before an emptied list is deleted
    for (const [target, paths] of moves) await call(commands.p4Reopen(paths, target));
    for (const list of cur.lists) {
      if (list.id !== DEFAULT_LIST_ID && !next.lists.some((l) => l.id === list.id))
        // oxlint-disable-next-line no-await-in-loop -- one p4 command at a time: each changes the same workspace
        await call(commands.p4ChangelistDelete(root, perforceChange(list.id)));
    }
    const active = created.get(next.active);
    if (active !== undefined) useChangelists.setState((s) => ({ state: { ...s.state, active: String(active) } }));
  } catch (e) {
    notifyPerforce("Perforce changelist was not updated", e);
  }
  await loadPerforceChangelists(root);
  void refreshNow();
}

export function updateChangelists(fn: (s: ChangelistState) => ChangelistState) {
  const cur = useChangelists.getState().state;
  const next = fn(cur);
  if (next === cur) return;
  const perforce = perforceRoot();
  if (perforce) {
    void applyPerforce(perforce, cur, next);
    return;
  }
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
    if (!available || !root || !statusLoaded) return;
    const perforce = perforceRoot();
    if (perforce) {
      void loadPerforceChangelists(perforce);
      return;
    }
    if (!useChangelists.getState().loaded) return;
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
    if (s.status !== p.status || s.kinds !== p.kinds) sync();
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
