/** A Settings dialog stand-in: a page's form over plain values, staging into `staged`. */
import { useMemo, type ReactNode } from "react";
import { create } from "zustand";
import { SettingsFormContext, type SettingsForm } from "@/workbench/contributions";

interface FormState {
  values: Record<string, unknown>;
  /** Staged writes in order, as `settingsSet` would get them on Apply. */
  staged: Array<[string, unknown]>;
}

export const useTestForm = create<FormState>(() => ({ values: {}, staged: [] }));

const getAt = (v: unknown, key: string) =>
  key
    .split(".")
    .reduce<unknown>((cur, k) => (cur && typeof cur === "object" ? (cur as Record<string, unknown>)[k] : undefined), v);

function putAt(source: unknown, key: string, value: unknown): Record<string, unknown> {
  const [head, ...rest] = key.split(".");
  const base = { ...(source as Record<string, unknown> | undefined) };
  if (rest.length) base[head!] = putAt(base[head!], rest.join("."), value);
  else if (value == null) delete base[head!];
  else base[head!] = value;
  return base;
}

export function resetTestForm(values: Record<string, unknown> = {}) {
  useTestForm.setState({ values, staged: [] });
}

/** The last value staged for `key`. */
export function stagedFor(key: string): unknown {
  return useTestForm.getState().staged.findLast(([k]) => k === key)?.[1];
}

export function TestSettingsForm({ children }: { children: ReactNode }) {
  const form = useMemo<SettingsForm>(
    () => ({
      scope: "global",
      useValue: (key) => useTestForm((s) => getAt(s.values, key)),
      set: (key, value) =>
        useTestForm.setState((s) => ({ values: putAt(s.values, key, value), staged: [...s.staged, [key, value]] })),
    }),
    [],
  );
  return <SettingsFormContext.Provider value={form}>{children}</SettingsFormContext.Provider>;
}
