/**
 * The endpoint providers and their endpoints, merged: the Endpoints tool
 * window reads this store; frameworks register a provider and keep its state.
 */
import { create } from "zustand";
import type { Endpoint, EndpointDiagnostic, EndpointProvider } from "./model";

interface EndpointsState {
  providers: EndpointProvider[];
  /** Every provider's endpoints, provider registration order. */
  endpoints: Endpoint[];
  diagnostics: EndpointDiagnostic[];
  /** Some provider applies to the project (the window is shown). */
  available: boolean;
  loading: boolean;
  /** Every provider has answered at least once. */
  loaded: boolean;
  error: string | null;
  /** Endpoint to select and reveal in the window ("Show in Endpoints"). */
  selectedId: string | null;
}

export const useEndpoints = create<EndpointsState>(() => ({
  providers: [],
  endpoints: [],
  diagnostics: [],
  available: false,
  loading: false,
  loaded: true,
  error: null,
  selectedId: null,
}));

function merge(providers: EndpointProvider[]): Omit<EndpointsState, "providers" | "selectedId"> {
  const states = providers.map((p) => p.getState());
  const errors = states.map((s) => s.error).filter((e): e is string => !!e);
  return {
    endpoints: states.flatMap((s) => s.endpoints ?? []),
    diagnostics: states.flatMap((s) => s.diagnostics),
    available: states.some((s) => s.endpoints !== null),
    loading: states.some((s) => s.loading),
    loaded: states.every((s) => s.loaded),
    error: errors.length ? errors.join("\n") : null,
  };
}

function refreshState() {
  useEndpoints.setState((s) => merge(s.providers));
}

const unsubscribers = new Map<string, () => void>();

/** Adds `provider` to the window; returns the disposer. */
export function registerEndpointProvider(provider: EndpointProvider): () => void {
  unsubscribers.get(provider.id)?.();
  unsubscribers.set(provider.id, provider.subscribe(refreshState));
  useEndpoints.setState((s) => {
    const providers = [...s.providers.filter((p) => p.id !== provider.id), provider];
    return { providers, ...merge(providers) };
  });
  return () => {
    if (useEndpoints.getState().providers.find((p) => p.id === provider.id) !== provider) return;
    unsubscribers.get(provider.id)?.();
    unsubscribers.delete(provider.id);
    useEndpoints.setState((s) => {
      const providers = s.providers.filter((p) => p !== provider);
      return { providers, ...merge(providers) };
    });
  };
}

/** Asks every provider to re-read its sources. */
export async function refreshEndpoints(): Promise<void> {
  await Promise.all(useEndpoints.getState().providers.map((p) => p.refresh()));
}

/** Selects `id` in the Endpoints window (it reveals the row when shown). */
export function selectEndpoint(id: string | null) {
  useEndpoints.setState({ selectedId: id });
}
