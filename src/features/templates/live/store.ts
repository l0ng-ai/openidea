/**
 * Effective live templates: built-ins with the user's edits applied plus
 * user-defined templates, persisted globally in localStorage.
 */
import { create } from "zustand";
import { loadJson, saveJson } from "../storage";
import { BUILTIN_TEMPLATES, BUILTIN_IDS } from "./builtins";
import type { LiveTemplate } from "./model";

export const LIVE_TEMPLATES_KEY = "openidea.liveTemplates.v1";
const KEY = LIVE_TEMPLATES_KEY;

export interface LiveTemplateCustomizations {
  /** Edited built-ins and user templates, by id. */
  templates: Record<string, LiveTemplate>;
  /** Removed built-ins. */
  deleted: string[];
}

export function mergeTemplates(builtins: readonly LiveTemplate[], c: LiveTemplateCustomizations): LiveTemplate[] {
  const deleted = new Set(c.deleted);
  const out = builtins.filter((t) => !deleted.has(t.id)).map((t) => c.templates[t.id] ?? t);
  for (const t of Object.values(c.templates)) if (!BUILTIN_IDS.has(t.id) && !deleted.has(t.id)) out.push(t);
  return out;
}

interface State {
  custom: LiveTemplateCustomizations;
  templates: LiveTemplate[];
}

const initial = loadJson<LiveTemplateCustomizations>(KEY, { templates: {}, deleted: [] });

export const useLiveTemplates = create<State>(() => ({
  custom: initial,
  templates: mergeTemplates(BUILTIN_TEMPLATES, initial),
}));

function commit(custom: LiveTemplateCustomizations) {
  saveJson(KEY, custom);
  useLiveTemplates.setState({ custom, templates: mergeTemplates(BUILTIN_TEMPLATES, custom) });
}

export function liveTemplates(): LiveTemplate[] {
  return useLiveTemplates.getState().templates;
}

export function saveTemplate(t: LiveTemplate) {
  const c = useLiveTemplates.getState().custom;
  commit({ ...c, templates: { ...c.templates, [t.id]: t }, deleted: c.deleted.filter((d) => d !== t.id) });
}

export function removeTemplate(id: string) {
  const c = useLiveTemplates.getState().custom;
  const templates = { ...c.templates };
  delete templates[id];
  commit({ templates, deleted: BUILTIN_IDS.has(id) ? [...new Set([...c.deleted, id])] : c.deleted });
}

/** Drops the user's edits of a built-in (or restores a deleted one). */
export function resetTemplate(id: string) {
  const c = useLiveTemplates.getState().custom;
  const templates = { ...c.templates };
  delete templates[id];
  commit({ templates, deleted: c.deleted.filter((d) => d !== id) });
}

export function isModifiedBuiltin(id: string): boolean {
  return BUILTIN_IDS.has(id) && id in useLiveTemplates.getState().custom.templates;
}

export function newTemplateId(): string {
  return `user.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

// ---------------------------------------------------------------------------
// Options

export const LIVE_TEMPLATE_OPTIONS_KEY = "openidea.liveTemplates.options.v1";
const OPTIONS_KEY = LIVE_TEMPLATE_OPTIONS_KEY;

export interface LiveTemplateOptions {
  /** Expand abbreviations with Tab. */
  expandWithTab: boolean;
  /** Offer live templates in the completion list. */
  showInCompletion: boolean;
}

export const useLiveTemplateOptions = create<LiveTemplateOptions>(() =>
  loadJson(OPTIONS_KEY, { expandWithTab: true, showInCompletion: true }),
);

export function updateLiveTemplateOptions(patch: Partial<LiveTemplateOptions>) {
  useLiveTemplateOptions.setState(patch);
  const { expandWithTab, showInCompletion } = useLiveTemplateOptions.getState();
  saveJson(OPTIONS_KEY, { expandWithTab, showInCompletion });
}

/** Re-reads templates and options (changed by another window). */
export function reloadLiveTemplates() {
  const custom = loadJson<LiveTemplateCustomizations>(KEY, { templates: {}, deleted: [] });
  useLiveTemplates.setState({ custom, templates: mergeTemplates(BUILTIN_TEMPLATES, custom) });
  useLiveTemplateOptions.setState(loadJson(OPTIONS_KEY, { expandWithTab: true, showInCompletion: true }));
}
