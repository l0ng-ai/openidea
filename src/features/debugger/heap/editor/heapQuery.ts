import { useEffect, useEffectEvent, useState } from "react";
import { tx } from "@/platform/i18n";
import { IpcError } from "@/platform/ipc";

/** The host answers `notFound` for a snapshot that another window opened (or that its window already closed). */
export function heapErrorText(e: unknown): string {
  if (e instanceof IpcError && e.kind === "notFound") return tx("This heap snapshot is not available in this window.");
  return e instanceof Error ? e.message : String(e);
}

export interface HeapQuery<T> {
  data: T | undefined;
  error: string | null;
}

/**
 * Runs `load` whenever `key` changes (nothing while it is `null`) and keeps the latest answer; an answer for an earlier
 * key is dropped.
 */
export function useHeapQuery<T>(key: string | null, load: () => Promise<T>): HeapQuery<T> {
  const [state, setState] = useState<HeapQuery<T> & { key: string | null }>({
    key: null,
    data: undefined,
    error: null,
  });
  const run = useEffectEvent(load);
  useEffect(() => {
    if (key === null) return;
    let live = true;
    run().then(
      (data) => live && setState({ key, data, error: null }),
      (e: unknown) => live && setState({ key, data: undefined, error: heapErrorText(e) }),
    );
    return () => {
      live = false;
    };
  }, [key]);
  return state.key === key ? state : { data: undefined, error: null };
}
