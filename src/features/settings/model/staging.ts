/**
 * Settings dialog state. Edits are staged per (scope, key) and only written on
 * Apply / OK as one `settingsSet(scope, key, json)` call per changed key, like
 * IDEA's Configurable `isModified` / `apply` / `reset` cycle.
 */
import { create } from "zustand";
import { call, commands, isTauri, type Settings } from "@/platform/ipc";
import { loadSettings, useProject } from "@/platform/project";
import { deepEqual, getAt, setAt, validateSettings, type ValidSettings } from "./schema";

export type Scope = "global" | "project";

export interface StagedChange {
  scope: Scope;
  key: string;
  value: unknown;
  /** Page that made the change (Reset discards per page). */
  page: string;
}

export interface SettingsDialogState {
  open: boolean;
  pageId: string;
  /** What the page should select when opened as `page#focus` (an inspection id). */
  focus: string | null;
  query: string;
  /** Effective settings when the dialog opened / last applied. */
  base: ValidSettings;
  /** Defaults + global layer (no project values): what the Global scope edits. */
  globalBase: ValidSettings;
  /** "Settings for New Projects": every page edits the global layer. */
  newProjects: boolean;
  staged: Record<string, StagedChange>;
  /** Scope chosen per page (Global / This project). */
  scopes: Record<string, Scope>;
  saving: boolean;
  error: string | null;
}

export const DEFAULT_PAGE = "appearance";

export const useSettingsDialog = create<SettingsDialogState>(() => ({
  open: false,
  pageId: DEFAULT_PAGE,
  focus: null,
  query: "",
  base: validateSettings(undefined),
  globalBase: validateSettings(undefined),
  newProjects: false,
  staged: {},
  scopes: {},
  saving: false,
  error: null,
}));

const stageKey = (scope: Scope, key: string) => `${scope}|${key}`;

/** `page#focus` → the page and what to select on it. */
export function splitPageTarget(target: string): { pageId: string; focus: string | null } {
  const i = target.indexOf("#");
  return i < 0 ? { pageId: target, focus: null } : { pageId: target.slice(0, i), focus: target.slice(i + 1) || null };
}

export function openSettings(pageId?: string, opts: { newProjects?: boolean } = {}) {
  const s = useSettingsDialog.getState();
  const base = validateSettings(useProject.getState().settings);
  const target = pageId ? splitPageTarget(pageId) : { pageId: s.pageId, focus: null };
  useSettingsDialog.setState({
    open: true,
    pageId: target.pageId,
    focus: target.focus,
    query: "",
    base,
    globalBase: base,
    newProjects: opts.newProjects ?? false,
    staged: {},
    saving: false,
    error: null,
  });
  void loadGlobalBase();
}

/** With a project open the effective settings include its values; the Global scope shows the global layer. */
async function loadGlobalBase() {
  if (!isTauri() || !useProject.getState().project) return;
  try {
    const globalBase = validateSettings(await commands.settingsGetGlobal());
    useSettingsDialog.setState((s) => (s.open ? { globalBase } : {}));
  } catch (e) {
    console.warn("cannot load global settings", e);
  }
}

/** IDEA's File › New Projects Setup › Settings for New Projects. */
export const settingsTitle = (newProjects: boolean) => (newProjects ? "Settings for New Projects" : "Settings");

export function setNewProjects(newProjects: boolean) {
  useSettingsDialog.setState({ newProjects });
}

type Bases = Pick<SettingsDialogState, "base" | "globalBase">;

const baseFor = (s: Bases, scope: Scope) => (scope === "global" ? s.globalBase : s.base);

export function closeSettings() {
  useSettingsDialog.setState({ open: false, staged: {}, error: null, saving: false });
}

/** Shows `pageId` (`page#focus` also selects `focus` on it). */
export function selectPage(pageId: string) {
  useSettingsDialog.setState(splitPageTarget(pageId));
}

export function setQuery(query: string) {
  useSettingsDialog.setState({ query });
}

export function setPageScope(pageId: string, scope: Scope) {
  useSettingsDialog.setState((s) => ({ scopes: { ...s.scopes, [pageId]: scope } }));
}

/** Current value of `key` as the page shows it: staged edit, else the effective value. */
export function stagedValue(s: Bases & Pick<SettingsDialogState, "staged">, scope: Scope, key: string): unknown {
  const hit = s.staged[stageKey(scope, key)];
  return hit ? hit.value : getAt(baseFor(s, scope), key);
}

export function stage(page: string, scope: Scope, key: string, value: unknown) {
  useSettingsDialog.setState((s) => {
    const staged = { ...s.staged };
    const id = stageKey(scope, key);
    // Back to the scope's current value: nothing to write.
    if (deepEqual(value, getAt(baseFor(s, scope), key))) delete staged[id];
    else staged[id] = { scope, key, value, page };
    return { staged, error: null };
  });
}

/** Discards staged edits of one page (the dialog's Reset button). */
export function resetPage(page: string) {
  useSettingsDialog.setState((s) => ({
    staged: Object.fromEntries(Object.entries(s.staged).filter(([, c]) => c.page !== page)),
    error: null,
  }));
}

/** Writes to perform, global layer first so a project value still wins afterwards. */
export function pendingChanges(s: Bases & Pick<SettingsDialogState, "staged">): StagedChange[] {
  return Object.values(s.staged)
    .filter((c) => !deepEqual(c.value, getAt(baseFor(s, c.scope), c.key)))
    .sort((a, b) => (a.scope === b.scope ? a.key.localeCompare(b.key) : a.scope === "global" ? -1 : 1));
}

export interface PersistDeps {
  set(scope: Scope, key: string, json: string): Promise<Settings>;
  /** Re-reads effective settings into `useProject`. */
  reload(): Promise<void>;
  /** Without a backend (plain browser) changes apply to the session only. */
  backend: boolean;
}

const defaultDeps = (): PersistDeps => ({
  set: (scope, key, json) => call(commands.settingsSet(scope, key, json)),
  reload: loadSettings,
  backend: isTauri(),
});

export interface PersistResult {
  /** Stage ids (`scope|key`) that were written. */
  written: string[];
  error: string | null;
}

/** Persists `changes` in order, stopping at the first failure (earlier writes stay, as in IDEA). */
export async function persistChanges(
  changes: StagedChange[],
  deps: PersistDeps = defaultDeps(),
): Promise<PersistResult> {
  const written: string[] = [];
  if (!deps.backend) {
    let settings = (useProject.getState().settings ?? {}) as Settings;
    for (const c of changes) {
      settings = setAt(settings, c.key, c.value);
      written.push(stageKey(c.scope, c.key));
    }
    useProject.setState({ settings });
    return { written, error: null };
  }
  let error: string | null = null;
  for (const c of changes) {
    try {
      const settings = await deps.set(c.scope, c.key, JSON.stringify(c.value));
      useProject.setState({ settings });
      written.push(stageKey(c.scope, c.key));
    } catch (e) {
      error = `${c.key}: ${e instanceof Error ? e.message : String(e)}`;
      break;
    }
  }
  if (written.length) await deps.reload().catch(() => {});
  return { written, error };
}

/** Apply: writes pending changes; returns whether everything was saved. */
export async function applySettings(deps?: PersistDeps): Promise<boolean> {
  const changes = pendingChanges(useSettingsDialog.getState());
  if (!changes.length) return true;
  useSettingsDialog.setState({ saving: true, error: null });
  const { written, error } = await persistChanges(changes, deps);
  const done = new Set(written);
  const base = validateSettings(useProject.getState().settings);
  useSettingsDialog.setState((st) => ({
    saving: false,
    error,
    base,
    // Written global values right away; the backend's copy follows.
    globalBase: useProject.getState().project
      ? changes
          .filter((c) => c.scope === "global" && done.has(stageKey(c.scope, c.key)))
          .reduce((g, c) => setAt(g, c.key, c.value), st.globalBase)
      : base,
    staged: Object.fromEntries(Object.entries(st.staged).filter(([k]) => !done.has(k))),
  }));
  await loadGlobalBase();
  return error === null;
}
