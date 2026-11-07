import { confirmProjectTrust } from "./projectTrust";
/**
 * Remote development: in a window whose project lives on another machine, the
 * commands that machine's `openidea-server` answers are routed to it (through
 * the `remote_invoke` command) instead of running locally. Routing happens below
 * the generated bindings, so features call `commands.*` as usual.
 */
import { Channel, type InvokeArgs, type InvokeOptions } from "@tauri-apps/api/core";
import { invokeLocal, setInvokeRoute, type InvokeRoute } from "./tauriCore";
import { create } from "zustand";
import {
  call,
  commands,
  IpcError,
  isTauri,
  type ChannelFrame,
  type RemoteProgress,
  type RemoteSession,
  type RemoteTarget,
} from "./ipc";
import { isClientSetting, overlayClientSettings } from "./clientSettings";
import type { Settings } from "./ipc";
import { usePlatform } from "./platformInfo";
import { useProject } from "./project";

interface RemoteState {
  session: RemoteSession | null;
}

export const useRemote = create<RemoteState>(() => ({ session: null }));

let routed = new Set<string>();
let nextChannel = 1;
const BUILD_MODEL_COMMANDS = new Set(["build_model", "build_sync", "gradle_link_projects", "gradle_unlink_projects"]);

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
  const value = JSON.parse(result);
  // Released servers predating independent Gradle builds return a single build.
  if (BUILD_MODEL_COMMANDS.has(cmd) && value?.gradle && !Array.isArray(value.gradle)) {
    value.gradle = [value.gradle];
  }
  return value;
}

/**
 * Where a command of a remote window runs. Local always: opening a project (a
 * local folder; leaving the remote one) and closing it (that drops the
 * connection, which ends the server's session). Client UI settings stay local.
 * Both: a global tooling setting, which
 * the server's language servers and the local windows read.
 */
export function remoteRouting(cmd: string, args: InvokeArgs | undefined, served: ReadonlySet<string>) {
  if (cmd === "system_font_families" || cmd === "settings_get_global") return "local";
  if (cmd === "settings_set" && isClientSetting((args as { key?: string } | undefined)?.key ?? "")) return "local";
  if (!served.has(cmd) || cmd === "open_project" || cmd === "close_project") return "local";
  if (cmd === "settings_set" && (args as { scope?: string } | undefined)?.scope === "global") return "both";
  return "remote";
}

/** All effective settings responses use the same client overlay, including writes and project snapshots. */
async function clientSettings<T extends Settings>(settings: T): Promise<T> {
  return overlayClientSettings(settings, await invokeLocal<Settings>("settings_get_global"));
}

const route: InvokeRoute = (cmd, args, options) => {
  if (cmd === "open_project" || cmd === "light_edit_open") {
    return invokeLocal(cmd, args, options).then((result) => {
      disableRemote();
      return result;
    });
  }
  const destination = remoteRouting(cmd, args, routed);
  if (cmd === "settings_set") {
    const setting = args as { scope: string; key: string; value: string };
    return (async () => {
      if (isClientSetting(setting.key)) {
        await invokeLocal(cmd, { ...setting, scope: "global" }, options);
        return clientSettings((await remoteInvoke("settings_get")) as Settings);
      }
      if (destination === "local") return invokeLocal(cmd, args, options);
      if (destination === "both") await invokeLocal(cmd, args, options);
      return clientSettings((await remoteInvoke(cmd, args, options)) as Settings);
    })();
  }
  if (destination === "local") return null;
  return remoteInvoke(cmd, args, options).then(async (result) => {
    if (cmd === "settings_get") return clientSettings(result as Settings);
    if (cmd === "project_current" && result) {
      const project = result as { settings: Settings };
      return { ...project, settings: await clientSettings(project.settings) };
    }
    return result;
  });
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

/** The OS this window's commands run on: the remote server's, else this desktop's (`usePlatform`). */
export function hostOs(): string {
  return useRemote.getState().session?.os ?? usePlatform.getState().os;
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

/**
 * Opens `path` of `target` (an SSH host or a WSL distribution) in this window. A dev container's
 * project folder is the one in the container: `path` is then only a label.
 */
export async function connectRemote(target: RemoteTarget, path: string) {
  useProject.setState({ opening: true });
  const location = remoteLocation(target, path);
  const onProgress = new Channel<RemoteProgress>();
  onProgress.onmessage = (progress) => {
    if (useRemoteProgress.getState().location === location) {
      useRemoteProgress.setState({ progress });
    }
  };
  useRemoteProgress.setState({
    progress: { stage: "connecting", fraction: null },
    location,
  });
  try {
    const r = await call(commands.remoteConnect(target, path, onProgress));
    if (useRemoteProgress.getState().location !== location) {
      await commands.remoteDisconnect().catch(() => {});
      throw new IpcError({ kind: "cancelled", message: "Remote connection cancelled" });
    }
    enableRemote({ target: r.target, root: r.root, host: r.host, os: r.os, commands: r.commands });
    if (takeLegacyRemoteTrust(r.target, path, r.host)) {
      const status = await call(commands.projectTrustStatus(r.root));
      if (!status.decided) await call(commands.projectTrustSet(r.root, true, false));
    }
    try {
      await confirmProjectTrust(r.root);
    } catch (error) {
      await commands.closeProject();
      disableRemote();
      throw error;
    }
    const current = await commands.projectCurrent();
    if (current) r.project = current;
    r.project.settings = await clientSettings(r.project.settings);
    useProject.setState({ project: r.project, settings: r.project.settings });
    rememberRemote({
      target: r.target,
      path: r.root,
      name: r.project.name,
      host: r.host,
      openedAtMs: Date.now(),
    });
    return r;
  } finally {
    if (useRemoteProgress.getState().location === location) {
      useProject.setState({ opening: false });
      useRemoteProgress.setState({ progress: null, location: null });
    }
  }
}

export async function disconnectRemote() {
  if (!isRemoteWindow()) return;
  await commands.closeProject();
  disableRemote();
  useProject.setState({ project: null });
}

// ---------------------------------------------------------------------------
// Remote project locations: `ssh://<configuration id>/<absolute path>`,
// `wsl://<distribution>/<absolute path>` or `devcontainer://<local folder>[:<config>]/<container path>`,
// what the session and the recent projects remember for a remote window.

const SCHEMES = { ssh: "ssh://", wsl: "wsl://", devContainer: "devcontainer://" } as const;

/** The SSH configuration id, the WSL distribution name or the dev container's local folder. */
export function targetName(target: RemoteTarget): string {
  switch (target.kind) {
    case "ssh":
      return target.config;
    case "wsl":
      return target.distro;
    case "devContainer":
      return target.folder;
  }
}

export function sameTarget(a: RemoteTarget, b: RemoteTarget): boolean {
  return (
    a.kind === b.kind &&
    targetName(a) === targetName(b) &&
    (a.kind !== "devContainer" || b.kind !== "devContainer" || a.config === b.config)
  );
}

export function remoteLocation(target: RemoteTarget, path: string): string {
  const config = target.kind === "devContainer" && target.config ? `:${encodeURIComponent(target.config)}` : "";
  return `${SCHEMES[target.kind]}${encodeURIComponent(targetName(target))}${config}${path.startsWith("/") ? "" : "/"}${path}`;
}

export function parseRemoteLocation(location: string): { target: RemoteTarget; path: string } | null {
  const kind = (Object.keys(SCHEMES) as (keyof typeof SCHEMES)[]).find((k) => location.startsWith(SCHEMES[k]));
  if (!kind) return null;
  const rest = location.slice(SCHEMES[kind].length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  const authority = rest.slice(0, slash);
  const colon = kind === "devContainer" ? authority.indexOf(":") : -1;
  const name = decodeURIComponent(colon < 0 ? authority : authority.slice(0, colon));
  const config = colon < 0 ? "" : decodeURIComponent(authority.slice(colon + 1));
  const target: RemoteTarget =
    kind === "ssh" ? { kind, config: name } : kind === "wsl" ? { kind, distro: name } : { kind, folder: name, config };
  return { target, path: rest.slice(slash) };
}

/**
 * The remote project a saved location stands for: a `ssh://` / `wsl://` location, or a
 * `\\wsl.localhost\<distro>\…` folder remembered before WSL projects existed (it is a WSL
 * project, not a network folder). `null` for a plain local path.
 */
export async function resolveRemoteLocation(location: string): Promise<{ target: RemoteTarget; path: string } | null> {
  return parseRemoteLocation(location) ?? (await commands.wslResolve(location).catch(() => null));
}

/** The location of this window's project: remote, else its local root. */
export function projectLocation(root: string | null | undefined): string | null {
  if (!root) return null;
  const session = useRemote.getState().session;
  return session && session.root === root ? remoteLocation(session.target, root) : root;
}

export interface RecentRemote {
  target: RemoteTarget;
  path: string;
  name: string;
  /** `user@host:port` when it was opened. */
  host: string;
  openedAtMs: number;
}

const RECENT_KEY = "openidea.remote.recent";
const RECENT_MAX = 20;
const TRUST_MIGRATION_KEY = "openidea.remote.trustMigration";

/** Snapshot existing user-owned recents before any new connection is remembered. */
export function initializeRemoteTrustMigration() {
  try {
    if (localStorage.getItem(TRUST_MIGRATION_KEY) === null) {
      localStorage.setItem(TRUST_MIGRATION_KEY, JSON.stringify(recentRemotes()));
    }
  } catch {
    /* Unavailable storage never grants trust. */
  }
}

/** An entry as stored: before WSL it carried `sshConfig` instead of `target`. */
function normalize(entry: RecentRemote & { sshConfig?: string }): RecentRemote | null {
  if (!entry || !entry.path) return null;
  const target = entry.target ?? (entry.sshConfig ? { kind: "ssh" as const, config: entry.sshConfig } : null);
  return target ? { ...entry, target } : null;
}

/** Whether `path` on SSH `target` was remembered before the trust prompt existed (WSL never was). */
export function takeLegacyRemoteTrust(target: RemoteTarget, path: string, host: string): boolean {
  if (target.kind !== "ssh") return false;
  try {
    const value: unknown = JSON.parse(localStorage.getItem(TRUST_MIGRATION_KEY) ?? "[]");
    if (!Array.isArray(value)) return false;
    const matches = (stored: RecentRemote) => {
      const entry = normalize(stored);
      return entry !== null && sameTarget(entry.target, target) && entry.path === path && entry.host === host;
    };
    const found = value.some(matches);
    localStorage.setItem(TRUST_MIGRATION_KEY, JSON.stringify(value.filter((entry) => !matches(entry))));
    return found;
  } catch {
    return false;
  }
}

export function recentRemotes(): RecentRemote[] {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as unknown;
    return Array.isArray(list) ? list.map(normalize).filter((r): r is RecentRemote => r !== null) : [];
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

const sameRemote = (a: Pick<RecentRemote, "target" | "path">, b: Pick<RecentRemote, "target" | "path">) =>
  sameTarget(a.target, b.target) && a.path === b.path;

export function rememberRemote(entry: RecentRemote) {
  saveRemotes([entry, ...recentRemotes().filter((r) => !sameRemote(r, entry))]);
}

export function forgetRemote(target: RemoteTarget, path: string) {
  saveRemotes(recentRemotes().filter((r) => !sameRemote(r, { target, path })));
}

// Any way of leaving the remote project (Close Project, opening a local one) ends remote routing.
useProject.subscribe((s, prev) => {
  const session = useRemote.getState().session;
  if (!session || s.opening) return;
  // Only a window whose project was the session's root can leave it. Auxiliary windows
  // (comparison, deployment) hold no project of their own — they ride their parent's
  // session, and a settings-only update (the comparison window keeps just the settings)
  // must not drop the routing: its next commands would run here instead of on the host,
  // where no project is open (`open_project` / `light_edit_open` / `close_project` end
  // the session themselves, see `route`).
  if (prev.project?.root !== session.root || s.project?.root === session.root) return;
  disableRemote();
});
