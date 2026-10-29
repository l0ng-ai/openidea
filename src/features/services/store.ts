/**
 * Docker state for the Services tool window: the configured connections and
 * registries, per connection the last snapshot and its refresh loop (a `docker
 * events` stream while the daemon is up, a slow poll while it is not, so the
 * view recovers when the daemon starts).
 */
import { create } from "zustand";
import { Channel } from "@tauri-apps/api/core";
import type {
  ComposeOp,
  ContainerOp,
  DockerConnection,
  DockerEndpoint,
  DockerEvent,
  DockerObject,
  DockerRegistry,
  DockerSettings,
  DockerSnapshot,
  PruneTarget,
  RequestId,
} from "@/platform/ipc";
import { call, commands, isCancelled, isTauri, nextRequestId } from "@/platform/ipc";
import { notifications } from "@/workbench/contributions";

export type DetailTab = "log" | "inspect";

/** `DockerSettings` with its defaults filled in. */
export interface Settings {
  connections: DockerConnection[];
  registries: DockerRegistry[];
}

export interface ConnectionState {
  snapshot: DockerSnapshot | null;
  loading: boolean;
  error: string | null;
}

interface DockerState {
  /** Null until loaded. */
  settings: Settings | null;
  /** By connection id. */
  conns: Record<string, ConnectionState>;
  detailTab: DetailTab;
  /** Long operation in progress (pull, prune, compose…): its title and last output line. */
  task: { title: string; line: string; request: RequestId } | null;
}

export const useServices = create<DockerState>(() => ({
  settings: null,
  conns: {},
  detailTab: "log",
  task: null,
}));

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

const IDLE: ConnectionState = { snapshot: null, loading: false, error: null };

export function connectionState(id: string, s = useServices.getState()): ConnectionState {
  return s.conns[id] ?? IDLE;
}

export function connections(s = useServices.getState()): DockerConnection[] {
  return s.settings?.connections ?? [];
}

export function endpointOf(connId: string): DockerEndpoint {
  return connections().find((c) => c.id === connId)?.endpoint ?? { kind: "default" };
}

function patchConn(id: string, patch: Partial<ConnectionState>) {
  useServices.setState((s) => ({ conns: { ...s.conns, [id]: { ...connectionState(id, s), ...patch } } }));
}

// ---------------------------------------------------------------------------
// Settings

let settingsLoad: Promise<void> | null = null;

export function loadSettings(): Promise<void> {
  if (!isTauri()) {
    useServices.setState({ settings: { connections: [], registries: [] } });
    return Promise.resolve();
  }
  settingsLoad ??= call(commands.dockerSettings())
    .then((s: DockerSettings) =>
      useServices.setState({ settings: { connections: s.connections ?? [], registries: s.registries ?? [] } }),
    )
    .catch((e) => {
      settingsLoad = null;
      notifications().notify({
        group: "run",
        level: "error",
        title: "Cannot read Docker settings",
        body: errorMessage(e),
      });
    });
  return settingsLoad;
}

async function saveSettings(settings: Settings): Promise<boolean> {
  try {
    if (isTauri()) await call(commands.dockerSaveSettings(settings));
    useServices.setState({ settings });
    return true;
  } catch (e) {
    notifications().notify({
      group: "run",
      level: "error",
      title: "Cannot save Docker settings",
      body: errorMessage(e),
    });
    return false;
  }
}

export const newId = (prefix: string) => `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Adds or replaces (same id) a connection; the tree picks it up right away. */
export async function saveConnection(c: DockerConnection): Promise<boolean> {
  await loadSettings();
  const s = useServices.getState().settings ?? { connections: [], registries: [] };
  const exists = s.connections.some((x) => x.id === c.id);
  const ok = await saveSettings({
    ...s,
    connections: exists ? s.connections.map((x) => (x.id === c.id ? c : x)) : [...s.connections, c],
  });
  if (ok) {
    stopEvents(c.id);
    if (watchers > 0) void refresh(c.id);
  }
  return ok;
}

export async function removeConnection(id: string): Promise<void> {
  const s = useServices.getState().settings;
  if (!s) return;
  stopEvents(id);
  if (await saveSettings({ ...s, connections: s.connections.filter((c) => c.id !== id) })) {
    useServices.setState((st) => {
      const conns = { ...st.conns };
      delete conns[id];
      return { conns };
    });
  }
}

/** Adds or replaces a registry; `password` undefined keeps the saved one, null forgets it. */
export async function saveRegistry(r: DockerRegistry, password: string | null | undefined): Promise<boolean> {
  await loadSettings();
  const s = useServices.getState().settings ?? { connections: [], registries: [] };
  const exists = s.registries.some((x) => x.id === r.id);
  const ok = await saveSettings({
    ...s,
    registries: exists ? s.registries.map((x) => (x.id === r.id ? r : x)) : [...s.registries, r],
  });
  if (ok && password !== undefined && isTauri()) {
    try {
      await call(commands.dockerSetRegistryPassword(r.id, password));
    } catch (e) {
      notifications().notify({
        group: "run",
        level: "error",
        title: "Cannot save the registry password",
        body: errorMessage(e),
      });
    }
  }
  return ok;
}

export async function removeRegistry(id: string): Promise<void> {
  const s = useServices.getState().settings;
  if (s) await saveSettings({ ...s, registries: s.registries.filter((r) => r.id !== id) });
}

/** Test login; resolves to docker's answer, rejects with its error. */
export function testRegistryLogin(r: DockerRegistry, password: string | null): Promise<string> {
  const endpoint = connections()[0]?.endpoint ?? { kind: "default" };
  return call(commands.dockerRegistryLogin(endpoint, r, password));
}

// ---------------------------------------------------------------------------
// Snapshots

const inflight = new Map<string, Promise<void>>();
const again = new Set<string>();

/** Re-reads one connection (all without `id`); concurrent calls coalesce into one follow-up refresh. */
export function refresh(id?: string): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  if (id === undefined) return Promise.all(connections().map((c) => refresh(c.id))).then(() => undefined);
  const running = inflight.get(id);
  if (running) {
    again.add(id);
    return running;
  }
  patchConn(id, { loading: true });
  const p = call(commands.dockerSnapshot(endpointOf(id)))
    .then((snapshot) => {
      if (!connections().some((c) => c.id === id)) return;
      const wasReady = connectionState(id).snapshot?.availability.kind === "ready";
      patchConn(id, { snapshot, error: null });
      if (snapshot.availability.kind === "ready" && !wasReady) startEvents(id);
    })
    .catch((e) => patchConn(id, { error: errorMessage(e) }))
    .finally(() => {
      inflight.delete(id);
      if (connections().some((c) => c.id === id)) patchConn(id, { loading: false });
      if (again.delete(id)) void refresh(id);
    });
  inflight.set(id, p);
  return p;
}

const debounces = new Map<string, ReturnType<typeof setTimeout>>();
function refreshSoon(id: string) {
  clearTimeout(debounces.get(id));
  debounces.set(
    id,
    setTimeout(() => void refresh(id), 250),
  );
}

const events = new Map<string, RequestId>();
let pollTimer: ReturnType<typeof setInterval> | undefined;
let watchers = 0;

function startEvents(id: string) {
  if (events.has(id) || watchers === 0) return;
  const request = nextRequestId();
  events.set(id, request);
  const channel = new Channel<DockerEvent>();
  channel.onmessage = () => refreshSoon(id);
  void call(commands.dockerEvents(request, endpointOf(id), channel))
    .catch(() => undefined)
    .finally(() => {
      if (events.get(id) !== request) return;
      events.delete(id);
      // The stream ended on its own (daemon stopped): re-check the state.
      if (watchers > 0) refreshSoon(id);
    });
}

function stopEvents(id?: string) {
  for (const [conn, r] of [...events]) {
    if (id !== undefined && conn !== id) continue;
    events.delete(conn);
    void commands.cancelRequest(r);
  }
}

/**
 * Keeps the snapshots live while the tree is shown: events while a daemon runs,
 * a poll every 10 s while it does not (or its events stream is down).
 */
export function watch(): () => void {
  watchers++;
  void loadSettings().then(() => refresh());
  if (watchers === 1) {
    pollTimer = setInterval(() => {
      for (const c of connections()) {
        const ready = connectionState(c.id).snapshot?.availability.kind === "ready";
        if (!ready || !events.has(c.id)) void refresh(c.id);
      }
    }, 10_000);
  }
  return () => {
    watchers--;
    if (watchers === 0) {
      clearInterval(pollTimer);
      stopEvents();
    }
  };
}

// ---------------------------------------------------------------------------
// Operations

async function guarded(connId: string, title: string, run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return true;
  } catch (e) {
    if (!isCancelled(e))
      notifications().notify({ group: "run", level: "error", title, body: errorMessage(e), key: "docker-op" });
    return false;
  } finally {
    refreshSoon(connId);
  }
}

export function containerOp(connId: string, ids: string[], op: ContainerOp): Promise<boolean> {
  const verb = { start: "start", stop: "stop", restart: "restart", pause: "pause", unpause: "unpause", kill: "kill" }[
    op
  ];
  return guarded(connId, `Could not ${verb} container`, () =>
    call(commands.dockerContainerOp(endpointOf(connId), ids, op)),
  );
}

export function removeObjects(connId: string, object: DockerObject, ids: string[], force: boolean): Promise<boolean> {
  return guarded(connId, `Could not remove ${object}`, () =>
    call(commands.dockerRemove(endpointOf(connId), object, ids, force)),
  );
}

/** Runs a streaming operation, showing its latest output line in the view's banner. */
async function task(
  connId: string,
  title: string,
  run: (request: RequestId, out: Channel<string>) => Promise<unknown>,
): Promise<boolean> {
  if (useServices.getState().task) {
    notifications().notify({
      group: "run",
      level: "info",
      title: "Another Docker operation is still running",
      key: "docker-op",
    });
    return false;
  }
  const request = nextRequestId();
  const out = new Channel<string>();
  let last = "";
  out.onmessage = (line) => {
    last = line;
    useServices.setState((s) => (s.task ? { task: { ...s.task, line } } : s));
  };
  useServices.setState({ task: { title, line: "", request } });
  try {
    return await guarded(connId, title.replace(/…$/, "") + " failed", () => run(request, out));
  } finally {
    useServices.setState({ task: null });
    if (last)
      notifications().notify({
        group: "run",
        level: "info",
        title: title.replace(/…$/, ""),
        body: last,
        key: "docker-task",
      });
  }
}

export function cancelTask() {
  const t = useServices.getState().task;
  if (t) void commands.cancelRequest(t.request);
}

export const pullImage = (connId: string, reference: string) =>
  task(connId, `Pulling ${reference}…`, (r, out) => call(commands.dockerPull(r, endpointOf(connId), reference, out)));

export const prune = (connId: string, target: PruneTarget) =>
  task(connId, `Pruning ${target === "allImages" ? "unused images" : target}…`, (r, out) =>
    call(commands.dockerPrune(r, endpointOf(connId), target, out)),
  );

export function composeOp(connId: string, project: string, files: string[], workingDir: string | null, op: ComposeOp) {
  return task(connId, `Compose ${op} ${project}…`, (r, out) =>
    call(commands.dockerComposeOp(r, endpointOf(connId), project, files, workingDir, op, out)),
  );
}
