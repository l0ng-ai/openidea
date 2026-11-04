/** Page context for the form components: which page / scope they edit and the search query. */
import { createContext, useCallback, useContext, useMemo } from "react";
import type { SettingsForm } from "@/workbench/contributions";
import { externalKey, stage, stageExternal, stagedValue, useSettingsDialog, type Scope } from "../model/staging";
import { labelMatches } from "../model/pages";

export interface PageContextValue {
  pageId: string;
  scope: Scope;
}

export const PageContext = createContext<PageContextValue>({ pageId: "", scope: "global" });

export function usePageContext(): PageContextValue {
  return useContext(PageContext);
}

/** Staged value of a settings key plus a setter that stages edits for this page's scope. */
export function useSetting<T>(key: string, scopeOverride?: Scope): [T, (value: T) => void] {
  const { pageId, scope: pageScope } = usePageContext();
  const scope = scopeOverride ?? pageScope;
  const value = useStagedValue(scope, key) as T;
  const set = useCallback((v: T) => stage(pageId, scope, key, v), [pageId, scope, key]);
  return [value, set];
}

/** `stagedValue` for components; recomputed only when the base or the staged edits change. */
export function useStagedValue(scope: Scope, key: string): unknown {
  const base = useSettingsDialog((s) => (scope === "global" ? s.globalBase : s.base));
  const staged = useSettingsDialog((s) => s.staged);
  return useMemo(() => stagedValue({ base, globalBase: base, staged }, scope, key), [base, staged, scope, key]);
}

/** The form contributed pages edit through (`useSettingsForm`). */
export function useSettingsFormFor(pageId: string, scope: Scope): SettingsForm {
  return useMemo(
    () => ({
      scope,
      useValue: (key: string) => useStagedValue(scope, key),
      set: (key: string, value: unknown) => stage(pageId, scope, key, value),
      useExternal: <T>(key: string, base: T, apply: (value: T) => Promise<T>) =>
        useExternalValue(pageId, key, base, apply),
    }),
    [pageId, scope],
  );
}

function useExternalValue<T>(page: string, key: string, base: T, apply: (value: T) => Promise<T>) {
  const id = externalKey(page, key);
  const staged = useSettingsDialog((s) => s.stagedExternal[id]);
  const current = useSettingsDialog((s) => (id in s.externalApplied ? (s.externalApplied[id] as T) : base));
  const saving = useSettingsDialog((s) => s.saving);
  return {
    value: staged ? (staged.value as T) : current,
    current,
    set: (value: T) => stageExternal(page, key, value, current, apply),
    saving,
  };
}

export function useSearchQuery(): string {
  return useSettingsDialog((s) => s.query);
}

/** Whether `label` should be highlighted for the current search. */
export function useLabelMatch(label: string | undefined): boolean {
  const q = useSearchQuery();
  return !!label && labelMatches(label, q);
}
