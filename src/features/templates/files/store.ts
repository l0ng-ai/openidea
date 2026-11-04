/**
 * File and Code Templates: the built-ins plus the user's customisations, kept
 * per scheme as IDEA does. `Default` lives in the user's storage; `Project`
 * is a copy for the open project (keyed by its root), seeded from Default on
 * first use.
 */
import { create } from "zustand";
import { useProject } from "@/platform/project";
import { loadJson, saveJson } from "../storage";
import { BUILTIN_CODE_TEMPLATES, BUILTIN_FILE_TEMPLATES, BUILTIN_INCLUDES } from "./builtins";
import { fragmentResolver, type FileTemplate, type IncludeResolver, type TemplateFragment } from "./model";

export const FILE_TEMPLATES_KEY = "openidea.fileTemplates.v1";
const BUILTIN_IDS = new Set(BUILTIN_FILE_TEMPLATES.map((t) => t.id));
const BUILTIN_INCLUDE_NAMES = new Set(BUILTIN_INCLUDES.map((f) => f.name));

export type TemplateScheme = "default" | "project";

interface Customizations {
  templates: Record<string, FileTemplate>;
  deleted: string[];
  /** Includes by name: edited built-ins and the user's own. */
  includes: Record<string, TemplateFragment>;
  deletedIncludes: string[];
  /** Edited code template bodies by name. */
  code: Record<string, string>;
}

const EMPTY: Customizations = { templates: {}, deleted: [], includes: {}, deletedIncludes: [], code: {} };

/** Templates plugins contribute (`fileTemplates`): treated like built-ins (customised, reset, hidden). */
let contributed: readonly FileTemplate[] = [];

const isBase = (id: string) => BUILTIN_IDS.has(id) || contributed.some((t) => t.id === id);

export function mergeFileTemplates(c: Pick<Customizations, "templates" | "deleted">): FileTemplate[] {
  const deleted = new Set(c.deleted);
  const base = [...BUILTIN_FILE_TEMPLATES, ...contributed];
  const out = base.filter((t) => !deleted.has(t.id)).map((t) => c.templates[t.id] ?? t);
  for (const t of Object.values(c.templates)) if (!isBase(t.id) && !deleted.has(t.id)) out.push(t);
  return out;
}

/** Adds a plugin's template to the New menu until the returned function is called. */
export function addContributedFileTemplate(t: FileTemplate): () => void {
  contributed = [...contributed.filter((x) => x.id !== t.id), t];
  refreshMerged();
  return () => {
    contributed = contributed.filter((x) => x !== t);
    refreshMerged();
  };
}

function refreshMerged() {
  useFileTemplates.setState((s) => ({ templates: mergeFileTemplates(s.custom) }));
}

export function mergeIncludes(c: Pick<Customizations, "includes" | "deletedIncludes">): TemplateFragment[] {
  const deleted = new Set(c.deletedIncludes);
  const out = BUILTIN_INCLUDES.filter((f) => !deleted.has(f.name)).map((f) => c.includes[f.name] ?? f);
  for (const f of Object.values(c.includes))
    if (!BUILTIN_INCLUDE_NAMES.has(f.name) && !deleted.has(f.name)) out.push(f);
  return out;
}

export function mergeCodeTemplates(c: Pick<Customizations, "code">): TemplateFragment[] {
  return BUILTIN_CODE_TEMPLATES.map((f) => (f.name in c.code ? { ...f, body: c.code[f.name]! } : f));
}

const projectRoot = () => useProject.getState().project?.root ?? null;
const schemeKey = (root: string) => `${FILE_TEMPLATES_KEY}.scheme:${root}`;
const projectKey = (root: string) => `${FILE_TEMPLATES_KEY}.project:${root}`;

function readScheme(root: string | null): TemplateScheme {
  return root && loadJson<{ scheme: TemplateScheme }>(schemeKey(root), { scheme: "default" }).scheme === "project"
    ? "project"
    : "default";
}

const storageKey = (scheme: TemplateScheme, root: string | null) =>
  scheme === "project" && root ? projectKey(root) : FILE_TEMPLATES_KEY;

interface FileTemplatesState {
  scheme: TemplateScheme;
  root: string | null;
  custom: Customizations;
  templates: FileTemplate[];
  includes: TemplateFragment[];
  codeTemplates: TemplateFragment[];
}

function snapshot(root: string | null): FileTemplatesState {
  const scheme = readScheme(root);
  const custom = { ...EMPTY, ...loadJson<Partial<Customizations>>(storageKey(scheme, root), {}) } as Customizations;
  return {
    scheme,
    root,
    custom,
    templates: mergeFileTemplates(custom),
    includes: mergeIncludes(custom),
    codeTemplates: mergeCodeTemplates(custom),
  };
}

export const useFileTemplates = create<FileTemplatesState>(() => snapshot(projectRoot()));

function commit(custom: Customizations) {
  const { scheme, root } = useFileTemplates.getState();
  saveJson(storageKey(scheme, root), custom);
  useFileTemplates.setState({
    custom,
    templates: mergeFileTemplates(custom),
    includes: mergeIncludes(custom),
    codeTemplates: mergeCodeTemplates(custom),
  });
}

const custom = () => useFileTemplates.getState().custom;

export const fileTemplates = () => useFileTemplates.getState().templates;
export const isBuiltinFileTemplate = (id: string) => isBase(id);

/** `#parse` lookup over the current scheme's includes, then its code templates. */
export function templateIncludes(): IncludeResolver {
  const s = useFileTemplates.getState();
  return fragmentResolver(s.includes, s.codeTemplates);
}

export function saveFileTemplate(t: FileTemplate) {
  const c = custom();
  commit({ ...c, templates: { ...c.templates, [t.id]: t }, deleted: c.deleted.filter((d) => d !== t.id) });
}

export function removeFileTemplate(id: string) {
  const c = custom();
  const templates = { ...c.templates };
  delete templates[id];
  commit({ ...c, templates, deleted: isBase(id) ? [...new Set([...c.deleted, id])] : c.deleted });
}

export function resetFileTemplate(id: string) {
  const c = custom();
  const templates = { ...c.templates };
  delete templates[id];
  commit({ ...c, templates, deleted: c.deleted.filter((d) => d !== id) });
}

export function isModifiedFileTemplate(id: string): boolean {
  return isBase(id) && id in custom().templates;
}

/** Saves an include; `previous` is its name before a rename. */
export function saveInclude(f: TemplateFragment, previous = f.name) {
  const c = custom();
  const includes = { ...c.includes };
  let deleted = c.deletedIncludes.filter((d) => d !== f.name);
  if (previous !== f.name) {
    delete includes[previous];
    if (BUILTIN_INCLUDE_NAMES.has(previous)) deleted = [...new Set([...deleted, previous])];
  }
  commit({ ...c, includes: { ...includes, [f.name]: f }, deletedIncludes: deleted });
}

export function removeInclude(name: string) {
  const c = custom();
  const includes = { ...c.includes };
  delete includes[name];
  const deletedIncludes = BUILTIN_INCLUDE_NAMES.has(name)
    ? [...new Set([...c.deletedIncludes, name])]
    : c.deletedIncludes;
  commit({ ...c, includes, deletedIncludes });
}

export function resetInclude(name: string) {
  const c = custom();
  const includes = { ...c.includes };
  delete includes[name];
  commit({ ...c, includes, deletedIncludes: c.deletedIncludes.filter((d) => d !== name) });
}

export const isBuiltinInclude = (name: string) => BUILTIN_INCLUDE_NAMES.has(name);
export const isModifiedInclude = (name: string) => BUILTIN_INCLUDE_NAMES.has(name) && name in custom().includes;

export function saveCodeTemplate(name: string, body: string) {
  const c = custom();
  commit({ ...c, code: { ...c.code, [name]: body } });
}

export function resetCodeTemplate(name: string) {
  const c = custom();
  const code = { ...c.code };
  delete code[name];
  commit({ ...c, code });
}

export const isModifiedCodeTemplate = (name: string) => name in custom().code;

/**
 * Switches the open project between the Default and Project schemes. A
 * project scheme used for the first time starts as a copy of Default.
 */
export function setTemplateScheme(scheme: TemplateScheme) {
  const root = useFileTemplates.getState().root;
  if (!root) return;
  if (scheme === "project" && globalThis.localStorage?.getItem(projectKey(root)) == null)
    saveJson(projectKey(root), loadJson<Partial<Customizations>>(FILE_TEMPLATES_KEY, {}));
  saveJson(schemeKey(root), { scheme });
  useFileTemplates.setState(snapshot(root));
}

/** Re-reads customisations (changed by another window, or another project opened). */
export function reloadFileTemplates() {
  useFileTemplates.setState(snapshot(projectRoot()));
}

/** Follows the open project (its scheme and Project templates). */
export function watchTemplateProject(): () => void {
  return useProject.subscribe((s, prev) => {
    if (s.project?.root !== prev.project?.root) reloadFileTemplates();
  });
}
