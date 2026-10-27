/** Pure helpers of the deployment feature: target paths, sync defaults, reports, remote paths. */
import type { SyncAction, SyncEntry, SyncStatus, TransferReport } from "@/platform/ipc";
import type { DeploymentServerValid, DeploymentSettingsValid, SshAuthValid } from "@/platform/remoteSettings";

/** Which part had focus last: the project view's selection or the editor's file is the target. */
export type FocusedPart = "project" | "editor" | null;

/** Paths passed to an action: a path, a list of paths or `{ paths }`; null when none were passed. */
export function pathsFromArg(arg: unknown): string[] | null {
  if (typeof arg === "string") return arg ? [arg] : null;
  const list = Array.isArray(arg) ? arg : (arg as { paths?: unknown } | null | undefined)?.paths;
  if (!Array.isArray(list)) return null;
  const paths = list.filter((p): p is string => typeof p === "string" && !!p);
  return paths.length ? paths : null;
}

/**
 * Files an action works on: the paths passed by a menu, else the project view
 * selection when it had focus last, else the active editor's file. Paths
 * outside the project are dropped.
 */
export function targetPaths(
  arg: unknown,
  ctx: { part: FocusedPart; selection: readonly string[]; editorPath: string | null; projectRoot: string | null },
): string[] {
  const passed = pathsFromArg(arg);
  const picked = passed
    ? passed
    : ctx.part === "project" && ctx.selection.length
      ? [...ctx.selection]
      : ctx.editorPath
        ? [ctx.editorPath]
        : ctx.selection.length && ctx.part !== "editor"
          ? [...ctx.selection]
          : [];
  const root = ctx.projectRoot;
  if (!root) return [];
  const inside = picked.filter((p) => p === root || p.startsWith(`${root}/`));
  // A folder and something inside it: the folder covers both.
  return inside.filter((p) => !inside.some((q) => q !== p && p.startsWith(`${q}/`)));
}

export type SyncChoice = SyncAction | "skip";

/** The Sync dialog's preselected action for a row. */
export function defaultSyncAction(status: SyncStatus): SyncChoice {
  switch (status) {
    case "localOnly":
    case "localNewer":
    case "different":
      return "upload";
    case "remoteOnly":
    case "remoteNewer":
      return "download";
    case "same":
      return "skip";
  }
}

/** Actions that make sense for a row (deleting needs the file on that side). */
export function syncChoices(entry: Pick<SyncEntry, "local" | "remote">): SyncChoice[] {
  const out: SyncChoice[] = ["skip"];
  if (entry.local) out.push("upload");
  if (entry.remote) out.push("download");
  if (entry.remote) out.push("deleteRemote");
  if (entry.local) out.push("deleteLocal");
  return out;
}

export function initialSyncChoices(entries: readonly SyncEntry[]): Record<string, SyncChoice> {
  return Object.fromEntries(entries.map((e) => [e.path, defaultSyncAction(e.status)]));
}

/** Steps to send to `deploySync` (skipped rows left out). */
export function syncSteps(choices: Record<string, SyncChoice>): { path: string; action: SyncAction }[] {
  return Object.entries(choices)
    .filter((e): e is [string, SyncAction] => e[1] !== "skip")
    .map(([path, action]) => ({ path, action }));
}

/** The server an action uses: `id`, else the default server, else the only one. */
export function resolveServer(settings: DeploymentSettingsValid, id: string | null): DeploymentServerValid | null {
  const { servers, defaultServer } = settings;
  if (id) return servers.find((s) => s.id === id) ?? null;
  return servers.find((s) => s.id === defaultServer) ?? (servers.length === 1 ? servers[0]! : null);
}

export const serverLabel = (s: Pick<DeploymentServerValid, "id" | "name">) => s.name.trim() || s.id;

export interface ReportSummary {
  level: "info" | "warning" | "error";
  /** English source text with `{n}` / `{server}` placeholders (translated by the caller). */
  title: string;
  params: { n: number; server: string; skipped: number };
}

/** Notification for a finished transfer. */
export function summarizeReport(
  report: TransferReport,
  verb: "upload" | "download" | "delete" | "sync",
  server: string,
): ReportSummary {
  const params = { n: report.files, server, skipped: report.skipped };
  const failed = report.errors.length > 0;
  const titles = {
    upload: failed ? "Upload to {server} finished with errors" : "Uploaded {n} files to {server}",
    download: failed ? "Download from {server} finished with errors" : "Downloaded {n} files from {server}",
    delete: failed ? "Delete from {server} finished with errors" : "Deleted {n} files from {server}",
    sync: failed ? "Sync with {server} finished with errors" : "Synchronized {n} files with {server}",
  };
  return { level: failed ? (report.files ? "warning" : "error") : "info", title: titles[verb], params };
}

/** Joins an absolute remote folder and a name / relative path. */
export function joinRemote(dir: string, rel: string): string {
  const r = rel.replace(/^\/+|\/+$/g, "");
  if (!r) return dir;
  return dir.endsWith("/") ? `${dir}${r}` : `${dir}/${r}`;
}

export function remoteParent(path: string): string {
  const trimmed = path.length > 1 ? path.replace(/\/+$/, "") : path;
  const i = trimmed.lastIndexOf("/");
  return i <= 0 ? "/" : trimmed.slice(0, i);
}

export function remoteName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || "/";
}

/**
 * The local project path a remote path is deployed from, through the server's
 * mappings (the most specific deployment path wins); null when not mapped.
 * `root` is the server's root path as resolved on the host.
 */
export function localPathForRemote(
  remotePath: string,
  root: string,
  mappings: DeploymentServerValid["mappings"],
  projectRoot: string,
): string | null {
  let best: { len: number; local: string } | null = null;
  for (const m of mappings) {
    const deployed = m.deployment.startsWith("/")
      ? m.deployment.replace(/\/+$/, "") || "/"
      : joinRemote(root, m.deployment);
    const within =
      remotePath === deployed || remotePath.startsWith(deployed === "/" ? "/" : `${deployed}/`) ? deployed : null;
    if (within === null || (best && best.len >= deployed.length)) continue;
    const rest = remotePath.slice(deployed.length).replace(/^\/+/, "");
    const base = joinRemote(projectRoot, m.local);
    best = { len: deployed.length, local: joinRemote(base, rest) };
  }
  return best?.local ?? null;
}

export type SshRemedy = "trustHostKey" | "secret" | null;

/**
 * What the user can do about a failed SSH connection (`ide-ssh` errors): trust
 * an unknown host key (never a changed one) or type a missing / rejected secret.
 */
export function sshRemedy(kind: string | undefined, message: string, auth: SshAuthValid): SshRemedy {
  if (/^Unknown SSH host key/.test(message)) return "trustHostKey";
  if (kind !== "permissionDenied") return null;
  if (/^SSH host key .* has changed/.test(message)) return null;
  if (/^SSH (password|key passphrase) required|^cannot decrypt SSH key/.test(message)) return "secret";
  // With OpenSSH config + agent there is nothing to type unless a key is encrypted.
  if (/^SSH authentication failed/.test(message)) return auth === "openSsh" ? null : "secret";
  return null;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/** `2026-10-27 14:03` from seconds since the epoch (local time). */
export function formatTime(seconds: number | null | undefined): string {
  if (seconds == null) return "";
  const d = new Date(seconds * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
