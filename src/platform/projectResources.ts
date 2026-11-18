import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { auxiliaryWindow, AUX_CLOSED, type AuxCloseResult } from "./auxWindow";
import { isTauri } from "./ipc";

interface ResourceProvider {
  snapshot(scope: unknown): unknown;
  subscribe(changed: () => void): () => void;
}
const providers = new Map<string, ResourceProvider>();
const changes = new Set<() => void>();
const REQUEST = "openidea://project-resource/request";
const VALUE = "openidea://project-resource/value";
const RELEASE = "openidea://project-resource/release";
interface Request {
  source: string;
  id: string;
  resource: string;
  scope: unknown;
}
interface ResourceValue<T> {
  id: string;
  value: T;
}

/** Project services publish data; window actions and UI never cross this bridge. */
export function registerProjectResource(name: string, provider: ResourceProvider): () => void {
  providers.set(name, provider);
  changes.forEach((changed) => changed());
  return () => {
    if (providers.get(name) === provider) {
      providers.delete(name);
      changes.forEach((changed) => changed());
    }
  };
}

export function installProjectResourceHost(): () => void {
  if (!isTauri() || auxiliaryWindow()) return () => {};
  const native = getCurrentWindow();
  const requests = new Map<string, { source: string; stop(): void }>();
  const listeners: Array<() => void> = [];
  let disposed = false;
  const keep = (off: () => void) => (disposed ? off() : listeners.push(off));
  const install = (request: Request) => {
    const aux = auxiliaryWindow(request.source);
    if ((aux?.kind !== "editor" && aux?.kind !== "diff") || aux.parent !== native.label) return;
    requests.get(request.id)?.stop();
    let unsubscribe = () => {};
    let active: ResourceProvider | undefined;
    const send = () => {
      const provider = providers.get(request.resource);
      if (!provider) return;
      void emitTo(request.source, VALUE, {
        id: request.id,
        value: provider.snapshot(request.scope),
      }).catch(() => {});
    };
    const connect = () => {
      const provider = providers.get(request.resource);
      if (active !== provider) {
        unsubscribe();
        active = provider;
        unsubscribe = provider?.subscribe(send) ?? (() => {});
      }
      send();
    };
    changes.add(connect);
    requests.set(request.id, {
      source: request.source,
      stop: () => {
        changes.delete(connect);
        unsubscribe();
      },
    });
    connect();
  };
  void native.listen<Request>(REQUEST, ({ payload }) => install(payload)).then(keep);
  void native
    .listen<{ id: string }>(RELEASE, ({ payload }) => {
      requests.get(payload.id)?.stop();
      requests.delete(payload.id);
    })
    .then(keep);
  void native
    .listen<AuxCloseResult>(AUX_CLOSED, ({ payload }) => {
      if (payload.closed)
        for (const [id, request] of requests)
          if (request.source === payload.label) {
            request.stop();
            requests.delete(id);
          }
    })
    .then(keep);
  return () => {
    disposed = true;
    listeners.forEach((off) => off());
    requests.forEach((request) => request.stop());
    requests.clear();
  };
}

export function subscribeProjectResource<T>(resource: string, scope: unknown, accept: (value: T) => void): () => void {
  const parent = auxiliaryWindow()?.parent;
  if (!parent) {
    let disposed = false;
    let active: ResourceProvider | undefined;
    let unsubscribe = () => {};
    const send = () => {
      if (disposed || !active) return;
      accept(active.snapshot(scope) as T);
    };
    const connect = () => {
      const provider = providers.get(resource);
      if (provider !== active) {
        unsubscribe();
        active = provider;
        unsubscribe = provider?.subscribe(send) ?? (() => {});
      }
      send();
    };
    changes.add(connect);
    connect();
    return () => {
      disposed = true;
      changes.delete(connect);
      unsubscribe();
    };
  }
  const native = getCurrentWindow();
  const id = crypto.randomUUID();
  let disposed = false;
  let stop = () => {};
  void native
    .listen<ResourceValue<T>>(VALUE, ({ payload }) => {
      if (disposed || payload.id !== id) return;
      accept(payload.value);
    })
    .then(async (off) => {
      if (disposed) {
        off();
        return;
      }
      stop = off;
      await emitTo(parent, REQUEST, {
        source: native.label,
        id,
        resource,
        scope,
      } satisfies Request);
      if (disposed) await emitTo(parent, RELEASE, { id });
    })
    .catch(console.warn);
  return () => {
    disposed = true;
    stop();
    void emitTo(parent, RELEASE, { id }).catch(() => {});
  };
}
