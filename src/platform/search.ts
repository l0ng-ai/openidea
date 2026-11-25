/**
 * Search pieces shared by Find / Replace in the editor and Find in Files:
 * the search context filter, Preserve Case, the recent-search history and the
 * user's custom (named) scopes, persisted per project.
 */
import { useEffect } from "react";
import { create } from "zustand";
import type { SearchContext } from "./ipc";
import { useProject } from "./project";

export type { SearchContext };

/** IDEA's search context filter: anywhere, only / except comments and string literals. */
export const SEARCH_CONTEXTS: ReadonlyArray<{ value: SearchContext; label: string }> = [
  { value: "any", label: "Anywhere" },
  { value: "inComments", label: "In Comments" },
  { value: "inStringLiterals", label: "In String Literals" },
  { value: "exceptComments", label: "Except Comments" },
  { value: "exceptStringLiterals", label: "Except String Literals" },
  { value: "exceptCommentsAndStringLiterals", label: "Except Comments and String Literals" },
];

export type LiteralKind = "comment" | "string";

/** Whether a match starting in `kind` (`null`: plain code) is kept (as the backend's `SearchContext::accepts`). */
export function contextAccepts(context: SearchContext, kind: LiteralKind | null): boolean {
  switch (context) {
    case "any":
      return true;
    case "inComments":
      return kind === "comment";
    case "inStringLiterals":
      return kind === "string";
    case "exceptComments":
      return kind !== "comment";
    case "exceptStringLiterals":
      return kind !== "string";
    case "exceptCommentsAndStringLiterals":
      return kind === null;
  }
}

/** IDEA's "Preserve case" (same rules as the backend's `preserve_case`). */
export function preserveCase(found: string, replacement: string): string {
  const letters = [...found].filter((c) => c.toLowerCase() !== c.toUpperCase());
  const first = letters[0];
  if (!first || !replacement) return replacement;
  const isUpper = (c: string) => c === c.toUpperCase() && c !== c.toLowerCase();
  if (letters.length > 1 && letters.every(isUpper)) return replacement.toUpperCase();
  const [head = "", ...rest] = [...replacement];
  return (isUpper(first) ? head.toUpperCase() : head.toLowerCase()) + rest.join("");
}

function load(key: string): unknown {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function save(key: string, value: unknown) {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}

/**
 * `key` for the open project: search history names the project's identifiers, so each project
 * keeps its own (IDEA stores it in the project's workspace). Without a project, `key` itself.
 */
export function projectKey(key: string): string {
  const root = useProject.getState().project?.root;
  return root ? `${key}:${root}` : key;
}

const HISTORY_KEYS = { find: "openidea.search.findHistory.v1", replace: "openidea.search.replaceHistory.v1" };
const MAX_HISTORY = 20;

/** Recent search (or replace) strings of the open project, newest first; shared by the find bar and Find in Files. */
export function searchHistory(kind: "find" | "replace"): string[] {
  const v = load(projectKey(HISTORY_KEYS[kind]));
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export function rememberSearch(kind: "find" | "replace", text: string) {
  if (!text.trim()) return;
  save(projectKey(HISTORY_KEYS[kind]), [text, ...searchHistory(kind).filter((x) => x !== text)].slice(0, MAX_HISTORY));
}

/**
 * A user-defined scope: a name and an IDEA-style pattern
 * (`file:src//*.ts&&!file:*test*`), matched by the backend (`SearchScope::Pattern`).
 */
export interface CustomScope {
  name: string;
  pattern: string;
}

interface CustomScopesState {
  /** Project the scopes belong to. */
  root: string | null;
  scopes: CustomScope[];
}

export const useCustomScopes = create<CustomScopesState>(() => ({ root: null, scopes: [] }));

const scopesKey = (root: string) => `openidea.scopes.v1:${root}`;

function validScopes(v: unknown): CustomScope[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((x) => {
    const s = x as Partial<CustomScope> | null;
    return s && typeof s.name === "string" && typeof s.pattern === "string" && s.name.trim()
      ? [{ name: s.name, pattern: s.pattern }]
      : [];
  });
}

/** Custom scopes of the open project (loaded on first use after the project changes). */
export function customScopes(): CustomScope[] {
  const root = useProject.getState().project?.root ?? null;
  const s = useCustomScopes.getState();
  if (s.root === root) return s.scopes;
  const scopes = root ? validScopes(load(scopesKey(root))) : [];
  useCustomScopes.setState({ root, scopes });
  return scopes;
}

/** Reactive {@link customScopes}. */
export function useCustomScopeList(): CustomScope[] {
  const root = useProject((p) => p.project?.root ?? null);
  const state = useCustomScopes();
  const stale = state.root !== root;
  useEffect(() => {
    if (stale) customScopes();
  }, [stale]);
  return stale ? NO_SCOPES : state.scopes;
}

const NO_SCOPES: CustomScope[] = [];

export function saveCustomScopes(scopes: CustomScope[]) {
  const root = useProject.getState().project?.root ?? null;
  const clean = validScopes(scopes).map((s) => ({ name: s.name.trim(), pattern: s.pattern.trim() }));
  useCustomScopes.setState({ root, scopes: clean });
  if (root) save(scopesKey(root), clean);
}

export function findCustomScope(name: string): CustomScope | null {
  return customScopes().find((s) => s.name === name) ?? null;
}

/** Action that opens the scope editor (registered by the search feature); `arg`: `{ select?: string }`. */
export const EDIT_SCOPES_ACTION = "search.editScopes";
