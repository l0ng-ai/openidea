/**
 * Documents of custom editor kinds (`EditorKindContribution.document`, e.g.
 * notebooks): one per input key, however many tabs and splits show it. The
 * editor controller keeps them alive while any tab shows the key and closes
 * them after the last one goes.
 */
import type { EditorDocumentLifecycle, EditorInput, EditorKindContribution } from "@/workbench/contributions";
import { openKeys, paneIds, type TabsState } from "./tabs";

export interface CustomDocument {
  input: EditorInput;
  lifecycle: EditorDocumentLifecycle;
}

type Kinds = ReadonlyMap<string, EditorKindContribution>;

export function documentLifecycle(input: EditorInput, kinds: Kinds): EditorDocumentLifecycle | undefined {
  return kinds.get(input.kind)?.document;
}

/** Open custom documents by input key, in visual tab order (the first tab's input). */
export function customDocuments(s: TabsState, kinds: Kinds): Map<string, CustomDocument> {
  const out = new Map<string, CustomDocument>();
  for (const id of paneIds(s))
    for (const t of s.panes[id]?.tabs ?? []) {
      if (out.has(t.input.key)) continue;
      const lifecycle = documentLifecycle(t.input, kinds);
      if (lifecycle) out.set(t.input.key, { input: t.input, lifecycle });
    }
  return out;
}

/** Custom documents open in `prev` that no tab of `next` shows any more. */
export function closedDocuments(prev: TabsState, next: TabsState, kinds: Kinds): CustomDocument[] {
  const open = openKeys(next);
  return [...customDocuments(prev, kinds).values()].filter((d) => !open.has(d.input.key));
}

/** Unsaved changes; a failing check counts as unsaved so nothing is dropped on its word. */
export function documentDirty(d: CustomDocument): boolean {
  try {
    return d.lifecycle.isDirty(d.input);
  } catch (e) {
    console.warn(`editor document ${d.input.key}: isDirty failed`, e);
    return true;
  }
}

/** Whether the tab's input is a custom document with unsaved changes; null when it is no custom document. */
export function inputDirty(input: EditorInput, kinds: Kinds): boolean | null {
  const lifecycle = documentLifecycle(input, kinds);
  return lifecycle ? documentDirty({ input, lifecycle }) : null;
}

/** The rejection reasons of `results` (an AggregateError contributes each of its errors). */
export function failures(results: readonly PromiseSettledResult<unknown>[]): unknown[] {
  return results.flatMap((r) =>
    r.status === "fulfilled" ? [] : r.reason instanceof AggregateError ? r.reason.errors : [r.reason],
  );
}

/** One error for `errors` (non-empty): itself when single, else an AggregateError with the first message. */
export function combinedError(errors: readonly unknown[]): unknown {
  if (errors.length === 1) return errors[0];
  const first = errors[0];
  return new AggregateError(errors, first instanceof Error ? first.message : String(first));
}
