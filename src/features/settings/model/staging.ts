/**
 * Settings dialog state. Edits are staged per (scope, key) and only written on
 * Apply / OK as one `settingsSet(scope, key, json)` call per changed key, like
 * IDEA's Configurable `isModified` / `apply` / `reset` cycle.
 */
import { create } from "zustand";
import { call, commands, isTauri, type Settings } from "@/platform/ipc";
import { loadSettings, useProject } from "@/platform/project";
import { deepEqual, getAt, putAt, setAt, validateSettings, type ValidSettings } from "./schema";

export type Scope = "global" | "project";

export interface StagedChange {
  scope: Scope;
  key: string;
  value: unknown;
  /** Page that made the change (Reset discards per page). */
  page: string;
}

interface ExternalChange {
  page: string;
  value: unknown;
  apply(): Promise<unknown>;
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
  /** SSH credentials stay outside settings JSON until Apply / OK. */
  stagedSecrets: Record<string, string>;
  stagedExternal: Record<string, ExternalChange>;
  /** Values written outside settings JSON since opening the dialog. */
  externalApplied: Record<string, unknown>;
  /** Scope chosen per page (Global / This project). */
  scopes: Record<string, Scope>;
  saving: boolean;
  error: string | null;
}

export const DEFAULT_PAGE = "appearance";
export const SSH_SETTINGS_PAGE = "tools.sshConfigurations";

export const useSettingsDialog = create<SettingsDialogState>(() => ({
  open: false,
  pageId: DEFAULT_PAGE,
  focus: null,
  query: "",
  base: validateSettings(undefined),
  globalBase: validateSettings(undefined),
  newProjects: false,
  staged: {},
  stagedSecrets: {},
  stagedExternal: {},
  externalApplied: {},
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
    stagedSecrets: {},
    stagedExternal: {},
    externalApplied: {},
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
  useSettingsDialog.setState({
    open: false,
    staged: {},
    stagedSecrets: {},
    stagedExternal: {},
    externalApplied: {},
    error: null,
    saving: false,
  });
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

const isInside = (key: string, parent: string) => key.startsWith(`${parent}.`);

/**
 * Current value of `key` as the page shows it: staged edit, else the effective
 * value. Edits staged for a parent (a whole map entry) or inside `key` (one
 * field of it) show through too.
 */
export function stagedValue(s: Bases & Pick<SettingsDialogState, "staged">, scope: Scope, key: string): unknown {
  const hit = s.staged[stageKey(scope, key)];
  if (hit) return hit.value;
  const related = Object.values(s.staged).filter(
    (c) => c.scope === scope && (isInside(key, c.key) || isInside(c.key, key)),
  );
  let value = getAt(baseFor(s, scope), key);
  for (const c of related.sort((a, b) => a.key.length - b.key.length)) {
    value = isInside(key, c.key)
      ? (getAt(c.value, key.slice(c.key.length + 1)) ?? undefined)
      : putAt(value, c.key.slice(key.length + 1), c.value);
  }
  return value;
}

/**
 * Stages `value` for `key`; `null` removes the key on Apply. An edit inside an
 * entry staged as a whole (a map entry just added) goes into that entry; a new
 * value for `key` drops the edits staged inside it.
 */
export function stage(page: string, scope: Scope, key: string, value: unknown) {
  useSettingsDialog.setState((s) => {
    const staged = { ...s.staged };
    const parent = Object.values(staged).find((c) => c.scope === scope && isInside(key, c.key));
    if (parent) {
      const merged = putAt(parent.value, key.slice(parent.key.length + 1), value);
      staged[stageKey(scope, parent.key)] = { ...parent, value: merged };
      return { staged, error: null };
    }
    for (const [id, c] of Object.entries(staged)) if (c.scope === scope && isInside(c.key, key)) delete staged[id];
    const id = stageKey(scope, key);
    const next = value === undefined ? null : value;
    // Back to the scope's current value: nothing to write.
    if (deepEqual(next ?? undefined, getAt(baseFor(s, scope), key))) delete staged[id];
    else staged[id] = { scope, key, value: next, page };
    return { staged, error: null };
  });
}

/** An empty field leaves the stored credential unchanged. */
export function stageSshSecret(id: string, value: string) {
  useSettingsDialog.setState((s) => {
    const stagedSecrets = { ...s.stagedSecrets };
    if (value) stagedSecrets[id] = value;
    else delete stagedSecrets[id];
    return { stagedSecrets, error: null };
  });
}

export const externalKey = (page: string, key: string) => `${page}|${key}`;

export function stageExternal<T>(page: string, key: string, value: T, base: T, apply: (value: T) => Promise<T>) {
  useSettingsDialog.setState((s) => {
    if (s.saving) return {};
    const stagedExternal = { ...s.stagedExternal };
    const id = externalKey(page, key);
    if (deepEqual(value, base)) delete stagedExternal[id];
    else stagedExternal[id] = { page, value, apply: () => apply(value) };
    return { stagedExternal, error: null };
  });
}

/** Discards staged edits of one page (the dialog's Reset button). */
export function resetPage(page: string) {
  useSettingsDialog.setState((s) => ({
    staged: Object.fromEntries(Object.entries(s.staged).filter(([, c]) => c.page !== page)),
    stagedSecrets: page === SSH_SETTINGS_PAGE ? {} : s.stagedSecrets,
    stagedExternal: Object.fromEntries(Object.entries(s.stagedExternal).filter(([, c]) => c.page !== page)),
    error: null,
  }));
}

/** Writes to perform, global layer first so a project value still wins afterwards. */
export function pendingChanges(s: Bases & Pick<SettingsDialogState, "staged">): StagedChange[] {
  return Object.values(s.staged)
    .filter((c) => !deepEqual(c.value ?? undefined, getAt(baseFor(s, c.scope), c.key)))
    .sort((a, b) => (a.scope === b.scope ? a.key.localeCompare(b.key) : a.scope === "global" ? -1 : 1));
}

export interface PersistDeps {
  set(scope: Scope, key: string, json: string): Promise<Settings>;
  setSecret(id: string, secret: string, save: boolean): Promise<void>;
  /** Re-reads effective settings into `useProject`. */
  reload(): Promise<void>;
  /** Without a backend (plain browser) changes apply to the session only. */
  backend: boolean;
}

const defaultDeps = (): PersistDeps => ({
  set: (scope, key, json) => call(commands.settingsSet(scope, key, json)),
  setSecret: (id, secret, save) => commands.sshSetSecret(id, secret, save),
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
export async function applySettings(deps: PersistDeps = defaultDeps()): Promise<boolean> {
  const initial = useSettingsDialog.getState();
  if (initial.saving) return false;
  const changes = pendingChanges(initial);
  const secrets = Object.entries(initial.stagedSecrets);
  const external = Object.entries(initial.stagedExternal);
  if (!changes.length && !secrets.length && !external.length) return true;
  useSettingsDialog.setState({ saving: true, error: null });
  const result = await persistChanges(changes, deps);
  const { written } = result;
  let { error } = result;
  const done = new Set(written);
  const base = validateSettings(useProject.getState().settings);
  useSettingsDialog.setState((st) => ({
    base,
    // Written global values right away; the backend's copy follows.
    globalBase: useProject.getState().project
      ? changes
          .filter((c) => c.scope === "global" && done.has(stageKey(c.scope, c.key)))
          .reduce((g, c) => putAt(g, c.key, c.value), st.globalBase)
      : base,
    staged: Object.fromEntries(Object.entries(st.staged).filter(([k]) => !done.has(k))),
  }));
  await loadGlobalBase();
  if (!error) {
    for (const [id, secret] of secrets) {
      const current = useSettingsDialog.getState();
      const config = current.globalBase.ssh.configs.find((c) => c.id === id);
      // A removed configuration or discarded credential must never be written.
      if (current.stagedSecrets[id] !== secret) continue;
      try {
        if (config && config.auth !== "openSsh" && deps.backend) {
          await deps.setSecret(id, secret, config.saveSecret);
        }
        useSettingsDialog.setState((s) => {
          const stagedSecrets = { ...s.stagedSecrets };
          if (stagedSecrets[id] === secret) delete stagedSecrets[id];
          return { stagedSecrets };
        });
      } catch (e) {
        error = `SSH secret: ${e instanceof Error ? e.message : String(e)}`;
        break;
      }
    }
  }
  if (!error) {
    for (const [id, change] of external) {
      if (useSettingsDialog.getState().stagedExternal[id] !== change) continue;
      try {
        const value = await change.apply();
        useSettingsDialog.setState((s) => {
          const stagedExternal = { ...s.stagedExternal };
          if (stagedExternal[id] === change) delete stagedExternal[id];
          return { stagedExternal, externalApplied: { ...s.externalApplied, [id]: value } };
        });
      } catch (e) {
        error = `${id}: ${e instanceof Error ? e.message : String(e)}`;
        break;
      }
    }
  }
  useSettingsDialog.setState({ saving: false, error });
  return error === null;
}
