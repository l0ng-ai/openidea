import type { CSSProperties, ReactNode } from "react";
import { create } from "zustand";
import type { Commit } from "@/bindings";
import { useEffect } from "react";
export const logCommitKey = (c: Pick<Commit, "id"> & { repo?: string | null }): string =>
  c.repo ? `${c.repo}\0${c.id}` : c.id;

export interface LogColumn {
  id: string;
  title: string;
  width?: number;
  render(commit: Commit): ReactNode;
  text?(commit: Commit): string;
  available?(commit: Commit): boolean;
  enabled?: boolean;
}

export interface LogContribution {
  id: string;
  columns?: readonly LogColumn[];
  highlight?(commit: Commit): CSSProperties | undefined;
  status?(commit: Commit): ReactNode;
  /** One cancellable load per visible batch; disposed when the provider or rows disappear. */
  load?(commits: readonly Commit[], signal: AbortSignal): Promise<ReadonlyMap<string, string>>;
}

export const useLogContributions = create<{
  providers: ReadonlyMap<string, LogContribution>;
  values: ReadonlyMap<string, string>;
}>(() => ({
  providers: new Map(),
  values: new Map(),
}));

export function useVisibleLogContributions(commits: readonly Commit[], columns?: readonly string[]) {
  const providers = useLogContributions((s) => s.providers);
  const key = commits.map(logCommitKey).join("\n");
  const enabledKey = columns?.join("\n");
  useEffect(() => {
    const controller = new AbortController();
    for (const provider of providers.values())
      if (
        provider.load &&
        (provider.status || provider.columns?.some((c) => c.enabled !== false && (!columns || columns.includes(c.id))))
      ) {
        const missing = commits.filter(
          (c) => !useLogContributions.getState().values.has(`${provider.id}\0${logCommitKey(c)}`),
        );
        if (!missing.length) continue;
        void provider
          .load(missing, controller.signal)
          .then((values) => {
            if (controller.signal.aborted || useLogContributions.getState().providers.get(provider.id) !== provider)
              return;
            useLogContributions.setState((s) => ({
              values: new Map([
                ...s.values,
                ...[...values].map(([id, text]) => [`${provider.id}\0${id}`, text] as const),
              ]),
            }));
          })
          .catch(() => undefined);
      }
    return () => controller.abort();
    // Commit identity and provider lifecycle determine each batch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers, key, enabledKey]);
}

/** Frontend extension point for log columns, row highlighters and commit statuses. */
export function registerLogContribution(provider: LogContribution): () => void {
  useLogContributions.setState((state) => ({
    providers: new Map(state.providers).set(provider.id, provider),
    values: new Map([...state.values].filter(([key]) => !key.startsWith(`${provider.id}\0`))),
  }));
  return () =>
    useLogContributions.setState((state) => {
      if (state.providers.get(provider.id) !== provider) return state;
      const providers = new Map(state.providers);
      providers.delete(provider.id);
      return { providers, values: new Map([...state.values].filter(([key]) => !key.startsWith(`${provider.id}\0`))) };
    });
}
