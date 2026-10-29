/**
 * Remote development: in a window whose project lives on another machine, the
 * commands that machine's `openidea-server` answers are routed to it (through
 * the `remote_invoke` command) instead of running locally. Routing happens below
 * the generated bindings, so features call `commands.*` as usual.
 */
import { Channel, type InvokeArgs, type InvokeOptions } from "@tauri-apps/api/core";
import { invokeLocal, setInvokeRoute, type InvokeRoute } from "./tauriCore";
import { create } from "zustand";
import { call, commands, isTauri, type ChannelFrame, type RemoteProgress, type RemoteSession } from "./ipc";
import { useProject } from "./project";

interface RemoteState {
  session: RemoteSession | null;
}

export const useRemote = create<RemoteState>(() => ({ session: null }));

let routed = new Set<string>();
let nextChannel = 1;

/**
 * The arguments with each `Channel` replaced by `{ $channel: id }`, and the
 * channels by id (their values come back tagged with the id).
 */
export function encodeArgs(args: unknown): { json: string; channels: Map<number, Channel<unknown>> } {
  const channels = new Map<number, Channel<unknown>>();
  const plain: Record<string, unknown> = {};
  if (args && typeof args === "object") {
    for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
      if (v instanceof Channel) {
        const id = nextChannel++;
        channels.set(id, v as Channel<unknown>);
        plain[k] = { $channel: id };
      } else {
        plain[k] = v;
      }
    }
  }
  return { json: JSON.stringify(plain), channels };
}

async function remoteInvoke(cmd: string, args?: InvokeArgs, options?: InvokeOptions): Promise<unknown> {
  const { json, channels } = encodeArgs(args);
  const onChannel = new Channel<ChannelFrame>();
  onChannel.onmessage = (frame) => channels.get(frame.id)?.onmessage(JSON.parse(frame.data));
  const result = await invokeLocal<string>("remote_invoke", { cmd, args: json, onChannel }, options);
  return JSON.parse(result);
}

/**
 * Where a command of a remote window runs. Local always: opening a project (a
 * local folder; leaving the remote one) and closing it (that drops the
 * connection, which ends the server's session). Both: a global setting, which
 * the server's language servers and the local windows read.
 */
export function remoteRouting(cmd: string, args: InvokeArgs | undefined, served: ReadonlySet<string>) {
  if (cmd === "system_font_families") return "local";
  if (!served.has(cmd) || cmd === "open_project" || cmd === "close_project") return "local";
  if (cmd === "settings_set" && (args as { scope?: string } | undefined)?.scope === "global") return "both";
  return "remote";
}

const route: InvokeRoute = (cmd, args, options) => {
  switch (remoteRouting(cmd, args, routed)) {
    case "local":
      return null;
    case "remote":
      return remoteInvoke(cmd, args, options);
    case "both":
      return invokeLocal(cmd, args, options).then(() => remoteInvoke(cmd, args, options));
  }
};

/** Routes the commands the server answers (`session.commands`) to it from now on. */
export function enableRemote(session: RemoteSession) {
  routed = new Set(session.commands);
  useRemote.setState({ session });
  setInvokeRoute(route);
}

export function disableRemote() {
  routed = new Set();
  setInvokeRoute(null);
  useRemote.setState({ session: null });
}

export function isRemoteWindow(): boolean {
  return useRemote.getState().session !== null;
}

/** Re-attaches after a reload (the backend keeps the connection per window). */
export async function restoreRemote(): Promise<RemoteSession | null> {
  if (!isTauri()) return null;
  const session = await commands.remoteCurrent().catch(() => null);
  if (session) enableRemote(session);
  return session;
}

/** Where the connection in progress is, and to which location (`null`: none). */
export const useRemoteProgress = create<{ progress: RemoteProgress | null; location: string | null }>(() => ({
  progress: null,
  location: null,
}));

/** Opens `path` on the host of SSH configuration `sshConfig` in this window. */
export async function connectRemote(sshConfig: string, path: string) {
  useProject.setState({ opening: true });
  const onProgress = new Channel<RemoteProgress>();
  onProgress.onmessage = (progress) => useRemoteProgress.setState({ progress });
  useRemoteProgress.setState({
    progress: { stage: "connecting", fraction: null },
    location: remoteLocation(sshConfig, path),
  });
  try {
    const r = await call(commands.remoteConnect(sshConfig, path, onProgress));
    enableRemote({ sshConfig: r.sshConfig, root: r.root, host: r.host, commands: r.commands });
    useProject.setState({ project: r.project, settings: r.project.settings });
    rememberRemote({
      sshConfig: r.sshConfig,
      path: r.root,
      name: r.project.name,
      host: r.host,
      openedAtMs: Date.now(),
    });
    return r;
  } finally {
    useProject.setState({ opening: false });
    useRemoteProgress.setState({ progress: null, location: null });
  }
}

export async function disconnectRemote() {
  if (!isRemoteWindow()) return;
  await commands.closeProject();
  disableRemote();
  useProject.setState({ project: null });
}

// ---------------------------------------------------------------------------
// Remote project locations: `ssh://<configuration id>/<absolute path>`, what the
// session and the recent projects remember for a remote window.

const SCHEME = "ssh://";

export function remoteLocation(sshConfig: string, path: string): string {
  return `${SCHEME}${encodeURIComponent(sshConfig)}${path.startsWith("/") ? "" : "/"}${path}`;
}

export function parseRemoteLocation(location: string): { sshConfig: string; path: string } | null {
  if (!location.startsWith(SCHEME)) return null;
  const rest = location.slice(SCHEME.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  return { sshConfig: decodeURIComponent(rest.slice(0, slash)), path: rest.slice(slash) };
}

/** The location of this window's project: remote, else its local root. */
export function projectLocation(root: string | null | undefined): string | null {
  if (!root) return null;
  const session = useRemote.getState().session;
  return session && session.root === root ? remoteLocation(session.sshConfig, root) : root;
}

export interface RecentRemote {
  sshConfig: string;
  path: string;
  name: string;
  /** `user@host:port` when it was opened. */
  host: string;
  openedAtMs: number;
}

const RECENT_KEY = "openidea.remote.recent";
const RECENT_MAX = 20;

export function recentRemotes(): RecentRemote[] {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as unknown;
    return Array.isArray(list) ? (list as RecentRemote[]).filter((r) => r && r.sshConfig && r.path) : [];
  } catch {
    return [];
  }
}

function saveRemotes(list: RecentRemote[]) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX)));
  } catch {
    /* storage unavailable */
  }
}

const sameRemote = (a: Pick<RecentRemote, "sshConfig" | "path">, b: Pick<RecentRemote, "sshConfig" | "path">) =>
  a.sshConfig === b.sshConfig && a.path === b.path;

export function rememberRemote(entry: RecentRemote) {
  saveRemotes([entry, ...recentRemotes().filter((r) => !sameRemote(r, entry))]);
}

export function forgetRemote(sshConfig: string, path: string) {
  saveRemotes(recentRemotes().filter((r) => !sameRemote(r, { sshConfig, path })));
}

// Any way of leaving the remote project (Close Project, opening a local one) ends remote routing.
useProject.subscribe((s) => {
  const session = useRemote.getState().session;
  if (session && !s.opening && s.project?.root !== session.root) disableRemote();
});
