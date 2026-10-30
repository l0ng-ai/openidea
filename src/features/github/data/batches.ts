/**
 * Incrementally loaded lists (IntelliJ's `BatchesLoader` / `IncrementallyComputedValue`):
 * pages are appended as they arrive, so choosers show the first users while the rest load.
 * A list loads once and stays cached until `reset()`.
 */
import { create, type StoreApi, type UseBoundStore } from "zustand";
import { errorMessage } from "../api/client";

export interface BatchesState<T> {
  items: T[];
  /** A page is being fetched. */
  loading: boolean;
  /** Every page arrived. */
  done: boolean;
  error: string | null;
}

export interface BatchesLoader<T> {
  store: UseBoundStore<StoreApi<BatchesState<T>>>;
  /** Starts loading unless loaded or loading; resolves with every item (rejects on failure). */
  load(): Promise<T[]>;
  /** Forgets the items; the next `load()` starts over. */
  reset(): void;
}

const initial = <T>(): BatchesState<T> => ({ items: [], loading: false, done: false, error: null });

/** A loader fetching `page(cursor)` from `first` until `next` is null. */
export function createBatchesLoader<T, C>(
  first: C,
  page: (cursor: C) => Promise<{ items: T[]; next: C | null }>,
): BatchesLoader<T> {
  const store = create<BatchesState<T>>(() => initial<T>());
  let run: Promise<T[]> | null = null;
  let generation = 0;
  const load = () => {
    if (run) return run;
    const gen = ++generation;
    const alive = () => gen === generation;
    store.setState({ ...initial<T>(), loading: true });
    run = (async () => {
      let cursor: C | null = first;
      try {
        while (cursor !== null) {
          const r: { items: T[]; next: C | null } = await page(cursor);
          if (!alive()) return store.getState().items;
          store.setState((s) => ({ items: [...s.items, ...r.items] }));
          cursor = r.next;
        }
        if (alive()) store.setState({ loading: false, done: true });
        return store.getState().items;
      } catch (e) {
        if (alive()) {
          store.setState({ loading: false, error: errorMessage(e) });
          run = null;
        }
        throw e;
      }
    })();
    return run;
  };
  const reset = () => {
    generation++;
    run = null;
    store.setState(initial<T>());
  };
  return { store, load, reset };
}

/** Merges several loaders' states (potential reviewers: teams + users), keeping their order. */
export function mergeBatches<T>(states: ReadonlyArray<BatchesState<T>>): BatchesState<T> {
  return {
    items: states.flatMap((s) => s.items),
    loading: states.some((s) => s.loading),
    done: states.every((s) => s.done),
    error: states.find((s) => s.error)?.error ?? null,
  };
}
