/** Language server status: `lsp_servers` snapshot + `languageServer` / `languageServerRemoved` events. */
import { getAction } from "@/platform/actions";
import { create } from "zustand";
import type { ServerId, ServerInfo, ServerStatus } from "@/bindings";
import { call, commands, isTauri, onIdeEvent } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { notifications } from "@/workbench/contributions";

export interface ServerEntry {
  id: ServerId;
  name: string;
  status: ServerStatus;
  message: string | null;
  languages: string[];
  root: string | null;
}

interface ServersState {
  servers: ReadonlyMap<ServerId, ServerEntry>;
}

export const useServers = create<ServersState>(() => ({ servers: new Map() }));

const notifiedMissing = new Set<string>();

/** Event count at each server's latest event, so a snapshot taken earlier doesn't undo it. */
let eventSeq = 0;
const lastEvent = new Map<ServerId, number>();
/** Event count when each server left the list, so an older snapshot doesn't bring it back. */
const removedAt = new Map<ServerId, number>();
/**
 * A running server shows busy only once it has been busy this long: jdtls reports a task of a
 * few milliseconds on almost every edit, save and search, which would make the status flicker.
 */
export const BUSY_SHOW_DELAY_MS = 500;
const pendingBusy = new Map<ServerId, ReturnType<typeof setTimeout>>();

function notifyMissing(e: ServerEntry) {
  if (notifiedMissing.has(e.name)) return;
  notifiedMissing.add(e.name);
  // features/tools shows the same notification with an Install button.
  if (getAction("tools.install")) return;
  notifications().notify({
    group: "lsp",
    level: "warning",
    title: `Language server '${e.name}' is not installed`,
    body: e.message ?? "Code insight features are unavailable for these files until it is installed.",
    key: `lsp-missing-${e.name}`,
  });
}

export function upsertServer(entry: Partial<ServerEntry> & { id: ServerId; name: string; status: ServerStatus }) {
  const prev = useServers.getState().servers.get(entry.id);
  const next: ServerEntry = {
    languages: prev?.languages ?? [],
    root: prev?.root ?? null,
    message: null,
    ...prev,
    ...entry,
  };
  useServers.setState((s) => ({ servers: new Map(s.servers).set(entry.id, next) }));
  if (next.status === "missing") notifyMissing(next);
}

export async function refreshServers() {
  if (!useProject.getState().project) {
    useServers.setState({ servers: new Map() });
    return;
  }
  if (!isTauri()) return;
  try {
    const since = eventSeq;
    const list: ServerInfo[] = await call(commands.lspServers());
    const prev = useServers.getState().servers;
    const map = new Map<ServerId, ServerEntry>();
    for (const s of list) {
      if ((removedAt.get(s.id) ?? 0) > since) continue;
      const p = prev.get(s.id);
      const newer = p && (lastEvent.get(s.id) ?? 0) > since;
      map.set(s.id, {
        id: s.id,
        name: s.name,
        status: newer ? p.status : s.status,
        languages: s.languages,
        root: s.root,
        message: p?.message ?? null,
      });
    }
    useServers.setState({ servers: map });
    for (const e of map.values()) if (e.status === "missing") notifyMissing(e);
  } catch {
    // No project / backend not ready; events will fill in.
  }
}

export async function restartServer(id: ServerId) {
  try {
    await call(commands.lspRestart(id));
  } catch (e) {
    notifications().notify({
      group: "lsp",
      level: "error",
      title: "Failed to restart language server",
      body: e instanceof Error ? e.message : String(e),
    });
  }
}

export function installServerEvents(): () => void {
  const off = onIdeEvent("languageServer", (e) => {
    const known = useServers.getState().servers.has(e.server);
    lastEvent.set(e.server, ++eventSeq);
    clearTimeout(pendingBusy.get(e.server));
    pendingBusy.delete(e.server);
    const entry = { id: e.server, name: e.name, status: e.status, message: e.message };
    if (e.status === "busy" && useServers.getState().servers.get(e.server)?.status === "ready") {
      pendingBusy.set(
        e.server,
        setTimeout(() => {
          pendingBusy.delete(e.server);
          upsertServer(entry);
        }, BUSY_SHOW_DELAY_MS),
      );
    } else upsertServer(entry);
    if (!known) void refreshServers();
  });
  const offRemoved = onIdeEvent("languageServerRemoved", (e) => {
    removedAt.set(e.server, ++eventSeq);
    lastEvent.delete(e.server);
    clearTimeout(pendingBusy.get(e.server));
    pendingBusy.delete(e.server);
    if (!useServers.getState().servers.has(e.server)) return;
    useServers.setState((s) => {
      const servers = new Map(s.servers);
      servers.delete(e.server);
      return { servers };
    });
  });
  let root = useProject.getState().project?.root ?? null;
  void refreshServers();
  const unsub = useProject.subscribe((s) => {
    const r = s.project?.root ?? null;
    if (r === root) return;
    root = r;
    notifiedMissing.clear();
    void refreshServers();
  });
  return () => {
    off();
    offRemoved();
    unsub();
    for (const t of pendingBusy.values()) clearTimeout(t);
    pendingBusy.clear();
  };
}

export const STATUS_LABEL: Record<ServerStatus, string> = {
  starting: "Starting…",
  ready: "Running",
  busy: "Busy",
  crashed: "Crashed",
  stopped: "Stopped",
  missing: "Not installed",
  misconfigured: "Not started",
};

/**
 * A missing server whose languages another installed one serves (vtsls missing,
 * typescript-language-server running as its fallback) is not a problem.
 */
export function servedByOther(server: ServerEntry, servers: readonly ServerEntry[]): boolean {
  return (
    server.languages.length > 0 &&
    server.languages.every((l) =>
      servers.some((o) => o !== server && o.status !== "missing" && o.languages.includes(l)),
    )
  );
}

/** One-line summary for the status bar. */
export function serversSummary(
  servers: readonly ServerEntry[],
): { text: string; tone: "ok" | "busy" | "error" | "idle" } | null {
  if (!servers.length) return null;
  const bad = servers.filter(
    (s) =>
      s.status === "crashed" || s.status === "misconfigured" || (s.status === "missing" && !servedByOther(s, servers)),
  );
  const busy = servers.filter((s) => s.status === "starting" || s.status === "busy");
  const tone = bad.length ? "error" : busy.length ? "busy" : servers.some((s) => s.status === "ready") ? "ok" : "idle";
  // A stopped server (one a preferred server took over from) isn't worth naming next to running ones.
  const active = servers.filter((s) => s.status !== "stopped");
  const names = [...new Set((active.length ? active : servers).map((s) => s.name))];
  const text = names.length === 1 ? names[0]! : `${names[0]} +${names.length - 1}`;
  return { text, tone };
}

const RUNNING: ReadonlySet<ServerStatus> = new Set(["ready", "busy"]);

/** Whether a running ESLint server covers `path` (a `language` file below its configuration). */
export function eslintCovers(path: string, language: string | null | undefined): boolean {
  if (!language) return false;
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const file = norm(path);
  for (const s of useServers.getState().servers.values()) {
    if (s.name !== "eslint" || !RUNNING.has(s.status) || !s.languages.includes(language)) continue;
    const root = s.root ? norm(s.root) : null;
    if (!root || file.startsWith(`${root}/`)) return true;
  }
  return false;
}
