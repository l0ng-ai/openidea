/**
 * Framework-neutral endpoints, as the Endpoints tool window shows them.
 * Frameworks (Rails routes, …) contribute them through an `EndpointProvider`;
 * the window only needs method, path, target, where it is defined and the
 * `.http` request to generate.
 */
import type { RequestSpec } from "../http-client/generate";

export interface Endpoint {
  /** Unique across providers (prefix it with the provider id). */
  id: string;
  /** `GET`, `POST`, …, `ANY`. */
  method: string;
  /** `/photos/:id` as the framework writes it. */
  path: string;
  /** What handles it, short (`photos#show`, `UserController.list`). */
  target: string;
  /** The handler's class as the row's right column (`Admin::PhotosController`). */
  targetClass: string;
  /** The URL helper / route name, when the framework has one. */
  name: string | null;
  /** The file and 1-based line of the declaration. */
  file: string;
  line: number;
  /** Module (project / workspace member) the endpoint belongs to. */
  module: string;
  /** Provider's framework name, shown in the Framework filter. */
  framework: string;
  /** Endpoint type (`HTTP`, `WebSocket`, `gRPC`…), shown in the Type filter. */
  type: string;
  /** Row icon (`ui/icons` name). */
  icon?: string;
  /** The request to generate for it. */
  request: RequestSpec;
  /** Extra rows of the Documentation tab, after the common ones. */
  docs?: [label: string, value: string][];
}

export interface EndpointDiagnostic {
  file: string;
  /** 1-based. */
  line: number;
  message: string;
}

/** What a provider currently knows. */
export interface ProviderState {
  /** `null`: the project has nothing of this framework (the provider does not apply). */
  endpoints: Endpoint[] | null;
  loading: boolean;
  /** Answered at least once for this project. */
  loaded: boolean;
  error: string | null;
  diagnostics: EndpointDiagnostic[];
}

export interface EndpointProvider {
  id: string;
  framework: string;
  /** Default `HTTP`. */
  type?: string;
  getState(): ProviderState;
  /** Called on every state change. */
  subscribe(listener: () => void): () => void;
  /** Re-reads the sources (the window's Refresh). */
  refresh(): Promise<void> | void;
}

/** Case-insensitive match of every whitespace-separated word of `query` against method, path, target and name. */
export function filterEndpoints(endpoints: readonly Endpoint[], query: string): Endpoint[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...endpoints];
  return endpoints.filter((e) => {
    const text = `${e.method} ${e.path} ${e.target} ${e.targetClass} ${e.name ?? ""}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

export interface EndpointGroup<K extends string = string> {
  key: K;
  endpoints: Endpoint[];
}

/** Endpoints per `key`, in the order the keys are first used. */
export function groupBy<K extends string>(endpoints: readonly Endpoint[], key: (e: Endpoint) => K): EndpointGroup<K>[] {
  const groups = new Map<K, Endpoint[]>();
  for (const e of endpoints) {
    const k = key(e);
    const list = groups.get(k);
    if (list) list.push(e);
    else groups.set(k, [e]);
  }
  return [...groups].map(([k, list]) => ({ key: k, endpoints: list }));
}

/** Where "jump to source" goes: the declaration (0-based editor line). */
export function navigationTarget(e: Endpoint): { path: string; line: number; col: number } {
  return { path: e.file, line: Math.max(0, e.line - 1), col: 0 };
}

export function relativeTo(root: string, path: string): string {
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}

/** Diagnostics for display: `config/routes.rb:12: message`. */
export function diagnosticLines(diagnostics: readonly EndpointDiagnostic[], root: string): string[] {
  return diagnostics.map((d) => `${relativeTo(root, d.file)}:${d.line}: ${d.message}`);
}

/** Distinct values in first-use order. */
export function distinct(values: readonly string[]): string[] {
  return [...new Set(values)];
}
