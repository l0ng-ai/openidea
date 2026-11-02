/**
 * Endpoint providers contributed by plugins (`[[contributes.endpoints]]` in
 * `plugin.toml`): one provider per declaration of every enabled plugin, loaded
 * through `plugin_endpoints` and re-run when a watched file (the declaration's
 * globs, or a file the last table reported) is saved or changes on disk.
 */
import type { EndpointDecl, PluginEndpoint, PluginEndpointTable, PluginInfo } from "@/bindings";
import { onEditorEvent } from "@/editor/api";
import { call, commands, isTauri, onIdeEvent } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { usePlugins } from "../plugins/store";
import type { RequestSpec } from "../http-client/generate";
import type { Endpoint, EndpointProvider, ProviderState } from "./model";
import { registerEndpointProvider } from "./store";

const RELOAD_DELAY = 300;

/** Compiles a project-relative glob (`*`, `**`, `?`) into a matcher of project-relative paths. */
export function globMatcher(pattern: string): (relativePath: string) => boolean {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // `**/` matches zero or more directories; a trailing `**` matches anything.
        if (pattern[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  const regex = new RegExp(`^${re}$`);
  return (p) => regex.test(p);
}

/** Whether a change to `path` re-runs a provider with `decl` whose last table read `files`. */
export function affectsProvider(path: string, root: string, decl: EndpointDecl, files: readonly string[]): boolean {
  if (files.includes(path)) return true;
  if (!path.startsWith(`${root}/`)) return false;
  const relative = path.slice(root.length + 1);
  return (decl.watch ?? []).some((w) => globMatcher(w)(relative));
}

export function providerId(pluginId: string, index: number): string {
  return `plugin:${pluginId}:${index}`;
}

function requestOf(e: PluginEndpoint): RequestSpec {
  const r = e.request;
  if (r)
    return {
      name: e.target,
      method: r.method,
      url: r.url,
      headers: (r.headers ?? []).map((h) => ({ name: h.name, value: h.value })),
      body: r.body ?? undefined,
    };
  return {
    name: e.target,
    method: e.method === "ANY" ? "GET" : e.method,
    url: `http://localhost${e.path}`,
    headers: [],
  };
}

/** A plugin's endpoint as the window's model. */
export function toEndpoint(e: PluginEndpoint, provider: string, decl: EndpointDecl, module: string): Endpoint {
  return {
    id: `${provider}:${e.file}:${e.line} ${e.method} ${e.path} ${e.target}`,
    method: e.method,
    path: e.path,
    target: e.target,
    targetClass: e.targetClass || e.target,
    name: e.name ?? null,
    file: e.file,
    line: e.line,
    module,
    framework: decl.framework,
    type: decl.type ?? "HTTP",
    icon: decl.icon ?? undefined,
    request: requestOf(e),
    docs: (e.docs ?? []).map(([k, v]) => [k, v] as [string, string]),
  };
}

/** One declaration of one plugin, as an `EndpointProvider` with its own state. */
export function pluginProvider(
  plugin: Pick<PluginInfo, "id">,
  index: number,
  decl: EndpointDecl,
): EndpointProvider & {
  /** Re-runs when `path` is one of the provider's files; returns whether it did. */
  changed(path: string, root: string): boolean;
  reset(): void;
} {
  const id = providerId(plugin.id, index);
  const listeners = new Set<() => void>();
  let state: ProviderState = { endpoints: null, loading: false, loaded: false, error: null, diagnostics: [] };
  let files: string[] = [];
  let seq = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const set = (patch: Partial<ProviderState>) => {
    state = { ...state, ...patch };
    listeners.forEach((l) => l());
  };
  const load = async () => {
    const root = useProject.getState().project?.root;
    if (!root || !isTauri()) {
      set({ endpoints: null, loading: false, loaded: true, error: null, diagnostics: [] });
      return;
    }
    const mine = ++seq;
    set({ loading: true });
    try {
      const table: PluginEndpointTable | null = await call(commands.pluginEndpoints(plugin.id, index));
      if (mine !== seq) return;
      const module = useProject.getState().project?.name ?? "";
      files = table?.files ?? [];
      set({
        endpoints: table ? table.endpoints.map((e) => toEndpoint(e, id, decl, module)) : null,
        diagnostics: table?.diagnostics ?? [],
        loading: false,
        loaded: true,
        error: null,
      });
    } catch (e) {
      if (mine !== seq) return;
      set({ loading: false, loaded: true, error: e instanceof Error ? e.message : String(e) });
    }
  };
  const schedule = (delay: number) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void load();
    }, delay);
  };
  return {
    id,
    framework: decl.framework,
    type: decl.type ?? "HTTP",
    getState: () => state,
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    refresh: load,
    changed: (path, root) => {
      if (!affectsProvider(path, root, decl, files)) return false;
      schedule(RELOAD_DELAY);
      return true;
    },
    reset: () => {
      seq++;
      if (timer) clearTimeout(timer);
      timer = null;
      files = [];
      state = { endpoints: null, loading: false, loaded: false, error: null, diagnostics: [] };
      listeners.forEach((l) => l());
      schedule(300);
    },
  };
}

/** Keeps one registered provider per `[[contributes.endpoints]]` of the enabled plugins; returns a disposer. */
export function installPluginProviders(): () => void {
  const active = new Map<string, { provider: ReturnType<typeof pluginProvider>; dispose: () => void }>();
  const sync = (plugins: readonly PluginInfo[]) => {
    const wanted = new Map<string, { plugin: PluginInfo; index: number; decl: EndpointDecl }>();
    for (const p of plugins)
      if (p.enabled && p.hasCode && p.status !== "failed")
        p.endpoints.forEach((decl, index) => wanted.set(providerId(p.id, index), { plugin: p, index, decl }));
    for (const [id, entry] of active)
      if (!wanted.has(id)) {
        entry.dispose();
        active.delete(id);
      }
    for (const [id, { plugin, index, decl }] of wanted)
      if (!active.has(id)) {
        const provider = pluginProvider(plugin, index, decl);
        active.set(id, { provider, dispose: registerEndpointProvider(provider) });
        void provider.refresh();
      }
  };
  sync(usePlugins.getState().plugins);
  const unsubPlugins = usePlugins.subscribe((s, prev) => {
    if (s.plugins !== prev.plugins) sync(s.plugins);
  });
  let root = useProject.getState().project?.root ?? null;
  const unsubProject = useProject.subscribe((s) => {
    const r = s.project?.root ?? null;
    if (r === root) return;
    root = r;
    for (const { provider } of active.values()) provider.reset();
  });
  const changed = (paths: string[]) => {
    if (!root) return;
    for (const { provider } of active.values()) for (const p of paths) if (provider.changed(p, root)) break;
  };
  const unsubFs = onIdeEvent("fsChanged", (e) => changed([...e.created, ...e.modified, ...e.removed]));
  const unsubEditor = onEditorEvent((e) => {
    if (e.type === "docSaved") changed([e.path]);
  });
  return () => {
    unsubPlugins();
    unsubProject();
    unsubFs();
    unsubEditor();
    for (const entry of active.values()) entry.dispose();
    active.clear();
  };
}
